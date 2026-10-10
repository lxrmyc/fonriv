"""Fonriv - Docker/容器管理 handler (v4.48.0 · P4 一期)

容器管理功能键 docker。全部操作走 SSH 远端 docker CLI（无需在被管机装 agent）：
  - docker_scan    : 检测 docker + 容器列表(ps -a) + 镜像列表
  - docker_images  : 镜像列表 (可单独刷新)
  - docker_action  : 容器操作 start/stop/restart/pause/unpause/rm (rm 前端二次确认)
  - docker_logs    : 拉取容器日志 (--tail N)
  - docker_import  : v5.89.0 容器/镜像导入 (docker load 镜像归档 / docker import 容器文件系统导出;
                     来源可为控制机文件或目标主机路径, 前者跨机时流式经 SSH 管道不落临时文件)

危险操作 (rm) 走审计日志； 所有命令白名单拼接，无用户可控 shell 注入面
(容器名/镜像名经 shlex.quote)。
"""
from __future__ import annotations
import os
import shlex
import time
_shlex = shlex  # 历史别名 (卷备份/inspect 模板引用)
from fastapi import WebSocket

from fastapi import WebSocketDisconnect

from backend.ssh_lib import SSHTarget, ssh_error_msg
from backend.log import log_operation


def _pub(topic: str, payload: dict) -> None:
    try:
        from backend import events
        events.publish(topic, payload)
    except Exception as e:
        print(f"[docker] publish {topic} fail: {e}")


async def _safe_send(ws, payload: dict) -> bool:
    """v5.88.0 · 容器/镜像归档是分钟级长任务, 期间客户端 WS 可能已断开;
    向死 socket send_json 会抛 RuntimeError(实测: "Cannot call send once a close
    message has been sent") → 任务明明成功, 前端却永远收不到结果报"失败"。
    结果发不出去不算错误: 产物已落盘 + _pub 事件仍会广播, 这里只记日志。"""
    try:
        await ws.send_json(payload)
        return True
    except Exception as e:
        print(f"[docker] 结果发送失败(WS 已断, 任务仍完成后台执行): {type(e).__name__}: {str(e)[:80]}")
        return False


async def _detect_docker(run) -> dict:
    """探测 docker CLI 与 daemon 状态。返回 {installed, version, server_error}"""
    code, out, _ = await run.exec("command -v docker", timeout=8)
    if code != 0:
        return {"installed": False, "version": "", "server_error": "docker 未安装"}
    code, out, err = await run.exec("docker version --format '{{.Server.Version}}' 2>&1", timeout=12)
    if code != 0:
        # CLI 在但 daemon 不通 (权限/未启动)
        first = (out or err or "").strip().splitlines()[-1] if (out or err or "").strip() else "daemon 不可达"
        return {"installed": True, "version": "", "server_error": first[:200]}
    return {"installed": True, "version": (out or "").strip(), "server_error": ""}


async def handle_docker_check(ws: WebSocket, data: dict):
    """v4.49.0 · 插件检测: 目标机 docker CLI / daemon / compose 可用性 (只读)。"""
    try:
        target = SSHTarget.from_ws_data(data)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": f"参数错误: {e}"})
        return
    try:
        async with target.runner() as run:
            det = await _detect_docker(run)
            # compose 探测 (v2 独立子命令 或 旧独立 binary)
            code, out, _ = await run.exec("docker compose version 2>&1", timeout=10)
            compose_v2 = code == 0
            code2, out2, _ = await run.exec("command -v docker-compose", timeout=8)
            compose_v1 = code2 == 0
            # 发行版 (安装引导用)
            code, out, _ = await run.exec(
                ". /etc/os-release 2>/dev/null && echo \"$ID|$ID_LIKE\"", timeout=8)
            os_id = (out or "").strip() or "unknown|"
        await ws.send_json({"type": "result", "status": "ok",
                            "host": target.host,
                            "docker": det,
                            "compose": {"v2": compose_v2, "v1_binary": compose_v1},
                            "os": os_id})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": f"连接失败: {ssh_error_msg(str(e))}"})


# 各发行版族的 docker 安装命令 (包管理器官方源; 不用第三方脚本, 防供应链)
_INSTALL_CMD = {
    "debian":  "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y docker.io docker-compose-v2 2>&1 || apt-get install -y docker.io 2>&1",
    "ubuntu":  "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y docker.io docker-compose-v2 2>&1 || apt-get install -y docker.io 2>&1",
    "kylin":   "yum install -y docker 2>&1 || dnf install -y docker 2>&1",
    "centos":  "yum install -y docker 2>&1 || dnf install -y docker 2>&1",
    "fedora":  "dnf install -y docker 2>&1",
    "rhel":    "dnf install -y docker 2>&1 || yum install -y docker 2>&1",
    "opensuse": "zypper install -y docker 2>&1",
    "arch":    "pacman -Sy --noconfirm docker docker-compose 2>&1",
    "alpine":  "apk add docker docker-cli-compose 2>&1",
}


async def handle_docker_install(ws: WebSocket, data: dict):
    """v4.49.0 · 一键安装 docker (按发行版族选官方源包管理器; 前端需二次确认)。

    安装后 systemctl enable --now docker; 全程输出 tail 回传。
    """
    try:
        target = SSHTarget.from_ws_data(data)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": f"参数错误: {e}"})
        return
    try:
        async with target.runner() as run:
            # 发行版探测
            code, out, _ = await run.exec(
                ". /etc/os-release 2>/dev/null && echo \"$ID|$ID_LIKE\"", timeout=8)
            os_raw = (out or "").strip() or "unknown|"
            os_id, os_like = (os_raw.split("|", 1) + [""])[:2]
            # 选安装命令: ID 精确优先, 再 ID_LIKE 族
            cmd = _INSTALL_CMD.get(os_id)
            if not cmd:
                for fam in os_like.split():
                    if fam in _INSTALL_CMD:
                        cmd = _INSTALL_CMD[fam]
                        break
            if not cmd:
                await ws.send_json({"type": "result", "status": "error",
                                    "msg": f"暂不支持自动安装: {os_id} (可手动安装 docker 后点插件检测)"})
                return
            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"检测到 {os_id} · 开始安装 docker (最长 10 分钟)..."})
            code, out, err = await run.exec(cmd + " ; SYSTEMD_OK=$? ; "
                                            "(systemctl enable --now docker 2>&1 || service docker start 2>&1); "
                                            "echo __INSTALL_DONE__",
                                            timeout=600, merge_stderr=True)
            full = out or ""
            tail = full.strip().splitlines()[-12:]
            # 安装后复检
            det = await _detect_docker(run)
        ok = det["installed"] and not det["server_error"]
        log_operation("Docker", f"一键安装 docker @ {target.host} ({os_id}) → {'成功' if ok else '失败'}")
        await ws.send_json({"type": "result",
                            "status": "ok" if ok else "error",
                            "host": target.host, "os": os_id,
                            "msg": ("安装成功 · docker " + det["version"]) if ok
                                   else ("安装后 daemon 仍不可用: " + (det["server_error"] or "unknown")),
                            "output_tail": "\n".join(tail)[-2000:]})
        _pub("docker.installed", {"host": target.host, "ok": ok})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": f"连接失败: {ssh_error_msg(str(e))}"})


async def handle_docker_scan(ws: WebSocket, data: dict):
    """扫描目标机 docker: 容器(含停止) + 镜像。只读。"""
    try:
        target = SSHTarget.from_ws_data(data)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": f"参数错误: {e}"})
        return

    await ws.send_json({"type": "log", "level": "info", "msg": f"扫描 Docker {target.host} ..."})
    result = {"host": target.host, "docker": {"installed": False, "version": "", "server_error": ""},
              "containers": [], "images": [], "warnings": []}
    try:
        async with target.runner() as run:
            result["docker"] = await _detect_docker(run)
            if not result["docker"]["installed"]:
                await ws.send_json({"type": "result", "status": "error",
                                    "msg": f"{target.host}: docker 未安装 (或不在 PATH)"})
                return
            if result["docker"]["server_error"]:
                result["warnings"].append(f"daemon 异常: {result['docker']['server_error']}")

            # 容器列表 (含停止的) · JSON 格式防列错位
            code, out, err = await run.exec(
                "docker ps -a --format '{{json .}}' 2>&1", timeout=20)
            if code == 0:
                import json as _json
                for line in (out or "").splitlines():
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    try:
                        o = _json.loads(line)
                    except Exception:
                        continue
                    result["containers"].append({
                        "id": (o.get("ID") or "")[:12],
                        "name": o.get("Names") or "",
                        "image": o.get("Image") or "",
                        "state": o.get("State") or "",
                        "status": o.get("Status") or "",
                        "ports": o.get("Ports") or "",
                        "created": o.get("CreatedAt") or "",
                    })
            else:
                result["warnings"].append(f"docker ps 失败: {(err or out or '').strip()[:160]}")

            # 镜像列表
            code, out, err = await run.exec(
                "docker images --format '{{json .}}' 2>&1", timeout=20)
            if code == 0:
                import json as _json
                for line in (out or "").splitlines():
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    try:
                        o = _json.loads(line)
                    except Exception:
                        continue
                    result["images"].append({
                        "repo": o.get("Repository") or "",
                        "tag": o.get("Tag") or "",
                        "id": (o.get("ID") or "")[:12],
                        "size": o.get("Size") or "",
                        "created": o.get("CreatedSince") or "",
                    })

        await ws.send_json({"type": "result", "status": "ok", **result})
        _pub("docker.scanned", {"host": target.host,
                                "containers": len(result["containers"]),
                                "images": len(result["images"])})
    except WebSocketDisconnect:
        raise  # 客户端断开, 交由 WS 层处理 (勿再向已关闭连接回包)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": f"连接失败: {ssh_error_msg(str(e))}"})


async def handle_docker_images(ws: WebSocket, data: dict):
    """单独刷新镜像列表。"""
    try:
        target = SSHTarget.from_ws_data(data)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": f"参数错误: {e}"})
        return
    try:
        async with target.runner() as run:
            det = await _detect_docker(run)
            if not det["installed"]:
                await ws.send_json({"type": "result", "status": "error",
                                    "msg": f"{target.host}: docker 未安装"})
                return
            code, out, err = await run.exec(
                "docker images --format '{{json .}}' 2>&1", timeout=20)
            images = []
            if code == 0:
                import json as _json
                for line in (out or "").splitlines():
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    try:
                        o = _json.loads(line)
                    except Exception:
                        continue
                    images.append({
                        "repo": o.get("Repository") or "",
                        "tag": o.get("Tag") or "",
                        "id": (o.get("ID") or "")[:12],
                        "size": o.get("Size") or "",
                        "created": o.get("CreatedSince") or "",
                    })
        await ws.send_json({"type": "result", "status": "ok",
                            "host": target.host, "images": images})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": f"连接失败: {ssh_error_msg(str(e))}"})


# 允许的容器操作 → docker 子命令 (rm 危险, 前端必须二次确认)
_ACTION_CMD = {
    "start":   "start",
    "stop":    "stop",
    "restart": "restart",
    "pause":   "pause",
    "unpause": "unpause",
    "rm":      "rm -f",
}


async def handle_docker_action(ws: WebSocket, data: dict):
    """容器生命周期操作。data: host/port/user/auth... + name(容器名) + op(start|stop|restart|pause|unpause|rm)"""
    name = (data.get("name") or "").strip()
    op = (data.get("op") or "").strip().lower()
    if not name or op not in _ACTION_CMD:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": "参数错误: 需要 name 与 op(start/stop/restart/pause/unpause/rm)"})
        return
    try:
        target = SSHTarget.from_ws_data(data)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": f"参数错误: {e}"})
        return
    if op == "rm":
        log_operation("Docker", f"删除容器 {name} @ {target.host}")  # 审计
    try:
        async with target.runner() as run:
            cmd = f"docker {_ACTION_CMD[op]} {shlex.quote(name)} 2>&1"
            code, out, err = await run.exec(cmd, timeout=60)
        ok = code == 0
        msg = (out or err or "").strip().splitlines()[-1] if (out or err or "").strip() else \
              ("ok" if ok else f"rc={code}")
        await ws.send_json({"type": "result", "status": "ok" if ok else "error",
                            "host": target.host, "name": name, "op": op, "msg": msg[:200]})
        _pub("docker.action", {"host": target.host, "name": name, "op": op, "ok": ok})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": f"连接失败: {ssh_error_msg(str(e))}"})


async def handle_docker_logs(ws: WebSocket, data: dict):
    """拉取容器日志尾部。data: ... + name + lines(默认 200, 上限 2000)"""
    name = (data.get("name") or "").strip()
    if not name:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 name"})
        return
    try:
        lines = max(10, min(2000, int(data.get("lines") or 200)))
    except (TypeError, ValueError):
        lines = 200
    try:
        target = SSHTarget.from_ws_data(data)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": f"参数错误: {e}"})
        return
    try:
        async with target.runner() as run:
            cmd = f"docker logs --tail {lines} {shlex.quote(name)} 2>&1"
            code, out, err = await run.exec(cmd, timeout=30)
        if code != 0 and not out:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": (err or f"rc={code}").strip()[:200]})
            return
        await ws.send_json({"type": "result", "status": "ok",
                            "host": target.host, "name": name,
                            "logs": (out or "")[-60000:]})  # 防超大日志撑爆 WS
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": f"连接失败: {ssh_error_msg(str(e))}"})


# ═══ v4.76.0 · 卷/网络/Compose/镜像管理 + 资源统计 ═══

async def _docker_exec(ws, data, cmd, timeout=120):
    """SSH 执行 docker 命令, 返回 (rc, out)。
    v5.14.1 · host 为空/本机回环 → 直接本地执行 (旧实现 ssh 空主机名 → 报错行被当成卷名)"""
    host = str(data.get("host") or "").strip().lower()
    if not host or host in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
        import asyncio as _asyncio
        proc = await _asyncio.create_subprocess_shell(
            cmd, stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.STDOUT)
        try:
            out, _ = await _asyncio.wait_for(proc.communicate(), timeout)
            return proc.returncode or 0, (out or b"").decode("utf-8", "replace")
        except _asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            return -1, "docker 命令超时"
    from backend.ssh_lib import SSHTarget
    try:
        target = SSHTarget.from_ws_data(data)
    except Exception as e:
        return -1, str(e)
    from backend.ssh_lib import ssh_error_msg
    try:
        async with target.runner() as run:
            code, out, err = await run.exec(cmd, timeout=timeout, merge_stderr=True)
            return code or 0, out
    except WebSocketDisconnect:
        raise
    except Exception as e:
        return -1, ssh_error_msg(str(e))


async def _docker_exec_progress(ws, data, cmd, out_path, timeout=3600,
                                label="归档", poll_sec=3.0):
    """v5.20.0 · 带进度的 docker 执行 (容器/镜像归档专用)。

    为什么需要: `_docker_exec` 是 communicate() 全量捕获, 归档期间**一条日志都不发**,
    用户看到的就是"点备份没反应、没进度、没日志"。这里改成:
      启动命令(本地或 SSH) → 后台轮询产物文件大小 → 周期性推送 log/progress 帧
    前端 rpcLong 已会把 log/progress 透传到面板日志区, 无需再改前端。

    返回 (rc, out) —— 与 _docker_exec 同签名, 便于直接替换。
    """
    import asyncio as _aio
    from backend.ssh_lib import SSHTarget, ssh_error_msg

    def _human(n):
        for u in ("B", "KB", "MB", "GB", "TB"):
            if n < 1024 or u == "TB":
                return f"{n:.1f} {u}" if u != "B" else f"{int(n)} B"
            n /= 1024

    async def _size():
        """取产物当前大小 (字节)。失败返回 -1。"""
        try:
            if local:
                return os.path.getsize(out_path) if os.path.exists(out_path) else 0
            async with target.runner() as run:
                code, out, _ = await run.exec(
                    f"stat -c %s {shlex.quote(out_path)} 2>/dev/null || echo 0", timeout=15)
            t = (out or "").strip().splitlines()
            return int(t[-1]) if t and t[-1].isdigit() else 0
        except Exception:
            return -1

    host = str(data.get("host") or "").strip().lower()
    local = (not host) or host in ("127.0.0.1", "localhost", "::1", "0.0.0.0")
    target = None
    if not local:
        try:
            target = SSHTarget.from_ws_data(data)
        except Exception as e:
            return -1, str(e)

    async def _emit(msg, level="info"):
        try:
            await ws.send_json({"type": "log", "level": level, "msg": msg})
        except Exception:
            pass

    try:
        if local:
            proc = await _aio.create_subprocess_shell(
                cmd, stdout=_aio.subprocess.PIPE, stderr=_aio.subprocess.STDOUT)
        else:
            run = target.runner()
            await run.__aenter__()
            # build_ssh_argv 返回 (argv, env) —— 只调一次, 避免重复构造
            _argv, _env = run.build_ssh_argv(cmd)
            proc = await _aio.create_subprocess_exec(
                *_argv, stdout=_aio.subprocess.PIPE, stderr=_aio.subprocess.STDOUT,
                env=_env)
    except Exception as e:
        return -1, f"启动失败: {ssh_error_msg(str(e)) if not local else e}"

    await _emit(f"⏳ {label}开始 (产物 {out_path})")
    comm = _aio.ensure_future(proc.communicate())
    t0 = time.time()
    last = -1
    stalled = 0
    try:
        while not comm.done():
            done, _ = await _aio.wait({comm}, timeout=poll_sec)
            if done:
                break
            sz = await _size()
            el = time.time() - t0
            if sz > 0:
                rate = sz / el if el > 0 else 0
                await _emit(f"⏳ {label}进行中 … 已写入 {_human(sz)} · 用时 {int(el)}s"
                            + (f" · 约 {_human(rate)}/s" if rate > 0 else ""))
                try:
                    await ws.send_json({"type": "progress", "percent": 0,
                                        "msg": f"{label} {_human(sz)}", "bytes": sz})
                except Exception:
                    pass
            if sz == last:
                stalled += 1
                if stalled in (20, 60):   # 约 1 分钟 / 3 分钟无增长 → 提醒但不断开
                    await _emit(f"⚠ {label}已 {int(el)}s 无体积增长 (大镜像 gob 阶段属正常, "
                                f"若长时间不动请检查远端磁盘空间与 docker daemon)", "warn")
            else:
                stalled = 0
            last = sz
        out_b, _ = await comm
        el = int(time.time() - t0)
        sz = await _size()
        await _emit(f"✓ {label}命令结束 (用时 {el}s" + (f", 产物 {_human(sz)}" if sz > 0 else "") + ")")
        rc = proc.returncode or 0
        if not local:
            try:
                await run.__aexit__(None, None, None)
            except Exception:
                pass
        return rc, (out_b or b"").decode("utf-8", "replace")
    except Exception as e:
        try:
            proc.kill()
        except Exception:
            pass
        try:
            comm.cancel()
        except Exception:
            pass
        if not local and target is not None:
            try:
                await run.__aexit__(None, None, None)
            except Exception:
                pass
        return -1, f"执行异常: {e}"


def _docker_rows(out: str, expect_cols: int):
    """解析 docker --format 输出 (\\t 字面量分隔)。
    v5.14.1 · 加固: 列数不匹配/含报错关键词的行不再被当成资源名 (旧实现把
    'ssh: Could not resolve hostname ...' 解析成卷 'ssh:')"""
    rows = []
    for line in (out or "").splitlines():
        line = line.replace("\\t", "\t").strip()
        if not line:
            continue
        low = line.lower()
        if any(k in low for k in ("could not", "cannot connect", "permission denied",
                                  "permission denied", "is the docker daemon",
                                  "command not found", "error", "cannot connect")):
            continue
        parts = line.split("\t") if "\t" in line else line.split()
        if len(parts) != expect_cols:
            continue
        rows.append([p.strip() for p in parts])
    return rows


async def handle_docker_volumes(ws: WebSocket, data: dict):
    """卷列表 (含挂载点/大小估算)。params: host/...(SSH); host 空=本机 docker"""
    code, out = await _docker_exec(ws, data,
        'docker volume ls --format "{{.Name}}\t{{.Driver}}" 2>&1')
    vols = []
    for parts in _docker_rows(out, 2):
        if parts[0] != "NAME":
            vols.append({"name": parts[0], "driver": parts[1]})
    if not vols and code != 0 and out:
        await ws.send_json({"type": "result", "status": "error", "volumes": [],
                            "msg": (out or "").strip().splitlines()[-1][:200] or f"rc={code}"})
        return
    # 挂载点 + 大小 (逐个查, 限 30 个)
    detail = []
    for v in vols[:30]:
        code2, out2 = await _docker_exec(ws, data,
            f'V={_shlex.quote(v["name"])}; M=$(docker volume inspect $V --format "{{{{.Mountpoint}}}}" 2>/dev/null); '
            f'S=$(du -sb "$M" 2>/dev/null | cut -f1); echo "$M|$S"', timeout=60)
        mp, _, sz = (out2 or "").strip().partition("|")
        detail.append({**v, "mountpoint": mp.strip(), "size": int(sz.strip() or 0) if sz.strip().isdigit() else 0})
    await ws.send_json({"type": "result", "status": "ok", "volumes": detail})


async def handle_docker_volume_backup(ws, data: dict):
    """卷备份: tar 打包卷数据目录 → 落盘目录 (可再走 restic/跨模块上传)。params: volume, dest_dir, host/...(SSH)"""
    import shlex as _shlex
    name = (data.get("volume") or "").strip()
    dest_dir = (data.get("dest_dir") or "/var/backups/docker_volumes").strip()
    if not name:
        await _safe_send(ws, {"type": "result", "status": "error", "msg": "缺少 volume"})
        return
    ts = time.strftime("%Y%m%d_%H%M%S")
    out = f"{dest_dir.rstrip('/')}/vol_{name}_{ts}.tar.gz"
    code, out_err = await _docker_exec(ws, data,
        f'mkdir -p {_shlex.quote(dest_dir)} && '
        f'M=$(docker volume inspect {_shlex.quote(name)} --format "{{{{.Mountpoint}}}}") && '
        f'tar czf {_shlex.quote(out)} -C "$(dirname $M)" "$(basename $M)" && '
        f'sha256sum {_shlex.quote(out)} > {_shlex.quote(out + ".sha256")} && '
        f'stat -c %s {_shlex.quote(out)}', timeout=1800)
    ok = code == 0 and (out_err or "").strip().splitlines()[-1].isdigit() if out_err else False
    size = (out_err or "").strip().splitlines()[-1] if out_err else "0"
    log_operation("容器备份", f"卷 {name} → {out}" if ok else f"卷 {name} 备份失败: {out_err[:120]}")
    _pub("docker.volume.backup", {"volume": name, "ok": bool(ok), "path": out})
    await _safe_send(ws, {"type": "result",
                        "status": "ok" if ok else "error",
                        "msg": (f"卷备份完成 · {os.path.basename(out)} · {int(size)//1024} KB"
                                if ok else f"备份失败: {(out_err or '')[:200]}"),
                        "path": out})
    # 卷备份也入 E1 统计基线
    try:
        from backend import stats as _st
        if ok:
            _st.record_run("backup_docker_volume", target=name, bytes_=int(size))
    except Exception:
        pass


async def handle_docker_networks(ws: WebSocket, data: dict):
    """网络列表"""
    code, out = await _docker_exec(ws, data,
        'docker network ls --format "{{.Name}}\t{{.Driver}}\t{{.Scope}}" 2>&1')
    nets = []
    for parts in _docker_rows(out, 3):
        if parts[0] != "NAME":
            nets.append({"name": parts[0], "driver": parts[1], "scope": parts[2]})
    await ws.send_json({"type": "result", "status": "ok", "networks": nets})


async def handle_docker_stats(ws: WebSocket, data: dict):
    """容器资源占用 (no-stream 快照)"""
    code, out = await _docker_exec(ws, data,
        'docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}" 2>&1', timeout=60)
    rows = []
    for parts in _docker_rows(out, 4):
        if parts[0] != "NAME":
            rows.append({"name": parts[0], "cpu": parts[1], "mem": parts[2], "net": parts[3]})
    if not rows and code != 0 and out:
        await ws.send_json({"type": "result", "status": "error", "stats": [],
                            "msg": (out or "").strip().splitlines()[-1][:200] or f"rc={code}"})
        return
    await ws.send_json({"type": "result", "status": "ok", "stats": rows})


async def handle_docker_prune(ws, data: dict):
    """清理悬空资源。params: kind(images|containers|volumes), force"""
    import shlex as _shlex
    kind = (data.get("kind") or "images").strip()
    if kind not in ("images", "containers", "volumes", "networks"):
        await ws.send_json({"type": "result", "status": "error", "msg": f"不支持: {kind}"})
        return
    if not data.get("force"):
        await ws.send_json({"type": "result", "status": "error",
                            "msg": "清理会删除未使用的资源, 请确认后重试 (force=1)"})
        return
    code, out = await _docker_exec(ws, data, f"docker {kind} prune -f 2>&1", timeout=300)
    await ws.send_json({"type": "result", "status": "ok" if code == 0 else "error",
                        "msg": (out or "").strip().splitlines()[-1][:200] if out else "完成"})


async def handle_docker_exec_cmd(ws: WebSocket, data: dict):
    """容器内执行命令。params: name, cmd, host/...(SSH)"""
    import shlex as _shlex
    name = (data.get("name") or "").strip()
    cmd = (data.get("cmd") or "").strip()
    if not name or not cmd:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 name 或 cmd"})
        return
    code, out = await _docker_exec(ws, data,
        f"docker exec {_shlex.quote(name)} sh -c {_shlex.quote(cmd)}", timeout=120)
    await ws.send_json({"type": "result", "status": "ok" if code == 0 else "error",
                        "output": (out or "")[:6000], "msg": "完成" if code == 0 else f"rc={code}"})


# ═══ v5.19.0 · 镜像/容器备份 (卷通常只有几百 KB 无备份价值; 镜像才是 GB 级实体) ═══

async def handle_docker_image_backup(ws, data: dict):
    """镜像备份: docker save → tar(.gz) 落盘 + sha256。
    params: image(必填, 仓库:标签 或 ID), dest_dir, compress(bool 默认 true)
    """
    name = (data.get("image") or "").strip()
    dest_dir = (data.get("dest_dir") or "/var/backups/docker_images").strip()
    if not name:
        await _safe_send(ws, {"type": "result", "status": "error", "msg": "缺少 image"})
        return
    do_gz = data.get("compress", True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    safe = name.replace("/", "_").replace(":", "_")[:60]
    ext = ".tar.gz" if do_gz else ".tar"
    out = f"{dest_dir.rstrip('/')}/img_{safe}_{ts}{ext}"
    # 镜像名/ID 经 shlex.quote; 先确认存在, 避免 save 出空包
    cmd = (f"mkdir -p {_shlex.quote(dest_dir)} && "
           f"docker image inspect {_shlex.quote(name)} >/dev/null 2>&1 || {{ echo 'NO_SUCH_IMAGE'; exit 3; }}; "
           f"docker save {_shlex.quote(name)} {'| gzip -6' if do_gz else ''} > {_shlex.quote(out)} 2>/tmp/rp_dockerimg.err && "
           f"sha256sum {_shlex.quote(out)} | awk '{{print $1}}' > {_shlex.quote(out + '.sha256')} && "
           f"stat -c %s {_shlex.quote(out)}")
    code, out_txt = await _docker_exec_progress(ws, data, cmd, out, timeout=3600,
                                                label="镜像归档")
    txt = (out_txt or "").strip()
    if "NO_SUCH_IMAGE" in txt:
        await _safe_send(ws, {"type": "result", "status": "error", "msg": f"镜像不存在: {name}"})
        return
    if code != 0:
        err = ""
        try:
            _, err = await _docker_exec(ws, data, "tail -c 400 /tmp/rp_dockerimg.err 2>/dev/null", timeout=20)
        except Exception:
            pass
        await _safe_send(ws, {"type": "result", "status": "error",
                            "msg": f"镜像备份失败: {(err or txt)[-300:]}"})
        return
    last = txt.splitlines()[-1] if txt else "0"
    size = int(last) if last.isdigit() else 0
    log_operation("容器备份", f"镜像 {name} → {out} ({size // 1048576} MB)")
    try:
        from backend import stats as _st
        _st.record_run("backup_docker_image", target=name, bytes_=size)
    except Exception:
        pass
    _pub("docker.image.backup", {"image": name, "ok": True, "path": out, "size": size})
    await _safe_send(ws, {"type": "result", "status": "ok",
                        "msg": f"镜像备份完成 · {os.path.basename(out)} · {size / 1048576:.1f} MB",
                        "path": out, "size": size,
                        "dest_dir": dest_dir})


async def handle_docker_container_backup(ws, data: dict):
    """容器备份: 两种模式
      mode=export (默认) → docker export 容器文件系统 (不含元数据/卷, 体积小, 可 docker import)
      mode=commit       → docker commit 成临时镜像再 docker save (含镜像层历史, 可 docker load 完整还原)
    params: name(容器名), dest_dir, mode, compress(bool), keep_image(commit 后是否删除临时镜像, 默认 true)
    """
    name = (data.get("name") or "").strip()
    dest_dir = (data.get("dest_dir") or "/var/backups/docker_containers").strip()
    mode = (data.get("mode") or "export").strip().lower()
    if not name:
        await _safe_send(ws, {"type": "result", "status": "error", "msg": "缺少 name"})
        return
    if mode not in ("export", "commit"):
        await _safe_send(ws, {"type": "result", "status": "error", "msg": "mode 仅支持 export / commit"})
        return
    do_gz = data.get("compress", True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    safe = name.replace("/", "_")[:60]
    gz = "| gzip -6" if do_gz else ""
    if mode == "export":
        out = f"{dest_dir.rstrip('/')}/ctr_{safe}_{ts}.tar{'.gz' if do_gz else ''}"
        cmd = (f"mkdir -p {_shlex.quote(dest_dir)} && "
               f"docker container inspect {_shlex.quote(name)} >/dev/null 2>&1 || {{ echo 'NO_SUCH_CONTAINER'; exit 3; }}; "
               f"docker export {_shlex.quote(name)} {gz} > {_shlex.quote(out)} 2>/tmp/rp_dockerctr.err && "
               f"sha256sum {_shlex.quote(out)} | awk '{{print $1}}' > {_shlex.quote(out + '.sha256')} && "
               f"stat -c %s {_shlex.quote(out)}")
    else:
        tmpimg = f"rp-backup-{safe}-{ts}".lower()
        out = f"{dest_dir.rstrip('/')}/ctr_{safe}_{ts}.tar{'.gz' if do_gz else ''}"
        keep = "" if data.get("keep_image") else f"; docker rmi {_shlex.quote(tmpimg)} >/dev/null 2>&1 || true"
        cmd = (f"mkdir -p {_shlex.quote(dest_dir)} && "
               f"docker container inspect {_shlex.quote(name)} >/dev/null 2>&1 || {{ echo 'NO_SUCH_CONTAINER'; exit 3; }}; "
               f"docker commit {_shlex.quote(name)} {_shlex.quote(tmpimg)} >/dev/null 2>&1 && "
               f"docker save {_shlex.quote(tmpimg)} {gz} > {_shlex.quote(out)} 2>/tmp/rp_dockerctr.err && "
               f"sha256sum {_shlex.quote(out)} | awk '{{print $1}}' > {_shlex.quote(out + '.sha256')} && "
               f"stat -c %s {_shlex.quote(out)}"
               + (f"; docker rmi {_shlex.quote(tmpimg)} >/dev/null 2>&1 || true" if not data.get("keep_image") else ""))
    code, out_txt = await _docker_exec_progress(ws, data, cmd, out, timeout=3600,
                                                label=f"容器 {name} ({mode}) 归档")
    txt = (out_txt or "").strip()
    if "NO_SUCH_CONTAINER" in txt:
        await _safe_send(ws, {"type": "result", "status": "error", "msg": f"容器不存在: {name}"})
        return
    if code != 0:
        err = ""
        try:
            _, err = await _docker_exec(ws, data, "tail -c 400 /tmp/rp_dockerctr.err 2>/dev/null", timeout=20)
        except Exception:
            pass
        await _safe_send(ws, {"type": "result", "status": "error",
                            "msg": f"容器备份失败 ({mode}): {(err or txt)[-300:]}"})
        return
    last = txt.splitlines()[-1] if txt else "0"
    size = int(last) if last.isdigit() else 0
    log_operation("容器备份", f"容器 {name} ({mode}) → {out} ({size // 1048576} MB)")
    try:
        from backend import stats as _st
        _st.record_run("backup_docker_container", target=name, bytes_=size)
    except Exception:
        pass
    _pub("docker.container.backup", {"container": name, "mode": mode, "ok": True, "path": out, "size": size})
    await _safe_send(ws, {"type": "result", "status": "ok",
                        "msg": f"容器备份完成 ({mode}) · {os.path.basename(out)} · {size / 1048576:.1f} MB",
                        "path": out, "size": size, "mode": mode, "dest_dir": dest_dir})


async def handle_docker_images_backup_all(ws, data: dict):
    """批量备份全部镜像 (可选排除列表)。params: dest_dir, exclude(逗号分隔), compress
    镜像通常 GB 级, 逐个 save 并在结束时汇总; 适合一次性归档整机镜像。"""
    dest_dir = (data.get("dest_dir") or "/var/backups/docker_images").strip()
    ex = [x.strip() for x in str(data.get("exclude") or "").split(",") if x.strip()]
    code, out = await _docker_exec(ws, data,
        "docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -v '<none>' || true",
        timeout=60)
    imgs = [x.strip() for x in (out or "").splitlines() if x.strip()]
    imgs = [i for i in imgs if i not in ex]
    if not imgs:
        await _safe_send(ws, {"type": "result", "status": "error", "msg": "未发现可备份镜像 (或全部被排除)"})
        return
    await _safe_send(ws, {"type": "log", "level": "info",
                        "msg": f"开始批量备份 {len(imgs)} 个镜像 (总大小见上方「镜像」区)"})
    ok_n, fail_n, total = 0, 0, 0
    results = []
    for i, img in enumerate(imgs):   # v5.20.0 · 需要序号给进度标签用
        safe = img.replace("/", "_").replace(":", "_")[:60]
        ts = time.strftime("%Y%m%d_%H%M%S")
        do_gz = data.get("compress", True)
        outp = f"{dest_dir.rstrip('/')}/img_{safe}_{ts}.tar{'.gz' if do_gz else ''}"
        cmd = (f"mkdir -p {_shlex.quote(dest_dir)} && "
               f"docker save {_shlex.quote(img)} {'| gzip -6' if do_gz else ''} > {_shlex.quote(outp)} 2>/dev/null && "
               f"sha256sum {_shlex.quote(outp)} | awk '{{print $1}}' > {_shlex.quote(outp + '.sha256')} && "
               f"stat -c %s {_shlex.quote(outp)}")
        # v5.20.0 · 单个 GB 镜像 gob/save 阶段可能数分钟, 之前这里全程静默 →
        #   用户以为卡死。改为逐镜像带进度 (体积轮询 + log/progress 帧)。
        c2, o2 = await _docker_exec_progress(
            ws, data, cmd, outp, timeout=3600,
            label=f"镜像 {img} ({i + 1}/{len(imgs)})")
        last = (o2 or "").strip().splitlines()[-1] if (o2 or "").strip() else "0"
        sz = int(last) if last.isdigit() else 0
        if c2 == 0 and sz > 0:
            ok_n += 1; total += sz
            results.append({"image": img, "ok": True, "size": sz})
            await _safe_send(ws, {"type": "log", "level": "info",
                                "msg": f"  ✓ {img} → {os.path.basename(outp)} ({sz / 1048576:.1f} MB)"})
        else:
            fail_n += 1
            results.append({"image": img, "ok": False})
            await _safe_send(ws, {"type": "log", "level": "warn", "msg": f"  ✗ {img} 备份失败"})
    log_operation("容器备份", f"批量镜像备份 {ok_n} 成功 / {fail_n} 失败 → {dest_dir} ({total // 1048576} MB)")
    await _safe_send(ws, {"type": "result", "status": "ok" if ok_n else "error",
                        "msg": f"批量镜像备份完成 · {ok_n} 成功 / {fail_n} 失败 · 共 {total / 1048576:.1f} MB",
                        "ok_count": ok_n, "fail_count": fail_n, "total_size": total,
                        "results": results, "dest_dir": dest_dir})


# ═══════════════════════════════════════════════════════════════
# v5.31.1 · docker compose 配置文件备份 (自动扫描 + 归档)
#   扫描来源两路:
#     ① 运行中/已停止容器的 compose 标签 (com.docker.compose.project.config_files /
#        working_dir) —— 这是最准的, 直接给出正在使用的 compose 文件绝对路径;
#     ② 常见目录的文件系统扫描 (compose.yaml/docker-compose.yml 等, 限深度与数量)。
# ═══════════════════════════════════════════════════════════════

_COMPOSE_NAMES = ("compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml",
                  "docker-compose.override.yaml", "docker-compose.override.yml")


async def handle_docker_compose_scan(ws: WebSocket, data: dict):
    """扫描 compose 配置文件。params: host/...(SSH); host 空=本机"""
    _req = data.get("req_id") or ""
    # ① 从容器标签取 compose 工程与文件 (最准确)
    code, out = await _docker_exec(ws, data,
        'docker ps -a --format "{{.Names}}\t{{.Label \\"com.docker.compose.project\\"}}'
        '\t{{.Label \\"com.docker.compose.project.config_files\\"}}'
        '\t{{.Label \\"com.docker.compose.project.working_dir\\"}}" 2>&1', timeout=60)
    projects = {}
    for parts in _docker_rows(out, 4):
        if len(parts) < 4 or parts[0] == "Names":
            continue
        cname, proj, cfg, wd = parts[0], parts[1], parts[2], parts[3]
        if not proj:
            continue
        ent = projects.setdefault(proj, {"project": proj, "containers": [], "files": [],
                                        "working_dir": wd or ""})
        ent["containers"].append(cname)
        for f in [x.strip() for x in (cfg or "").split(",") if x.strip()]:
            if f not in ent["files"]:
                ent["files"].append(f)

    # ② 文件系统扫描 (常见目录 + 工程 working_dir)
    dirs = ["/opt", "/srv", "/root", "/home", "/var/lib/docker/compose", "/data", "/mnt"]
    for ent in projects.values():
        if ent["working_dir"] and ent["working_dir"].startswith("/"):
            dirs.insert(0, ent["working_dir"])
    names = " -o ".join(f'-name "{n}"' for n in _COMPOSE_NAMES)
    scan = (f'for d in {" ".join(_shlex.quote(d) for d in dirs)}; do '
            f'[ -d "$d" ] && find "$d" -maxdepth 4 -type f \\( {names} \\) 2>/dev/null; done | head -200')
    code2, out2 = await _docker_exec(ws, data, scan, timeout=90)
    found = []
    for line in (out2 or "").splitlines():
        pth = line.strip()
        if pth.startswith("/") and pth not in found:
            found.append(pth)

    # 汇总: 标签命中的文件优先, 扫描结果补充
    tagged = {}
    for ent in projects.values():
        for f in ent["files"]:
            if f.startswith("/"):
                tagged[f] = ent["project"]
    files = []
    for pth in list(tagged.keys()) + [p for p in found if p not in tagged]:
        try:
            st = await _docker_exec(ws, data,
                f'stat -c "%s %Y" {_shlex.quote(pth)} 2>/dev/null || echo ""', timeout=20)
            parts = (st[1] or "").strip().split()
            size = int(parts[0]) if parts and parts[0].isdigit() else 0
        except Exception:
            size = 0
        files.append({"path": pth, "project": tagged.get(pth, ""), "size": size})

    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "files": files, "projects": list(projects.values()),
                        "scanned_dirs": dirs[:8],
                        "msg": f"扫描到 {len(files)} 个 compose 配置文件"
                               + (f" · {len(projects)} 个 compose 工程" if projects else "")})


async def handle_docker_compose_backup(ws: WebSocket, data: dict):
    """归档选定的 compose 配置文件 (整包 + 可选带上同目录的 .env)。
    params: files(list, 必填), dest_dir, compress(bool), with_env(bool)
    """
    _req = data.get("req_id") or ""
    files = data.get("files") or ([data.get("file")] if data.get("file") else [])
    files = [str(f).strip() for f in files if str(f or "").strip()]
    if not files:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "请先勾选要备份的 compose 文件"})
        return
    dest_dir = (data.get("dest_dir") or "/var/backups/docker_compose").strip()
    do_gz = str(data.get("compress", True)).lower() not in ("0", "false", "no")
    with_env = str(data.get("with_env", True)).lower() not in ("0", "false", "no")
    ts = __import__("time").strftime("%Y%m%d_%H%M%S")
    ext = ".tar.gz" if do_gz else ".tar"
    out = f"{dest_dir.rstrip('/')}/compose_{ts}{ext}"
    # 用 tar 的 -C 逐文件归档, 保留绝对路径的目录结构; 同时可选带上 .env
    quoted = " ".join(_shlex.quote(f) for f in files)
    env_part = ""
    if with_env:
        env_part = (" && for f in " + quoted + "; do d=$(dirname \"$f\"); "
                    "[ -f \"$d/.env\" ] && echo \"$d/.env\"; done | sort -u > /tmp/_rp_env.list; "
                    "tar " + ("-czf" if do_gz else "-cf") + " " + _shlex.quote(out) +
                    " -T /tmp/_rp_env.list 2>/dev/null || true")
    cmd = (f"mkdir -p {_shlex.quote(dest_dir)} && "
           f"tar {'-czf' if do_gz else '-cf'} {_shlex.quote(out)} {quoted} 2>&1; "
           f"echo \"$?\"" + env_part + "; ls -l " + _shlex.quote(out) + " 2>&1")
    code, txt = await _docker_exec(ws, data, cmd, timeout=300)
    # 远端主机时本地 os.path 无意义, 统一用 ls 输出行判断产物是否存在与大小
    size = 0
    for line in reversed((txt or "").splitlines()):
        parts = line.split()
        if len(parts) >= 5 and parts[-1].endswith((".tar", ".gz")):
            try:
                size = int(parts[4]); break
            except Exception:
                pass
    if "No such file" in (txt or "") and size == 0:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "归档失败: " + (txt or "")[-200:]})
        return
    log_operation("容器备份", f"compose 配置 {len(files)} 个 → {out}")
    try:
        from backend import stats as _st
        _st.record_run("backup_docker_compose", target=f"{len(files)} 个文件", bytes_=size)
    except Exception:
        pass
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "path": out, "size": size, "dest_dir": dest_dir, "files": files,
                        "msg": f"compose 配置备份完成 · {os.path.basename(out)} · {size/1048576:.2f} MB"})


# ═══ v5.89.0 · 容器/镜像导入 (所有版本) ═══
# 把备份产物 (docker save / docker export 的 tar/tar.gz) 导回 docker:
#   save 格式 (镜像备份 / commit 模式容器备份) → docker load
#   export 格式 (export 模式容器备份)          → docker import - <tag>
# 来源两类:
#   src_kind=local  → 控制机本机文件 (远端目标时流式经 SSH 管道, 不落远端临时文件)
#   src_kind=remote → 已在目标主机上的路径

async def _detect_archive_kind(local: bool, data: dict, path: str) -> str:
    """探测归档是 save 格式还是 export 格式: save 包根层有 manifest.json/repositories"""
    probe = (f"tar -tzf {_shlex.quote(path)} 2>/dev/null || tar -tf {_shlex.quote(path)} 2>/dev/null"
             ) + " | head -40"
    if local:
        import asyncio as _aio
        proc = await _aio.create_subprocess_shell(probe, stdout=_aio.subprocess.PIPE,
                                                  stderr=_aio.subprocess.DEVNULL)
        try:
            out, _ = await _aio.wait_for(proc.communicate(), 30)
        except _aio.TimeoutError:
            return "load"
        txt = (out or b"").decode("utf-8", "replace")
    else:
        from backend.ssh_lib import SSHTarget
        try:
            target = SSHTarget.from_ws_data(data)
            async with target.runner() as run:
                _, txt, _ = await run.exec(probe, timeout=40, merge_stderr=True)
            txt = txt or ""
        except Exception:
            return "load"
    head = "\n".join(txt.splitlines()[:40])
    if "manifest.json" in head or "repositories" in head:
        return "load"
    return "import"


async def handle_docker_import(ws, data: dict, task_id: str = ""):
    """v5.89.0 · 容器/镜像导入 (所有版本)。**ROUTE_TASK 异步派发** —— 镜像归档常见 GB 级、
    耗时数分钟, 串行 await 会占住整条 WS 连接 (进度/其它请求全部排队)。
    params:
    src_kind: 'local'(控制机文件) | 'remote'(目标主机路径, 默认 local)
    src_path: 归档文件路径
    mode: 'auto'(默认, 自动识别) | 'load' | 'import'
    tag: import 模式的镜像标签 (留空则从文件名推导; auto/import 生效, load 忽略)
    """
    import asyncio as _aio
    src_kind = (data.get("src_kind") or "local").strip().lower()
    src_path = (data.get("src_path") or "").strip()
    mode = (data.get("mode") or "auto").strip().lower()
    tag = (data.get("tag") or "").strip()
    host = str(data.get("host") or "").strip().lower()
    local_target = (not host) or host in ("127.0.0.1", "localhost", "::1", "0.0.0.0")

    async def _emit(msg, level="info"):
        try:
            await ws.send_json({"type": "log", "level": level, "msg": "📥 " + msg})
        except Exception:
            pass

    async def _prog(done, total):
        try:
            await ws.send_json({"type": "progress",
                                "percent": (round(done / total * 100, 1) if total else 0),
                                "msg": f"导入 {_human_bytes(done)}" if total else "导入中…",
                                "bytes": done})
        except Exception:
            pass

    # v5.89.0 · 本 action 由 ROUTE_TASK **异步派发**, 期间 ws._current_req_id 已被后续消息覆盖,
    #   早退错误必须显式带 req_id —— 否则前端 rpcLong 匹配不上, 用户看到的是"任务超时"
    #   而不是"文件不存在"这类具体原因 (实测踩到)。
    _rid = data.get("req_id") or ""

    async def _fail(msg: str) -> None:
        await _safe_send(ws, {"type": "result", "status": "error", "req_id": _rid, "msg": msg})

    if not src_path:
        await _fail("缺少归档文件路径")
        return
    if src_kind not in ("local", "remote"):
        await _fail("src_kind 仅支持 local / remote")
        return

    # 来源文件存在性与大小
    if src_kind == "local":
        if not os.path.isfile(src_path):
            await _fail(f"本机文件不存在: {src_path}")
            return
        total = os.path.getsize(src_path)
    else:
        if local_target:
            if not os.path.isfile(src_path):
                await _fail(f"文件不存在: {src_path}")
                return
            total = os.path.getsize(src_path)
        else:
            code, out = await _docker_exec(ws, data,
                                           f"stat -c %s {_shlex.quote(src_path)} 2>/dev/null || echo NOFILE",
                                           timeout=20)
            t = (out or "").strip().splitlines()[-1] if (out or "").strip() else ""
            if t == "NOFILE" or not t.isdigit():
                await _fail(f"目标主机上文件不存在: {src_path}")
                return
            total = int(t)

    # 导入方式 (auto = 探测归档头 40 项, 有 manifest.json/repositories 即 save 格式)
    if mode == "auto":
        await _emit(f"识别归档格式 ({'本机' if src_kind == 'local' else '目标机'}: {os.path.basename(src_path)}) …")
        mode = await _detect_archive_kind(src_kind == "local" or local_target, data, src_path)
        await _emit(f"识别为 {'docker load (镜像归档)' if mode == 'load' else 'docker import (容器文件系统导出)'}")
    if mode not in ("load", "import"):
        await _fail("mode 仅支持 auto / load / import")
        return
    if mode == "import" and not tag:
        base = os.path.basename(src_path)
        for pre in ("img_", "ctr_", "vol_"):
            if base.startswith(pre):
                base = base[len(pre):]
        import re as _re
        base = _re.sub(r"[_\-]20\d{6}_\d{6}", "", base)
        base = _re.sub(r"\.(tar\.gz|tgz|tar\.bz2|tar\.xz|tar)$", "", base).strip("_-.")
        tag = (base or "imported") + ":restored"
        await _emit(f"未指定镜像标签, 从文件名推导: {tag}")

    await _emit(f"开始导入 → {'本机' if local_target else host} docker · {src_path} "
                f"({'%.1f MB' % (total / 1048576) if total else '?'})")

    t0 = time.time()
    try:
        if src_kind == "remote" or local_target:
            # 归档文件与 docker 同机 (本机 docker 或已在目标主机上的路径) → 直接按路径导入
            cmd = (f"docker load -i {_shlex.quote(src_path)}" if mode == "load"
                   else f"docker import {_shlex.quote(src_path)} {_shlex.quote(tag)}")
            code, out = await _docker_exec(ws, data, cmd, timeout=3600)
        else:
            # 本机文件 → 远端 docker: 流式经 SSH 管道 (docker load / import 均支持读 stdin)
            from backend.ssh_lib import SSHTarget
            target = SSHTarget.from_ws_data(data)
            run = target.runner()
            await run.__aenter__()
            if mode == "load":
                remote_cmd = "docker load"
            else:
                remote_cmd = f"docker import - {_shlex.quote(tag)}"
            _argv, _env = run.build_ssh_argv(remote_cmd)
            proc = await _aio.create_subprocess_exec(
                *_argv, stdin=_aio.subprocess.PIPE, stdout=_aio.subprocess.PIPE,
                stderr=_aio.subprocess.STDOUT, env=_env)
            sent = 0
            last_emit = 0.0
            with open(src_path, "rb") as f:
                while True:
                    chunk = await _aio.get_running_loop().run_in_executor(None, f.read, 262144)
                    if not chunk:
                        break
                    proc.stdin.write(chunk)
                    sent += len(chunk)
                    if time.time() - last_emit > 1.2:
                        last_emit = time.time()
                        await _emit(f"传输中 … {sent / 1048576:.1f} / {total / 1048576:.1f} MB"
                                    + (f" · {sent / 1048576 / max(time.time() - t0, 0.1):.1f} MB/s"))
                        await _prog(sent, total)
            proc.stdin.close()
            out_b, _ = await _aio.wait_for(proc.communicate(), 3600)
            await run.__aexit__(None, None, None)
            code, out = proc.returncode or 0, (out_b or b"").decode("utf-8", "replace")
    except WebSocketDisconnect:
        raise
    except Exception as e:
        from backend.ssh_lib import ssh_error_msg
        await _fail("导入异常: " + (ssh_error_msg(str(e)) if not local_target else str(e)))
        return

    el = time.time() - t0
    txt = (out or "").strip()
    if code != 0:
        await _fail(f"导入失败 (rc={code}): {txt[-300:]}")
        return
    loaded = ""
    for ln in txt.splitlines():
        if "Loaded image" in ln or "Loaded from" in ln or ln.startswith("sha256:"):
            loaded = ln.strip()
            break
    _pub("docker.image.imported", {"src": os.path.basename(src_path), "mode": mode, "tag": tag,
                                   "ok": True, "output": loaded[:120]})
    log_operation("容器导入", f"{os.path.basename(src_path)} → {mode}"
                  + (f" {tag}" if mode == "import" else "") + f" ({el:.1f}s)")
    try:
        from backend import stats as _st
        _st.record_run("import_docker_archive", target=os.path.basename(src_path), bytes_=int(total or 0))
    except Exception:
        pass
    await _safe_send(ws, {"type": "result", "status": "ok",
                          "req_id": _rid,
                          "mode": mode, "tag": tag,
                          "msg": (f"导入完成 · {loaded or 'docker ' + mode}" + f" · 用时 {el:.1f}s"
                                  + (f" · {total / 1048576:.1f} MB" if total else ""))})


def _human_bytes(n):
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return f"{n:.1f} {u}" if u != "B" else f"{int(n)} B"
        n /= 1024

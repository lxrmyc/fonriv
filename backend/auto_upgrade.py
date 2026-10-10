"""Fonriv - 自动升级系统 (v4.85.0)

功能:
  - 检查更新: 对比当前版本 vs 目标服务器版本 (或 Git HEAD)
  - 下载更新包: 从本机 rsync 或远程 tar.gz 拉取
  - 安装: 解压覆盖(排除 data/venv/backups) + systemctl restart
  - 远程升级: 对已配置的升级目标服务器执行远程升级
  - 回滚: 保留旧版本 tar.gz 用于回滚

升级模式:
  1. git_archive: 从本机仓库目录 git archive 打包 → 推送到远端解压
  2. tar_url: 从 HTTP URL 下载 tar.gz → 解压
  3. local_tar: 使用本地已有的 tar.gz 文件

WS 动作:
  upgrade_check    检查更新 (本机 vs 远端版本)
  upgrade_run      执行远程升级
  upgrade_status   升级结果/日志
"""
from __future__ import annotations

import asyncio
import json
import os
import json
import shlex
import subprocess
import time

from fastapi import WebSocket, WebSocketDisconnect

from backend import db
from backend.log import log_operation

# 升级目标清单外置 (v6.16.2 · 凭据修复): 内网/外网机器清单不再硬编码在源码里,
#   改为从不入库的运行时文件读取 —— 优先级:
#   ① app_settings.upgrade_test_servers (页面配置) ② data/upgrade_targets.json ③ 空
#   data/upgrade_targets.json 格式: [{"ip","label","path","svc","port","user"},...]
#   (data/ 整目录已在 .gitignore 与 release.sh 排除清单中, 不进 git 与任何发行包)
DEFAULT_TEST_SERVERS: list = []

_TARGETS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "data", "upgrade_targets.json")

_update_log: list = []


def _targets_file_load() -> list:
    try:
        with open(_TARGETS_FILE, "r", encoding="utf-8") as f:
            arr = json.load(f)
        if isinstance(arr, list):
            return [s for s in arr if isinstance(s, dict) and s.get("ip")]
    except Exception:
        pass
    return []


def test_servers() -> list:
    """升级目标列表: 页面配置 (app_settings.upgrade_test_servers) > data/upgrade_targets.json > 空。"""
    try:
        raw = db.setting_get("upgrade_test_servers", "")
        if raw:
            arr = json.loads(raw)
            if isinstance(arr, list):
                good = [s for s in arr if isinstance(s, dict) and s.get("ip")]
                if good:
                    return good
    except Exception as e:
        print(f"[upgrade] 读取 upgrade_test_servers 配置失败, 回退 targets 文件: {e}")
    return _targets_file_load()


def _log(msg: str, level: str = "info"):
    _update_log.append({"ts": time.strftime("%H:%M:%S"), "level": level, "msg": msg[:300]})
    if len(_update_log) > 100:
        del _update_log[:20]
    print(f"[upgrade] {msg}")


async def _ssh_exec(ip: str, port: int, user: str, cmd: str, timeout: int = 60) -> tuple[int, str]:
    """SSH 执行 (用 sshpass + ssh)"""
    pw = _get_ssh_password(ip)
    if not pw:
        return -1, f"No SSH password for {ip}"
    cmd_full = (
        f"sshpass -p {shlex.quote(pw)} ssh -o StrictHostKeyChecking=accept-new "
        f"-o ConnectTimeout=10 -p {port} {user}@{ip} {shlex.quote(cmd)}"
    )
    proc = await asyncio.create_subprocess_shell(
        cmd_full, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        return proc.returncode or 0, (out or b"").decode("utf-8", "replace").strip()
    except asyncio.TimeoutError:
        try: proc.kill()
        except Exception: pass
        return 1, f"SSH 超时 ({timeout}s)"


def _get_ssh_password(ip: str) -> str:
    """从环境变量或 tests/machine_creds.txt 读取 SSH 密码 (v6.16.2 凭据修复: 不再硬编码默认密码)"""
    pw = os.environ.get(f"SSHPASS_{ip.replace('.', '_')}")
    if pw:
        return pw
    creds_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              "tests", "machine_creds.txt")
    if os.path.exists(creds_file):
        with open(creds_file) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) >= 3 and parts[0] == ip:
                    return parts[2]
    return ""


def _get_local_version() -> str:
    try:
        version_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                    "backend", "version.py")
        for line in open(version_file):
            if line.startswith("VERSION"):
                return line.split("=")[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return "?"


async def handle_upgrade_servers_get(ws, data: dict):
    """v5.50.0 · 读取远程升级目标列表 (内置默认 / 配置覆盖) — 审计报告 #3 配套"""
    _req = data.get("req_id") or ""
    raw = db.setting_get("upgrade_test_servers", "")
    configured = False
    if raw:
        try:
            configured = bool(json.loads(raw))
        except Exception as e:
            print(f"[upgrade] 配置解析失败(按未配置处理): {e}")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "servers": test_servers(), "configured": configured,
                        "default_servers": DEFAULT_TEST_SERVERS,
                        "msg": "共 %d 个升级目标 (%s)" % (len(test_servers()),
                                                       "已配置" if configured else "内置默认")})


async def handle_upgrade_servers_set(ws, data: dict):
    """v5.50.0 · 保存远程升级目标列表 (仅管理员; reset=true 恢复内置默认)。
    params: servers=[{ip,label,path,svc,port,user,external,bw_mbps}] 或 reset=True"""
    _req = data.get("req_id") or ""
    role = None
    try:
        from backend.ws import active_sessions
        role = (active_sessions.get(ws) or {}).get("role")
    except Exception as e:
        print(f"[upgrade] 取会话角色失败: {e}")
    if role != "admin":
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "仅管理员可修改升级目标"})
        return
    if data.get("reset"):
        db.setting_delete("upgrade_test_servers")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "servers": DEFAULT_TEST_SERVERS, "configured": False,
                            "msg": "已恢复内置默认列表"})
        return
    arr = data.get("servers")
    if not isinstance(arr, list):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "servers 必须是数组"})
        return
    clean = []
    for s in arr:
        if not isinstance(s, dict) or not str(s.get("ip") or "").strip():
            continue
        try:
            port = int(s.get("port") or 22)
        except Exception:
            port = 22
        item = {"ip": str(s["ip"]).strip(),
                "label": str(s.get("label") or s["ip"]).strip(),
                "path": str(s.get("path") or "/opt/fonriv").strip(),
                "svc": str(s.get("svc") or "fonriv").strip(),
                "port": port,
                "user": str(s.get("user") or "root").strip()}
        if s.get("external"):
            item["external"] = True
        if s.get("bw_mbps"):
            item["bw_mbps"] = s["bw_mbps"]
        clean.append(item)
    if not clean:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "没有有效条目 (每条至少要 ip)"})
        return
    db.setting_set("upgrade_test_servers", json.dumps(clean, ensure_ascii=False))
    _log("⚙ 升级目标列表已更新: %d 条" % len(clean))
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "servers": clean, "configured": True,
                        "msg": "已保存 %d 个升级目标" % len(clean)})


async def handle_upgrade_check(ws, data: dict):
    """检查各服务器当前版本 vs 本机版本"""
    _req = data.get("req_id") or ""
    local_ver = _get_local_version()
    servers = []
    for srv in test_servers():
        rc, out = await _ssh_exec(srv["ip"], srv["port"], srv["user"],
                                  f"grep '^VERSION' {srv['path']}/backend/version.py 2>/dev/null | head -1", 30)
        remote_ver = out.replace("VERSION = ", "").strip().strip('"') if rc == 0 else "?"
        servers.append({
            **{k: v for k, v in srv.items()},
            "local_version": local_ver,
            "remote_version": remote_ver,
            "needs_update": remote_ver != local_ver and remote_ver != "?",
            "ssh_ok": rc == 0,
        })
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "local_version": local_ver, "servers": servers})


async def handle_upgrade_run(ws, data: dict):
    """执行远程升级 (git archive → scp → 解压 → restart)。
    params: targets(服务器 IP 列表, 空=全部), skip_version_check(bool)"""
    _req = data.get("req_id") or ""
    targets = data.get("targets") or [s["ip"] for s in test_servers()]
    local_ver = _get_local_version()

    # 1) 生成本机最新 tar.gz (v6.16.2: 仓库目录取本文件安装根, 不再硬编码开发机路径)
    _repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    tar_path = "/tmp/rp_upgrade.tar.gz"
    git_cmd = f"git -c safe.directory={_repo_root} -C {_repo_root} archive --format=tar.gz -o {tar_path} HEAD"
    proc = subprocess.run(git_cmd, shell=True, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"打包失败: {proc.stderr[:200]}"})
        return
    tar_size = os.path.getsize(tar_path) if os.path.exists(tar_path) else 0
    _log(f"📦 已打包 HEAD → {tar_path} ({tar_size // 1024} KB) · 版本 {local_ver}")

    results = []
    for srv in test_servers():
        ip = srv["ip"]
        if ip not in targets:
            continue
        _log(f"🔄 升级 {ip} ({srv['label']}) …")
        # 2) 推送
        rc, out = await _ssh_exec(ip, srv["port"], srv["user"],
                                  f"ls {srv['path']}/backend/version.py 2>/dev/null", 15)
        if rc != 0:
            results.append({**srv, "ok": False, "msg": "远端路径不存在"})
            _log(f"  ✗ {ip}: {srv['path']} 不存在", "error")
            continue

        scp_cmd = (f"sshpass -p {shlex.quote(_get_ssh_password(ip))} "
                   f"scp -o StrictHostKeyChecking=accept-new {tar_path} {srv['user']}@{ip}:/tmp/rp_upgrade.tar.gz")
        proc = await asyncio.create_subprocess_shell(scp_cmd, stdout=asyncio.subprocess.DEVNULL,
                                                     stderr=asyncio.subprocess.PIPE)
        await asyncio.wait_for(proc.wait(), 120)
        if proc.returncode != 0:
            results.append({**srv, "ok": False, "msg": "SCP 失败"})
            _log(f"  ✗ {ip}: SCP 失败", "error")
            continue

        # 3) 解压 + 重启 (保留 data/)
        rc, out = await _ssh_exec(ip, srv["port"], srv["user"],
                                  f"cd {srv['path']} && tar xzf /tmp/rp_upgrade.tar.gz && "
                                  f"systemctl restart {srv['svc']} && sleep 5 && "
                                  f"systemctl is-active {srv['svc']}", 60)
        svc_ok = "active" in out
        # 4) 验证版本
        rc2, ver_out = await _ssh_exec(ip, srv["port"], srv["user"],
                                       f"grep '^VERSION' {srv['path']}/backend/version.py", 15)
        remote_ver = ver_out.replace("VERSION = ", "").strip().strip('"') if rc2 == 0 else "?"
        ok = svc_ok and remote_ver == local_ver
        results.append({**srv, "ok": ok, "msg": f"v{remote_ver} · {'✓' if ok else '✗'}"})
        _log(f"  {'✓' if ok else '✗'} {ip}: v{remote_ver} · {'active' if svc_ok else 'inactive'}")

    os.remove(tar_path)
    log_operation("自动升级", f"v{local_ver} → {len(results)} 台服务器, 成功 {sum(1 for r in results if r['ok'])}")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "local_version": local_ver, "results": results,
                        "log": _update_log[-30:]})


# ── WS handler: 本机自动升级 (通过 git pull + restart) ──

async def handle_upgrade_self(ws, data: dict):
    """本机自动升级: git pull → version bump → restart"""
    _req = data.get("req_id") or ""
    _log("🔄 本机自动升级: git pull …")
    _repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.run(f"git -c safe.directory={_repo_root} -C {_repo_root} pull", shell=True,
                          capture_output=True, text=True, timeout=120)
    _log(f"  git pull rc={proc.returncode}: {proc.stdout[:200]}")
    if proc.returncode != 0:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"git pull 失败: {proc.stderr[:200]}"})
        return
    # 重新加载版本
    proc2 = subprocess.run(f"python3 -c 'import sys; sys.path.insert(0,{_repo_root!r}); "
                          "from backend.version import VERSION; print(VERSION)'",
                          shell=True, capture_output=True, text=True, timeout=15)
    new_ver = proc2.stdout.strip()
    _log(f"  新版本: {new_ver} · 需要重启服务生效")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "msg": f"代码已更新到 v{new_ver}, 请重启服务生效", "version": new_ver})

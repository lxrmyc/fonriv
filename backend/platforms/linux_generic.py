"""Linux 通用平台（兜底）。"""
import logging

import shlex

from backend.platforms.base import BackupPlatform, BackupItem


def _shellq(s: str) -> str:
    """把任意字符串安全嵌入 shell 命令。"""
    return shlex.quote(s)


class LinuxGenericPlatform(BackupPlatform):
    NAME = "linux_generic"
    DISPLAY = "通用 Linux"
    ICON = "🐧"
    NOTES = "适用于 Debian / Ubuntu / CentOS / RHEL / Alpine 等常规 Linux 主机。"

    @classmethod
    def detect(cls, probe: dict) -> int:
        # 兜底：只要 uname 里带 Linux 就给 20 分保底
        uname = probe.get("uname", "") or ""
        if "Linux" in uname:
            return 20
        return 5  # 甚至没 uname 也留个火种（走 fallback）

    def collect_config_manifest(self):
        return [
            BackupItem("network",  "网络配置",    "/etc/network/;/etc/netplan/;/etc/NetworkManager/",
                       kind="dir",  required=False, description="接口/路由/NetworkManager"),
            BackupItem("ssh",      "SSH 配置",    "/etc/ssh/",         kind="dir",  required=True,
                       description="sshd_config + host keys"),
            BackupItem("fstab",    "挂载表",      "/etc/fstab",        kind="file", required=True),
            BackupItem("hosts",    "hosts 文件",  "/etc/hosts",        kind="file", required=True),
            BackupItem("users",    "用户/密码",   "/etc/passwd;/etc/shadow;/etc/group;/etc/gshadow",
                       kind="file", required=False, description="系统用户账号"),
            BackupItem("sudoers",  "sudo 规则",   "/etc/sudoers;/etc/sudoers.d/", kind="dir", required=False),
            BackupItem("systemd_units", "systemd 单元", "/etc/systemd/system/",
                       kind="dir",  required=False, description="自定义 .service / .timer"),
            BackupItem("root_ssh", "root SSH",    "/root/.ssh/",       kind="dir",  required=False,
                       description="authorized_keys + private keys"),
            BackupItem("crontab",  "crontab",     "crontab -l",        kind="command_output",
                       required=False, description="root 的 crontab"),
        ]

    def workloads_hint(self):
        return ["docker", "systemd"]

    # ------------------------------------------------------------------
    # alpha1.5: 只读探测 workloads
    # Docker 容器 + systemd 启用/运行的服务清单。全部只读。
    # ------------------------------------------------------------------
    async def detect_workloads(self, runner):
        from backend.platforms.base import Workload

        workloads = []

        # Docker 容器（含已停止）—— 无 docker 直接跳过
        rc, out, _ = await runner.exec(
            "command -v docker >/dev/null 2>&1 && "
            "docker ps -a --no-trunc --format '{{.ID}}\\t{{.Names}}\\t{{.Status}}\\t{{.Image}}' "
            "2>/dev/null || echo __NO_DOCKER__",
            timeout=20,
        )
        if rc == 0 and "__NO_DOCKER__" not in out:
            for line in out.strip().splitlines():
                if not line.strip():
                    continue
                parts = line.split("\t")
                if len(parts) >= 3:
                    workloads.append(Workload(
                        kind="docker", id=parts[0][:12], name=parts[1],
                        status=parts[2],
                        extra={"image": parts[3] if len(parts) > 3 else ""},
                    ))

        # systemd 已启用的服务（enabled，不含 static/generated）
        rc, out, _ = await runner.exec(
            "command -v systemctl >/dev/null 2>&1 && "
            "systemctl list-unit-files --type=service --state=enabled --no-legend --no-pager "
            "2>/dev/null || echo __NO_SYSTEMD__",
            timeout=15,
        )
        if rc == 0 and "__NO_SYSTEMD__" not in out:
            for line in out.strip().splitlines():
                parts = line.split()
                if len(parts) >= 2 and parts[0].endswith(".service"):
                    workloads.append(Workload(
                        kind="systemd", id=parts[0], name=parts[0],
                        status=parts[1],
                    ))

        return workloads

    # ------------------------------------------------------------------
    # alpha3 上半: 备份计划预览 (只读)
    #
    # 输入 selected_keys: manifest 中被选中的 BackupItem.key 列表；
    #      None → 使用 default_selected=True 的项。
    # 输出 dict:
    #   items   : [{key, display, kind, paths, exists, count, size_bytes, note}]
    #   summary : {total_items, total_size_bytes, missing, tools:{tar,zstd,gzip}}
    #
    # 全程 stat/find/wc/ls · 绝不写入远端。
    # ------------------------------------------------------------------
    async def plan_backup(self, runner, selected_keys=None):
        manifest = self.collect_config_manifest()
        if selected_keys is None:
            wanted = [it for it in manifest if it.default_selected]
        else:
            sk = set(selected_keys)
            wanted = [it for it in manifest if it.key in sk]

        # 工具可用性 (一次探)
        rc, tools_out, _ = await runner.exec(
            "for t in tar zstd gzip pigz xz sha256sum; do "
            "  if command -v $t >/dev/null 2>&1; then echo \"$t=1\"; else echo \"$t=0\"; fi; "
            "done", timeout=10)
        tools = {}
        for line in (tools_out or "").splitlines():
            if "=" in line:
                k, v = line.strip().split("=", 1)
                tools[k] = (v == "1")

        items_result = []
        total_size = 0
        missing = 0

        for it in wanted:
            item_info = {
                "key": it.key, "display": it.display, "kind": it.kind,
                "paths": [], "exists": False, "count": 0, "size_bytes": 0,
                "note": "",
            }

            if it.kind == "command_output":
                # crontab -l 类型：跑一次 · 只在 rc=0 且 stdout 非空时才算存在
                # (crontab -l 无 cron 时会往 stderr 打印 "no crontab for xxx" 并返回 rc=1)
                cmd = it.path  # e.g. "crontab -l"
                rc, out, _ = await runner.exec(
                    f"{cmd} 2>/dev/null", timeout=10,
                )
                stdout = out or ""
                exists = rc == 0 and stdout.strip() != ""
                size = len(stdout.encode("utf-8", errors="ignore")) if exists else 0
                lines = stdout.count("\n") if exists else 0
                item_info.update({
                    "paths": [cmd], "exists": exists,
                    "count": lines, "size_bytes": size,
                })
                if not exists:
                    item_info["note"] = "命令无输出或不存在"
                    missing += 1
                total_size += size

            else:
                # path / file / dir : 支持分号分隔的多路径
                paths = [p for p in (it.path or "").split(";") if p.strip()]
                item_info["paths"] = paths
                agg_exists = False
                agg_count = 0
                agg_size = 0
                for p in paths:
                    # test -e 然后 du -sb（GNU du -sb 返回字节；stat 兜底）
                    rc, out, _ = await runner.exec(
                        f"if [ -e {_shellq(p)} ]; then "
                        f"  echo EXIST; "
                        f"  du -sb {_shellq(p)} 2>/dev/null | awk '{{print $1}}'; "
                        f"  find {_shellq(p)} -type f 2>/dev/null | wc -l; "
                        f"else echo MISS; fi", timeout=30,
                    )
                    lines = [l.strip() for l in (out or "").splitlines() if l.strip()]
                    if lines and lines[0] == "EXIST":
                        agg_exists = True
                        try:
                            agg_size += int(lines[1]) if len(lines) > 1 else 0
                        except Exception as _e: logging.debug("suppressed", exc_info=True)
                        try:
                            agg_count += int(lines[2]) if len(lines) > 2 else 0
                        except Exception as _e: logging.debug("suppressed", exc_info=True)
                item_info["exists"] = agg_exists
                item_info["count"] = agg_count
                item_info["size_bytes"] = agg_size
                if not agg_exists:
                    item_info["note"] = "未找到"
                    missing += 1
                total_size += agg_size

            items_result.append(item_info)

        return {
            "items": items_result,
            "summary": {
                "total_items": len(items_result),
                "existing_items": len(items_result) - missing,
                "missing_items": missing,
                "total_size_bytes": total_size,
                "tools": tools,
            },
        }

    # ------------------------------------------------------------------
    # alpha4: 真备份 · 远端 tar 走 stdout · 本地文件落盘 · sha256
    #
    # 输入:
    #   runner            · SSHRunner
    #   plan              · plan_backup() 的返回；只打包 exists=True 的项
    #   local_dst         · 本地目标 .tar.gz 完整路径 (dir 会自动创建)
    #   compressor        · "gzip"|"zstd"|"none" · 默认 gzip (兼容性最好)
    #   progress_cb       · async fn(bytes_transferred, elapsed) 可选
    #
    # 输出 dict:
    #   {ok, path, size_bytes, sha256, duration_sec, item_count,
    #    compressor, remote_cmd(sanitized)}
    #
    # 特性:
    #   · 远端不落盘 (tar 直接写 stdout · 本地 pipe 接收)
    #   · command_output 类型 (crontab -l) 单独 dump 到本地 sidecar
    #   · 大小/sha256 边写边算 (不 read 两遍)
    #   · 不改远端任何文件
    # ------------------------------------------------------------------
    async def execute_backup(self, runner, plan, local_dst,
                             compressor="gzip", progress_cb=None, task_id=None):
        import os, hashlib, time, asyncio as _aio

        items = [it for it in plan.get("items", []) if it.get("exists")]
        # 路径类项 (file/dir/path) 要打进 tar
        path_items = [it for it in items if it.get("kind") in ("file", "dir", "path")]
        cmd_items  = [it for it in items if it.get("kind") == "command_output"]

        # 汇总所有 path (可能一个 item 有多路径)
        tar_paths = []
        for it in path_items:
            for p in it.get("paths", []):
                if p and p not in tar_paths:
                    tar_paths.append(p)

        if not tar_paths and not cmd_items:
            return {"ok": False, "error": "无可备份项 (plan 中全部 exists=False)"}

        # 压缩器选择
        comp_flag = {"gzip": "-z", "zstd": "--zstd", "none": ""}.get(compressor, "-z")
        ext = {"gzip": ".tar.gz", "zstd": ".tar.zst", "none": ".tar"}.get(compressor, ".tar.gz")

        # 若 local_dst 未带扩展名，自动补上
        if not (local_dst.endswith(".tar") or local_dst.endswith(".tar.gz")
                or local_dst.endswith(".tar.zst")):
            local_dst = local_dst + ext

        os.makedirs(os.path.dirname(local_dst) or ".", exist_ok=True)

        # 远端 tar 命令: --ignore-failed-read (读不到不 fatal) + -P 保留绝对路径
        # -C / 从根切换，避免 "removing leading /" 警告干扰
        quoted = " ".join(_shellq(p) for p in tar_paths) if tar_paths else _shellq("/dev/null")
        remote_cmd = (
            f"tar -c {comp_flag} -P --ignore-failed-read "
            f"-f - {quoted} 2>/dev/null"
        )

        t0 = time.time()
        sha = hashlib.sha256()
        total = 0
        proc = await runner.stream_bytes(remote_cmd, chunk_size=131072, task_id=task_id)
        try:
            with open(local_dst, "wb") as fout:
                while True:
                    chunk = await proc.stdout.read(131072)
                    if not chunk:
                        break
                    fout.write(chunk)
                    sha.update(chunk)
                    total += len(chunk)
                    if progress_cb:
                        try:
                            await progress_cb(total, time.time() - t0)
                        except Exception as _e: logging.debug("suppressed", exc_info=True)
            await proc.wait()
            rc = proc.returncode
            stderr = (await proc.stderr.read()).decode("utf-8", errors="replace") if proc.stderr else ""
        finally:
            if task_id:
                from backend.ssh_lib.runner import active_tasks
                active_tasks.pop(task_id, None)

        # command_output 类 sidecar (crontab -l 等)
        sidecars = []
        for it in cmd_items:
            cmd = it["paths"][0]
            rc2, out, _ = await runner.exec(cmd, timeout=15)
            if rc2 == 0 and out:
                sidecar_path = local_dst + f".{it['key']}.txt"
                with open(sidecar_path, "w", encoding="utf-8") as f:
                    f.write(out)
                sidecars.append({"key": it["key"], "path": sidecar_path,
                                 "size": os.path.getsize(sidecar_path)})

        duration = time.time() - t0
        if rc != 0 and total == 0:
            # tar 完全失败
            try:
                os.remove(local_dst)
            except OSError as _e: logging.debug("suppressed", exc_info=True)
            return {"ok": False, "error": f"tar 失败 rc={rc}: {stderr[:200]}",
                    "duration_sec": duration}

        return {
            "ok": True,
            "path": local_dst,
            "size_bytes": total,
            "sha256": sha.hexdigest(),
            "duration_sec": round(duration, 2),
            "item_count": len(path_items) + len(cmd_items),
            "path_items": len(path_items),
            "sidecars": sidecars,
            "compressor": compressor,
            "tar_rc": rc,
            "tar_stderr": stderr[:500] if stderr else "",
        }

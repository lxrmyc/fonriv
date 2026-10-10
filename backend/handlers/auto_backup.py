"""Fonriv - 一键备份处理器 (Stage 7: 迁移到 SSHRunner)"""
import logging

import os
import re
import json
import asyncio
import time
import subprocess
import shutil

from backend.ssh_lib import (
    SSHTarget, sanitize_output, active_tasks,
)
from backend.auth import decode_password
from backend.log import log_operation
from backend import db


def _pwd(target) -> str:
    return getattr(target.auth, "password", "") or ""


def _key(target) -> str:
    return getattr(target.auth, "key_path", "") or ""

# ---------------------------------------------------------------------------
# 依赖自动检测与安装
# ---------------------------------------------------------------------------
def check_and_install_deps():
    """启动时自动检测并安装所有依赖，已安装的跳过。"""

    # ---- 1. Python 包依赖 ----
    PIP_DEPS = [
        ("fastapi",      "fastapi"),
        ("uvicorn",      "uvicorn[standard]"),
        ("websockets",   "websockets"),
    ]

    missing_pip = []
    for mod_name, pip_name in PIP_DEPS:
        try:
            __import__(mod_name)
        except ImportError:
            missing_pip.append(pip_name)

    if missing_pip:
        print(f"  [DEPS] 检测到缺少 Python 包: {', '.join(missing_pip)}")
        print(f"  [DEPS] 正在自动安装...")
        try:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet"] + missing_pip,
                timeout=120, check=True
            )
            print(f"  [DEPS] ✓ Python 包安装完成")
        except subprocess.CalledProcessError as e:
            print(f"  [DEPS] ✗ pip 安装失败 (exit {e.returncode})，尝试用户级安装...")
            try:
                subprocess.run(
                    [sys.executable, "-m", "pip", "install", "--quiet", "--user"] + missing_pip,
                    timeout=120, check=True
                )
                print(f"  [DEPS] ✓ Python 包安装完成 (用户级)")
            except Exception as e2:
                print(f"  [DEPS] ✗ 安装失败: {e2}")
                print(f"  [DEPS] 请手动执行: pip install {' '.join(missing_pip)}")
                sys.exit(1)
        except Exception as e:
            print(f"  [DEPS] ✗ 安装异常: {e}")
            sys.exit(1)
    else:
        print("  [DEPS] ✓ Python 包依赖完整")

    # ---- 2. 系统工具依赖 ----
    SYS_TOOLS = [
        ("rsync",   "rsync",   "rsync"),
        ("sshpass", "sshpass", "sshpass"),
        ("ssh",     "openssh-client", "openssh-clients"),
    ]

    missing_sys = []
    for cmd, deb_pkg, rpm_pkg in SYS_TOOLS:
        found = False
        for path_dir in os.environ.get("PATH", "/usr/bin:/usr/local/bin").split(os.pathsep):
            if path_dir and os.path.isfile(os.path.join(path_dir, cmd)):
                found = True
                break
        if not found:
            try:
                subprocess.run([cmd, "--version"], capture_output=True, timeout=5)
                found = True
            except Exception as _e: logging.debug("suppressed", exc_info=True)
        if not found:
            missing_sys.append((cmd, deb_pkg, rpm_pkg))

    if missing_sys:
        print(f"  [DEPS] 检测到缺少系统工具: {', '.join(t[0] for t in missing_sys)}")
        # 检测包管理器
        pkg_manager = None
        install_cmd = None
        if os.path.isfile("/usr/bin/apt-get"):
            pkg_manager = "apt"
            install_cmd = ["apt-get", "install", "-y"] + [t[1] for t in missing_sys]
        elif os.path.isfile("/usr/bin/yum"):
            pkg_manager = "yum"
            install_cmd = ["yum", "install", "-y"] + [t[2] for t in missing_sys]
        elif os.path.isfile("/usr/bin/dnf"):
            pkg_manager = "dnf"
            install_cmd = ["dnf", "install", "-y"] + [t[2] for t in missing_sys]
        elif os.path.isfile("/usr/bin/pacman"):
            pkg_manager = "pacman"
            install_cmd = ["pacman", "-S", "--noconfirm"] + [t[1] for t in missing_sys]

        if install_cmd:
            print(f"  [DEPS] 使用 {pkg_manager} 安装: {' '.join(t[0] for t in missing_sys)}")
            # apt 需要先 update
            if pkg_manager == "apt":
                try:
                    subprocess.run(["apt-get", "update", "-qq"], timeout=60, capture_output=True)
                except Exception as _e: logging.debug("suppressed", exc_info=True)
            try:
                result = subprocess.run(install_cmd, timeout=120, capture_output=True, text=True)
                if result.returncode == 0:
                    print(f"  [DEPS] ✓ 系统工具安装完成")
                else:
                    # 可能需要 sudo
                    if "Permission denied" in result.stderr or "not root" in result.stderr.lower():
                        print(f"  [DEPS] 需要管理员权限，尝试 sudo...")
                        result2 = subprocess.run(
                            ["sudo"] + install_cmd, timeout=120, capture_output=True, text=True
                        )
                        if result2.returncode == 0:
                            print(f"  [DEPS] ✓ 系统工具安装完成 (sudo)")
                        else:
                            print(f"  [DEPS] ✗ sudo 安装也失败: {result2.stderr.strip()[:200]}")
                            print(f"  [DEPS] 请手动执行: sudo {' '.join(install_cmd)}")
                    else:
                        print(f"  [DEPS] ✗ 安装失败: {result.stderr.strip()[:200]}")
                        print(f"  [DEPS] 请手动执行: sudo {' '.join(install_cmd)}")
            except Exception as e:
                print(f"  [DEPS] ✗ 安装异常: {e}")
                print(f"  [DEPS] 请手动安装: {' '.join(t[0] for t in missing_sys)}")
        else:
            print(f"  [DEPS] ✗ 未检测到包管理器 (apt/yum/dnf/pacman)")
            print(f"  [DEPS] 请手动安装: {' '.join(t[0] for t in missing_sys)}")
    else:
        print("  [DEPS] ✓ 系统工具依赖完整 (rsync, sshpass, ssh)")

    # ---- 3. 可选工具提示 ----
    optional = [("lsof", "用于端口占用检测"), ("qemu-img", "用于 VM 磁盘信息查询")]
    for cmd, desc in optional:
        found = False
        for path_dir in os.environ.get("PATH", "/usr/bin:/usr/local/bin").split(os.pathsep):
            if path_dir and os.path.isfile(os.path.join(path_dir, cmd)):
                found = True
                break
        if not found:
            print(f"  [DEPS] ⚠ 可选工具 {cmd} 未安装（{desc}），不影响核心功能")

    # ---- 4. Proxmox Backup Client (PBS 功能需要) ----
    pbs_cmd = "proxmox-backup-client"
    pbs_found = False
    for path_dir in os.environ.get("PATH", "/usr/bin:/usr/local/bin").split(os.pathsep):
        if path_dir and os.path.isfile(os.path.join(path_dir, pbs_cmd)):
            pbs_found = True
            break
    if not pbs_found:
        try:
            subprocess.run([pbs_cmd, "--version"], capture_output=True, timeout=5)
            pbs_found = True
        except Exception as _e: logging.debug("suppressed", exc_info=True)
    if not pbs_found:
        print("  [DEPS] ⚠ proxmox-backup-client 未安装（PBS 功能需要）")
        print("  [DEPS] 自动安装方式（需管理员权限）:")
        print("  [DEPS]   # Ubuntu/Debian:")
        print("  [DEPS]   curl -fsSL https://enterprise.proxmox.com/debian/proxmox-release-bookworm.gpg | sudo tee /etc/apt/trusted.gpg.d/proxmox-release-bookworm.gpg >/dev/null")
        print('  [DEPS]   echo "deb https://enterprise.proxmox.com/debian/pbs bookworm pbs-enterprise" | sudo tee /etc/apt/sources.list.d/pbs-client.list')
        print("  [DEPS]   sudo apt-get update && sudo apt-get install -y proxmox-backup-client")
        print("  [DEPS]  或添加 PBS 测试页面一键安装按钮")


async def handle_auto_backup(ws, data, task_id):
    """一键自动备份 Proxmox 服务器配置 (支持项目选择 + SSH密钥)"""
    from datetime import datetime

    target = SSHTarget.from_ws_data(data)
    host = target.host
    local_dst = data.get("local_dst", "").rstrip("/")
    extra_paths = data.get("extra_paths", "")
    items_selection = data.get("items", None)

    if not host:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少服务器地址"})
        return

    db.task_create(task_id, f"一键备份: {host}", "auto_backup", command=f"backup {host}")

    if not local_dst:
        await ws.send_json({"type": "result", "status": "error", "msg": "请指定本地目标路径"})
        db.task_update(task_id, status='failed')
        return

    await ws.send_json({"type": "log", "level": "info", "msg": f"本地目标路径: {local_dst}"})
    try:
        os.makedirs(local_dst, exist_ok=True)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": f"创建本地目录失败: {e}"})
        db.task_update(task_id, status='failed')
        return

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    temp_dir = f"/tmp/proxmox_backup_{timestamp}"

    # 16 项备份清单（path_groups 保留原来的结构）
    path_groups = [
        (0, "pve", "/etc/pve", True),
        (1, "network", "/etc/network", True),
        (2, "fstab", "/etc/fstab", False),
        (3, "hosts", "/etc/hosts", False),
        (4, "resolv.conf", "/etc/resolv.conf", False),
        (5, "zfs", "/etc/zfs", True),
        (6, "crontab", "/etc/crontab", False),
        (6, "cron.d", "/etc/cron.d", True),
        (6, "cron.daily", "/etc/cron.daily", True),
        (6, "cron.hourly", "/etc/cron.hourly", True),
        (6, "cron.weekly", "/etc/cron.weekly", True),
        (6, "cron.monthly", "/etc/cron.monthly", True),
        (6, "cron.yearly", "/etc/cron.yearly", True),
        (7, "apt-sources", "/etc/apt/sources.list", False),
        (7, "apt-sources-d", "/etc/apt/sources.list.d", True),
        (7, "dpkg", "/var/lib/dpkg/status", False),
        (8, "sysctl", "/etc/sysctl.conf", False),
        (8, "sysctl.d", "/etc/sysctl.d", True),
        (8, "modules", "/etc/modules", False),
        (8, "modules-load", "/etc/modules-load.d", True),
        (8, "modprobe", "/etc/modprobe.d", True),
        (9, "ssh-sshd", "/etc/ssh/sshd_config", False),
        (9, "ssh-sshd-d", "/etc/ssh/sshd_config.d", True),
        (10, "systemd", "/etc/systemd", True),
        (11, "limits", "/etc/security/limits.conf", False),
        (11, "limits.d", "/etc/security/limits.d", True),
        (11, "login.defs", "/etc/login.defs", False),
        (12, "ssh-keys", "/root/.ssh", True),
    ]

    if items_selection and isinstance(items_selection, list):
        used_indices = set(g[0] for g in path_groups)
        selected = set()
        for i, idx in enumerate(used_indices):
            if i < len(items_selection) and items_selection[i]:
                selected.add(idx)
        path_groups = [g for g in path_groups if g[0] in selected]
        await ws.send_json({"type": "log", "level": "info",
                            "msg": f"已选择 {len(selected)} 个项目，共 {len(path_groups)} 个路径"})
    else:
        await ws.send_json({"type": "log", "level": "info",
                            "msg": f"未指定选择项，使用全部 {len(path_groups)} 个路径"})

    if extra_paths:
        for p in extra_paths.split(","):
            p = p.strip()
            if p:
                name = p.strip("/").replace("/", "_")
                path_groups.append((99, f"extra_{name}", p, True))

    total_paths = len(path_groups)
    copied = 0
    failed = 0
    skipped = 0
    archive_name = f"proxmox_config_{host}_{timestamp}.tar.gz"
    archive_path = f"{local_dst}/{archive_name}"

    try:
        async with target.runner() as run:
            # 1. 远端创建临时目录
            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"[1/5] 在远端创建临时目录: {temp_dir}"})
            rc, out, err = await run.exec(f"mkdir -p {temp_dir}", timeout=10)
            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"mkdir 远端临时目录: rc={rc}"})
            if rc != 0:
                await ws.send_json({"type": "result", "status": "error",
                                    "msg": f"创建远端临时目录失败: {out.strip()[:200]} {err.strip()[:200]}"})
                db.task_update(task_id, status='failed')
                return
            await ws.send_json({"type": "progress", "pct": 5, "text": "临时目录已创建"})

            # 2. 收集配置项
            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"[2/5] 收集服务器配置 ({total_paths} 个路径)..."})
            idx = 0
            for item_idx, name, path, is_dir in path_groups:
                idx += 1
                pct = 5 + int((idx / total_paths) * 40)
                try:
                    if is_dir:
                        cmd = (f"mkdir -p {temp_dir}/{name} && "
                               f"(cp -r {path}/* {temp_dir}/{name}/ 2>/dev/null || "
                               f"cp -a {path}/ {temp_dir}/{name}/ 2>/dev/null) ; true")
                    else:
                        cmd = f"mkdir -p {temp_dir}/{name} && cp {path} {temp_dir}/{name}/ 2>/dev/null || true"
                    await run.exec(cmd, timeout=15)
                    # 检查源文件是否存在
                    exists_line = await run.exec_last_line(
                        f"test -e {path} && echo EXISTS || echo NOTFOUND", timeout=5
                    )
                    if exists_line == "EXISTS":
                        rc3, out3, _ = await run.exec(
                            f"find {temp_dir}/{name} -mindepth 1 | head -1", timeout=5,
                        )
                        if out3.strip():
                            await ws.send_json({"type": "log", "level": "info",
                                                "msg": f"  ✓ {name}: {path}"})
                            copied += 1
                        else:
                            await ws.send_json({"type": "log", "level": "warn",
                                                "msg": f"  ⚠ {name}: {path} (拷贝失败)"})
                            failed += 1
                    else:
                        await ws.send_json({"type": "log", "level": "info",
                                            "msg": f"  - {name}: {path} (不存在，跳过)"})
                        skipped += 1
                except Exception as e:
                    await ws.send_json({"type": "log", "level": "warn",
                                        "msg": f"  ✗ {name}: {path} (异常: {str(e)[:80]})"})
                    failed += 1
                await ws.send_json({"type": "progress", "pct": pct,
                                    "text": f"收集中 {idx}/{total_paths} ({copied} 成功)"})

            # ZFS 状态 (item 13)
            item_13 = True
            if items_selection and 13 < len(items_selection):
                item_13 = items_selection[13]
            if item_13:
                await ws.send_json({"type": "log", "level": "info", "msg": "  收集 ZFS 状态..."})
                try:
                    await run.exec(
                        f"mkdir -p {temp_dir}/zfs_status && "
                        f"zpool status > {temp_dir}/zfs_status/zpool_status.txt 2>&1; "
                        f"zfs list > {temp_dir}/zfs_status/zfs_list.txt 2>&1; "
                        f"zpool get all > {temp_dir}/zfs_status/zpool_get_all.txt 2>&1; true",
                        timeout=15,
                    )
                    copied += 1
                    await ws.send_json({"type": "log", "level": "info", "msg": "  ✓ ZFS 状态已收集"})
                except Exception as e:
                    await ws.send_json({"type": "log", "level": "warn",
                                        "msg": f"  ✗ ZFS 状态: {str(e)[:80]}"})

            # 网络状态 (item 14)
            item_14 = True
            if items_selection and 14 < len(items_selection):
                item_14 = items_selection[14]
            if item_14:
                await ws.send_json({"type": "log", "level": "info", "msg": "  收集网络状态..."})
                try:
                    await run.exec(
                        f"mkdir -p {temp_dir}/network_status && "
                        f"ip addr > {temp_dir}/network_status/ip_addr.txt 2>&1; "
                        f"ip route > {temp_dir}/network_status/ip_route.txt 2>&1; true",
                        timeout=10,
                    )
                    copied += 1
                    await ws.send_json({"type": "log", "level": "info", "msg": "  ✓ 网络状态已收集"})
                except Exception as e:
                    await ws.send_json({"type": "log", "level": "warn",
                                        "msg": f"  ✗ 网络状态: {str(e)[:80]}"})

            # 系统信息 (item 15)
            item_15 = True
            if items_selection and 15 < len(items_selection):
                item_15 = items_selection[15]
            if item_15:
                await ws.send_json({"type": "log", "level": "info", "msg": "  收集系统信息..."})
                try:
                    await run.exec(
                        f"mkdir -p {temp_dir}/system_info && "
                        f"uname -a > {temp_dir}/system_info/uname.txt 2>&1; "
                        f"df -h > {temp_dir}/system_info/disk_usage.txt 2>&1; "
                        f"free -m > {temp_dir}/system_info/mem_info.txt 2>&1; "
                        f"cat /etc/os-release > {temp_dir}/system_info/os_release.txt 2>&1; true",
                        timeout=10,
                    )
                    copied += 1
                    await ws.send_json({"type": "log", "level": "info", "msg": "  ✓ 系统信息已收集"})
                except Exception as e:
                    await ws.send_json({"type": "log", "level": "warn",
                                        "msg": f"  ✗ 系统信息: {str(e)[:80]}"})

            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"✓ 共收集 {copied} 个配置项 (失败:{failed} 跳过:{skipped})"})
            await ws.send_json({"type": "progress", "pct": 50,
                                "text": f"收集完成 ({copied} 个配置项)"})

            # 3. 打包并流式下载
            await ws.send_json({"type": "log", "level": "info",
                                "msg": "[3/5] 打包并传输到本地..."})
            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"归档路径: {archive_path}"})
            cmd_str = f"cd {temp_dir} && tar czf - ."
            await ws.send_json({"type": "log", "level": "info", "msg": f"打包命令: {cmd_str}"})

            # 用 build_ssh_argv 拿到原始 argv+env，走二进制流写盘（agent 由 runner 管理）
            argv, env = run.build_ssh_argv(cmd_str)
            proc = await asyncio.create_subprocess_exec(
                *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
            )
            total_bytes = 0
            stderr_buf = b""
            with open(archive_path, "wb") as f:
                while True:
                    chunk = await proc.stdout.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
                    total_bytes += len(chunk)
                    try:
                        stderr_ready = await asyncio.wait_for(
                            proc.stderr.read(8192), timeout=0.1
                        )
                        stderr_buf += stderr_ready
                    except (asyncio.TimeoutError, Exception) as _e: logging.debug("suppressed", exc_info=True)
                    pct = 50 + min(30, int(total_bytes / 1024 / 1024 * 5))
                    await ws.send_json({"type": "progress", "pct": pct,
                                        "text": f"传输中... {total_bytes/1024:.0f}KB"})
            stderr_out = await proc.stderr.read()
            if stderr_out:
                stderr_buf += stderr_out
            await proc.wait()
            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"打包输出: {total_bytes} bytes"})

            if total_bytes == 0:
                err_text = stderr_buf.decode("utf-8", errors="replace").strip()
                await ws.send_json({"type": "log", "level": "error",
                                    "msg": f"✗ SSH tar 返回 0 字节 (rc={proc.returncode})"})
                if err_text:
                    for ln in err_text.splitlines()[-10:]:
                        await ws.send_json({"type": "log", "level": "error",
                                            "msg": f"  stderr: {ln}"})
                await run.exec(f"rm -rf {temp_dir}", timeout=10)
                try:
                    os.remove(archive_path)
                except Exception as _e: logging.debug("suppressed", exc_info=True)
                await ws.send_json({"type": "result", "status": "error",
                                    "msg": "打包传输失败: 未收到任何数据 (查看 stderr)"})
                db.task_update(task_id, status='failed')
                return

            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"✓ 打包完成: {archive_name}"})

            # 计算文件大小
            size_str = "0 KB"
            try:
                size = os.path.getsize(archive_path)
                if size > 1024 * 1024:
                    size_str = f"{size / 1024 / 1024:.2f} MB"
                else:
                    size_str = f"{size / 1024:.1f} KB"
                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"  文件大小: {size_str}"})
            except Exception as e:
                await ws.send_json({"type": "log", "level": "warn",
                                    "msg": f"  文件大小计算失败: {e}"})
            await ws.send_json({"type": "progress", "pct": 80,
                                "text": f"打包完成 ({size_str})"})

            # 4. 清理远端临时目录
            await ws.send_json({"type": "log", "level": "info",
                                "msg": "[4/5] 清理远端临时目录..."})
            await run.exec(f"rm -rf {temp_dir}", timeout=10)
            await ws.send_json({"type": "log", "level": "info", "msg": "✓ 远端临时目录已清理"})
            await ws.send_json({"type": "progress", "pct": 95, "text": "清理完成"})

            # 5. 完成
            await ws.send_json({"type": "log", "level": "info", "msg": "[5/5] 备份完成!"})
            await ws.send_json({"type": "progress", "pct": 100, "text": "备份完成!"})
            await ws.send_json({
                "type": "result", "status": "ok",
                "msg": f"备份完成: {archive_name} ({size_str})",
                "archive": archive_name,
                "archive_path": archive_path,
                "local_dst": local_dst,
                "items_copied": copied,
                "host": host,
                "timestamp": timestamp,
            })
            db.task_update(task_id, status='completed')
            log_operation("auto_backup", f"Proxmox 配置备份: {host}",
                          f"文件: {archive_path}, 配置项: {copied}")
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "log", "level": "error", "msg": f"✗ 备份异常: {safe}"})
        await ws.send_json({"type": "result", "status": "error", "msg": f"备份异常: {safe}"})
        db.task_update(task_id, status='failed')


# ---------------------------------------------------------------------------
# 多节点批量备份 (v4.38.0)
# ---------------------------------------------------------------------------
async def handle_batch_backup(ws, data, task_id):
    """批量备份多个服务器配置：接收 config_ids 列表，逐个执行 auto_backup"""
    import uuid

    config_ids = data.get("config_ids", [])
    local_dst = data.get("local_dst", "").rstrip("/")
    items_selection = data.get("items", None)

    if not config_ids or not isinstance(config_ids, list):
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 config_ids 列表"})
        return
    if not local_dst:
        await ws.send_json({"type": "result", "status": "error", "msg": "请指定本地目标路径"})
        return

    # v5.35.0 · G2 零遗留: config_ids → server_profiles 档案标识 (guid/主机名)
    configs = []
    from backend.db.crypto import decrypt_value as _dv
    from backend.db import _get_fernet as _gf
    conn = db.get_conn()
    for cid in config_ids:
        row = conn.execute(
            "SELECT * FROM server_profiles WHERE guid=? OR hostname=? LIMIT 1",
            (str(cid), str(cid))).fetchone()
        if not row:
            await ws.send_json({"type": "log", "level": "warn",
                                "msg": f"服务器 {cid} 不存在，已跳过"})
            continue
        d = dict(row)
        av = d.get("ssh_auth_value") or ""
        if av and str(av).startswith("ENC$"):
            try:
                av = _dv(_gf(), av)
            except Exception:
                pass
        configs.append({"name": d.get("name"), "host": d.get("hostname"),
                        "port": str(d.get("ssh_port") or 22),
                        "user": d.get("ssh_user") or "root",
                        "auth_type": d.get("ssh_auth_type") or "pass",
                        "auth_value": av, "auth_passphrase": ""})

    if not configs:
        await ws.send_json({"type": "result", "status": "error", "msg": "无有效配置"})
        return

    total = len(configs)
    db.task_create(task_id, f"批量备份: {total} 个节点", "batch_backup",
                   command=f"batch {total} nodes")

    await ws.send_json({"type": "batch_start", "total": total,
                        "nodes": [c.get("name") or c.get("host") or "?" for c in configs]})

    success_count = 0
    fail_count = 0

    for idx, cfg in enumerate(configs):
        # v5.35.0 · G2: 档案字段 (上游已换轨为 hostname/port/user/auth_value)
        node_name = cfg.get("name") or cfg.get("host") or f"node-{idx}"
        host = cfg.get("host") or cfg.get("ab_host") or ""
        sub_task_id = f"{task_id}_{idx}"

        await ws.send_json({
            "type": "batch_progress",
            "current": idx + 1,
            "total": total,
            "node": node_name,
            "host": host,
            "status": "running",
        })

        if not host:
            await ws.send_json({"type": "log", "level": "warn",
                                "msg": f"[{idx+1}/{total}] {node_name}: 无 ab_host，跳过"})
            fail_count += 1
            continue

        sub_data = {
            "host": host,
            "port": cfg.get("port") or cfg.get("ab_port") or "22",
            "user": cfg.get("user") or cfg.get("ab_user") or "root",
            "auth_type": cfg.get("auth_type") or cfg.get("ab_auth_type") or "pass",
            "auth_value": cfg.get("auth_value") or cfg.get("ab_auth_value") or "",
            "auth_passphrase": cfg.get("auth_passphrase") or cfg.get("ab_auth_passphrase") or "",
            "local_dst": local_dst,
            "items": items_selection,
        }

        try:
            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"[{idx+1}/{total}] 开始备份 {node_name} ({host})"})
            await handle_auto_backup(ws, sub_data, sub_task_id)
            success_count += 1
            await ws.send_json({"type": "log", "level": "success",
                                "msg": f"[{idx+1}/{total}] ✓ {node_name} 备份完成"})
        except Exception as e:
            fail_count += 1
            await ws.send_json({"type": "log", "level": "error",
                                "msg": f"[{idx+1}/{total}] ✗ {node_name} 备份失败: {e}"})

        await ws.send_json({
            "type": "batch_progress",
            "current": idx + 1,
            "total": total,
            "node": node_name,
            "host": host,
            "status": "done",
            "success": fail_count == 0 or True,
        })

    await ws.send_json({
        "type": "batch_done",
        "total": total,
        "success": success_count,
        "failed": fail_count,
    })
    await ws.send_json({"type": "result", "status": "ok",
                        "msg": f"批量备份完成: {success_count}/{total} 成功, {fail_count} 失败"})
    db.task_update(task_id, status='completed')
    log_operation("batch_backup", f"批量备份 {total} 个节点",
                  f"成功 {success_count}, 失败 {fail_count}")


# ---------------------------------------------------------------------------
# 一键恢复：检测服务器状态
# ---------------------------------------------------------------------------

# ---- Re-export restore handlers (backward compatibility) ----
from backend.handlers.auto_restore import (
    handle_auto_restore_detect,
    handle_auto_restore_compare,
    handle_auto_restore,
    handle_auto_restore_browse,
    handle_auto_restore_item,
)

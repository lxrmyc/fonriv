"""Fonriv - 自动恢复处理器 (从 auto_backup.py 拆分)"""
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
from backend.handlers.auto_backup import _pwd, _key

async def handle_auto_restore_detect(ws, data, task_id):
    """检测 Proxmox 服务器状态，返回系统信息和 VM/LXC 列表"""
    target = SSHTarget.from_ws_data(data)
    host = target.host

    if not host:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少服务器地址"})
        return

    await ws.send_json({"type": "log", "level": "info", "msg": f"正在检测服务器 {host} ..."})
    await ws.send_json({"type": "progress", "pct": 10, "text": "连接服务器..."})

    try:
      async with target.runner() as run:
        # 1. 系统信息
        await ws.send_json({"type": "log", "level": "info", "msg": "  收集系统信息..."})
        rc, out, err = await run.exec(
            "cat /etc/os-release 2>/dev/null; echo '---SEPARATOR---'; uname -r; echo '---SEPARATOR---'; hostname",
        )
        if err and err.strip():
            await ws.send_json({"type": "log", "level": "warn",
                                "msg": f"  [WARN] system info stderr: {err.strip()[:100]}"})
        os_info = kernel = hostname = ""
        if rc == 0:
            parts = out.split("---SEPARATOR---")
            os_info = parts[0].strip() if len(parts) > 0 else ""
            kernel = parts[1].strip() if len(parts) > 1 else ""
            hostname = parts[2].strip() if len(parts) > 2 else ""

        # 2. PVE 版本
        await ws.send_json({"type": "log", "level": "info", "msg": "  检测 PVE 版本..."})
        _, out, _ = await run.exec("pveversion 2>/dev/null || echo NOT_PVE")
        pve_version = out.strip()
        await ws.send_json({"type": "log", "level": "info",
                            "msg": f"  PVE version output: {pve_version[:80]}"})
        is_pve = not pve_version.startswith("NOT_PVE")

        # 3. VM 列表
        await ws.send_json({"type": "log", "level": "info", "msg": "  检测虚拟机列表..."})
        rc, out, _ = await run.exec("qm list 2>/dev/null || echo NO_QM")
        vms = []
        if rc == 0 and not out.strip().startswith("NO_QM"):
            for line in out.strip().split("\n")[1:]:
                parts = line.split()
                if len(parts) >= 4:
                    vms.append({"vmid": parts[0], "name": parts[1] if len(parts) > 1 else "",
                                "status": parts[2] if len(parts) > 2 else "",
                                "mem": parts[3] if len(parts) > 3 else ""})
        await ws.send_json({"type": "log", "level": "info",
                            "msg": f"  VMs found: {len(vms)} (rc={rc})"})

        # 4. LXC 容器列表
        await ws.send_json({"type": "log", "level": "info", "msg": "  检测 LXC 容器列表..."})
        rc, out, _ = await run.exec("pct list 2>/dev/null || echo NO_PCT")
        lxcs = []
        if rc == 0 and not out.strip().startswith("NO_PCT"):
            for line in out.strip().split("\n")[1:]:
                parts = line.split()
                if len(parts) >= 3:
                    lxcs.append({"vmid": parts[0], "name": parts[1] if len(parts) > 1 else "",
                                 "status": parts[2] if len(parts) > 2 else ""})
        await ws.send_json({"type": "log", "level": "info",
                            "msg": f"  LXC found: {len(lxcs)} (rc={rc})"})

        # 5. 存储列表
        await ws.send_json({"type": "log", "level": "info", "msg": "  检测存储列表..."})
        rc, out, _ = await run.exec("pvesm status 2>/dev/null || echo NO_STORAGE")
        storages = []
        if rc == 0 and not out.strip().startswith("NO_STORAGE"):
            for line in out.strip().split("\n")[1:]:
                parts = line.split()
                if len(parts) >= 4:
                    storages.append({"name": parts[0], "type": parts[1], "status": parts[2],
                                     "total": parts[3] if len(parts) > 3 else "",
                                     "used": parts[4] if len(parts) > 4 else ""})
        await ws.send_json({"type": "log", "level": "info",
                            "msg": f"  Storages found: {len(storages)} (rc={rc})"})

        # 6. 网络接口
        await ws.send_json({"type": "log", "level": "info", "msg": "  检测网络配置..."})
        rc, out, _ = await run.exec("cat /etc/network/interfaces 2>/dev/null")
        network_config = out.strip()
        await ws.send_json({"type": "log", "level": "info",
                            "msg": f"  Network config: {len(network_config)} bytes (rc={rc})"})

        # 7. 集群状态
        await ws.send_json({"type": "log", "level": "info", "msg": "  检测集群状态..."})
        _, out, _ = await run.exec("pvecm status 2>/dev/null || echo NO_CLUSTER")
        cluster_info = out.strip() if not out.strip().startswith("NO_CLUSTER") else ""

        # 8. 判断是否新安装
        rc, out, _ = await run.exec(
            "ls /etc/pve/qemu-server/ 2>/dev/null | wc -l; echo '---'; ls /etc/pve/lxc/ 2>/dev/null | wc -l",
        )
        vm_count = lxc_count = 0
        if rc == 0:
            parts = out.strip().split("---")
            try:
                vm_count = int(parts[0].strip())
                lxc_count = int(parts[1].strip())
            except Exception as _e: logging.debug("suppressed", exc_info=True)
        is_new_install = (vm_count == 0 and lxc_count == 0
                          and len(vms) == 0 and len(lxcs) == 0)
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "result", "status": "error", "msg": safe})
        return

    await ws.send_json({"type": "progress", "pct": 100, "text": "检测完成"})
    await ws.send_json({
        "type": "result", "status": "ok",
        "msg": f"检测完成: {hostname} ({pve_version})",
        "os_info": os_info, "kernel": kernel, "hostname": hostname,
        "pve_version": pve_version, "is_pve": is_pve,
        "is_new_install": is_new_install,
        "vms": vms, "lxcs": lxcs, "storages": storages,
        "network_config": network_config, "cluster_info": cluster_info,
        "vm_count": vm_count, "lxc_count": lxc_count, "host": host,
    })
    await ws.send_json({"type": "log", "level": "info",
                        "msg": f"✓ 检测完成: PVE={is_pve}, VM={len(vms)}, LXC={len(lxcs)}, 新安装={is_new_install}"})


# ---------------------------------------------------------------------------
# 一键恢复：对比备份与当前配置
# ---------------------------------------------------------------------------
async def handle_auto_restore_compare(ws, data, task_id):
    """对比本地备份文件与服务器当前配置，返回差异列表"""
    import tarfile
    import tempfile

    target = SSHTarget.from_ws_data(data)
    host = target.host
    archive_path = data.get("archive_path", "")

    if not host:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少服务器地址"})
        return
    if not archive_path or not os.path.isfile(archive_path):
        await ws.send_json({"type": "result", "status": "error",
                            "msg": "备份文件不存在: " + str(archive_path)})
        return

    await ws.send_json({"type": "log", "level": "info", "msg": "正在对比备份配置..."})
    await ws.send_json({"type": "progress", "pct": 10, "text": "解压备份文件..."})

    # 1. 解压
    tmp_dir = tempfile.mkdtemp(prefix="proxmox_restore_")
    try:
        with tarfile.open(archive_path, "r:gz") as tf:
            tf.extractall(tmp_dir, filter=tarfile.fully_trusted_filter)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": f"解压失败: {e}"})
        return

    await ws.send_json({"type": "progress", "pct": 30, "text": "扫描备份内容..."})

    # 2. 扫描
    backup_files = {}
    for root, dirs, files in os.walk(tmp_dir):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), tmp_dir)
            backup_files[rel] = os.path.join(root, f)
    await ws.send_json({"type": "log", "level": "info",
                        "msg": f"  备份包含 {len(backup_files)} 个文件"})

    # 3. 恢复映射
    restore_map = {
        "pve": "/etc/pve", "network": "/etc/network",
        "network-d": "/etc/network/interfaces.d", "NetworkManager": "/etc/NetworkManager",
        "fstab": "/etc/fstab", "hosts": "/etc/hosts", "resolv.conf": "/etc/resolv.conf",
        "zfs": "/etc/zfs", "crontab": "/etc/crontab",
        "cron.d": "/etc/cron.d", "cron.daily": "/etc/cron.daily",
        "cron.hourly": "/etc/cron.hourly", "cron.weekly": "/etc/cron.weekly",
        "cron.monthly": "/etc/cron.monthly", "cron.yearly": "/etc/cron.yearly",
        "apt": "/etc/apt/sources.list", "apt-sources": "/etc/apt/sources.list.d",
        "sysctl": "/etc/sysctl.conf", "sysctl.d": "/etc/sysctl.d",
        "modules": "/etc/modules", "modules-load": "/etc/modules-load.d",
        "modprobe": "/etc/modprobe.d", "ssh-sshd": "/etc/ssh/sshd_config",
        "ssh-sshd-d": "/etc/ssh/sshd_config.d", "systemd": "/etc/systemd",
        "limits": "/etc/security/limits.conf", "limits.d": "/etc/security/limits.d",
        "login.defs": "/etc/login.defs", "corosync": "/etc/corosync",
        "pbs-client": "/etc/pbs", "pbs-conf": "/etc/pbs.conf",
        "iscsi": "/etc/iscsi", "drbd": "/etc/drbd.d", "chrony": "/etc/chrony",
        "timesyncd": "/etc/systemd/timesyncd.conf",
        "dhcp": "/etc/dhcp/dhclient.conf", "proftpd": "/etc/proftpd",
        "haproxy": "/etc/haproxy", "nginx": "/etc/nginx",
    }

    # 每个配置项的"已知动态文件"白名单：这些文件由 PVE / systemd 运行时管理，
    # 内容会随集群状态、时间戳、随机 token 变化，永远会报差异。跳过它们。
    # 匹配相对于配置目录的路径（大小写敏感），支持前缀匹配 (以 '/' 结尾) 和精确匹配。
    DYNAMIC_FILES = {
        "pve": {
            ".version", ".vmlist", ".clusterlog", ".rrd", ".members",
            "authkey.pub", "authkey.pub.old", "authkey.key",
            "priv/authkey.key", "priv/authorized_keys",
            "priv/pve-root-ca.key", "priv/pve-root-ca.srl",
            "pve-www.key", "pve-root-ca.pem",
            "priv/lock/", "ha/", "sdn/",  # 前缀匹配
        },
        "systemd": {
            # timers/units 里的 .wants 符号链接、生成的 override 目录内容
            "system/timers.target.wants/", "user/timers.target.wants/",
            "system/multi-user.target.wants/", "system/sockets.target.wants/",
            "network/", "resolved.conf.d/",
        },
        "cron.hourly": {"0anacron"},   # anacron 时间戳
        "cron.monthly": {"0anacron"},
        "cron.yearly": {"0anacron"},
        "cron.daily": {"0anacron"},
        "apt-sources": {  # 由 apt update / add-apt-repository 动态生成
            "pve-enterprise.list", "ceph.list",  # PVE 安装后自动加
        },
    }

    def _is_dynamic(config_name: str, rel_path: str) -> bool:
        """判断某文件是否属于该配置项的动态白名单。"""
        rules = DYNAMIC_FILES.get(config_name, set())
        rel = rel_path.replace("\\", "/")
        for rule in rules:
            if rule.endswith("/"):
                if rel == rule.rstrip("/") or rel.startswith(rule):
                    return True
            else:
                if rel == rule:
                    return True
        return False

    diff_items = []
    vm_diffs = []
    lxc_diffs = []

    try:
      async with target.runner() as run:
        # 4. 对比配置项
        await ws.send_json({"type": "log", "level": "info", "msg": "  对比配置差异..."})
        idx = 0
        total = len(restore_map)

        for backup_name, server_path in restore_map.items():
            idx += 1
            pct = 30 + int((idx / total) * 50)
            backup_dir = os.path.join(tmp_dir, backup_name)
            if not os.path.exists(backup_dir):
                continue

            # 服务器路径存在性（用 exec_last_line 避免 SSH warning 干扰）
            exists_line = await run.exec_last_line(
                f"test -e {server_path} && echo EXISTS || echo NOTFOUND"
            )
            server_exists = exists_line == "EXISTS"

            # 备份内容检查
            backup_has_content = False
            if os.path.isdir(backup_dir):
                backup_has_content = bool(os.listdir(backup_dir))
            elif os.path.isfile(backup_dir):
                backup_has_content = os.path.getsize(backup_dir) > 0
            if not backup_has_content:
                continue

            if not server_exists:
                diff_items.append({
                    "name": backup_name, "server_path": server_path,
                    "diff_type": "new",
                    "description": "服务器不存在，备份中有此配置",
                    "can_restore": True,
                })
                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"  🆕 {backup_name}: 服务器不存在"})
                continue

            # 检查服务器路径的类型：文件还是目录（决定后续对比策略）
            server_type = await run.exec_last_line(
                f"if [ -f {server_path} ]; then echo FILE; "
                f"elif [ -d {server_path} ]; then echo DIR; "
                f"else echo OTHER; fi"
            )

            # 特殊：备份脚本对"单文件"也套了一层同名子目录（backup 的 cp 行为），
            # 如 /etc/fstab → {tmp_dir}/fstab/fstab。此时 backup_dir 是目录但只装了
            # 一个文件，服务器端 server_path 是文件。→ 提取内层文件对比。
            if os.path.isdir(backup_dir) and server_type == "FILE":
                inner_files = [x for x in os.listdir(backup_dir)
                               if os.path.isfile(os.path.join(backup_dir, x))]
                if len(inner_files) == 1:
                    inner_path = os.path.join(backup_dir, inner_files[0])
                    try:
                        with open(inner_path, "r", errors="replace") as fh:
                            backup_content = fh.read()
                        _, out2, _ = await run.exec(
                            f"cat {server_path} 2>/dev/null || echo __NOFILE__",
                            merge_stderr=True,
                        )
                        if out2.strip() == "__NOFILE__":
                            diff_items.append({"name": backup_name,
                                               "server_path": server_path,
                                               "diff_type": "new",
                                               "description": "服务器不存在",
                                               "can_restore": True})
                        elif out2.strip() != backup_content.strip():
                            diff_items.append({"name": backup_name,
                                               "server_path": server_path,
                                               "diff_type": "changed",
                                               "description": "内容有差异",
                                               "can_restore": True})
                        else:
                            diff_items.append({"name": backup_name,
                                               "server_path": server_path,
                                               "diff_type": "same",
                                               "description": "无差异",
                                               "can_restore": False})
                    except Exception as _e: logging.debug("suppressed", exc_info=True)
                    await ws.send_json({"type": "progress", "pct": pct,
                                        "text": f"对比中 {idx}/{total}"})
                    continue

            if os.path.isdir(backup_dir):
                backup_file_list = []
                for r, dirs, files in os.walk(backup_dir):
                    for f in files:
                        rel = os.path.relpath(os.path.join(r, f), backup_dir)
                        # 过滤已知动态文件（白名单）
                        if _is_dynamic(backup_name, rel):
                            continue
                        backup_file_list.append(rel)

                changed_files = []
                for bf in backup_file_list:
                    local_file = os.path.join(backup_dir, bf)
                    if not os.path.isfile(local_file):
                        continue
                    try:
                        with open(local_file, "r", errors="replace") as fh:
                            backup_content = fh.read()
                        _, out2, _ = await run.exec(
                            f"cat {server_path}/{bf} 2>/dev/null || echo __NOFILE__",
                            merge_stderr=True,
                        )
                        if out2.strip() == "__NOFILE__":
                            changed_files.append(bf + " (新增)")
                        elif out2.strip() != backup_content.strip():
                            changed_files.append(bf + " (已变更)")
                    except Exception as _e: logging.debug("suppressed", exc_info=True)
                if changed_files:
                    diff_items.append({
                        "name": backup_name, "server_path": server_path,
                        "diff_type": "changed",
                        "description": f"{len(changed_files)} 个文件有差异",
                        "changed_files": changed_files,
                        "can_restore": True,
                    })
                    await ws.send_json({"type": "log", "level": "info",
                                        "msg": f"  📝 {backup_name}: {len(changed_files)} 个文件有差异"})
                    # 打出具体文件名，方便加白名单
                    for cf in changed_files[:20]:
                        await ws.send_json({"type": "log", "level": "dim",
                                            "msg": f"      · {cf}"})
                    if len(changed_files) > 20:
                        await ws.send_json({"type": "log", "level": "dim",
                                            "msg": f"      · ... 及另外 {len(changed_files) - 20} 个"})
                else:
                    diff_items.append({
                        "name": backup_name, "server_path": server_path,
                        "diff_type": "same", "description": "无差异",
                        "can_restore": False,
                    })
            else:
                # 单文件
                try:
                    with open(backup_dir, "r", errors="replace") as fh:
                        backup_content = fh.read()
                    _, out2, _ = await run.exec(
                        f"cat {server_path} 2>/dev/null || echo __NOFILE__",
                        merge_stderr=True,
                    )
                    if out2.strip() == "__NOFILE__":
                        diff_items.append({"name": backup_name, "server_path": server_path,
                                           "diff_type": "new", "description": "服务器不存在",
                                           "can_restore": True})
                    elif out2.strip() != backup_content.strip():
                        diff_items.append({"name": backup_name, "server_path": server_path,
                                           "diff_type": "changed", "description": "内容有差异",
                                           "can_restore": True})
                    else:
                        diff_items.append({"name": backup_name, "server_path": server_path,
                                           "diff_type": "same", "description": "无差异",
                                           "can_restore": False})
                except Exception as _e: logging.debug("suppressed", exc_info=True)
            await ws.send_json({"type": "progress", "pct": pct,
                                "text": f"对比中 {idx}/{total}"})

        # 5. VM/LXC 配置差异
        await ws.send_json({"type": "log", "level": "info", "msg": "  检查 VM/LXC 配置差异..."})
        pve_qemu_dir = os.path.join(tmp_dir, "pve", "qemu-server")
        pve_lxc_dir = os.path.join(tmp_dir, "pve", "lxc")

        if os.path.isdir(pve_qemu_dir):
            for f in os.listdir(pve_qemu_dir):
                if f.endswith(".conf"):
                    vmid = f.replace(".conf", "")
                    local_file = os.path.join(pve_qemu_dir, f)
                    try:
                        with open(local_file, "r", errors="replace") as fh:
                            backup_content = fh.read()
                        _, out2, _ = await run.exec(
                            f"cat /etc/pve/qemu-server/{f} 2>/dev/null || echo __NOFILE__",
                            merge_stderr=True,
                        )
                        if out2.strip() == "__NOFILE__":
                            vm_diffs.append({"vmid": vmid, "type": "qemu",
                                             "diff_type": "new",
                                             "description": "服务器不存在此 VM 配置"})
                        elif out2.strip() != backup_content.strip():
                            vm_diffs.append({"vmid": vmid, "type": "qemu",
                                             "diff_type": "changed",
                                             "description": "VM 配置有差异"})
                    except Exception as _e: logging.debug("suppressed", exc_info=True)
        if os.path.isdir(pve_lxc_dir):
            for f in os.listdir(pve_lxc_dir):
                if f.endswith(".conf"):
                    vmid = f.replace(".conf", "")
                    local_file = os.path.join(pve_lxc_dir, f)
                    try:
                        with open(local_file, "r", errors="replace") as fh:
                            backup_content = fh.read()
                        _, out2, _ = await run.exec(
                            f"cat /etc/pve/lxc/{f} 2>/dev/null || echo __NOFILE__",
                            merge_stderr=True,
                        )
                        if out2.strip() == "__NOFILE__":
                            lxc_diffs.append({"vmid": vmid, "type": "lxc",
                                              "diff_type": "new",
                                              "description": "服务器不存在此 LXC 配置"})
                        elif out2.strip() != backup_content.strip():
                            lxc_diffs.append({"vmid": vmid, "type": "lxc",
                                              "diff_type": "changed",
                                              "description": "LXC 配置有差异"})
                    except Exception as _e: logging.debug("suppressed", exc_info=True)
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "result", "status": "error", "msg": safe})
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return

    shutil.rmtree(tmp_dir, ignore_errors=True)
    await ws.send_json({"type": "progress", "pct": 100, "text": "对比完成"})
    await ws.send_json({
        "type": "result", "status": "ok",
        "msg": f"对比完成: {len(diff_items)} 个配置项, {len(vm_diffs)} 个 VM, {len(lxc_diffs)} 个 LXC",
        "diff_items": diff_items, "vm_diffs": vm_diffs, "lxc_diffs": lxc_diffs,
        "archive_path": archive_path, "host": host,
    })
    await ws.send_json({"type": "log", "level": "info",
                        "msg": f"✓ 对比完成: {len([d for d in diff_items if d['diff_type'] != 'same'])} 个有差异"})


# ---------------------------------------------------------------------------
# 一键恢复：执行恢复
# ---------------------------------------------------------------------------
async def handle_auto_restore(ws, data, task_id):
    """执行配置恢复到 Proxmox 服务器"""
    import tarfile
    import tempfile

    target = SSHTarget.from_ws_data(data)
    host = target.host
    archive_path = data.get("archive_path", "")
    restore_items = data.get("restore_items", [])
    restore_vms = data.get("restore_vms", [])
    restore_lxcs = data.get("restore_lxcs", [])
    restore_all = data.get("restore_all", False)

    if not host:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少服务器地址"})
        return
    if not archive_path or not os.path.isfile(archive_path):
        await ws.send_json({"type": "result", "status": "error", "msg": "备份文件不存在"})
        return

    db.task_create(task_id, f"一键恢复: {host}", "auto_restore", command=f"restore {host}")
    await ws.send_json({"type": "log", "level": "info", "msg": f"恢复请求: host={host}"})
    await ws.send_json({"type": "log", "level": "info", "msg": f"开始恢复配置到 {host} ..."})
    await ws.send_json({"type": "progress", "pct": 5, "text": "准备恢复..."})

    # 1. 解压备份
    tmp_dir = tempfile.mkdtemp(prefix="proxmox_restore_")
    try:
        with tarfile.open(archive_path, "r:gz") as tf:
            tf.extractall(tmp_dir, filter=tarfile.fully_trusted_filter)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": f"解压失败: {e}"})
        db.task_update(task_id, status='failed')
        return
    await ws.send_json({"type": "log", "level": "info", "msg": "✓ 备份文件已解压"})

    # 恢复映射
    restore_map = {
        "pve": "/etc/pve", "network": "/etc/network",
        "network-d": "/etc/network/interfaces.d", "NetworkManager": "/etc/NetworkManager",
        "fstab": "/etc/fstab", "hosts": "/etc/hosts", "resolv.conf": "/etc/resolv.conf",
        "zfs": "/etc/zfs", "crontab": "/etc/crontab",
        "cron.d": "/etc/cron.d", "cron.daily": "/etc/cron.daily",
        "cron.hourly": "/etc/cron.hourly", "cron.weekly": "/etc/cron.weekly",
        "cron.monthly": "/etc/cron.monthly", "cron.yearly": "/etc/cron.yearly",
        "apt-sources": "/etc/apt/sources.list", "apt-sources-d": "/etc/apt/sources.list.d",
        "dpkg": "/var/lib/dpkg/status",
        "sysctl": "/etc/sysctl.conf", "sysctl.d": "/etc/sysctl.d",
        "modules": "/etc/modules", "modules-load": "/etc/modules-load.d",
        "modprobe": "/etc/modprobe.d", "ssh-sshd": "/etc/ssh/sshd_config",
        "ssh-sshd-d": "/etc/ssh/sshd_config.d", "systemd": "/etc/systemd",
        "limits": "/etc/security/limits.conf", "limits.d": "/etc/security/limits.d",
        "login.defs": "/etc/login.defs", "corosync": "/etc/corosync",
        "pbs-client": "/etc/pbs", "pbs-conf": "/etc/pbs.conf",
        "iscsi": "/etc/iscsi", "drbd": "/etc/drbd.d", "chrony": "/etc/chrony",
        "timesyncd": "/etc/systemd/timesyncd.conf",
        "dhcp": "/etc/dhcp/dhclient.conf", "proftpd": "/etc/proftpd",
        "haproxy": "/etc/haproxy", "nginx": "/etc/nginx",
        "ssh-keys": "/root/.ssh",
    }

    if restore_all:
        restore_items = [name for name in restore_map.keys()
                         if os.path.exists(os.path.join(tmp_dir, name))]
        await ws.send_json({"type": "log", "level": "info",
                            "msg": f"恢复全部，发现 {len(restore_items)} 项"})

    total = len(restore_items) + len(restore_vms) + len(restore_lxcs)
    if total == 0:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        await ws.send_json({"type": "result", "status": "error", "msg": "没有选择恢复项"})
        db.task_update(task_id, status='failed')
        return

    restored = 0

    try:
      async with target.runner() as run:
        # 2. 远端临时目录
        remote_tmp = f"/tmp/proxmox_restore_{int(asyncio.get_event_loop().time())}"
        await ws.send_json({"type": "log", "level": "info",
                            "msg": f"创建远端临时目录: {remote_tmp}"})
        rc, out, err = await run.exec(f"mkdir -p {remote_tmp}")
        if rc != 0:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            await ws.send_json({"type": "result", "status": "error",
                                "msg": f"创建远端临时目录失败: {err.strip()[:200]}"})
            db.task_update(task_id, status='failed')
            return

        idx = 0
        # 3. 逐项恢复配置
        for name in restore_items:
            idx += 1
            pct = 5 + int((idx / total) * 80)
            local_path = os.path.join(tmp_dir, name)
            server_path = restore_map.get(name, "")

            if not os.path.exists(local_path) or not server_path:
                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"  - {name}: 跳过 (本地不存在或无映射)"})
                continue

            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"  恢复 {name} → {server_path}"})

            try:
                # 备份服务器当前配置
                await run.exec(
                    f"cp -r {server_path} {server_path}.bak.$(date +%Y%m%d%H%M%S) 2>/dev/null; true",
                    merge_stderr=True,
                )

                if os.path.isdir(local_path):
                    # 目录：走 stdin pipe 上传到远端临时位置
                    rc, out, err = await run.upload_via_stdin(
                        local_path, f"{remote_tmp}/{name}", timeout=120,
                    )
                    await ws.send_json({"type": "log", "level": "info",
                                        "msg": f"    上传目录: rc={rc}"})
                    if rc == 0:
                        rc2, _, err2 = await run.exec(
                            f"cp -r {remote_tmp}/{name}/* {server_path}/ 2>/dev/null || "
                            f"cp -r {remote_tmp}/{name}/. {server_path}/ 2>/dev/null; true",
                            merge_stderr=True,
                        )
                        if rc2 == 0:
                            restored += 1
                            await ws.send_json({"type": "log", "level": "info",
                                                "msg": f"  ✓ {name} 恢复成功"})
                        else:
                            await ws.send_json({"type": "log", "level": "warn",
                                                "msg": f"  ⚠ {name} 远端复制失败: {err2[:80]}"})
                    else:
                        await ws.send_json({"type": "log", "level": "warn",
                                            "msg": f"  ⚠ {name} 上传失败: {err[:80]}"})
                else:
                    rc, out, err = await run.upload_via_stdin(
                        local_path, server_path, timeout=30,
                    )
                    await ws.send_json({"type": "log", "level": "info",
                                        "msg": f"    上传文件: rc={rc}"})
                    if rc == 0:
                        restored += 1
                        await ws.send_json({"type": "log", "level": "info",
                                            "msg": f"  ✓ {name} 恢复成功"})
                    else:
                        await ws.send_json({"type": "log", "level": "warn",
                                            "msg": f"  ⚠ {name} 上传失败: {err[:80]}"})
            except Exception as e:
                await ws.send_json({"type": "log", "level": "warn",
                                    "msg": f"  ✗ {name} 异常: {str(e)[:80]}"})

            await ws.send_json({"type": "progress", "pct": pct,
                                "text": f"恢复中 {idx}/{total}"})

        # 4. 恢复 VM 配置
        for vmid in restore_vms:
            idx += 1
            pct = 5 + int((idx / total) * 80)
            conf_file = f"{vmid}.conf"
            local_file = os.path.join(tmp_dir, "pve", "qemu-server", conf_file)
            if not os.path.isfile(local_file):
                local_file = os.path.join(tmp_dir, "pve", "lxc", conf_file)
                target_path = f"/etc/pve/lxc/{conf_file}"
            else:
                target_path = f"/etc/pve/qemu-server/{conf_file}"

            if os.path.isfile(local_file):
                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"  恢复 VM/LXC {vmid} 配置..."})
                try:
                    rc, _, err = await run.upload_via_stdin(local_file, target_path, timeout=30)
                    if rc == 0:
                        restored += 1
                        await ws.send_json({"type": "log", "level": "info",
                                            "msg": f"  ✓ VM/LXC {vmid} 配置已恢复"})
                    else:
                        await ws.send_json({"type": "log", "level": "warn",
                                            "msg": f"  ⚠ VM/LXC {vmid} 恢复失败: {err[:80]}"})
                except Exception as e:
                    await ws.send_json({"type": "log", "level": "warn",
                                        "msg": f"  ✗ VM/LXC {vmid} 异常: {str(e)[:60]}"})
            await ws.send_json({"type": "progress", "pct": pct,
                                "text": f"恢复 VM/LXC {idx}/{total}"})

        # 5. 恢复 LXC 配置
        for vmid in restore_lxcs:
            idx += 1
            pct = 5 + int((idx / total) * 80)
            conf_file = f"{vmid}.conf"
            local_file = os.path.join(tmp_dir, "pve", "lxc", conf_file)
            target_path = f"/etc/pve/lxc/{conf_file}"

            if os.path.isfile(local_file):
                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"  恢复 LXC {vmid} 配置..."})
                try:
                    rc, _, err = await run.upload_via_stdin(local_file, target_path, timeout=30)
                    if rc == 0:
                        restored += 1
                        await ws.send_json({"type": "log", "level": "info",
                                            "msg": f"  ✓ LXC {vmid} 配置已恢复"})
                    else:
                        await ws.send_json({"type": "log", "level": "warn",
                                            "msg": f"  ⚠ LXC {vmid} 恢复失败: {err[:80]}"})
                except Exception as e:
                    await ws.send_json({"type": "log", "level": "warn",
                                        "msg": f"  ✗ LXC {vmid} 异常: {str(e)[:60]}"})
            await ws.send_json({"type": "progress", "pct": pct,
                                "text": f"恢复 LXC {idx}/{total}"})

        # 6. 清理
        await ws.send_json({"type": "log", "level": "info", "msg": "清理临时文件..."})
        shutil.rmtree(tmp_dir, ignore_errors=True)
        await run.exec(f"rm -rf {remote_tmp}", merge_stderr=True)
        await ws.send_json({"type": "progress", "pct": 95, "text": "清理完成"})
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        shutil.rmtree(tmp_dir, ignore_errors=True)
        await ws.send_json({"type": "result", "status": "error", "msg": f"恢复异常: {safe}"})
        db.task_update(task_id, status='failed')
        return

    # 7. 结果
    await ws.send_json({"type": "progress", "pct": 100,
                        "text": f"恢复完成 ({restored}/{total})"})
    await ws.send_json({
        "type": "result",
        "status": "ok" if restored > 0 else "error",
        "msg": f"恢复完成: {restored}/{total} 项成功",
        "restored": restored, "total": total,
    })
    db.task_update(task_id, status='completed')
    log_operation("auto_restore", f"Proxmox 配置恢复: {host}",
                  f"恢复 {restored}/{total} 项")


async def handle_auto_restore_item(ws, data, task_id):
    """从备份包恢复单个项目（配置或 VM/LXC 配置）"""
    import tarfile
    import tempfile

    target = SSHTarget.from_ws_data(data)
    host = target.host
    archive_path = data.get("archive_path", "")
    item_type = data.get("item_type", "")
    item_name = data.get("item_name", "")
    restore_map = {
        "pve": "/etc/pve", "network": "/etc/network",
        "network-d": "/etc/network/interfaces.d", "NetworkManager": "/etc/NetworkManager",
        "fstab": "/etc/fstab", "hosts": "/etc/hosts", "resolv.conf": "/etc/resolv.conf",
        "zfs": "/etc/zfs", "crontab": "/etc/crontab",
        "cron.d": "/etc/cron.d", "cron.daily": "/etc/cron.daily",
        "cron.hourly": "/etc/cron.hourly", "cron.weekly": "/etc/cron.weekly",
        "cron.monthly": "/etc/cron.monthly", "cron.yearly": "/etc/cron.yearly",
        "apt": "/etc/apt/sources.list", "apt-sources": "/etc/apt/sources.list.d",
        "sysctl": "/etc/sysctl.conf", "sysctl.d": "/etc/sysctl.d",
        "modules": "/etc/modules", "modules-load": "/etc/modules-load.d",
        "modprobe": "/etc/modprobe.d", "ssh-sshd": "/etc/ssh/sshd_config",
        "ssh-sshd-d": "/etc/ssh/sshd_config.d", "systemd": "/etc/systemd",
        "limits": "/etc/security/limits.conf", "limits.d": "/etc/security/limits.d",
        "login.defs": "/etc/login.defs", "corosync": "/etc/corosync",
        "pbs-client": "/etc/pbs", "pbs-conf": "/etc/pbs.conf",
        "iscsi": "/etc/iscsi", "drbd": "/etc/drbd.d",
        "chrony": "/etc/chrony", "timesyncd": "/etc/systemd/timesyncd.conf",
        "dhcp": "/etc/dhcp/dhclient.conf", "proftpd": "/etc/proftpd",
        "haproxy": "/etc/haproxy", "nginx": "/etc/nginx",
        "ssh-keys": "/root/.ssh",
    }

    if not host:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少服务器地址"})
        return
    if not archive_path or not os.path.isfile(archive_path):
        await ws.send_json({"type": "result", "status": "error", "msg": "备份文件不存在"})
        return

    await ws.send_json({"type": "log", "level": "info",
                        "msg": f"恢复项目: type={item_type} name={item_name}"})
    await ws.send_json({"type": "progress", "pct": 5,
                        "text": f"恢复 {item_type}: {item_name}..."})

    # 1. 解压
    tmp_dir = tempfile.mkdtemp(prefix="proxmox_restore_")
    try:
        with tarfile.open(archive_path, "r:gz") as tf:
            tf.extractall(tmp_dir, filter=tarfile.fully_trusted_filter)
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        await ws.send_json({"type": "result", "status": "error", "msg": f"解压失败: {e}"})
        return
    await ws.send_json({"type": "log", "level": "info", "msg": "✓ 备份文件已解压"})

    # 2. 恢复
    success = False
    try:
      async with target.runner() as run:
        try:
            if item_type == "config":
                server_path = restore_map.get(item_name, "")
                if not server_path:
                    raise ValueError(f"未知配置项: {item_name}")
                local_path = os.path.join(tmp_dir, item_name)
                if not os.path.exists(local_path):
                    raise ValueError(f"备份中不存在: {item_name}")

                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"  备份当前配置 {server_path} ..."})
                await run.exec(
                    f"cp -r {server_path} {server_path}.bak.$(date +%Y%m%d%H%M%S) 2>/dev/null; true",
                    merge_stderr=True,
                )

                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"  上传 {item_name} → {server_path} ..."})
                rc, out, err = await run.upload_via_stdin(local_path, server_path, timeout=120)
                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"  上传: rc={rc}"})
                if rc == 0:
                    success = True
                    await ws.send_json({"type": "log", "level": "info",
                                        "msg": f"  ✓ {item_name} 恢复成功"})
                else:
                    raise ValueError(err[:200] if err else "上传失败")

            elif item_type in ("vm", "lxc"):
                vmid = item_name
                section = "qemu-server" if item_type == "vm" else "lxc"
                conf_file = f"{vmid}.conf"
                local_file = os.path.join(tmp_dir, "pve", section, conf_file)
                if not os.path.isfile(local_file):
                    raise ValueError(f"备份中不存在 {section}/{conf_file}")
                target_path = f"/etc/pve/{section}/{conf_file}"

                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"  备份当前配置 {target_path} ..."})
                await run.exec(
                    f"cp {target_path} {target_path}.bak.$(date +%Y%m%d%H%M%S) 2>/dev/null; true",
                    merge_stderr=True,
                )

                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"  上传 {item_type} {vmid} 配置..."})
                rc, out, err = await run.upload_via_stdin(local_file, target_path, timeout=30)
                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"  上传: rc={rc}"})
                if rc == 0:
                    success = True
                    await ws.send_json({"type": "log", "level": "info",
                                        "msg": f"  ✓ {item_type.upper()} {vmid} 配置已恢复"})
                else:
                    raise ValueError(err[:200] if err else "上传失败")
            else:
                raise ValueError(f"未知类型: {item_type}")
        except Exception as e:
            await ws.send_json({"type": "log", "level": "error",
                                "msg": f"  ✗ 恢复失败: {str(e)[:100]}"})
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "log", "level": "error",
                            "msg": f"  ✗ 会话异常: {safe}"})
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    await ws.send_json({"type": "progress", "pct": 100 if success else 0, "text": "完成!"})
    await ws.send_json({
        "type": "result",
        "status": "ok" if success else "error",
        "msg": f"恢复 {'成功' if success else '失败'}: {item_type}/{item_name}",
    })
    log_operation("auto_restore_item", f"{item_type}: {item_name}",
                  f"{'成功' if success else '失败'}")


async def handle_auto_restore_browse(ws, data, task_id):
    """Browse contents of a backup archive file (list config items, VMs, LXC containers)"""
    import tarfile
    import tempfile
    import shutil

    archive_path = data.get("archive_path", "")
    if not archive_path or not os.path.isfile(archive_path):
        await ws.send_json({"type": "result", "status": "error", "msg": f"备份文件不存在: {archive_path}"})
        return

    await ws.send_json({"type": "log", "level": "info", "msg": f"正在扫描备份包内容..."})

    tmp_dir = tempfile.mkdtemp(prefix="proxmox_browse_")
    try:
        with tarfile.open(archive_path, "r:gz") as tf:
            tf.extractall(tmp_dir, filter=tarfile.fully_trusted_filter)
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        await ws.send_json({"type": "result", "status": "error", "msg": f"解压失败: {e}"})
        return

    # Scan config items
    config_items = []
    for entry in os.listdir(tmp_dir):
        entry_path = os.path.join(tmp_dir, entry)
        if not os.path.isdir(entry_path):
            continue
        file_count = 0
        for _, _, files in os.walk(entry_path):
            file_count += len(files)
        if file_count > 0:
            config_items.append({"name": entry, "file_count": file_count})

    # Scan VM configs
    vm_items = []
    pve_qemu = os.path.join(tmp_dir, "pve", "qemu-server")
    if os.path.isdir(pve_qemu):
        for f in os.listdir(pve_qemu):
            if f.endswith(".conf"):
                vmid = f.replace(".conf", "")
                vm_items.append({"vmid": vmid, "file": f})

    # Scan LXC configs
    lxc_items = []
    pve_lxc = os.path.join(tmp_dir, "pve", "lxc")
    if os.path.isdir(pve_lxc):
        for f in os.listdir(pve_lxc):
            if f.endswith(".conf"):
                vmid = f.replace(".conf", "")
                lxc_items.append({"vmid": vmid, "file": f})

    shutil.rmtree(tmp_dir, ignore_errors=True)

    await ws.send_json({
        "type": "result",
        "status": "ok",
        "msg": f"扫描完成: {len(config_items)} 个配置项, {len(vm_items)} 个 VM, {len(lxc_items)} 个 LXC",
        "config_items": config_items,
        "vm_items": vm_items,
        "lxc_items": lxc_items,
        "archive_path": archive_path
    })

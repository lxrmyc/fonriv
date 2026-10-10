"""Fonriv - Proxmox VE 处理器 (Stage 4: 迁移到 SSHRunner)"""
from __future__ import annotations
import logging

import os
import re
import asyncio
from fastapi import WebSocket

from backend.ssh_lib import (
    SSHTarget, sanitize_output, parse_ls_output, active_tasks,
)
from backend import db


def _pwd(target) -> str:
    return getattr(target.auth, "password", "") or ""


def _key(target) -> str:
    return getattr(target.auth, "key_path", "") or ""


async def handle_scan_pve(ws: WebSocket, data: dict):
    target = SSHTarget.from_ws_data(data)
    scan_cmd = "qm list 2>/dev/null; echo '---CT_SEPARATOR---'; pct list 2>/dev/null"
    try:
        async with target.runner() as run:
            code, out, _ = await run.exec(scan_cmd, timeout=30, merge_stderr=True)
            if code != 0:
                # 兜底：列 /var/lib/vz/images 子目录
                code2, out2, _ = await run.exec(
                    "ls -d /var/lib/vz/images/*/ 2>/dev/null | head -40",
                    timeout=15, merge_stderr=True,
                )
                if code2 == 0:
                    vm_list = parse_dirs_from_ls(out2)
                    await ws.send_json({"type": "scan_result", "status": "ok",
                                        "vms": vm_list, "fallback": True})
                    return
                safe = sanitize_output((out or "").strip(), _pwd(target), _key(target))
                await ws.send_json({"type": "scan_result", "status": "error", "msg": safe})
                return
            vms = parse_pve_list(out)
            await ws.send_json({"type": "scan_result", "status": "ok",
                                "vms": vms, "fallback": False})
    except FileNotFoundError:
        await ws.send_json({"type": "scan_result", "status": "error",
                            "msg": "SSH 命令不可用"})
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "scan_result", "status": "error", "msg": safe})


def parse_pve_list(output):
    vms = []
    sections = (output or "").split("---CT_SEPARATOR---")
    for sec_idx, section in enumerate(sections):
        lines = section.strip().split("\n")
        is_ct = sec_idx > 0
        for line in lines[1:]:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) >= 3:
                vmid = parts[0]
                try:
                    int(vmid)
                except ValueError:
                    continue
                name = parts[1]
                status = parts[2] if len(parts) > 2 else "unknown"
                mem = parts[3] if len(parts) > 3 and status != "unknown" else "0"
                disk = parts[4] if len(parts) > 4 and status != "unknown" else "0"
                vms.append({
                    "vmid": vmid, "name": name, "status": status,
                    "type": "CT" if is_ct else "VM",
                    "memory": mem, "disk": disk,
                })
            elif len(parts) == 2:
                try:
                    int(parts[0])
                except ValueError:
                    continue
                vms.append({
                    "vmid": parts[0], "name": parts[1], "status": "unknown",
                    "type": "CT" if is_ct else "VM",
                    "memory": "0", "disk": "0",
                })
    return vms


# v4.15.21 · 解析 qm config / pct config 输出中的磁盘条目
# 匹配行示例（VM）：
#   scsi0: local-lvm:vm-100-disk-0,size=32G
#   ide2: local:iso/debian.iso,media=cdrom
#   virtio1: /mnt/data/vm-100-extra.qcow2,size=100G
#   efidisk0: local-lvm:vm-100-disk-1,size=4M
# CT：rootfs: local-lvm:vm-101-disk-0,size=8G
_DISK_KEY_RE = __import__("re").compile(
    r"^(scsi|sata|ide|virtio|efidisk|tpmstate)\d+|^rootfs|^mp\d+", __import__("re").IGNORECASE
)


def parse_vm_config_disks(output: str, vmid: str) -> list:
    """从 qm config / pct config 输出提取磁盘条目。

    返回 list[dict{key, storage_ref, size, media, path, name}]
    - storage_ref: 如 'local-lvm:vm-100-disk-0' 或 '/mnt/data/x.qcow2'
    - size: 如 '32G'
    - path: 若能确定绝对路径（storage_ref 以 / 开头），填入
    - name: 建议的展示名
    """
    import re
    disks = []
    for line in (output or "").split("\n"):
        line = line.strip()
        if not line or line.startswith("#") or "---PCT---" in line:
            continue
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        if not _DISK_KEY_RE.match(key):
            continue
        # val = "storage_ref[,option=x[,option=y]]"
        parts = [p.strip() for p in val.split(",")]
        storage_ref = parts[0]
        opts = {}
        for p in parts[1:]:
            if "=" in p:
                k, _, v = p.partition("=")
                opts[k.strip()] = v.strip()
        # 排除 CDROM ISO
        if opts.get("media") == "cdrom":
            continue
        size = opts.get("size", "")
        path = storage_ref if storage_ref.startswith("/") else ""
        name = storage_ref.split("/")[-1] if path else storage_ref.split(":")[-1]
        disks.append({
            "key": key,
            "storage_ref": storage_ref,
            "size": size,
            "media": opts.get("media", ""),
            "path": path,
            "name": name,
            "raw_name": name,
            "vmid": vmid,
            "source": "qm_config",
        })
    return disks


def parse_dirs_from_ls(output):
    vms = []
    for line in (output or "").strip().split("\n"):
        line = line.strip().rstrip("/")
        if not line:
            continue
        basename = os.path.basename(line)
        try:
            int(basename)
        except ValueError:
            continue
        vms.append({
            "vmid": basename, "name": "Unknown-" + basename,
            "status": "unknown", "type": "VM",
            "memory": "?", "disk": "?",
        })
    return vms


async def handle_scan_disks(ws: WebSocket, data: dict):
    target = SSHTarget.from_ws_data(data)
    vmid = str(data.get("vmid", ""))
    pve_dir = data.get("pve_dir", "/var/lib/vz/images/")
    dir_hints = data.get("dir_hints", [])
    vm_type = (data.get("type") or "").upper()  # v4.15.21 · VM / CT

    DISK_EXTS = ('.qcow2', '.raw', '.iso', '.img', '.vma', '.tar',
                 '.zst', '.log', '.lz4', '.gz', '.xz', '.bz2')

    def is_disk_file(name):
        lower = name.lower()
        if lower.startswith(".") or lower in ("token", "lock", "index"):
            return False
        for ext in DISK_EXTS:
            if lower.endswith(ext) or ext in lower:
                return True
        return False

    disks = []
    found_dir = pve_dir
    config_disks = []  # v4.15.21 · qm/pct config 解析出的真实盘

    try:
        async with target.runner() as run:
            # v4.15.21 · 先尝试 qm/pct config，抓 VM/CT 真实盘配置
            if vmid:
                cfg_cmd = f"qm config {vmid} 2>/dev/null; echo '---PCT---'; pct config {vmid} 2>/dev/null"
                cc, co, _ = await run.exec(cfg_cmd, timeout=15, merge_stderr=True)
                if cc == 0 and co.strip():
                    config_disks = parse_vm_config_disks(co, vmid)
                    if config_disks:
                        await ws.send_json({
                            "type": "log", "level": "info",
                            "msg": f"从 qm/pct config 解析到 {len(config_disks)} 个磁盘条目"
                        })

            # 待扫描的目录列表
            scan_paths = []
            if vmid:
                scan_paths.append(pve_dir.rstrip("/") + "/" + vmid)
                scan_paths.append(pve_dir.rstrip("/"))
                for hint_dir in dir_hints:
                    hint_vmid = hint_dir.rstrip("/") + "/" + vmid
                    if hint_vmid not in scan_paths:
                        scan_paths.append(hint_vmid)
                    if hint_dir.rstrip("/") not in scan_paths:
                        scan_paths.append(hint_dir.rstrip("/"))
                for dd in ("/var/lib/vz/dump", "/var/lib/vz/backup", "/var/backups/vzdump",
                           "/mnt/backup", "/mnt/data/backup", "/backup"):
                    if dd not in scan_paths:
                        scan_paths.append(dd)
            else:
                scan_paths = [pve_dir.rstrip("/")]

            for search_dir in scan_paths:
                base = search_dir.rstrip("/")
                # 第一层：ls -lh <base>/
                code1, out1, _ = await run.exec(f"ls -lh {base}/ 2>/dev/null",
                                                timeout=15, merge_stderr=True)
                if code1 == 0 and out1.strip():
                    found_items = parse_ls_output(out1)
                    for fi in found_items:
                        if "path" in fi and not fi["path"].startswith("/"):
                            fi["path"] = base + "/" + fi["path"]
                    found_items = [d for d in found_items
                                   if is_disk_file(d.get("raw_name", d.get("name", "")))]
                    if vmid and "dump" in search_dir:
                        found_items = [d for d in found_items
                                       if vmid in (d.get("raw_name", "") or d.get("name", ""))]
                    disks.extend(found_items)
                    if found_items:
                        found_dir = search_dir

                # 第二层：递归扫描子目录（若上一步没找到）
                if not disks and vmid:
                    lc, lo, _ = await run.exec(
                        f"find {base} -maxdepth 2 -type d 2>/dev/null | head -50",
                        timeout=10, merge_stderr=True,
                    )
                    sub_dirs = ([d.strip() for d in lo.strip().split("\n") if d.strip()]
                                if lc == 0 and lo.strip() else [base])
                    for sd in sub_dirs:
                        sd_code, sd_out, _ = await run.exec(
                            f"ls -lh {sd} 2>/dev/null",
                            timeout=15, merge_stderr=True,
                        )
                        if sd_code == 0 and sd_out.strip():
                            si = parse_ls_output(sd_out)
                            for fi in si:
                                if "path" in fi and not fi["path"].startswith("/"):
                                    fi["path"] = sd + "/" + fi["path"]
                            si = [d for d in si
                                  if is_disk_file(d.get("raw_name", d.get("name", "")))]
                            if "dump" in sd or "backup" in sd:
                                si = [d for d in si
                                      if vmid in (d.get("raw_name", "") or d.get("name", ""))]
                            if si:
                                disks.extend(si)
                                found_dir = sd

        # 去重
        seen = set()
        unique = []
        for d in disks:
            name = d.get("raw_name", d.get("name", ""))
            if name and name not in seen:
                seen.add(name)
                unique.append(d)
        disks = unique

        if disks:
            await ws.send_json({"type": "disk_result", "status": "ok",
                                "disks": disks, "scan_dir": found_dir,
                                "config_disks": config_disks})
        else:
            await ws.send_json({
                "type": "disk_result", "status": "ok",
                "disks": [], "scan_dir": found_dir,
                "config_disks": config_disks,
                "msg": ("未扫描到磁盘文件，但 qm/pct config 中有 "
                        f"{len(config_disks)} 个块存储条目（LVM/ZFS/Ceph 等）"
                        if config_disks else
                        "未在已扫描的目录中找到磁盘/备份文件（可能使用 LVM/ZFS 块存储）"),
            })
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "disk_result", "status": "error", "msg": safe})


async def handle_pve_backup(ws: WebSocket, data: dict, task_id):
    target = SSHTarget.from_ws_data(data)
    disks = data.get("disks", [])
    local_dir = (data.get("local_dir") or "").strip()

    if not disks:
        await ws.send_json({"type": "finish", "status": "error", "msg": "未选择磁盘文件"})
        return
    if not local_dir:
        await ws.send_json({"type": "finish", "status": "error", "msg": "请指定本地保存目录"})
        return

    try:
        os.makedirs(local_dir, exist_ok=True)
        await ws.send_json({"type": "log", "level": "info", "msg": "本地目录: " + local_dir})
    except Exception as e:
        await ws.send_json({"type": "finish", "status": "error",
                            "msg": f"无法创建本地目录 {local_dir}: {e}"})
        return

    # 提取 VMID
    vmid_str = ""
    for disk in disks:
        p = disk.get("path", "")
        for part in [x for x in p.split("/") if x]:
            try:
                int(part)
                vmid_str = part
                break
            except ValueError:
                continue
        if vmid_str:
            break
    db.task_create(task_id, f"PVE备份: {vmid_str}", "pve_backup", command=f"backup {vmid_str}")

    total = len(disks)
    completed = 0
    skipped = 0
    stopped = False

    flags = data.get("flags", "-avP")
    bw = data.get("bwlimit", "0")

    idx = 0
    try:
        async with target.runner() as run:
            for idx, disk in enumerate(disks, 1):
                remote_path = disk.get("path", "")
                if not remote_path:
                    continue
                filename = os.path.basename(remote_path)
                local_path = os.path.join(local_dir, filename)

                # 智能跳过：本地已有且大小一致
                if os.path.exists(local_path):
                    local_size = os.path.getsize(local_path)
                    try:
                        c_code, c_out, _ = await run.exec(
                            f'stat --format="%s" {remote_path} 2>/dev/null',
                            timeout=10, merge_stderr=True,
                        )
                        if c_code == 0 and c_out.strip():
                            remote_size = int(c_out.strip().strip('"').strip())
                            if remote_size == local_size:
                                await ws.send_json({
                                    "type": "log", "level": "success",
                                    "msg": f"[{idx}/{total}] 跳过: {filename} (本地文件已存在且大小一致 {local_size} 字节)",
                                })
                                skipped += 1
                                continue
                            await ws.send_json({
                                "type": "log", "level": "warn",
                                "msg": f"[{idx}/{total}] 需要更新: {filename} (本地={local_size} 远端={remote_size} 字节)",
                            })
                    except Exception as _e: logging.debug("suppressed", exc_info=True)
                await ws.send_json({
                    "type": "log", "level": "info",
                    "msg": f"[{idx}/{total}] 开始传输: {filename}",
                })

                rsync_flags = [flags]
                if bw and bw != "0":
                    rsync_flags.append(f"--bwlimit={bw}")

                argv, _env = run.build_rsync_argv("down", remote_path, local_dir,
                                                  flags=rsync_flags)
                await ws.send_json({"type": "log", "level": "cmd",
                                    "msg": "  " + " ".join(argv)})

                progress_re = re.compile(r"\((\d+\.?\d*)%\)")
                speed_re = re.compile(r"(\d+\.?\d*\s*[A-Za-z]+/s)")

                returncode = None
                async for line_str in run.rsync_stream("down", remote_path, local_dir,
                                                        flags=rsync_flags, task_id=task_id):
                    if line_str.startswith("__DONE__|"):
                        returncode = int(line_str.split("|", 1)[1])
                        continue
                    if not line_str:
                        continue
                    pct_m = progress_re.search(line_str)
                    speed_m = speed_re.search(line_str)
                    if pct_m:
                        pct = float(pct_m.group(1))
                        overall = (idx - 1 + pct / 100) / total * 100
                        payload = {"type": "progress", "pct": overall, "file": filename}
                        if speed_m:
                            payload["speed"] = speed_m.group(1).strip()
                        await ws.send_json(payload)
                    else:
                        await ws.send_json({"type": "log", "level": "dim", "msg": line_str})

                if returncode == 0:
                    completed += 1
                    await ws.send_json({"type": "log", "level": "success",
                                        "msg": f"  ✓ {filename} 传输完成"})
                else:
                    await ws.send_json({
                        "type": "log", "level": "error",
                        "msg": f"  ✗ {filename} 传输失败 (码: {returncode})",
                    })

                # 检测用户主动停止
                if task_id not in active_tasks:
                    stopped = True
                    break
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "log", "level": "error", "msg": "  错误: " + safe})

    if stopped:
        db.task_update(task_id, status='failed')
    elif completed + skipped == total:
        db.task_update(task_id, status='completed')
    else:
        db.task_update(task_id, status='failed')
    active_tasks.pop(task_id, None)

    if stopped and (total - completed - skipped) > 1:
        await ws.send_json({
            "type": "log", "level": "warn",
            "msg": f"任务中止，跳过剩余 {total - completed - skipped} 个文件",
        })

    msg_parts = ["PVE 磁盘备份完成", f"共 {total} 个文件"]
    if completed:
        msg_parts.append(f"传输 {completed} 个")
    if skipped:
        msg_parts.append(f"跳过 {skipped} 个")
    await ws.send_json({"type": "finish", "status": "success", "msg": "，".join(msg_parts)})
    # v4.18.3 · publish pve.backup.finished
    try:
        from backend import events
        events.publish("pve.backup.finished", {
            "task_id": task_id, "status": "success",
            "completed": completed, "skipped": skipped, "total": total,
            "target": data.get("host") or "",
        })
    except Exception as _e:
        print(f"[pve] publish backup.finished fail: {_e}")


async def handle_pve_restore(ws: WebSocket, data: dict, task_id):
    target = SSHTarget.from_ws_data(data)
    files = data.get("files", [])
    pve_dir = (data.get("pve_dir") or "/var/lib/vz/dump/").strip()
    vmid = str(data.get("vmid", ""))

    if not files:
        await ws.send_json({"type": "finish", "status": "error", "msg": "未选择恢复文件"})
        return

    # v3.0.3: pre-flight 参数校验（VMID 格式 · 冲突检查 · 目录/磁盘空间）
    # VMID 格式（非空时必须纯数字 100-999999）
    if vmid:
        if not vmid.isdigit() or not (100 <= int(vmid) <= 999999):
            await ws.send_json({"type": "finish", "status": "error",
                                "msg": f"VMID 无效: '{vmid}'（Proxmox 要求纯数字 100-999999）"})
            return

    # pve_dir 格式合理性
    if pve_dir and not pve_dir.startswith("/"):
        await ws.send_json({"type": "finish", "status": "error",
                            "msg": f"目标目录必须为绝对路径: {pve_dir}"})
        return
    # 危险路径拦截
    _forbidden_prefixes = ("/bin", "/sbin", "/lib", "/etc", "/boot", "/proc", "/sys", "/dev", "/run")
    if any(pve_dir.rstrip("/").startswith(p) for p in _forbidden_prefixes):
        await ws.send_json({"type": "finish", "status": "error",
                            "msg": f"目标目录疑似系统路径，已拒绝: {pve_dir}"})
        return

    # 需要传输的总字节数（本地文件大小之和）
    _need_bytes = 0
    for _f in files:
        _lp = _f.get("path", "")
        if _lp and os.path.exists(_lp):
            try:
                _need_bytes += os.path.getsize(_lp)
            except Exception as _e: logging.debug("suppressed", exc_info=True)
    # 远端预检 · 目录存在 + VMID 冲突 + 磁盘空间
    try:
        async with target.runner() as _pre_run:
            # 1) 目标目录父路径检查（不存在允许，会自动 mkdir -p；但父路径不能是文件）
            if pve_dir:
                _code, _out, _ = await _pre_run.exec(
                    f"test -e '{pve_dir}' && stat --format='%F' '{pve_dir}' 2>/dev/null || echo 'not_exists'",
                    timeout=10, merge_stderr=True
                )
                _kind = (_out or "").strip()
                if _kind and _kind not in ("directory", "not_exists"):
                    await ws.send_json({"type": "finish", "status": "error",
                                        "msg": f"目标 {pve_dir} 已存在但不是目录: {_kind}"})
                    return

            # 2) 磁盘空间检查（df 目标目录的挂载点；不足则拒绝）
            if _need_bytes > 0 and pve_dir:
                # 找一个存在的父目录
                _probe = pve_dir
                for _ in range(6):
                    _c, _o, _ = await _pre_run.exec(
                        f"test -d '{_probe}' && echo yes || echo no",
                        timeout=8, merge_stderr=True
                    )
                    if (_o or "").strip() == "yes":
                        break
                    _probe = os.path.dirname(_probe.rstrip("/")) or "/"
                _c2, _o2, _ = await _pre_run.exec(
                    f"df -B1 --output=avail '{_probe}' 2>/dev/null | tail -1",
                    timeout=8, merge_stderr=True
                )
                try:
                    _avail = int((_o2 or "0").strip())
                except Exception:
                    _avail = 0
                if _avail and _avail < _need_bytes:
                    _human = lambda b: f"{b/1024/1024/1024:.2f} GB" if b > 1024**3 else f"{b/1024/1024:.1f} MB"
                    await ws.send_json({"type": "finish", "status": "error",
                                        "msg": f"目标磁盘空间不足：需要 {_human(_need_bytes)}，剩余 {_human(_avail)}（路径 {_probe}）"})
                    return

            # 3) VMID 冲突检查（若指定 vmid → 查 qm list / pct list 是否已有）
            if vmid:
                _cc, _oc, _ = await _pre_run.exec(
                    f"qm status {vmid} 2>/dev/null; pct status {vmid} 2>/dev/null",
                    timeout=10, merge_stderr=True
                )
                _oc = (_oc or "").strip()
                # qm/pct status 返回 "status: xxx" 表示存在
                if _oc and ("status:" in _oc.lower()):
                    await ws.send_json({
                        "type": "log", "level": "warn",
                        "msg": f"⚠ VMID {vmid} 在远端已存在（{_oc.splitlines()[0]}）— 文件传输会覆盖，如需保留请先在 PVE 里迁移或改 vmid"
                    })
                    # 不 return —— 只警告，因为用户可能就是要覆盖恢复
    except Exception as _pre_e:
        # 预检失败仅记 warn 不 return，让主流程继续（避免连接偶发问题阻塞恢复）
        await ws.send_json({
            "type": "log", "level": "warn",
            "msg": f"预检异常（继续尝试恢复）: {_pre_e}"
        })

    db.task_create(task_id, f"PVE恢复: {vmid}", "pve_restore", command=f"restore {vmid}")

    total = len(files)
    completed = 0
    skipped = 0
    stopped = False
    idx = 0

    try:
        async with target.runner() as run:
            for idx, f in enumerate(files, 1):
                local_path = f.get("path", "")
                remote_path = f.get("remote", "")
                if not local_path:
                    continue

                filename = os.path.basename(local_path)

                # 确定目标路径
                if remote_path:
                    target_path = remote_path
                elif "vzdump" in filename.lower():
                    target_path = "/var/lib/vz/dump/" + filename
                elif vmid:
                    target_path = "/var/lib/vz/images/" + vmid + "/" + filename
                else:
                    target_path = pve_dir.rstrip("/") + "/" + filename

                target_dir = os.path.dirname(target_path)

                await ws.send_json({
                    "type": "log", "level": "info",
                    "msg": f"[{idx}/{total}] 恢复: {filename} -> {target_path}",
                })

                # 远端自动 mkdir -p
                try:
                    await run.exec(f"mkdir -p '{target_dir}' 2>/dev/null",
                                   timeout=10, merge_stderr=True)
                except Exception as _e: logging.debug("suppressed", exc_info=True)
                # 检查远端是否已存在同大小文件
                try:
                    c_code, c_out, _ = await run.exec(
                        f"stat --format='%s' '{target_path}' 2>/dev/null",
                        timeout=10, merge_stderr=True,
                    )
                    if c_code == 0 and c_out.strip():
                        remote_size = int(c_out.strip().strip("'").strip())
                        local_size = os.path.getsize(local_path)
                        if remote_size == local_size:
                            await ws.send_json({
                                "type": "log", "level": "success",
                                "msg": f"[{idx}/{total}] 跳过: {filename} (远端文件已存在且大小一致 {remote_size} 字节)",
                            })
                            skipped += 1
                            continue
                        await ws.send_json({
                            "type": "log", "level": "warn",
                            "msg": f"[{idx}/{total}] 需要更新: {filename} (远端={remote_size} 本地={local_size} 字节)",
                        })
                except Exception as _e: logging.debug("suppressed", exc_info=True)
                src = local_path + "/" if os.path.isdir(local_path) else local_path
                rsync_flags = ["-avP"]

                argv, _env = run.build_rsync_argv("up", src, target_path, flags=rsync_flags)
                await ws.send_json({"type": "log", "level": "cmd",
                                    "msg": "  " + " ".join(argv)})

                progress_re = re.compile(r"\((\d+\.?\d*)%\)")
                returncode = None
                async for line_str in run.rsync_stream("up", src, target_path,
                                                        flags=rsync_flags, task_id=task_id):
                    if line_str.startswith("__DONE__|"):
                        returncode = int(line_str.split("|", 1)[1])
                        continue
                    if not line_str:
                        continue
                    pct_m = progress_re.search(line_str)
                    if pct_m:
                        pct = float(pct_m.group(1))
                        overall = (idx - 1 + pct / 100) / total * 100
                        await ws.send_json({"type": "progress", "pct": overall,
                                            "file": filename})
                    else:
                        await ws.send_json({"type": "log", "level": "dim", "msg": line_str})

                if returncode == 0:
                    completed += 1
                    await ws.send_json({"type": "log", "level": "success",
                                        "msg": f"  ✓ {filename} 恢复完成"})
                else:
                    await ws.send_json({
                        "type": "log", "level": "error",
                        "msg": f"  ✗ {filename} 恢复失败 (码: {returncode})",
                    })

                if task_id not in active_tasks:
                    stopped = True
                    break
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "log", "level": "error", "msg": "  错误: " + safe})

    if stopped:
        db.task_update(task_id, status='failed')
    elif completed + skipped == total:
        db.task_update(task_id, status='completed')
    else:
        db.task_update(task_id, status='failed')
    active_tasks.pop(task_id, None)

    msg_parts = ["PVE 磁盘恢复完成", f"共 {total} 个文件"]
    if completed:
        msg_parts.append(f"传输 {completed} 个")
    if skipped:
        msg_parts.append(f"跳过 {skipped} 个")
    await ws.send_json({"type": "finish", "status": "success",
                        "msg": "，".join(msg_parts)})

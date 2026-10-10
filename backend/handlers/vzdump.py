"""Fonriv - vzdump 归档处理器 (Stage 5: 迁移到 SSHRunner)"""

import os
import re
import asyncio

from backend import db
from backend.ssh_lib import (
    SSHTarget, sanitize_output, parse_ls_output, active_tasks, kill_process,
)
from backend.log import get_operations_log, clear_operations_log
from fastapi import WebSocket


def _pwd(target) -> str:
    return getattr(target.auth, "password", "") or ""


def _key(target) -> str:
    return getattr(target.auth, "key_path", "") or ""


def _parse_pvesm_status(text):
    """Parse pvesm status output into structured list."""
    storages = []
    for line in (text or "").strip().split("\n")[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 3:
            continue

        s = {"name": parts[0], "type": parts[1], "content": "", "path": "",
             "status": "", "avail": "", "total": "", "used_pct": ""}

        remaining = parts[2:]
        content_found = False
        path_found = False

        for p in remaining:
            p_lower = p.lower()
            if p_lower in ("active", "disabled", "error", "unknown"):
                s["status"] = p
            elif any(c in p for c in ["images", "backup", "iso", "snippets", "vztmpl"]):
                s["content"] = p
                content_found = True
            elif p_lower.startswith("/") or (not content_found and not path_found and p_lower.count("/") > 0):
                s["path"] = p
                path_found = True
            elif "%" in p:
                s["used_pct"] = p
            elif p.replace(".", "").replace(",", "").isdigit() or any(c in p for c in "TGMK"):
                if not s["avail"]:
                    s["avail"] = p
                elif not s["total"]:
                    s["total"] = p

        if not s["path"]:
            name = s["name"]
            if name == "local":
                s["path"] = "/var/lib/vz/"
            elif name == "local-lvm" or "lvm" in name.lower():
                s["path"] = "/dev/pve/"

        storages.append(s)
    return storages


def _is_backup_file(name):
    """Check if a filename is a backup/archive/disk file (not metadata)."""
    if not name:
        return False
    lower = name.lower()
    if lower.startswith(".") or lower in ("token", "lock", "index", "lost+found"):
        return False
    if lower.endswith(".notes") or lower.endswith(".protected"):
        return False
    backup_exts = (".vma", ".zst", ".lz4", ".gz", ".xz", ".bz2",
                   ".qcow2", ".raw", ".img", ".iso",
                   ".tar", ".log", ".conf", ".json")
    for ext in backup_exts:
        if lower.endswith(ext):
            return True
    if ".vma." in lower or ".tar." in lower:
        return True
    return False


async def handle_vzdump(ws: WebSocket, data: dict, task_id):
    target = SSHTarget.from_ws_data(data)
    vmid = data.get("vmid", "")
    mode = data.get("mode", "snapshot")
    compress = data.get("compress", "zstd")
    storage = data.get("storage", "local")
    local_dir = (data.get("local_dir") or "").strip()
    auto_clean = data.get("auto_clean", True)
    pre_hook = (data.get("pre_hook") or "").strip()    # v4.65.0 · C2 应用一致性钩子
    post_hook = (data.get("post_hook") or "").strip()

    if not vmid or not local_dir:
        await ws.send_json({"type": "finish", "status": "error",
                            "msg": "请指定 VM ID 和本地保存目录"})
        return

    try:
        os.makedirs(local_dir, exist_ok=True)
    except Exception as e:
        await ws.send_json({"type": "finish", "status": "error",
                            "msg": f"无法创建本地目录 {local_dir}: {e}"})
        return

    db.task_create(task_id, f"vzdump: {target.host}", "vzdump",
                   command=f"vzdump {vmid} {mode} {compress}")

    comp_flag = "" if compress == "0" else "--compress " + compress
    vzdump_cmd = f"vzdump {vmid} --storage {storage} {comp_flag} --mode {mode}"

    await ws.send_json({"type": "phase", "phase": 1,
                        "msg": f"开始 vzdump 打包 VM {vmid}"})
    await ws.send_json({"type": "log", "level": "info",
                        "msg": "--- 阶段 1/2: 远程 vzdump 打包 ---"})
    await ws.send_json({"type": "log", "level": "cmd", "msg": "  " + vzdump_cmd})

    path_re = re.compile(r"""['"]?(/[^\s'"]+\.(?:vma|tar)(?:\.\w+)?)['"]?""")
    remote_archive = None

    try:
        async with target.runner() as run:
            # ============ v4.65.0 · C2 Pre 钩子 (应用级一致性, 失败中止备份) ============
            if pre_hook:
                await ws.send_json({"type": "log", "level": "info",
                                    "msg": "🪝 Pre 钩子: " + pre_hook})
                rc_pre, out_pre, err_pre = await run.exec(pre_hook, timeout=120)
                for _ln in (out_pre or "").splitlines()[:20]:
                    await ws.send_json({"type": "log", "level": "dim", "msg": "[pre] " + _ln})
                if rc_pre != 0:
                    await ws.send_json({"type": "log", "level": "error",
                                        "msg": f"Pre 钩子失败 (rc={rc_pre}): {(err_pre or out_pre or '').strip()[-200:]}"})
                    await ws.send_json({"type": "log", "level": "warn",
                                        "msg": "备份已中止 (防止不一致快照入库)。Post 钩子不执行。"})
                    db.task_update(task_id, status='failed',
                                   log_output=f"pre hook failed: {(err_pre or out_pre or '')[:2000]}")
                    await ws.send_json({"type": "finish", "status": "error",
                                        "msg": "Pre 钩子失败, 备份中止"})
                    return
                await ws.send_json({"type": "log", "level": "success", "msg": "Pre 钩子成功"})

            # ============ Phase 1: 远程 vzdump 打包 ============
            returncode = None
            async for line_str in run.stream_lines(vzdump_cmd, task_id=task_id):
                if line_str.startswith("__DONE__|"):
                    returncode = int(line_str.split("|", 1)[1])
                    continue
                if not line_str:
                    continue
                await ws.send_json({"type": "log", "level": "dim",
                                    "msg": "[PVE] " + line_str})
                if not remote_archive:
                    m = path_re.search(line_str)
                    if m:
                        remote_archive = m.group(1)
                        await ws.send_json({"type": "log", "level": "success",
                                            "msg": "检测到归档文件: " + remote_archive})

            if returncode != 0 or not remote_archive:
                db.task_update(task_id, status='failed')
                msg = f"vzdump 打包失败 (退出码: {returncode})"
                if not remote_archive:
                    msg += "，未检测到归档文件路径"
                await ws.send_json({"type": "finish", "status": "error", "msg": msg})
                return

            db.task_update(task_id, status='running', progress=50)
            await ws.send_json({"type": "phase", "phase": 1,
                                "msg": "打包完成", "path": remote_archive})

            # ============ Phase 2: rsync 下载 ============
            await ws.send_json({"type": "phase", "phase": 2, "msg": "开始 rsync 下载"})
            await ws.send_json({"type": "log", "level": "info",
                                "msg": "--- 阶段 2/2: rsync 下载归档 ---"})

            rsync_flags = ["-avPh"]
            argv, _ = run.build_rsync_argv("down", remote_archive, local_dir,
                                           flags=rsync_flags)
            await ws.send_json({"type": "log", "level": "cmd",
                                "msg": "  " + " ".join(argv)})

            progress_re = re.compile(r"\((\d+\.?\d*)%\)")
            speed_re = re.compile(r"(\d+\.?\d*\s*[A-Za-z]+/s)")

            r_returncode = None
            async for line_str in run.rsync_stream("down", remote_archive, local_dir,
                                                    flags=rsync_flags, task_id=task_id):
                if line_str.startswith("__DONE__|"):
                    r_returncode = int(line_str.split("|", 1)[1])
                    continue
                if not line_str:
                    continue
                pct_m = progress_re.search(line_str)
                speed_m = speed_re.search(line_str)
                if pct_m:
                    payload = {"type": "progress", "phase": 2,
                               "pct": float(pct_m.group(1))}
                    if speed_m:
                        payload["speed"] = speed_m.group(1).strip()
                    await ws.send_json(payload)
                else:
                    await ws.send_json({"type": "log", "level": "dim", "msg": line_str})

            if r_returncode != 0:
                db.task_update(task_id, status='failed')
                await ws.send_json({"type": "finish", "status": "error",
                                    "msg": f"rsync 下载失败 (退出码: {r_returncode})"})
                return

            db.task_update(task_id, status='completed')
            await ws.send_json({"type": "log", "level": "success",
                                "msg": "归档文件已下载至 " + local_dir})

            # ============ Phase 3 (可选): 清理远端 ============
            if auto_clean:
                await ws.send_json({"type": "log", "level": "info",
                                    "msg": "--- 阶段 3/3: 清理远端临时文件 ---"})
                try:
                    c, o, _ = await run.exec(f"rm -f '{remote_archive}'",
                                              timeout=30, merge_stderr=True)
                    if c == 0:
                        await ws.send_json({"type": "log", "level": "success",
                                            "msg": "已清理: " + remote_archive})
                    else:
                        safe = sanitize_output(o.strip(), _pwd(target), _key(target))
                        await ws.send_json({"type": "log", "level": "warn",
                                            "msg": "清理失败: " + safe})
                except Exception as e:
                    safe = sanitize_output(str(e), _pwd(target), _key(target))
                    await ws.send_json({"type": "log", "level": "warn",
                                        "msg": "清理异常: " + safe})

            # ============ v4.65.0 · C2 Post 钩子 (解锁/恢复服务) ============
            if post_hook:
                await ws.send_json({"type": "log", "level": "info",
                                    "msg": "🪝 Post 钩子: " + post_hook})
                rc_post, out_post, err_post = await run.exec(post_hook, timeout=120)
                for _ln in (out_post or "").splitlines()[:20]:
                    await ws.send_json({"type": "log", "level": "dim", "msg": "[post] " + _ln})
                if rc_post == 0:
                    await ws.send_json({"type": "log", "level": "success", "msg": "Post 钩子成功"})
                else:
                    await ws.send_json({"type": "log", "level": "warn",
                                        "msg": f"Post 钩子失败 (rc={rc_post}): {(err_post or out_post or '').strip()[-200:]} (备份本身已成功)"})

            await ws.send_json({"type": "finish", "status": "success",
                                "msg": f"vzdump 流水线完成！VM {vmid} 备份已下载至 {local_dir}"})

    except FileNotFoundError:
        db.task_update(task_id, status='failed')
        active_tasks.pop(task_id, None)
        await ws.send_json({"type": "finish", "status": "error",
                            "msg": "SSH 命令不可用"})
    except Exception as e:
        db.task_update(task_id, status='failed')
        active_tasks.pop(task_id, None)
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "finish", "status": "error",
                            "msg": "执行错误: " + safe})


async def handle_scan_storage(ws: WebSocket, data: dict):
    """Scan PVE storage configuration and discover all backup/backupable directories."""
    target = SSHTarget.from_ws_data(data)
    results = {"storages": [], "backup_dirs": [], "vm_disks_dirs": [], "dump_dirs": [],
               "disk_info": [], "storage_cfg": "", "pve_version": "", "is_pve": False}

    try:
        async with target.runner() as run:
            # Step 1: PVE 版本 + storage 状态 + storage.cfg + df
            cmd_ver = ("pveversion 2>/dev/null | head -5; "
                       "echo '---STORAGE_STATUS---'; pvesm status 2>/dev/null; "
                       "echo '---STORAGE_CFG---'; cat /etc/pve/storage.cfg 2>/dev/null | grep -v '^#' | grep -v '^$'; "
                       "echo '---DF---'; df -h 2>/dev/null")
            code, out, _ = await run.exec(cmd_ver, timeout=30, merge_stderr=True)
            all_dirs = set()

            if code == 0:
                sections = out.split("---STORAGE_STATUS---")
                version_section = sections[0] if sections else ""
                if "proxmox" in version_section.lower() or "pve-manager" in version_section.lower():
                    results["is_pve"] = True
                    for vline in version_section.strip().split("\n"):
                        vline = vline.strip()
                        if vline:
                            results["pve_version"] = vline
                            break

                if len(sections) > 1:
                    rest = sections[1]
                    ss_sections = rest.split("---STORAGE_CFG---")
                    status_text = ss_sections[0] if ss_sections else ""
                    cfg_text = ss_sections[1].split("---DF---")[0] if len(ss_sections) > 1 else ""
                    df_text = ss_sections[-1].split("---DF---")[-1] if len(ss_sections) > 1 else ""

                    results["storages"] = _parse_pvesm_status(status_text)
                    results["storage_cfg"] = cfg_text.strip()[:500]

                    for dline in df_text.strip().split("\n")[1:]:
                        if not dline.strip():
                            continue
                        parts = dline.split()
                        if len(parts) >= 6:
                            results["disk_info"].append({
                                "filesystem": parts[0], "size": parts[1],
                                "used": parts[2], "avail": parts[3],
                                "use_pct": parts[4], "mounted": parts[5]
                            })

                    # Step 2: 解析 storage.cfg 块
                    if cfg_text:
                        blocks = []
                        current_block = {}
                        for cline in cfg_text.strip().split("\n"):
                            cline = cline.strip()
                            if not cline or cline.startswith("#"):
                                continue
                            block_start = re.match(r'^(dir|nfs|cifs|btrfs|lvmthin|lvm|zfspool|rbd|glusterfs):\s*(\S+)', cline)
                            if block_start:
                                if current_block:
                                    blocks.append(current_block)
                                current_block = {
                                    "type": block_start.group(1),
                                    "name": block_start.group(2),
                                    "path": "", "content": ""
                                }
                            else:
                                m_path = re.match(r'path\s+(\S+)', cline)
                                if m_path and current_block:
                                    current_block["path"] = m_path.group(1)
                                m_content = re.match(r'content\s+(.*)', cline)
                                if m_content and current_block:
                                    current_block["content"] = m_content.group(1).strip()
                        if current_block:
                            blocks.append(current_block)

                        for blk in blocks:
                            base = blk.get("path", "").rstrip("/")
                            stype = blk.get("type", "")
                            scontent = blk.get("content", "")
                            sname = blk.get("name", "")
                            if not base:
                                continue
                            all_dirs.add(base)
                            if stype in ("dir", "nfs", "cifs", "btrfs"):
                                if "images" in scontent or "vztmpl" in scontent or "rootdir" in scontent:
                                    img_dir = base + "/images"
                                    if img_dir not in results["vm_disks_dirs"]:
                                        results["vm_disks_dirs"].append(img_dir)
                                    if base not in results["vm_disks_dirs"]:
                                        results["vm_disks_dirs"].append(base)
                                if "backup" in scontent:
                                    dump_dir = base + "/dump"
                                    if dump_dir not in results["dump_dirs"]:
                                        results["dump_dirs"].append(dump_dir)
                                    if dump_dir not in results["backup_dirs"]:
                                        results["backup_dirs"].append(dump_dir)
                                    if base not in results["dump_dirs"]:
                                        results["dump_dirs"].append(base)
                                    if base not in results["backup_dirs"]:
                                        results["backup_dirs"].append(base)

                            found = False
                            for s in results["storages"]:
                                if s.get("name") == sname:
                                    if not s.get("path") and base:
                                        s["path"] = base
                                    if not s.get("content") and scontent:
                                        s["content"] = scontent
                                    found = True
                                    break
                            if not found and stype in ("dir", "nfs", "cifs", "btrfs"):
                                results["storages"].append({
                                    "name": sname, "type": stype,
                                    "content": scontent, "status": "active",
                                    "path": base
                                })

                    # Step 3: pvesm 也可能有 path，补充
                    for s in results["storages"]:
                        if s.get("path"):
                            base = s["path"].rstrip("/")
                            all_dirs.add(base)
                            if s.get("type") in ("dir", "nfs", "cifs", "btrfs") and s.get("content"):
                                if "images" in s.get("content", "") or "vztmpl" in s.get("content", "") or "rootdir" in s.get("content", ""):
                                    img_dir = base + "/images"
                                    if img_dir not in results["vm_disks_dirs"]:
                                        results["vm_disks_dirs"].append(img_dir)
                                    if base not in results["vm_disks_dirs"]:
                                        results["vm_disks_dirs"].append(base)
                                if "backup" in s.get("content", ""):
                                    dump_dir = base + "/dump"
                                    if dump_dir not in results["dump_dirs"]:
                                        results["dump_dirs"].append(dump_dir)
                                    if dump_dir not in results["backup_dirs"]:
                                        results["backup_dirs"].append(dump_dir)
                                    if base not in results["dump_dirs"]:
                                        results["dump_dirs"].append(base)
                                    if base not in results["backup_dirs"]:
                                        results["backup_dirs"].append(base)

                # Step 4: 常见默认路径
                common_backup = [
                    "/var/lib/vz/dump/", "/var/lib/vz/backup/", "/var/backups/vzdump/",
                    "/mnt/backup/", "/mnt/data/backup/", "/backup/",
                    "/var/lib/vz/images/", "/var/lib/vz/template/",
                ]
                for cd in common_backup:
                    if cd not in results["backup_dirs"] and cd not in results["dump_dirs"] and cd not in results["vm_disks_dirs"]:
                        cc, co, _ = await run.exec(f"test -d {cd} && echo EXISTS",
                                                    timeout=10, merge_stderr=True)
                        if cc == 0 and "EXISTS" in co:
                            if "/dump" in cd or "/backup" in cd:
                                results["backup_dirs"].append(cd)
                                results["dump_dirs"].append(cd)
                            elif "/images" in cd or "/template" in cd:
                                results["vm_disks_dirs"].append(cd)
            else:
                # 非 PVE 或失败：探常见备份目录
                for cd in ["/var/lib/vz/dump/", "/backup/", "/mnt/backup/"]:
                    cc, co, _ = await run.exec(f"test -d {cd} && echo EXISTS",
                                                timeout=10, merge_stderr=True)
                    if cc == 0 and "EXISTS" in co:
                        results["backup_dirs"].append(cd)

            # Step 5: Fallback - 探子目录
            checked = set()
            for sd in list(all_dirs):
                sd = sd.rstrip("/")
                for sub in ("dump", "images", "backup", "template"):
                    subpath = sd + "/" + sub
                    if subpath in checked:
                        continue
                    checked.add(subpath)
                    cc, co, _ = await run.exec(f"test -d {subpath} && echo EXISTS",
                                                timeout=10, merge_stderr=True)
                    if cc == 0 and "EXISTS" in co:
                        if sub in ("dump", "backup"):
                            if subpath not in results["dump_dirs"]:
                                results["dump_dirs"].append(subpath)
                            if subpath not in results["backup_dirs"]:
                                results["backup_dirs"].append(subpath)
                        elif sub in ("images", "template"):
                            if subpath not in results["vm_disks_dirs"]:
                                results["vm_disks_dirs"].append(subpath)
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "storage_result", "status": "error", "msg": safe})
        return

    await ws.send_json({"type": "storage_result", "status": "ok", **results})


async def handle_scan_archives(ws: WebSocket, data: dict):
    target = SSHTarget.from_ws_data(data)
    remote_dir = (data.get("remote_dir") or "").strip()
    dir_hints = data.get("dir_hints", [])

    try:
        archives = []
        dirs_found = []

        if remote_dir:
            scan_dirs = [remote_dir]
        elif dir_hints:
            scan_dirs = dir_hints
        else:
            scan_dirs = [
                "/var/lib/vz/dump/", "/var/lib/vz/backup/", "/var/backups/vzdump/",
                "/mnt/backup/", "/mnt/data/backup/", "/backup/",
            ]

        async with target.runner() as run:
            # 预筛：只扫真实存在的目录
            existing_dirs = []
            for sd in scan_dirs:
                cc, co, _ = await run.exec(f"test -d {sd} && echo OK",
                                            timeout=10, merge_stderr=True)
                if cc == 0 and "OK" in co:
                    existing_dirs.append(sd)

            if not existing_dirs and not remote_dir:
                discover_cmd = ('find / -maxdepth 3 -type d '
                                '\\( -name "vzdump" -o -name "backup" -o -name "dumps" -o -name "vz_backup" \\) '
                                '2>/dev/null | head -20')
                dc, dout, _ = await run.exec(discover_cmd, timeout=15, merge_stderr=True)
                if dc == 0 and dout.strip():
                    for dline in dout.strip().split("\n"):
                        existing_dirs.append(dline.strip() + "/")

            for search_dir in existing_dirs:
                base = search_dir.rstrip("/")
                code2, out2, _ = await run.exec(f"ls -lh {base} 2>/dev/null",
                                                 timeout=30, merge_stderr=True)
                if code2 == 0 and out2.strip():
                    found2 = parse_ls_output(out2)
                    for f in found2:
                        if "path" in f and not f["path"].startswith("/"):
                            f["path"] = base + "/" + f["path"]
                    found2 = [f for f in found2
                              if _is_backup_file(f.get("raw_name", f.get("name", "")))]
                    if found2:
                        archives.extend(found2)
                        dirs_found.append(search_dir)

        # 去重
        seen = set()
        unique = []
        for a in archives:
            name = a.get("name", "") or a.get("raw_name", "")
            if name and name not in seen:
                seen.add(name)
                unique.append(a)

        await ws.send_json({"type": "archive_result", "status": "ok",
                            "archives": unique, "scan_dirs": dirs_found,
                            "total_dirs_checked": len(existing_dirs)})
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "archive_result", "status": "error", "msg": safe})


async def handle_download_archives(ws: WebSocket, data: dict, task_id):
    target = SSHTarget.from_ws_data(data)
    archives = data.get("archives", [])
    local_dir = (data.get("local_dir") or "").strip()
    bwlimit = data.get("bwlimit", "0")

    if not archives:
        await ws.send_json({"type": "finish", "status": "error", "msg": "未选择文件"})
        return

    if local_dir:
        try:
            os.makedirs(local_dir, exist_ok=True)
        except Exception as e:
            await ws.send_json({"type": "finish", "status": "error",
                                "msg": f"无法创建本地目录 {local_dir}: {e}"})
            return

    total = len(archives)
    rsync_flags = ["-avPh"]
    if bwlimit and bwlimit != "0":
        rsync_flags.append(f"--bwlimit={bwlimit}")

    try:
        async with target.runner() as run:
            for idx, arch in enumerate(archives, 1):
                remote_path = arch.get("path", "")
                if not remote_path:
                    continue

                await ws.send_json({
                    "type": "log", "level": "info",
                    "msg": f"[{idx}/{total}] 下载: {os.path.basename(remote_path)}",
                })

                progress_re = re.compile(r"\((\d+\.?\d*)%\)")
                speed_re = re.compile(r"(\d+\.?\d*\s*[A-Za-z]+/s)")

                returncode = None
                try:
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
                            payload = {"type": "progress", "pct": overall,
                                       "file": os.path.basename(remote_path)}
                            if speed_m:
                                payload["speed"] = speed_m.group(1).strip()
                            await ws.send_json(payload)
                        else:
                            await ws.send_json({"type": "log", "level": "dim",
                                                "msg": line_str})

                    if returncode == 0:
                        await ws.send_json({
                            "type": "log", "level": "success",
                            "msg": f"  ✓ {os.path.basename(remote_path)} 下载完成",
                        })
                    else:
                        await ws.send_json({
                            "type": "log", "level": "error",
                            "msg": f"  ✗ 下载失败 (码: {returncode})",
                        })

                    if task_id not in active_tasks:
                        break
                except Exception as e:
                    safe = sanitize_output(str(e), _pwd(target), _key(target))
                    await ws.send_json({"type": "log", "level": "error",
                                        "msg": "  错误: " + safe})
                    break
    finally:
        active_tasks.pop(task_id, None)
    await ws.send_json({"type": "finish", "status": "success",
                        "msg": f"下载完成，共 {total} 个文件"})
    # v4.20.0 · publish download.finished (vzdump 批量下载)
    try:
        from backend import events as _events
        _events.publish("download.finished", {
            "task_id": task_id, "type": "vzdump",
            "count": total, "local_dir": local_dir, "status": "success",
        })
    except Exception as _e:
        print(f"[vzdump] publish download.finished fail: {_e}")


async def handle_kill(ws: WebSocket, data: dict, task_id):
    await kill_process(task_id)
    await ws.send_json({"type": "log", "level": "warn", "msg": "进程已终止"})


async def handle_get_logs(ws: WebSocket, data: dict):
    """Get operation logs from file"""
    limit = data.get("limit", 200)
    records = get_operations_log(limit)
    await ws.send_json({"type": "op_logs", "records": records, "total": len(records)})


async def handle_clear_logs(ws: WebSocket, data: dict):
    """Clear operation log file"""
    clear_operations_log()
    await ws.send_json({"type": "log", "level": "info", "msg": "操作日志已清除"})
    # v6.3.33 · FIX(全面审计): 只发 log 帧 → 前端 send() 的**非流式结算白名单**里没有 'log'
    #   (app.js 非流式分支只认 result/error/各类 *_result), 于是 `clearOpLogs()` 的回调永不触发:
    #   用户看不到"已清除"提示、日志列表也不刷新(实测: 前端调用点 app.js:5570 依赖该回调)。
    #   这里补一条规范的 result 帧(显式回显 req_id), log 帧保留给日志区。
    await ws.send_json({"type": "result", "status": "ok",
                        "req_id": data.get("req_id") or "", "msg": "操作日志已清除"})

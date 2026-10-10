"""Fonriv - 双向同步冲突中心 (v4.63.0 · B2)

原理 (快照对比法):
  1. sync 前取上次快照 (上次同步完成时刻两边的清单)
  2. 本机当前 vs 快照 → 本机改动集; 远端当前 vs 快照 → 远端改动集
  3. 交集 = 冲突文件 (两边在两次同步之间都被改过)
  4. 按策略隔离后才开始两轮 rsync:
       keep-both(默认): 远端 cp 一份 <name>.conflict_<ts> → down 轮会把它带到本地, 两版都保
       keep-newer     : 维持 rsync -u 较新者胜, 只记录
       keep-local     : SSH rm 远端版本 → up 覆盖
       keep-remote    : 本地 rm → down 覆盖
  5. sync 完成后存新快照
"""
from __future__ import annotations

import os
import shlex
import time
from datetime import datetime

from fastapi import WebSocket, WebSocketDisconnect

from backend import db
from backend.db import sync_conflicts as scdb
from backend.ssh_lib import SSHTarget, ssh_error_msg
from backend.log import log_operation

_LIST_MAX = 20000


def _local_manifest(root: str) -> dict | None:
    """本机目录清单 {rel: [size, mtime]}"""
    out = {}
    root = root.rstrip("/")
    try:
        for cur, _dirs, files in os.walk(root):
            for fn in files:
                p = os.path.join(cur, fn)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                rel = p[len(root) + 1:]
                out[rel] = [st.st_size, int(st.st_mtime)]
                if len(out) > _LIST_MAX:
                    return None
    except Exception:
        return None
    return out


def _remote_manifest(target: SSHTarget, root: str) -> dict | None:
    """远端目录清单 (SSH find -printf)"""
    q = shlex.quote(root.rstrip("/"))
    cmd = (f"cd {q} 2>/dev/null && find . -type f -printf '%P\\t%s\\t%T@\\n' 2>/dev/null | "
           f"head -{_LIST_MAX + 1}")
    try:
        import asyncio

        async def _run():
            async with target.runner() as run:
                code, out, _e = await run.exec(cmd, timeout=120)
                return code, out
        loop = None
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            pass
        if loop is None:
            code, out = asyncio.run(_run())
        else:
            # 在 async 上下文里由调用方 await _run_manifest
            raise RuntimeError("async context")
        if code != 0:
            return None
    except RuntimeError:
        raise
    except Exception:
        return None
    files = {}
    for line in (out or "").splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        rel, sz, mt = parts
        try:
            files[rel] = [int(sz), int(float(mt))]
        except ValueError:
            continue
    if len(files) > _LIST_MAX:
        return None
    return files


async def _remote_manifest_async(target: SSHTarget, root: str) -> dict | None:
    q = shlex.quote(root.rstrip("/"))
    cmd = (f"cd {q} 2>/dev/null && find . -type f -printf '%P\\t%s\\t%T@\\n' 2>/dev/null | "
           f"head -{_LIST_MAX + 1}")
    try:
        async with target.runner() as run:
            code, out, _e = await run.exec(cmd, timeout=120)
    except Exception:
        return None
    if code != 0:
        return None
    files = {}
    for line in (out or "").splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        rel, sz, mt = parts
        try:
            files[rel] = [int(sz), int(float(mt))]
        except ValueError:
            continue
    if len(files) > _LIST_MAX:
        return None
    return files


def detect_conflicts(old_snap: dict | None, local_now: dict, remote_now: dict) -> list:
    """返回冲突 rel 列表: 快照存在且两边相对快照都有变化"""
    if not old_snap:
        return []
    conflicts = []
    for rel, [sz, mt] in local_now.items():
        old = old_snap.get(rel)
        if old is None:
            continue  # 新文件: 本机新增不算冲突 (远端新增若同名才冲突)
        if [sz, mt] != old:
            r_old = remote_now.get(rel)
            if r_old is not None and r_old != old:
                conflicts.append(rel)
    return conflicts


def isolate_keep_both(target: SSHTarget | None, remote_root: str, rels: list) -> list:
    """远端 cp 冲突副本 → sync 后经 down 轮带到本地 (两版都保)。返回成功隔离的 rel"""
    if not rels:
        return []
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    ok = []
    root = remote_root.rstrip("/")
    if target and target.host:
        import asyncio

        cmds = [f"cp -a {shlex.quote(root + '/' + r)} {shlex.quote(root + '/' + r)}.conflict_{ts} 2>&1 && echo OK_{i}"
                for i, r in enumerate(rels)]

        async def _run_all():
            results = []
            async with target.runner() as run:
                for i, cmd in enumerate(cmds):
                    code, out, _e = await run.exec(cmd, timeout=30)
                    results.append((code, out))
            return results
        try:
            results = asyncio.run(_run_all()) if not asyncio.get_event_loop().is_running() else []
        except RuntimeError:
            results = []
        for i, (code, out) in enumerate(results or []):
            if code == 0:
                ok.append(rels[i])
    else:
        # 纯本机对 (sync 两个本机路径): 直接本地 cp
        for r in rels:
            try:
                src = os.path.join(root, r)
                shutil_copy2(src, src + f".conflict_{ts}")
                ok.append(r)
            except Exception:
                continue
    return ok


def shutil_copy2(src, dst):
    import shutil
    shutil.copy2(src, dst)


# ── WS handlers ──

async def handle_sync_conflict_list(ws, data: dict):
    conn = db.get_conn()
    rows = scdb.conflict_list(conn, open_only=bool(data.get("open_only")))
    await ws.send_json({"type": "result", "status": "ok", "conflicts": rows})


async def handle_sync_conflict_resolve(ws, data: dict):
    _req_id = data.get("req_id") or ""
    cid = int(data.get("id") or 0)
    resolution = (data.get("resolution") or "resolved").strip()[:40]
    if not cid:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "缺少 id"})
        return
    conn = db.get_conn()
    ok = scdb.conflict_resolve(conn, cid, resolution)
    await ws.send_json({"type": "result", "status": "ok" if ok else "error",
                        "req_id": _req_id,
                        "msg": "已标记解决" if ok else "记录不存在"})


async def handle_sync_conflict_delete(ws, data: dict):
    _req_id = data.get("req_id") or ""
    cid = int(data.get("id") or 0)
    conn = db.get_conn()
    ok = scdb.conflict_delete(conn, cid)
    await ws.send_json({"type": "result", "status": "ok" if ok else "error",
                        "req_id": _req_id,
                        "msg": "已删除记录" if ok else "记录不存在"})

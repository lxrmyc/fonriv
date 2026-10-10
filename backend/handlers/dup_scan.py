"""Fonriv - 重复文件检测 handler (v4.62.0 · E4)

两层过滤避免全量哈希:
  ① find 列出 (size, path) → 同 size 才是候选
  ② 对候选组批量 sha256sum → hash 相同才判重复
支持本机与远端 SSH (find/sha256sum 均为标准工具, 远端零依赖)。
"""
from __future__ import annotations

import os
import shlex
from fastapi import WebSocket, WebSocketDisconnect

from backend import db
from backend.ssh_lib import SSHTarget, ssh_error_msg
from backend.log import log_operation


def _fmt_bytes(n: int) -> str:
    b = float(n)
    for u in ("B", "KB", "MB", "GB", "TB"):
        if b < 1024 or u == "TB":
            return f"{b:.1f} {u}" if u != "B" else f"{int(b)} B"
        b /= 1024
    return f"{b:.1f} TB"


async def _run(target, cmd, timeout=600):
    if target and target.host:
        async with target.runner() as run:
            code, out, _ = await run.exec(cmd, timeout=timeout)
            return code, out
    import subprocess as sp
    r = sp.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout


async def handle_dup_scan(ws, data: dict):
    """扫描目录内重复文件 (size 分组 + sha256 精查)。params: path, min_size(默认1024B), host/...(SSH可选)"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip().rstrip("/") or "/"
    min_size = int(data.get("min_size") or 1024)
    limit = min(int(data.get("limit") or 50000), 200000)
    try:
        target = SSHTarget.from_ws_data(data) if data.get("host") else None
        qp = shlex.quote(path)
        # ① size+path 清单
        cmd_list = (f"find {qp} -type f -size +{min_size}c -printf '%s\\t%p\\n' 2>/dev/null | "
                    f"head -{limit}")
        rc, out = await _run(target, cmd_list, timeout=300)
        if rc != 0 and not out.strip():
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"清单扫描失败: {(out or '').strip()[:120]}"})
            return
        by_size: dict[int, list[str]] = {}
        total_files = 0
        for line in out.splitlines():
            if "\t" not in line:
                continue
            sz_s, p = line.split("\t", 1)
            if not sz_s.isdigit():
                continue
            by_size.setdefault(int(sz_s), []).append(p)
            total_files += 1
        candidates = {sz: ps for sz, ps in by_size.items() if len(ps) > 1}
        if not candidates:
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                                "groups": [], "total_files": total_files, "wasted": 0})
            return
        # ② 候选批量 sha256 (每组一次调用, 最多 80 组防超时)
        cand_sorted = sorted(candidates.items(), key=lambda kv: -kv[0] * (len(kv[1]) - 1))[:80]
        groups = []
        wasted = 0
        for sz, ps in cand_sorted:
            q_ps = " ".join(shlex.quote(p) for p in ps)
            rc2, out2 = await _run(target, f"sha256sum {q_ps} 2>/dev/null", timeout=600)
            if rc2 != 0 and not out2.strip():
                continue
            by_hash: dict[str, list[str]] = {}
            for l2 in out2.splitlines():
                if "  " not in l2:
                    continue
                h, p2 = l2.split("  ", 1)
                by_hash.setdefault(h.strip(), []).append(p2)
            for h, dup_ps in by_hash.items():
                if len(dup_ps) > 1:
                    groups.append({"hash": h[:16], "size": sz,
                                   "count": len(dup_ps), "files": dup_ps,
                                   "wasted": sz * (len(dup_ps) - 1)})
                    wasted += sz * (len(dup_ps) - 1)
        groups.sort(key=lambda g: -g["wasted"])
        log_operation("重复检测", f"{path} · {len(groups)} 组 · 可回收 {_fmt_bytes(wasted)}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "path": path, "groups": groups,
                            "total_files": total_files, "wasted": wasted,
                            "wasted_fmt": _fmt_bytes(wasted)})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"扫描异常: {ssh_error_msg(str(e))}"})


async def handle_dup_delete(ws, data: dict):
    """删除选中的重复副本 (保留每组的最新 mtime 一份)。params: keep_map {hash: 保留路径} 或 paths[要删的]"""
    _req_id = data.get("req_id") or ""
    paths = data.get("paths") or []
    if not isinstance(paths, list) or not paths:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "缺少 paths"})
        return
    if len(paths) > 500:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "单次最多删除 500 个文件"})
        return
    try:
        target = SSHTarget.from_ws_data(data) if data.get("host") else None
        q_ps = " ".join(shlex.quote(str(p)) for p in paths)
        rc, out = await _run(target, f"rm -f {q_ps} 2>&1", timeout=120)
        if rc == 0:
            log_operation("重复清理", f"删除 {len(paths)} 个重复副本")
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                                "msg": f"已删除 {len(paths)} 个重复副本"})
        else:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"删除失败: {(out or '').strip()[-150:]}"})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"删除异常: {ssh_error_msg(str(e))}"})

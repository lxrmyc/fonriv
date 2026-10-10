"""v4.27.0 · 进程级 task 日志尾流式 buffer（tail -f）

内存里维护每个 task_id 的 lines deque + 单调递增 seq + subscriber ws 集合。
每次 append 会异步推送 {type:"task_log_push", task_id, seq, line} 给所有订阅者。

生命周期：
  - append(): rsync/platform 循环里每收到一行 stdout 就调用
  - subscribe(): WS handler task_log_subscribe 里挂载 ws
  - unsubscribe(): WS handler task_log_unsubscribe 或 ws 断开 / 任务结束
  - finalize(): 任务结束时打 finished 标记 + 空 subs（可保留 buffer 供后续 tail 一次性拉）
  - drop(): 手动清空一个 task_id（可选）
"""
from __future__ import annotations

import asyncio
from collections import deque
from typing import Any


# task_id -> {"lines": deque[(seq, line)], "seq": int, "subs": set, "finished": bool}
_BUFS: dict[str, dict[str, Any]] = {}
_MAX_LINES = 400


def _ensure(task_id: str) -> dict:
    b = _BUFS.get(task_id)
    if b is None:
        b = {"lines": deque(maxlen=_MAX_LINES), "seq": 0, "subs": set(), "finished": False}
        _BUFS[task_id] = b
    return b


def snapshot(task_id: str) -> tuple[list[dict], int, bool]:
    """(lines_list[{seq,line}], last_seq, finished)"""
    b = _BUFS.get(task_id)
    if not b:
        return [], 0, False
    lines = [{"seq": s, "line": ln} for (s, ln) in list(b["lines"])]
    return lines, b["seq"], b["finished"]


def append(task_id: str, line: str) -> int:
    """写入一行，返回新 seq。若有订阅者则 fire-and-forget 推送。"""
    if not task_id:
        return 0
    b = _ensure(task_id)
    b["seq"] += 1
    seq = b["seq"]
    b["lines"].append((seq, line))
    subs = list(b["subs"])
    if subs:
        payload = {"type": "task_log_push", "task_id": task_id, "seq": seq, "line": line}
        for ws in subs:
            try:
                # ws.send_json 是 async · 用 create_task 避免阻塞循环 · 任何异常都吞掉
                asyncio.create_task(_safe_send(ws, payload, task_id))
            except RuntimeError:
                # 无 running loop 或 ws 已废
                _discard_sub(task_id, ws)
    return seq


async def _safe_send(ws, payload: dict, task_id: str) -> None:
    try:
        await ws.send_json(payload)
    except Exception:
        _discard_sub(task_id, ws)


def _discard_sub(task_id: str, ws) -> None:
    b = _BUFS.get(task_id)
    if b:
        b["subs"].discard(ws)


def subscribe(task_id: str, ws) -> tuple[list[dict], int, bool]:
    """注册 ws · 返回当前 snapshot 供前端首屏。"""
    b = _ensure(task_id)
    b["subs"].add(ws)
    return snapshot(task_id)


def unsubscribe(task_id: str, ws) -> None:
    b = _BUFS.get(task_id)
    if b:
        b["subs"].discard(ws)


def unsubscribe_all(ws) -> int:
    """ws 断开时调用 · 从所有 task 移除该订阅者。返回被清理的 task 数。"""
    n = 0
    for tid, b in _BUFS.items():
        if ws in b["subs"]:
            b["subs"].discard(ws)
            n += 1
    return n


def finalize(task_id: str) -> None:
    """任务结束时调用 · 通知前端『流关闭』但 buffer 保留以供后拉。"""
    if not task_id:
        return
    b = _BUFS.get(task_id)
    if not b:
        return
    b["finished"] = True
    subs = list(b["subs"])
    payload = {"type": "task_log_push", "task_id": task_id, "seq": b["seq"], "line": None, "finished": True}
    for ws in subs:
        try:
            asyncio.create_task(_safe_send(ws, payload, task_id))
        except RuntimeError:
            _discard_sub(task_id, ws)


def drop(task_id: str) -> None:
    _BUFS.pop(task_id, None)


def stats() -> dict:
    """调试用。"""
    return {
        tid: {"lines": len(b["lines"]), "seq": b["seq"],
              "subs": len(b["subs"]), "finished": b["finished"]}
        for tid, b in _BUFS.items()
    }

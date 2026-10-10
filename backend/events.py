"""Fonriv - 进程内 WebSocket 事件推流 (v4.16.0 · v4.16.3 加跨线程支持)

前端 subscribe 主题后，后端在业务处理里 publish(topic, payload)，
所有订阅了该 topic 的 ws 都收到 {type:"event", topic, payload}。

设计要点：
* 单进程 uvicorn --workers=1 场景 → 只需 asyncio 内存 pubsub
* 通配符：订阅 "flow.*" 匹配 "flow.updated" 等（一层通配，够用）
* 断开自动清理：websocket_endpoint 的 finally 里调 unsubscribe_all(ws)
* publish 是同步的，兼容 async 上下文和工作线程（v4.16.3）
  - 主 asyncio 线程调用 → loop.create_task
  - 工作线程调用（如 flow_engine.run_flow）→ run_coroutine_threadsafe 到 main loop

暴露：
  set_main_loop(loop)          → 服务启动时由 server.py/ws.py 注入主 loop
  subscribe(ws, topic)         → 一个 ws 订阅一个 topic
  unsubscribe(ws, topic)       → 取消
  unsubscribe_all(ws)          → 断线时调
  publish(topic, payload)      → 广播（跨线程安全）
  list_topics()                → 调试
"""
from __future__ import annotations
import logging

import asyncio
import fnmatch
import threading
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional, Set

# ws -> set[topic]
_ws_subs: Dict[Any, Set[str]] = {}
# v4.21.0 · Python 回调订阅（供 alerting/审计等模块用，不经 ws）
_py_callbacks: List[Any] = []
# topic -> set[ws]（正向索引，加速 publish）
_topic_ws: Dict[str, Set[Any]] = {}
# v4.16.3 · 由服务器启动时注入的主 asyncio loop（用于跨线程 publish）
_main_loop: Optional[asyncio.AbstractEventLoop] = None

# v4.19.1 · 服务端环形缓冲最近事件（供前端启用事件日志时回放最近 N 条）
_RECENT_MAX = 500
_recent: Deque[Dict[str, Any]] = deque(maxlen=_RECENT_MAX)

# ═══════════════════════════════════════════════════════════════════════════
# v5.50.0 · 事件契约 v1 (P0-4)
#   topic 规范: <domain>.<entity>.<action>   例: hub.node.changed / transfer.job.progress
#   payload 信封: { v: 1, ts, seq, guid?, ...业务字段 }   seq 单调递增, 供前端检测丢包
#   兼容策略: 旧主题照旧投递(零改动 61 处 publish 调用点), 同时"双发"一份规范主题,
#             新前端与事件总线订阅规范主题; 旧前端继续收旧主题。
# ═══════════════════════════════════════════════════════════════════════════
EVENT_SCHEMA_VERSION = 1
_evt_seq = 0
_evt_seq_lock = threading.Lock()
# topic → 累计发布次数 (投递可观测: 由 core_status/事件页暴露)
_evt_stats: Dict[str, int] = {}
# 旧主题 → 规范主题（双发映射）; 新增事件请直接用 publish_event()
LEGACY_TOPIC_MAP: Dict[str, str] = {
    "transfer.progress": "transfer.job.progress",
    "profile.changed": "hub.node.changed",
    "conn.changed": "hub.conn.changed",
    "share.changed": "hub.share.changed",
    "remote.changed": "hub.cloud.changed",
}


def next_event_seq() -> int:
    """v5.50.0 · 递增事件序号（进程内单调, 供前端检测丢包/断线补拉游标）"""
    global _evt_seq
    with _evt_seq_lock:
        _evt_seq += 1
        return _evt_seq


def event_envelope(payload: Any = None) -> Dict[str, Any]:
    """v5.50.0 · 构造事件信封 {v, ts, seq} + 业务字段（dict 平铺, 其他类型放 data）"""
    env: Dict[str, Any] = {"v": EVENT_SCHEMA_VERSION, "ts": time.time(), "seq": next_event_seq()}
    if isinstance(payload, dict):
        env.update(payload)
    elif payload is not None:
        env["data"] = payload
    return env


def publish_event(domain: str, entity: str, action: str, payload: Any = None) -> int:
    """v5.50.0 · 规范发布入口: topic = <domain>.<entity>.<action>。
    payload 建议带 guid（前端按 guid 只重绘受影响行）。"""
    return publish("%s.%s.%s" % (domain, entity, action), event_envelope(payload))


# ═══════════════════════════════════════════════════════════════════════════
# v5.56.0 · C2 事件总线**档 3**: 进度类合并(100ms 窗口) + 投递计数 + 慢消费者背压
#   背景(评审): 大文件传输时进度事件高频(每秒数十条/job), 多条 job 并发时 WS 通道被
#   进度帧占满 → UI 卡顿、状态事件被挤后。档 3 的做法:
#     · **只合并进度类主题**(见 _COALESCE_SUFFIX): 同一 (topic, job) 在 100ms 窗口内
#       只发**最后一条**(进度是幂等快照, 丢中间帧不丢语义);
#     · **状态类主题一律不合并**(hub.node.changed / share.changed 等) —— 状态变化必须即时,
#       合并会制造"界面显示旧状态"的事故;
#     · 慢消费者(单连接待发 > SLOW_QUEUE 条)只对**进度帧**丢弃并计数, 状态帧永不丢;
#     · 计数: published / coalesced / delivered / slow_dropped / send_fail / pending, 由
#       events_stats 与核心运行状况暴露。
# ═══════════════════════════════════════════════════════════════════════════
_COALESCE_SUFFIX = ("progress", "progress_detail", "tick")
# 明确列出的高频进度主题 (fonr.job = FonrVFS 任务岛每个 job 的状态/进度快照, 按 id 合并安全:
#   同一 job 的窗口内最后一条即其最新状态, 终态(done/failed)不会丢)
_COALESCE_TOPICS = ("fonr.job", "transfer.job.progress", "job.progress")
COALESCE_WINDOW = 0.1        # 合并窗口(秒)
SLOW_QUEUE = 32              # 单连接在途待发条数阈值(超过即视为慢消费者)
_pending: Dict[str, Dict[str, Any]] = {}          # key=topic|job → 最新消息
_pending_lock = threading.Lock()
_flush_task: Optional[Any] = None
_flush_sched_ts = 0.0        # 工作线程排 flush 的节流时间戳
_ws_inflight: Dict[Any, int] = {}
_c2_stats: Dict[str, int] = {"published": 0, "coalesced": 0, "delivered": 0,
                             "slow_dropped": 0, "send_fail": 0, "flush_batches": 0}


def is_coalescible(topic: str) -> bool:
    """进度类主题才合并 (状态类永不合并)。"""
    t = (topic or "").lower()
    if t in _COALESCE_TOPICS:
        return True
    return any(t.endswith(s) for s in _COALESCE_SUFFIX) or ".progress" in t


def _job_key(payload: Any) -> str:
    if isinstance(payload, dict):
        for k in ("job_id", "task_id", "id", "name", "path"):
            if payload.get(k) not in (None, ""):
                return str(payload.get(k))
    return "-"


def _schedule_flush() -> None:
    """安排一次窗口后的 flush（幂等: 已有未完成的任务就不重复排）。

    v5.56.0 真机修正: 进度事件常由**工作线程**发布（任务/传输在线程里跑）。此时本线程没有
    running loop, 早期实现直接 `loop.create_task()` 会抛错并被吞 → 累积的进度帧**永远不 flush**,
    直到下一次主线程也发进度才顺带冲出去（表现为"线程驱动的任务进度卡住不动"）。
    正确做法: 工作线程用 `run_coroutine_threadsafe` 投递到主循环。
    """
    global _flush_task, _flush_sched_ts
    if _main_loop is None and _flush_task is None:
        pass
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None:
        try:
            if _flush_task is None or _flush_task.done():
                _flush_task = running.create_task(_flush_later())
        except Exception as e:
            logging.debug("events: flush 排程失败: %s", e)
        return
    # ── 工作线程: 投递到主循环(带节流, 避免每帧都排一个任务) ──
    if _main_loop is None:
        return
    now = time.time()
    if (now - _flush_sched_ts) < (COALESCE_WINDOW / 2.0):
        return
    _flush_sched_ts = now
    try:
        asyncio.run_coroutine_threadsafe(_flush_later(), _main_loop)
    except Exception as e:
        logging.debug("events: 工作线程 flush 排程失败: %s", e)


async def _flush_later() -> None:
    await asyncio.sleep(COALESCE_WINDOW)
    await flush_pending()


async def flush_pending() -> int:
    """把窗口内累积的进度帧各发一条(每个 topic+job 取最后一条)。返回发送条数。"""
    with _pending_lock:
        batch = list(_pending.values())
        _pending.clear()
    if not batch:
        return 0
    _c2_stats["flush_batches"] += 1
    sent = 0
    for item in batch:
        for ws in item["targets"]:
            if _ws_inflight.get(ws, 0) >= SLOW_QUEUE:
                _c2_stats["slow_dropped"] += 1      # 慢消费者: 进度帧可丢, 计数不静默
                continue
            if await _safe_send(ws, item["msg"]):
                sent += 1
    return sent


def bus_health() -> Dict[str, Any]:
    """档 3 可观测: 合并/投递/丢弃/慢消费者/待发。"""
    with _pending_lock:
        pend = len(_pending)
    return dict(_c2_stats, pending=pend, coalesce_window_ms=int(COALESCE_WINDOW * 1000),
                slow_queue=SLOW_QUEUE, subs_topics=len(_topic_ws))


def event_stats() -> Dict[str, Any]:
    """v5.50.0 · 事件总线健康度: 累计序号 + 各主题发布次数 + 内存缓冲长度
    v5.56.0 · 增加档 3 计数 (合并/投递/丢弃/慢消费者)"""
    return {"schema_version": EVENT_SCHEMA_VERSION, "seq": _evt_seq,
            "topics": dict(sorted(_evt_stats.items(), key=lambda kv: -kv[1])),
            "recent_len": len(_recent), "bus": bus_health()}


def _record_recent(topic: str, payload: Any, seq: Optional[int] = None) -> None:
    """v4.19.1 · 记录到环形缓冲。忽略高频 system.heartbeat 避免占位。
    v4.20.0 · 同时双写到 SQLite event_log 表（用于持久化查询）。
    v5.50.0 · 记录事件序号 seq（供断线后按游标补拉 replay）
    """
    if topic == "system.heartbeat" or topic == "system.stats":
        return
    try:
        _recent.append({"ts": time.time(), "topic": topic, "payload": payload,
                        "seq": seq if seq is not None else next_event_seq()})
    except Exception as e:
        print(f"[events] recent buffer append fail: {e}")
    # v4.20.0 · 双写 SQLite（懒导入避免循环）
    try:
        import json as _json
        from backend import db as _db
        _db.event_log_insert(time.time(), topic,
                             _json.dumps(payload, ensure_ascii=False, default=str))
    except Exception as e:
        print(f"[events] event_log_insert fail: {e}")


def replay(since_seq: int, limit: int = 500) -> List[Dict[str, Any]]:
    """v5.50.0 · 断线补偿: 返回 seq > since_seq 的最近事件（内存环形缓冲, 升序）。
    前端 WS 重连后带 last_seq 调用, 用于把错过的变更补齐（避免停留在旧状态）。"""
    try:
        since = int(since_seq or 0)
    except Exception:
        since = 0
    out = [r for r in list(_recent) if int(r.get("seq") or 0) > since]
    return out[-max(1, min(int(limit or 500), _RECENT_MAX)):]


def recent(limit: int = 100) -> List[Dict[str, Any]]:
    """v4.19.1 · 返回最近 limit 条事件（按时间升序）
    v4.20.0 · 优先从 SQLite 拉（服务重启后仍有历史），失败回落内存 deque。
    """
    limit = max(1, min(int(limit or 100), _RECENT_MAX))
    try:
        from backend import db as _db
        rows = _db.event_log_recent(limit)
        if rows:
            return rows
    except Exception as e:
        print(f"[events] recent from db fail, fallback deque: {e}")
    return list(_recent)[-limit:]


def set_main_loop(loop: asyncio.AbstractEventLoop) -> None:
    """服务启动时调用一次；用于工作线程 publish 时跨线程调度回 main loop"""
    global _main_loop
    _main_loop = loop


def subscribe(ws, topic: str) -> None:
    if not topic:
        return
    _ws_subs.setdefault(ws, set()).add(topic)
    _topic_ws.setdefault(topic, set()).add(ws)


def unsubscribe(ws, topic: str) -> None:
    s = _ws_subs.get(ws)
    if s and topic in s:
        s.discard(topic)
        if not s:
            _ws_subs.pop(ws, None)
    t = _topic_ws.get(topic)
    if t and ws in t:
        t.discard(ws)
        if not t:
            _topic_ws.pop(topic, None)


def unsubscribe_all(ws) -> None:
    topics = list(_ws_subs.get(ws, ()))
    for t in topics:
        unsubscribe(ws, t)


def _match_targets(topic: str) -> Set[Any]:
    """topic="flow.updated" → 命中订阅 flow.updated 的 ws + 订阅 flow.* 的 ws"""
    out: Set[Any] = set()
    # 精确
    for ws in _topic_ws.get(topic, ()):
        out.add(ws)
    # 通配（订阅键含 * 或 ?）
    for sub_topic, wss in _topic_ws.items():
        if ('*' in sub_topic or '?' in sub_topic) and fnmatch.fnmatchcase(topic, sub_topic):
            out.update(wss)
    return out


def publish(topic: str, payload: Any = None) -> int:
    """广播事件。返回派发到的 ws 数。
    v4.16.3 · 支持从工作线程调用：
      · async 上下文（有 running loop）→ loop.create_task
      · 工作线程（无 running loop）→ run_coroutine_threadsafe(_main_loop)
    v4.19.1 · 环形缓冲最近 N 条到 _recent（供 event_log_recent 拉取）
    """
    # v5.50.0 · 信封序号: 若 payload 已带 seq 则沿用(避免同一事件两个号), 否则现取一个
    _seq = payload.get("seq") if isinstance(payload, dict) else None
    if _seq is None:
        _seq = next_event_seq()
    _evt_stats[topic] = _evt_stats.get(topic, 0) + 1
    # v4.19.1 · 无论是否有订阅者都记录，供后续开启事件日志的客户端回放
    _record_recent(topic, payload, _seq)
    # v5.50.0 · 兼容双发: 旧主题 → 规范主题(topic 语义统一), 旧前端不受影响
    _alias = LEGACY_TOPIC_MAP.get(topic)
    if _alias:
        try:
            publish(_alias, payload if isinstance(payload, dict) and "seq" in payload
                    else event_envelope(payload))
        except Exception as e:
            print(f"[events] alias publish fail ({topic} → {_alias}): {e}")
    # v4.21.0 · Python 回调订阅（同步调用，供 alerting/审计）
    for cb in list(_py_callbacks):
        try:
            cb(topic, payload)
        except Exception as e:
            print(f"[events] py callback fail (topic={topic}): {e}")
    targets = _match_targets(topic)
    if not targets:
        return 0
    msg = {"type": "event", "topic": topic, "payload": payload}
    _c2_stats["published"] += 1

    # v5.56.0 C2 · 进度类合并: 同一 (topic, job) 在窗口内只留最后一条(进度是幂等快照)
    if is_coalescible(topic):
        key = "%s|%s" % (topic, _job_key(payload))
        with _pending_lock:
            _pending[key] = {"topic": topic, "msg": msg, "targets": targets}
            _c2_stats["coalesced"] += 1
        _schedule_flush()
        return len(targets)

    # 优先当前 running loop（async handler 内）
    running_loop = None
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError as _e: logging.debug("suppressed", exc_info=True)
    if running_loop is not None:
        for ws in targets:
            try:
                running_loop.create_task(_safe_send(ws, msg))
            except Exception as e:
                print(f"[events] create_task fail (topic={topic}): {e}")
        return len(targets)

    # 工作线程：走 main loop 的 threadsafe 派发
    if _main_loop is None:
        print(f"[events] publish '{topic}' 无 main loop（未 set_main_loop），丢弃 {len(targets)} 条消息")
        return 0
    for ws in targets:
        try:
            asyncio.run_coroutine_threadsafe(_safe_send(ws, msg), _main_loop)
        except Exception as e:
            print(f"[events] threadsafe schedule fail (topic={topic}): {e}")
    return len(targets)


async def _safe_send(ws, msg: dict) -> bool:
    # v4.96.0 · 先看连接状态: 已关闭的 socket 直接静默清理订阅
    #   (旧实现每次都尝试 send 并打印异常, 用户多标签页 + 断线重连后日志被刷屏)
    # v5.56.0 C2 · 返回是否送达 + 在途计数(慢消费者判定用)
    _ws_inflight[ws] = _ws_inflight.get(ws, 0) + 1
    try:
        try:
            from starlette.websockets import WebSocketState
            if getattr(ws, "client_state", None) not in (None, WebSocketState.CONNECTED):
                unsubscribe_all(ws)
                return False
            # v5.98.1 · 应用侧已发过 close(application_state != CONNECTED) 也别再 send ——
            # 否则 asyncio 会抛 Unexpected ASGI message 'websocket.send', after sending
            # 'websocket.close' 并**刷屏**(实测日志里成串出现, 淹没真异常)。
            if getattr(ws, "application_state", None) not in (None, WebSocketState.CONNECTED):
                unsubscribe_all(ws)
                return False
        except Exception:
            pass
        await ws.send_json(msg)
        _c2_stats["delivered"] += 1
        return True
    except Exception as e:
        # ws 断了 → 自动清理订阅，避免堆积 (仅提示一次级别, 不打全量堆栈)
        _c2_stats["send_fail"] += 1
        _m = str(e)
        _known_closed = ("websocket.close" in _m or "WebSocketDisconnected" in type(e).__name__
                         or _m.startswith("Unexpected ASGI message"))
        if _known_closed:
            _c2_stats["send_fail_closed"] = _c2_stats.get("send_fail_closed", 0) + 1   # 静默计数
        else:
            print(f"[events] send fail (topic={msg.get('topic')}): {type(e).__name__}: {_m[:120]}")
        unsubscribe_all(ws)
        return False
    finally:
        _n = _ws_inflight.get(ws, 1) - 1
        if _n <= 0:
            _ws_inflight.pop(ws, None)
        else:
            _ws_inflight[ws] = _n


def list_topics() -> dict:
    """调试用"""
    return {
        "topics": {t: len(wss) for t, wss in _topic_ws.items()},
        "ws_count": len(_ws_subs),
        "py_callbacks": len(_py_callbacks),
    }


# v4.21.0 · Python 回调订阅 API（供 alerting/审计模块用）
def subscribe_all(callback) -> None:
    """注册 Python 回调 · 每次 publish 都会同步调用 callback(topic, payload)。
    典型使用：alerting.start()、审计日志镜像等。
    """
    if callback not in _py_callbacks:
        _py_callbacks.append(callback)


def unsubscribe_py(callback) -> None:
    try:
        _py_callbacks.remove(callback)
    except ValueError as _e: logging.debug("suppressed", exc_info=True)
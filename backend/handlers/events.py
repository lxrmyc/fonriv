"""v4.16.0 · WebSocket 事件订阅 handler

前端 → {action:"subscribe", topic:"flow.*"} → 后端订阅
前端 → {action:"unsubscribe", topic:"flow.*"} → 取消
后端 publish 走 backend/events.py 完成。
"""
from backend import events


async def _reply(ws, payload):
    await ws.send_json(payload)


async def handle_subscribe(ws, data):
    """订阅一个或多个主题：{topic:"flow.*"} 或 {topics:["a","b"]}"""
    try:
        topics = []
        if data.get("topic"):
            topics.append(str(data["topic"]))
        if isinstance(data.get("topics"), list):
            topics.extend(str(t) for t in data["topics"] if t)
        for t in topics:
            events.subscribe(ws, t)
        await _reply(ws, {"type": "result", "status": "ok", "subscribed": topics})
    except Exception as e:
        print("[events] subscribe error:", e)
        await _reply(ws, {"type": "result", "status": "err", "msg": str(e)})


async def handle_unsubscribe(ws, data):
    """取消订阅"""
    try:
        topics = []
        if data.get("topic"):
            topics.append(str(data["topic"]))
        if isinstance(data.get("topics"), list):
            topics.extend(str(t) for t in data["topics"] if t)
        if not topics:
            # 空 → 全清
            events.unsubscribe_all(ws)
            topics = ["*ALL*"]
        else:
            for t in topics:
                events.unsubscribe(ws, t)
        await _reply(ws, {"type": "result", "status": "ok", "unsubscribed": topics})
    except Exception as e:
        print("[events] unsubscribe error:", e)
        await _reply(ws, {"type": "result", "status": "err", "msg": str(e)})


async def handle_event_debug(ws, data):
    """调试用：查看当前进程内订阅拓扑"""
    await _reply(ws, {"type": "result", "status": "ok", "info": events.list_topics()})


async def handle_event_log_recent(ws, data):
    """v4.19.1 · 返回服务端环形缓冲里最近 N 条事件（供前端启用事件日志时回放）"""
    try:
        limit = int(data.get("limit") or 100)
    except Exception:
        limit = 100
    await _reply(ws, {"type": "result", "status": "ok", "events": events.recent(limit)})


async def handle_event_log_query(ws, data):
    """v4.21.0 · 分页查询事件历史（SQLite）"""
    from backend import db as _db
    try:
        page = int(data.get("page") or 1)
        page_size = int(data.get("page_size") or 100)
        topic_like = data.get("topic_like") or None
        since_ts = data.get("since_ts")
        until_ts = data.get("until_ts")
        if since_ts is not None: since_ts = float(since_ts)
        if until_ts is not None: until_ts = float(until_ts)
        result = _db.event_log_query(page, page_size, topic_like, since_ts, until_ts)
        await _reply(ws, {"type": "result", "status": "ok", **result})
    except Exception as e:
        await _reply(ws, {"type": "result", "status": "error", "msg": str(e)})


async def handle_event_log_fts_search(ws, data):
    """v4.23.0 · FTS5 全文搜索 event_log.payload_json"""
    from backend import db as _db
    try:
        q = str(data.get("query", "")).strip()
        if not q:
            await _reply(ws, {"type": "result", "status": "error", "msg": "query 不能为空"})
            return
        limit = int(data.get("limit") or 100)
        topic_like = data.get("topic_like") or None
        since_ts = data.get("since_ts")
        if since_ts is not None: since_ts = float(since_ts)
        events = _db.event_log_fts_search(q, limit, topic_like, since_ts)
        await _reply(ws, {"type": "result", "status": "ok",
                          "events": events, "count": len(events)})
    except Exception as e:
        await _reply(ws, {"type": "result", "status": "error", "msg": str(e)})

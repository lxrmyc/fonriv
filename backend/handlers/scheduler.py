"""Fonriv - 定时计划 WS handlers (v2.9.0 · v4.16.1 加事件推流)"""
import logging

from backend import scheduler as _sched
from backend.auth import _require_admin


# v4.16.1 · 事件推流：schedule.* 主题
def _pub(topic: str, payload=None):
    try:
        from backend import events
        events.publish(topic, payload)
    except Exception as e:
        print(f"[scheduler] publish {topic} fail: {e}")


async def handle_schedule_list(ws, data):
    schedules = _sched.schedule_list()
    await ws.send_json({"type": "schedule_list", "status": "ok", "schedules": schedules})


async def handle_schedule_create(ws, data):
    if not await _require_admin(ws):
        return
    name = (data.get("name") or "").strip()
    cron_expr = (data.get("cron_expr") or "").strip()
    # 用 action_type 避免与 WS dispatch key "action" 冲突
    action = (data.get("action_type") or "noop").strip()
    params = dict(data.get("params") or {})
    # v4.47.0 P2 · 多时间段表达式数组 (可选; 非空时优先于 cron_expr)
    times = [str(t).strip() for t in (data.get("times") or []) if str(t).strip()]
    # v4.7.0: 记录创建者 user_id · 派发时透传给 headless ws
    from backend.auth import _get_user_id as _auth_uid
    params.setdefault("_owner_user_id", _auth_uid(ws))
    if not name or not cron_expr:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 name / cron_expr"})
        return
    try:
        sid = _sched.schedule_create(name, cron_expr, action, params, enabled=True, times=times)
        await ws.send_json({"type": "result", "status": "ok", "id": sid,
                            "msg": f"定时任务 #{sid} 已创建"})
        _pub("schedule.created", {"id": sid, "name": name})
    except (ValueError, RuntimeError) as e:
        await ws.send_json({"type": "result", "status": "error", "msg": str(e)})


async def handle_schedule_update(ws, data):
    if not await _require_admin(ws):
        return
    sid = data.get("id")
    if not sid:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 id"})
        return
    kwargs = {}
    for k in ("name", "cron_expr", "enabled"):
        if k in data:
            kwargs[k] = data[k]
    if "action_type" in data:
        kwargs["action"] = data["action_type"]
    if "params" in data:
        kwargs["params_json"] = data["params"]
    # v4.47.0 P2 · 多时间段
    if "times" in data:
        kwargs["times_json"] = [str(t).strip() for t in (data.get("times") or []) if str(t).strip()]
    try:
        _sched.schedule_update(int(sid), **kwargs)
        await ws.send_json({"type": "result", "status": "ok", "msg": f"任务 #{sid} 已更新"})
        _pub("schedule.updated", {"id": int(sid)})
    except (ValueError, RuntimeError) as e:
        await ws.send_json({"type": "result", "status": "error", "msg": str(e)})


async def handle_schedule_cron_preview(ws, data):
    """v4.47.0 P2 · cron 预览: 校验表达式并返回未来 N 次运行时间。

    入参: expr(单表达式) 或 times(表达式数组) · count(默认 5, 上限 20)
    出参: {status, valid, invalid:[...], next:[...], desc}
    """
    from croniter import croniter
    from datetime import datetime, timedelta
    expr = (data.get("expr") or "").strip()
    times = [str(t).strip() for t in (data.get("times") or []) if str(t).strip()]
    exprs = times or ([expr] if expr else [])
    try:
        count = max(1, min(20, int(data.get("count") or 5)))
    except (TypeError, ValueError):
        count = 5
    if not exprs:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 expr / times"})
        return
    invalid = [e for e in exprs if not croniter.is_valid(e)]
    if invalid:
        await ws.send_json({"type": "result", "status": "ok", "valid": False,
                            "invalid": invalid, "next": [],
                            "msg": "无效表达式: " + "; ".join(invalid)})
        return
    # 多表达式并集展开未来 count 次 (每条各展开再归并取前 N)
    now = datetime.now()
    horizon = now + timedelta(days=400)  # 展开上限, 防低频表达式死循环
    merged = []
    for e in exprs:
        it = croniter(e, now)
        for _ in range(count * 3):  # 每条多取些再归并
            nxt = it.get_next(datetime)
            if nxt > horizon:
                break
            merged.append((nxt, e))
    merged.sort(key=lambda x: x[0])
    await ws.send_json({"type": "result", "status": "ok", "valid": True,
                        "next": [t.strftime("%Y-%m-%d %H:%M:%S") for t, _ in merged[:count]],
                        "exprs": exprs})


async def handle_schedule_delete(ws, data):
    if not await _require_admin(ws):
        return
    sid = data.get("id")
    if not sid:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 id"})
        return
    _sched.schedule_delete(int(sid))
    await ws.send_json({"type": "result", "status": "ok", "msg": f"任务 #{sid} 已删除"})
    _pub("schedule.deleted", {"id": int(sid)})


async def handle_schedule_run_now(ws, data):
    if not await _require_admin(ws):
        return
    sid = data.get("id")
    if not sid:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 id"})
        return
    result = await _sched._run_now(int(sid))
    await ws.send_json({"type": "result", **result})
    _pub("schedule.run.finished", {"id": int(sid), "status": result.get("status", "?")})


async def handle_schedule_runs(ws, data):
    """v4.6.0: 列出某任务的运行历史（最多 limit 条，默认 50）。
    v4.15.10: 若不传 id / id=0，则返回全部任务最近 limit 条（含任务名）"""
    sid = data.get("id")
    limit = int(data.get("limit") or 50)
    if not sid or int(sid) <= 0:
        # 全局最近运行（无任务空态用）
        conn = _sched._db.get_conn()
        try:
            rows = conn.execute(
                "SELECT r.id, r.schedule_id, s.name AS sched_name, s.action, "
                "       r.started_at, r.ended_at, r.status, r.trigger, r.duration_ms, r.msg "
                "FROM schedule_runs r LEFT JOIN schedules s ON s.id=r.schedule_id "
                "ORDER BY r.id DESC LIMIT ?",
                (limit,),
            ).fetchall()
            runs = [dict(r) for r in rows]
        except Exception as e:
            print("[schedule_runs] global fetch error:", e)
            runs = []
        await ws.send_json({
            "type": "schedule_runs", "status": "ok",
            "schedule_id": 0, "runs": runs,
        })
        return
    runs = _sched.runs_list(int(sid), limit)
    await ws.send_json({
        "type": "schedule_runs", "status": "ok",
        "schedule_id": int(sid), "runs": runs,
    })


async def handle_schedule_timeline(ws, data):
    """v4.10.0: 调度看板 24h 时间轴数据。

    Params:
      window_hours: int (默认 12) · 前后各多少小时
      future_max:   int (默认 20) · 每任务展开的未来触发上限
    Returns:
      { schedules: [{id, name, action, cron_expr, enabled,
                     past: [{started_at, ended_at, status, trigger, duration_ms}],
                     future: ["YYYY-MM-DDTHH:MM:SS", ...]}],
        window: { start, now, end } (ISO) }
    """
    from datetime import datetime, timedelta
    try:
        window_hours = int(data.get("window_hours") or 12)
    except (TypeError, ValueError):
        window_hours = 12
    window_hours = max(1, min(72, window_hours))
    try:
        future_max = int(data.get("future_max") or 20)
    except (TypeError, ValueError):
        future_max = 20
    future_max = max(1, min(100, future_max))

    now = datetime.now()
    start = now - timedelta(hours=window_hours)
    end = now + timedelta(hours=window_hours)
    end_str = end.strftime("%Y-%m-%d %H:%M:%S")
    start_str = start.strftime("%Y-%m-%d %H:%M:%S")

    scheds = _sched.schedule_list()
    out = []
    # 惰性 import croniter (可选依赖 · 已在 scheduler 里 try 过)
    try:
        from croniter import croniter
    except ImportError:
        croniter = None

    conn = _sched._db.get_conn()
    try:
        for s in scheds:
            sid = s["id"]
            # past: 起点起的所有 runs
            rows = conn.execute(
                "SELECT id, started_at, ended_at, status, trigger, duration_ms, msg "
                "FROM schedule_runs "
                "WHERE schedule_id=? AND started_at>=? "
                "ORDER BY started_at ASC",
                (sid, start_str),
            ).fetchall()
            past = []
            for r in rows:
                past.append({
                    "id": r["id"],
                    "started_at": r["started_at"],
                    "ended_at": r["ended_at"],
                    "status": r["status"],
                    "trigger": r["trigger"],
                    "duration_ms": r["duration_ms"],
                    "msg": (r["msg"] or "")[:120],
                })
            # future: 用 croniter 从 now 展开
            future = []
            if croniter and s.get("cron_expr") and s.get("enabled"):
                try:
                    it = croniter(s["cron_expr"], now)
                    for _ in range(future_max):
                        nxt = it.get_next(datetime)
                        if nxt > end:
                            break
                        future.append(nxt.strftime("%Y-%m-%d %H:%M:%S"))
                except (ValueError, KeyError) as _e: logging.debug("suppressed", exc_info=True)
            out.append({
                "id": sid,
                "name": s["name"],
                "action": s.get("action"),
                "cron_expr": s.get("cron_expr"),
                "enabled": bool(s.get("enabled")),
                "past": past,
                "future": future,
            })
    finally:
        pass  # 共享连接 · 不关闭

    await ws.send_json({
        "type": "schedule_timeline", "status": "ok",
        "window": {
            "start": start_str,
            "now": now.strftime("%Y-%m-%d %H:%M:%S"),
            "end": end_str,
            "hours": window_hours,
        },
        "schedules": out,
    })

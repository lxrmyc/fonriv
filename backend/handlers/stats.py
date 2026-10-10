"""Fonriv - 统计与智能分析 WS handler (v4.67.0 · E1/E2)"""
from __future__ import annotations

from backend import db
from backend import stats as st


async def handle_stats_overview(ws, data: dict):
    """概览: 最近运行记录 + 异常列表 + 时间推荐"""
    conn = db.get_conn()
    st.ensure_table(conn)
    limit = min(int(data.get("limit") or 30), 200)
    rows = conn.execute(
        "SELECT * FROM run_stats ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    recent = [dict(r) for r in rows]
    await ws.send_json({
        "type": "result", "status": "ok",
        "recent": recent,
        "anomalies": st.recent_anomalies(20),
        "recommend": st.recommend_window(),
        "kinds": sorted({r["kind"] for r in recent}) if recent else [],
    })


async def handle_stats_baseline(ws, data: dict):
    """某类任务/目标的基线统计"""
    kind = (data.get("kind") or "").strip()
    target = (data.get("target") or "").strip()
    if not kind:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 kind"})
        return
    b = st.baseline(kind, target)
    await ws.send_json({"type": "result", "status": "ok", "baseline": b,
                        "hourly": st.speed_by_hour(kind)})


async def handle_stats_recommend(ws, data: dict):
    """E2 · 智能时间推荐"""
    await ws.send_json({"type": "result", "status": "ok",
                        "recommend": st.recommend_window(),
                        "hourly": st.speed_by_hour(data.get("kind") or "")})

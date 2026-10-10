"""Fonriv · v3.3.7 db.sessions: API 会话 bearer tokens"""
from __future__ import annotations


API_SESSION_TTL_HOURS = 24 * 7  # 7 天


def api_session_create(conn, token: str, user_id: int, username: str, role: str = 'user'):
    conn.execute(
        "INSERT OR REPLACE INTO api_sessions (token,user_id,username,role) VALUES (?,?,?,?)",
        (token, user_id, username, role),
    )
    conn.commit()


def api_session_get(conn, token: str):
    """返回 dict 或 None；命中即更新 last_used_at"""
    if not token:
        return None
    row = conn.execute(
        "SELECT token,user_id,username,role,created_at,last_used_at FROM api_sessions WHERE token=?",
        (token,),
    ).fetchone()
    if not row:
        return None
    conn.execute(
        "UPDATE api_sessions SET last_used_at=datetime('now','localtime') WHERE token=?",
        (token,),
    )
    conn.commit()
    return dict(row)


def api_session_delete(conn, token: str):
    conn.execute("DELETE FROM api_sessions WHERE token=?", (token,))
    conn.commit()


def api_session_gc(conn, ttl_hours: int = API_SESSION_TTL_HOURS):
    """清理超过 TTL 的会话"""
    conn.execute(
        "DELETE FROM api_sessions WHERE datetime(last_used_at, '+' || ? || ' hours') < datetime('now','localtime')",
        (ttl_hours,),
    )
    conn.commit()

"""Fonriv · v3.3.5 db.logs: 日志表 CRUD"""
from __future__ import annotations


def log_create(conn, level: str, category: str, message: str, detail: str = '',
               task_id: str = '', user_id: int = 1):
    conn.execute("""
        INSERT INTO logs (level, category, message, detail, task_id, user_id)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (level, category, message, detail, task_id, user_id))
    conn.commit()


def log_list(conn, category: str = '', limit: int = 200, user_id: int = 1) -> list:
    if category:
        rows = conn.execute(
            "SELECT * FROM logs WHERE user_id=? AND category=? ORDER BY id DESC LIMIT ?",
            (user_id, category, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM logs WHERE user_id=? ORDER BY id DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]

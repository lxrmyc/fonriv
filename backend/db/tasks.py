"""Fonriv · v3.3.4 db.tasks: 任务表 CRUD"""
from __future__ import annotations


def task_create(conn, task_id: str, name: str, task_type: str,
                user_id: int = 1, command: str = '') -> int:
    """创建任务（若 task_id 已存在则重置为 running）"""
    cur = conn.execute("""
        INSERT INTO tasks (task_id, name, type, command, user_id, status)
        VALUES (?, ?, ?, ?, ?, 'running')
        ON CONFLICT(task_id) DO UPDATE SET
            name=excluded.name,
            type=excluded.type,
            command=excluded.command,
            status='running',
            progress=0,
            log_output='',
            finished_at=NULL
    """, (task_id, name, task_type, command, user_id))
    task_db_id = cur.lastrowid
    conn.commit()
    return task_db_id


def task_update(conn, task_id: str, **kwargs):
    allowed = ['status', 'progress', 'log_output', 'started_at', 'finished_at']
    sets, vals = [], []
    for col in allowed:
        if col in kwargs:
            sets.append(f'{col}=?')
            vals.append(kwargs[col])
    if sets:
        vals.append(task_id)
        conn.execute(f"UPDATE tasks SET {','.join(sets)} WHERE task_id=?", vals)
    conn.commit()


def task_list(conn, user_id: int = 1, limit: int = 50) -> list:
    rows = conn.execute(
        "SELECT * FROM tasks WHERE user_id=? ORDER BY id DESC LIMIT ?",
        (user_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def task_get(conn, task_id: str, user_id: int = 1):
    row = conn.execute(
        "SELECT * FROM tasks WHERE task_id=? AND user_id=?", (task_id, user_id)
    ).fetchone()
    return dict(row) if row else None

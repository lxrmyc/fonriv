"""Fonriv · v3.3.6 db.backups: 备份记录 CRUD
v4.39.0: 自动生成 uuid,支持 uuid 查询
"""
from __future__ import annotations
from typing import Optional


def backup_create(conn, config_id, source: str, destination: str,
                  backup_type: str, task_id: str = '', user_id: int = 1,
                  *, config_uuid: Optional[str] = None) -> int:
    """v4.39.0: 自动生成 uuid。config_uuid 可选,存到 config_uuid 列(Phase 2 FK 迁移后)。"""
    from backend.db.uuidv7 import uuidv7 as _uuidv7
    _uuid = _uuidv7()
    # v4.39.0: 若传了 config_uuid,同时写入(新列,Phase 2 用)
    try:
        cur = conn.execute("""
            INSERT INTO backups (uuid, config_id, source, destination, type, task_id, user_id, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'running')
        """, (_uuid, config_id, source, destination, backup_type, task_id, user_id))
    except Exception:
        # 兜底:老库无 uuid 列
        cur = conn.execute("""
            INSERT INTO backups (config_id, source, destination, type, task_id, user_id, status)
            VALUES (?, ?, ?, ?, ?, ?, 'running')
        """, (config_id, source, destination, backup_type, task_id, user_id))
    backup_id = cur.lastrowid
    conn.commit()
    return backup_id


def backup_update(conn, backup_id: int, **kwargs):
    allowed = ['status', 'size_bytes', 'file_count', 'error_message', 'finished_at',
               'sha256', 'verified_at']
    sets, vals = [], []
    for col in allowed:
        if col in kwargs:
            sets.append(f'{col}=?')
            vals.append(kwargs[col])
    if sets:
        vals.append(backup_id)
        conn.execute(f"UPDATE backups SET {','.join(sets)} WHERE id=?", vals)
    conn.commit()


def backup_list(conn, user_id: int = 1, limit: int = 100) -> list:
    # v5.22.0 · G5: user_id=None → 全量 (admin)
    if user_id is None:
        rows = conn.execute(
            "SELECT * FROM backups ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM backups WHERE user_id=? ORDER BY id DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]

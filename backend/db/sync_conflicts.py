"""Fonriv - 双向同步冲突中心 db 层 (v4.63.0 · B2)

sync_snapshots:  同步对 (本地src, 远端dst, host) 的文件清单快照 {rel: [size, mtime]}
sync_conflicts:  冲突记录 (两边都改过的文件) + 解决状态
"""
from __future__ import annotations

import json

_SNAP_MAX = 20000  # 清单条数上限, 超出返回 None (安全降级)


def ensure_tables(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sync_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT 1,
            src_path TEXT NOT NULL,
            dst_path TEXT NOT NULL,
            host TEXT DEFAULT '',
            files_json TEXT DEFAULT '{}',
            taken_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sync_conflicts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT 1,
            src_path TEXT DEFAULT '',
            dst_path TEXT DEFAULT '',
            host TEXT DEFAULT '',
            rel_path TEXT NOT NULL,
            side TEXT DEFAULT 'both',
            local_mtime TEXT DEFAULT '',
            remote_mtime TEXT DEFAULT '',
            size INTEGER DEFAULT 0,
            resolution TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            resolved_at TEXT DEFAULT ''
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sync_conflicts_open ON sync_conflicts(resolution, id)")


# ── 快照 ──

def snapshot_get(conn, src_path: str, dst_path: str, host: str) -> dict | None:
    ensure_tables(conn)
    row = conn.execute(
        """SELECT files_json FROM sync_snapshots
           WHERE src_path=? AND dst_path=? AND host=?
           ORDER BY id DESC LIMIT 1""",
        (src_path, dst_path, host or "")).fetchone()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except Exception:
        return None


def snapshot_put(conn, src_path: str, dst_path: str, host: str, files: dict, user_id: int = 1):
    ensure_tables(conn)
    if len(files) > _SNAP_MAX:
        return False  # 超限不存
    # 同一对只留最近 2 份 (防膨胀)
    conn.execute(
        """DELETE FROM sync_snapshots WHERE id IN (
             SELECT id FROM sync_snapshots WHERE src_path=? AND dst_path=? AND host=?
             ORDER BY id DESC LIMIT -1 OFFSET 2)""",
        (src_path, dst_path, host or ""))
    conn.execute(
        "INSERT INTO sync_snapshots (user_id, src_path, dst_path, host, files_json) VALUES (?,?,?,?,?)",
        (user_id, src_path, dst_path, host or "", json.dumps(files, ensure_ascii=False)))
    conn.commit()
    return True


# ── 冲突记录 ──

def conflict_add(conn, rel_path: str, src_path: str, dst_path: str, host: str,
                 local_mtime: str = "", remote_mtime: str = "", size: int = 0,
                 user_id: int = 1) -> int:
    ensure_tables(conn)
    cur = conn.execute(
        """INSERT INTO sync_conflicts
           (user_id, src_path, dst_path, host, rel_path, local_mtime, remote_mtime, size)
           VALUES (?,?,?,?,?,?,?,?)""",
        (user_id, src_path, dst_path, host or "", rel_path,
         local_mtime, remote_mtime, size))
    conn.commit()
    return cur.lastrowid


def conflict_list(conn, user_id: int = 1, open_only: bool = False, limit: int = 100) -> list:
    ensure_tables(conn)
    where = "user_id=?" + (" AND resolution=''" if open_only else "")
    rows = conn.execute(
        f"SELECT * FROM sync_conflicts WHERE {where} ORDER BY id DESC LIMIT ?",
        (user_id, limit)).fetchall()
    return [dict(r) for r in rows]


def conflict_resolve(conn, cid: int, resolution: str) -> bool:
    ensure_tables(conn)
    cur = conn.execute(
        "UPDATE sync_conflicts SET resolution=?, resolved_at=datetime('now','localtime') WHERE id=?",
        (resolution, cid))
    conn.commit()
    return cur.rowcount > 0


def conflict_delete(conn, cid: int) -> bool:
    ensure_tables(conn)
    cur = conn.execute("DELETE FROM sync_conflicts WHERE id=?", (cid,))
    conn.commit()
    return cur.rowcount > 0

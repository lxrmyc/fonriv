"""Fonriv - 实时同步守护 db 层 (v4.59.0)

watch_rules: 监控规则 (src 本机路径 → dst 本机或远端, inotify 事件防抖后 rsync 增量)
watch_events: 事件流 (inotify 触发 + 同步结果, 供前端实时展示与审计)
敏感字段 password 走 db.crypto 门面加密。
"""
from __future__ import annotations

RULE_FIELDS = [
    'name', 'src_path', 'dst_path', 'host', 'port', 'user',
    'auth_type', 'password', 'key',
    'exclude', 'debounce', 'delete_extra',
]
RULE_ENCRYPTED = ['password']


def _get_crypto():
    from backend import db as _db
    fernet = _db._get_fernet()
    from backend.db.crypto import encrypt_value, decrypt_value
    return fernet, encrypt_value, decrypt_value


def _encrypt_rule(data: dict) -> dict:
    fernet, enc, _ = _get_crypto()
    out = dict(data)
    for k in RULE_ENCRYPTED:
        if k in out and out[k]:
            out[k] = enc(fernet, str(out[k]))
    return out


def _decrypt_rule(row: dict) -> dict:
    fernet, _, dec = _get_crypto()
    out = dict(row)
    for k in RULE_ENCRYPTED:
        if out.get(k):
            try:
                out[k] = dec(fernet, out[k])
            except Exception:
                pass
    return out


def _ensure_tables(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS watch_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT 1,
            name TEXT NOT NULL,
            src_path TEXT NOT NULL,
            dst_path TEXT NOT NULL,
            host TEXT DEFAULT '',
            port TEXT DEFAULT '22',
            user TEXT DEFAULT 'root',
            auth_type TEXT DEFAULT 'pass',
            password TEXT DEFAULT '',
            key TEXT DEFAULT '',
            exclude TEXT DEFAULT '',
            debounce INTEGER DEFAULT 2,
            delete_extra INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1,
            last_run TEXT DEFAULT '',
            last_status TEXT DEFAULT '',
            last_msg TEXT DEFAULT '',
            events_total INTEGER DEFAULT 0,
            sync_total INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS watch_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_id INTEGER NOT NULL,
            ts TEXT DEFAULT (datetime('now','localtime')),
            path TEXT DEFAULT '',
            event_type TEXT DEFAULT '',
            action TEXT DEFAULT ''
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_watch_events_rule ON watch_events(rule_id, id)")
    conn.commit()


# --- 规则 CRUD ---

def rule_list(conn, user_id: int = 1) -> list:
    _ensure_tables(conn)
    rows = conn.execute(
        "SELECT * FROM watch_rules WHERE user_id=? ORDER BY id DESC", (user_id,)
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d.pop("password", None)  # 密码不出后端
        out.append(d)
    return out


def rule_get(conn, rule_id: int, decrypt: bool = False) -> dict | None:
    _ensure_tables(conn)
    row = conn.execute("SELECT * FROM watch_rules WHERE id=?", (rule_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    return _decrypt_rule(d) if decrypt else d


def rule_create(conn, data: dict, user_id: int = 1) -> int:
    _ensure_tables(conn)
    d = _encrypt_rule({k: data.get(k, "") for k in RULE_FIELDS})
    cur = conn.execute(
        """INSERT INTO watch_rules
           (user_id, name, src_path, dst_path, host, port, user, auth_type,
            password, key, exclude, debounce, delete_extra, enabled)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (user_id, d['name'], d['src_path'], d['dst_path'], d['host'], d['port'] or '22',
         d['user'] or 'root', d['auth_type'] or 'pass', d['password'], d['key'],
         d['exclude'], int(data.get('debounce') or 2), int(data.get('delete_extra') or 0),
         1 if data.get('enabled', 1) else 0))
    conn.commit()
    return cur.lastrowid


def rule_update(conn, rule_id: int, data: dict) -> bool:
    _ensure_tables(conn)
    cur_row = rule_get(conn, rule_id, decrypt=True)
    if not cur_row:
        return False
    merged = {k: (data[k] if k in data and data[k] != "" else cur_row.get(k, "")) for k in RULE_FIELDS}
    # 密码留空的场景上面已保留旧值; enabled 单独走 toggle
    d = _encrypt_rule(merged)
    conn.execute(
        """UPDATE watch_rules SET name=?, src_path=?, dst_path=?, host=?, port=?, user=?,
           auth_type=?, password=?, key=?, exclude=?, debounce=?, delete_extra=? WHERE id=?""",
        (d['name'], d['src_path'], d['dst_path'], d['host'], d['port'] or '22',
         d['user'] or 'root', d['auth_type'] or 'pass', d['password'], d['key'],
         d['exclude'], int(merged.get('debounce') or 2), int(merged.get('delete_extra') or 0),
         rule_id))
    conn.commit()
    return True


def rule_delete(conn, rule_id: int) -> bool:
    _ensure_tables(conn)
    cur = conn.execute("DELETE FROM watch_rules WHERE id=?", (rule_id,))
    conn.execute("DELETE FROM watch_events WHERE rule_id=?", (rule_id,))
    conn.commit()
    return cur.rowcount > 0


def rule_set_enabled(conn, rule_id: int, on: bool) -> bool:
    _ensure_tables(conn)
    cur = conn.execute("UPDATE watch_rules SET enabled=? WHERE id=?",
                       (1 if on else 0, rule_id))
    conn.commit()
    return cur.rowcount > 0


def rule_enabled_ids(conn) -> list:
    _ensure_tables(conn)
    return [r[0] for r in conn.execute("SELECT id FROM watch_rules WHERE enabled=1").fetchall()]


def rule_touch_run(conn, rule_id: int, status: str, msg: str, synced: bool = False):
    """记录最近一次触发同步的结果 + 累计数"""
    _ensure_tables(conn)
    conn.execute(
        """UPDATE watch_rules SET last_run=datetime('now','localtime'),
           last_status=?, last_msg=?, events_total=events_total+1,
           sync_total=sync_total+? WHERE id=?""",
        (status, msg[:200], 1 if synced else 0, rule_id))
    conn.commit()


# --- 事件流 ---

def event_add(conn, rule_id: int, path: str, event_type: str, action: str):
    _ensure_tables(conn)
    conn.execute(
        "INSERT INTO watch_events (rule_id, path, event_type, action) VALUES (?,?,?,?)",
        (rule_id, path[:400], event_type[:60], action[:200]))
    conn.commit()


def event_list(conn, rule_id: int | None = None, limit: int = 50) -> list:
    _ensure_tables(conn)
    if rule_id:
        rows = conn.execute(
            "SELECT * FROM watch_events WHERE rule_id=? ORDER BY id DESC LIMIT ?",
            (rule_id, limit)).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM watch_events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def event_prune(conn, keep: int = 500):
    _ensure_tables(conn)
    conn.execute(
        """DELETE FROM watch_events WHERE id <=
           (SELECT MAX(id) FROM watch_events) - ?""", (keep,))
    conn.commit()

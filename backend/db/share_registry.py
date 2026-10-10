"""Fonriv · v6.4.0 批3 · share_registry: 全站分享统一台账

背景(批3 规划, docs/Fonriv_多云体系分析与规划报告_v1.md §4/§5):
  全站曾有 **5 个分享源、3 套管理界面、2 种存储**(配置文件标记块 / SQLite / 内存 dict),
  没有任何页面能列出"全部活跃分享"。本表为**单一真源**:
    vshare(局域网导出) / fonr_share(HTTP 链接) / cp_gateway(池网关导出) /
    g5_serve(rclone serve) 产生分享时都登记一行; 分享管理页从这里读。

字段:
  source_module : vdisk | fonrvfs | cloudpool | security
  type          : lan_smb | lan_nfs | lan_dlna | link | serve
  ref           : 外部引用 —— vshare 条目 = 标记块 id(形如 12); link = token;
                  serve = rclone 服务名。按 ref 回源定位/操作。
  status        : active | disabled | error
  meta          : JSON 附加(guest/force_user/主目录挂载点/访客统计缓存等)
"""
from __future__ import annotations

import json
import time
from typing import Optional


def _ensure_tables(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS share_registry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_module TEXT NOT NULL DEFAULT 'vdisk',
            type TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            path TEXT DEFAULT '',
            protocol TEXT DEFAULT '',
            perm TEXT DEFAULT 'ro',
            allow TEXT DEFAULT '[]',
            owner TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            ref TEXT DEFAULT '',
            meta TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_share_reg_src ON share_registry(source_module, type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_share_reg_ref ON share_registry(source_module, ref)")
    conn.commit()


def _row_to_dict(r) -> dict:
    d = dict(r)
    for k, dv in (("allow", []), ("meta", {})):
        try:
            d[k] = json.loads(d.get(k) or ("[]" if k == "allow" else "{}"))
        except Exception:
            d[k] = dv
    return d


def register(conn, *, source_module: str, type: str, name: str = "", path: str = "",
             protocol: str = "", perm: str = "ro", allow=None, owner: str = "",
             status: str = "active", ref: str = "", meta: Optional[dict] = None,
             rid: Optional[int] = None, dedupe: bool = True) -> int:
    """登记/更新一条分享。dedupe=True 时按 (source_module, type, ref) 覆盖同一条。

    rid: v6.4.0 · **显式 id**(与 vshare 标记块共用一号, 见 vshare.next_block_id)。
      传了就以此为主键 INSERT(不存在时) —— 保证「标记块里的 id」与「台账行 id」
      永远同一个(首版两套自增导致按条操作对不上号, 实测踩中)。
    返回 registry id。
    """
    _ensure_tables(conn)
    allow_j = json.dumps(list(allow or []))
    meta_j = json.dumps(meta or {})
    if dedupe and ref:
        row = conn.execute(
            "SELECT id FROM share_registry WHERE source_module=? AND type=? AND ref=?",
            (source_module, type, str(ref))).fetchone()
        if row:
            conn.execute(
                "UPDATE share_registry SET name=?, path=?, protocol=?, perm=?, allow=?, "
                "owner=?, status=?, meta=?, updated_at=datetime('now','localtime') WHERE id=?",
                (name, path, protocol, perm, allow_j, owner, status, meta_j, row["id"]))
            conn.commit()
            return int(row["id"])
    if rid:
        exists = conn.execute("SELECT id FROM share_registry WHERE id=?", (int(rid),)).fetchone()
        if exists:
            conn.execute(
                "UPDATE share_registry SET source_module=?, type=?, name=?, path=?, protocol=?, "
                "perm=?, allow=?, owner=?, status=?, ref=?, meta=?, "
                "updated_at=datetime('now','localtime') WHERE id=?",
                (source_module, type, name, path, protocol, perm, allow_j, owner, status,
                 str(ref), meta_j, int(rid)))
            conn.commit()
            return int(rid)
        conn.execute(
            "INSERT INTO share_registry(id, source_module, type, name, path, protocol, perm, "
            "allow, owner, status, ref, meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (int(rid), source_module, type, name, path, protocol, perm, allow_j, owner,
             status, str(ref), meta_j))
        conn.commit()
        return int(rid)
    cur = conn.execute(
        "INSERT INTO share_registry(source_module, type, name, path, protocol, perm, "
        "allow, owner, status, ref, meta) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (source_module, type, name, path, protocol, perm, allow_j, owner, status,
         str(ref), meta_j))
    conn.commit()
    return int(cur.lastrowid)


def update(conn, rid: int, **kw) -> bool:
    _ensure_tables(conn)
    allowed = {"name", "path", "protocol", "perm", "allow", "owner", "status", "ref", "meta",
               "source_module", "type"}
    sets, vals = [], []
    for k, v in kw.items():
        if k not in allowed or v is None:
            continue
        if k == "allow":
            v = json.dumps(list(v))
        elif k == "meta":
            v = json.dumps(dict(v))
        sets.append("%s=?" % k)
        vals.append(v)
    if not sets:
        return False
    sets.append("updated_at=datetime('now','localtime')")
    vals.append(rid)
    conn.execute("UPDATE share_registry SET %s WHERE id=?" % ", ".join(sets), vals)
    conn.commit()
    return True


def remove(conn, rid: int) -> bool:
    _ensure_tables(conn)
    cur = conn.execute("DELETE FROM share_registry WHERE id=?", (rid,))
    conn.commit()
    return cur.rowcount > 0


def remove_by_ref(conn, source_module: str, ref: str, type: Optional[str] = None) -> int:
    _ensure_tables(conn)
    if type:
        cur = conn.execute(
            "DELETE FROM share_registry WHERE source_module=? AND ref=? AND type=?",
            (source_module, str(ref), type))
    else:
        cur = conn.execute(
            "DELETE FROM share_registry WHERE source_module=? AND ref=?",
            (source_module, str(ref)))
    conn.commit()
    return cur.rowcount


def get(conn, rid: int) -> Optional[dict]:
    _ensure_tables(conn)
    r = conn.execute("SELECT * FROM share_registry WHERE id=?", (rid,)).fetchone()
    return _row_to_dict(r) if r else None


def list_all(conn, *, source_module: str = "", type: str = "", status: str = "") -> list:
    _ensure_tables(conn)
    q = "SELECT * FROM share_registry WHERE 1=1"
    args = []
    if source_module:
        q += " AND source_module=?"
        args.append(source_module)
    if type:
        q += " AND type=?"
        args.append(type)
    if status:
        q += " AND status=?"
        args.append(status)
    q += " ORDER BY id DESC"
    return [_row_to_dict(r) for r in conn.execute(q, args).fetchall()]


def prune_dead_links(conn) -> int:
    """v6.5.1: 清理**死链**台账行 —— type=link 且 ref 在 fonr_share 已不存在。

    背景(真实事故): fonr_share_purge 只删 fonr_share 表, 台账残留 → 界面"共 N 条分享"里
    混着一批点不开的死链, 且用户无法分辨。purge/删除 之后调用本函数做一致性收口;
    幂等(没有死链时返回 0)。"""
    _ensure_tables(conn)
    cur = conn.execute(
        "DELETE FROM share_registry WHERE type='link' "
        "AND ref NOT IN (SELECT token FROM fonr_share)")
    conn.commit()
    return cur.rowcount


def next_block_id(conn) -> int:
    """为新 vshare 标记块分配唯一 id(取 registry 自增, 保证跨重启唯一)。

    用途: `# >>> fonriv (vshare:<id>) >>>` 按条标记块。
    """
    _ensure_tables(conn)
    cur = conn.execute(
        "INSERT INTO share_registry(source_module, type, name, status, meta) "
        "VALUES('vdisk','lan_smb','','pending','{}')")
    rid = int(cur.lastrowid)
    conn.execute("DELETE FROM share_registry WHERE id=?", (rid,))
    conn.commit()
    return rid

"""Fonriv · v4.2.0 db.remotes: 远端存储 CRUD + 上传记录 CRUD

设计：
- remote_configs.secret_key 存 Fernet ENC$ 密文（同 configs 表的密码字段）
- 读时委托 db 门面的 decrypt_value 解密单字段
- extra_json 存平台特定选项（S3 path_style / Seafile repo_pwd 等），不加密（非敏感）
"""
from __future__ import annotations

import json
from typing import Optional


def _enc(v: str) -> str:
    from backend import db as _db
    return _db._encrypt_value(v or "")


def _dec(v: str) -> str:
    from backend import db as _db
    return _db._decrypt_value(v or "")


# ============ remote_configs ============

def remote_create(conn, user_id: int, name: str, provider: str, *,
                  endpoint: str = "", region: str = "", bucket: str = "",
                  prefix: str = "", access_key: str = "", secret_key: str = "",
                  extra: Optional[dict] = None, auto_upload: int = 0) -> int:
    """v4.39.0: 自动生成 uuid"""
    from backend.db.uuidv7 import uuidv7 as _uuidv7
    enc_secret = _enc(secret_key) if secret_key else ""
    extra_json = json.dumps(extra or {}, ensure_ascii=False)
    _uuid = _uuidv7()
    cur = conn.execute("""
        INSERT INTO remote_configs
        (uuid, user_id, name, provider, endpoint, region, bucket, prefix,
         access_key, secret_key, extra_json, auto_upload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (_uuid, user_id, name, provider, endpoint, region, bucket, prefix,
          access_key, enc_secret, extra_json, 1 if auto_upload else 0))
    rid = cur.lastrowid
    conn.commit()
    return rid


def remote_get(conn, remote_id: int = None, *, decrypt: bool = True, uuid: Optional[str] = None) -> Optional[dict]:
    """v4.39.0: 支持 uuid 查询"""
    if uuid:
        row = conn.execute(
            "SELECT * FROM remote_configs WHERE uuid=?", (uuid,)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM remote_configs WHERE id=?", (remote_id,)
        ).fetchone()
    if not row:
        return None
    d = dict(row)
    if decrypt:
        d["secret_key"] = _dec(d.get("secret_key") or "")
    try:
        d["extra"] = json.loads(d.get("extra_json") or "{}")
    except Exception:
        d["extra"] = {}
    return d


def remote_list(conn, user_id: int = 1, *, mask_secret: bool = True) -> list:
    """列出用户的所有远端配置。默认屏蔽 secret（前端展示用）。
    v5.22.0 · G5: user_id=None → 全量 (admin 强制点语义)。"""
    if user_id is None:
        rows = conn.execute(
            "SELECT * FROM remote_configs ORDER BY id DESC",
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM remote_configs WHERE user_id=? ORDER BY id DESC",
            (user_id,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if mask_secret:
            sk = d.get("secret_key") or ""
            d["secret_key"] = "***" if sk else ""
            d["has_secret"] = bool(sk)
        try:
            d["extra"] = json.loads(d.get("extra_json") or "{}")
        except Exception:
            d["extra"] = {}
        out.append(d)
    return out


def remote_update(conn, remote_id: int, **kwargs):
    """v4.39.0: 支持 uuid 定位"""
    uuid = kwargs.pop("uuid", None)
    where_clause = "uuid=?" if uuid else "id=?"
    where_arg = uuid if uuid else remote_id
    allowed = ["name", "provider", "endpoint", "region", "bucket", "prefix",
               "access_key", "auto_upload"]
    sets, vals = [], []
    for col in allowed:
        if col in kwargs:
            sets.append(f"{col}=?")
            if col == "auto_upload":
                vals.append(1 if kwargs[col] else 0)
            else:
                vals.append(kwargs[col])
    if "secret_key" in kwargs and kwargs["secret_key"]:
        sets.append("secret_key=?")
        vals.append(_enc(kwargs["secret_key"]))
    if "extra" in kwargs:
        sets.append("extra_json=?")
        vals.append(json.dumps(kwargs["extra"] or {}, ensure_ascii=False))
    if not sets:
        return
    vals.append(where_arg)
    conn.execute(
        f"UPDATE remote_configs SET {','.join(sets)} WHERE {where_clause}", vals
    )
    conn.commit()


def remote_delete(conn, remote_id: int, *, uuid: Optional[str] = None):
    """v4.39.0: 支持 uuid 定位删除"""
    where_clause = "uuid=?" if uuid else "id=?"
    where_arg = uuid if uuid else remote_id
    # v4.15.5 · 先清关联 remote_uploads（否则外键约束会报 IntegrityError）
    conn.execute(f"DELETE FROM remote_uploads WHERE remote_id=?", (where_arg,))
    conn.execute(f"DELETE FROM remote_configs WHERE {where_clause}", (where_arg,))
    conn.commit()


def remote_list_auto(conn, user_id: int = 1) -> list:
    """v4.3: 列出该用户所有 auto_upload=1 的远端（解密后完整对象）。"""
    rows = conn.execute("""
        SELECT * FROM remote_configs
        WHERE user_id=? AND auto_upload=1
        ORDER BY id ASC
    """, (user_id,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["secret_key"] = _dec(d.get("secret_key") or "")
        try:
            d["extra"] = json.loads(d.get("extra_json") or "{}")
        except Exception:
            d["extra"] = {}
        out.append(d)
    return out


# ============ remote_uploads ============

def upload_create(conn, backup_id: int, remote_id: int, remote_key: str) -> int:
    cur = conn.execute("""
        INSERT INTO remote_uploads (backup_id, remote_id, remote_key)
        VALUES (?, ?, ?)
    """, (backup_id, remote_id, remote_key))
    uid = cur.lastrowid
    conn.commit()
    return uid


def upload_update(conn, upload_id: int, **kwargs):
    allowed = ["status", "size_bytes", "duration_sec", "etag",
               "error_message", "finished_at"]
    sets, vals = [], []
    for col in allowed:
        if col in kwargs:
            sets.append(f"{col}=?")
            vals.append(kwargs[col])
    if "status" in kwargs and kwargs["status"] in ("success", "failed"):
        # 自动补 finished_at
        if "finished_at" not in kwargs:
            sets.append("finished_at=datetime('now','localtime')")
    if not sets:
        return
    vals.append(upload_id)
    conn.execute(
        f"UPDATE remote_uploads SET {','.join(sets)} WHERE id=?", vals
    )
    conn.commit()


def upload_list(conn, *, backup_id: Optional[int] = None, limit: int = 100) -> list:
    if backup_id is not None:
        rows = conn.execute("""
            SELECT u.*, r.name AS remote_name, r.provider AS remote_provider
            FROM remote_uploads u
            LEFT JOIN remote_configs r ON u.remote_id = r.id
            WHERE u.backup_id=?
            ORDER BY u.id DESC LIMIT ?
        """, (backup_id, limit)).fetchall()
    else:
        rows = conn.execute("""
            SELECT u.*, r.name AS remote_name, r.provider AS remote_provider
            FROM remote_uploads u
            LEFT JOIN remote_configs r ON u.remote_id = r.id
            ORDER BY u.id DESC LIMIT ?
        """, (limit,)).fetchall()
    return [dict(r) for r in rows]


def upload_clear(conn, *, remote_id: Optional[int] = None) -> int:
    """v4.15.9 · 清空上传历史。remote_id 给了则只清该远端；否则全清。"""
    if remote_id is not None:
        cur = conn.execute("DELETE FROM remote_uploads WHERE remote_id=?", (remote_id,))
    else:
        cur = conn.execute("DELETE FROM remote_uploads")
    conn.commit()
    return cur.rowcount

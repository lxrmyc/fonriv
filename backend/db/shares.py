"""Fonriv · v4.39.0 Phase 2a db.shares: 网络共享配置 CRUD

SMB/NFS/AFP/WebDAV 共享配置表（mount 到本机 /var/lib/fonriv_mounts/shares/<uuid>）。

设计：
- 函数第一参数 conn（依赖注入，同 configs.py 风格）
- 敏感字段（auth_value 密码）走门面 encrypt_value / decrypt_value
- meta_json 不需要（字段不多，扁平存储）
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

# 可更新列白名单
SHARE_UPDATE_COLS = [
    'name', 'color', 'proto', 'host', 'port', 'share', 'path',
    'user', 'auth_type', 'auth_value', 'domain', 'vers',
    'ro', 'uid', 'gid', 'opts', 'sort_order',
]

# 敏感字段（密码）
SHARE_ENCRYPTED_FIELDS = ['auth_value']


def _get_crypto():
    """Lazy import encrypt/decrypt helpers · 避免循环"""
    from backend import db as _db
    fernet = _db._get_fernet()
    from backend.db.crypto import encrypt_value, decrypt_value
    return fernet, encrypt_value, decrypt_value


def _encrypt_share(data: dict) -> dict:
    fernet, enc, _ = _get_crypto()
    out = dict(data)
    for k in SHARE_ENCRYPTED_FIELDS:
        if k in out and out[k]:
            out[k] = enc(fernet, str(out[k]))
    return out


def _decrypt_share(row: dict) -> dict:
    fernet, _, dec = _get_crypto()
    out = dict(row)
    for k in SHARE_ENCRYPTED_FIELDS:
        if k in out and out[k]:
            out[k] = dec(fernet, str(out[k]))
    return out


def share_list(conn, user_id: int = 1) -> list:
    """获取用户的所有共享配置（密码解密后返回）"""
    rows = conn.execute(
        "SELECT * FROM shares WHERE user_id=? ORDER BY sort_order, id",
        (user_id,),
    ).fetchall()
    return [_decrypt_share(dict(r)) for r in rows]


def share_get(conn, share_id=None, user_id: int = 1, *, uuid: Optional[str] = None):
    """按 id 或 uuid 查询单条共享配置"""
    if uuid:
        row = conn.execute(
            "SELECT * FROM shares WHERE uuid=? AND user_id=?",
            (uuid, user_id),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM shares WHERE id=? AND user_id=?",
            (share_id, user_id),
        ).fetchone()
    if not row:
        return None
    return _decrypt_share(dict(row))


def share_create(conn, data: dict, user_id: int = 1) -> int:
    """创建共享配置 · data 含 name/proto/host/share 等 · 自动生成 uuid"""
    from backend.db.uuidv7 import uuidv7 as _uuidv7
    enc = _encrypt_share(data)
    cols = ['uuid']
    vals = [_uuidv7()]
    for k in SHARE_UPDATE_COLS + ['user_id']:
        if k in enc:
            cols.append(k)
            vals.append(enc[k])
    if 'user_id' not in enc:
        cols.append('user_id')
        vals.append(user_id)
    placeholders = ','.join(['?'] * len(vals))
    col_str = ','.join(cols)
    cur = conn.execute(
        f"INSERT INTO shares ({col_str}) VALUES ({placeholders})",
        vals,
    )
    conn.commit()
    return cur.lastrowid


def share_update(conn, share_id: int, data: dict, user_id: int = 1, *, uuid: Optional[str] = None):
    """更新共享配置 · 只允许白名单列"""
    enc = _encrypt_share(data)
    sets = []
    vals = []
    for k in SHARE_UPDATE_COLS:
        if k in enc:
            sets.append(f"{k}=?")
            vals.append(enc[k])
    if not sets:
        return False
    sets.append("updated_at=datetime('now','localtime')")
    if uuid:
        vals += [uuid, user_id]
        cur = conn.execute(
            f"UPDATE shares SET {','.join(sets)} WHERE uuid=? AND user_id=?",
            vals,
        )
    else:
        vals += [share_id, user_id]
        cur = conn.execute(
            f"UPDATE shares SET {','.join(sets)} WHERE id=? AND user_id=?",
            vals,
        )
    conn.commit()
    return cur.rowcount > 0


def share_delete(conn, share_id: int, user_id: int = 1, *, uuid: Optional[str] = None):
    """删除共享配置"""
    if uuid:
        cur = conn.execute(
            "DELETE FROM shares WHERE uuid=? AND user_id=?",
            (uuid, user_id),
        )
    else:
        cur = conn.execute(
            "DELETE FROM shares WHERE id=? AND user_id=?",
            (share_id, user_id),
        )
    conn.commit()
    return cur.rowcount > 0


def share_update_status(conn, share_uuid: str, status: str, mounted_at: str = ''):
    """更新共享挂载状态（last_status / last_mounted_at）"""
    conn.execute(
        "UPDATE shares SET last_status=?, last_mounted_at=? WHERE uuid=?",
        (status, mounted_at, share_uuid),
    )
    conn.commit()

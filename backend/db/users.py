"""Fonriv · v3.3.2 db.users: 用户 CRUD + 权限

抽自 backend/db/__init__.py（v3.3.x 拆包战役第 3 块砖）。

设计：
- get_conn 通过参数注入（不 import 上层 __init__ 避免循环）
- 所有函数签名与 __init__.py 里的完全一致
- __init__.py 里保留同名门面，委托到这里；旧代码不动
"""
from __future__ import annotations
import logging

import sqlite3


# 所有可控页面 key（与前端 tab id 对应）
# v4.44.1 · 精细化权限分配: 覆盖全部一级/二级页面模块
#   (文件传输/远端磁盘管理/网络共享/终端/远端存储/跨模块流程/各备份模块等单独可控)
ALL_PAGES = [
    'conn_center',
    'transfer', 'disk_manager', 'shares', 'terminal',
    'vdisk_cloud',     # v5.98.19 · 多云虚拟存储池(统一虚拟根)
    'share_lan',       # v6.5.0 · 批6 · 局域网文件分享管理(SMB/NFS/DLNA)
    'share_http',      # v6.5.0 · 批6 · HTTP 链接分享管理
    'share_access',    # v6.5.0 · 批6 · SMB 账号与文件权限
    'backup_center',   # v5.98.18 · 备份总览
    'disk_image',      # v6.2.1 · 磁盘镜像备份/恢复(独立二级菜单)
    'rdp_console', 'vnc_direct', 'pve_console',
    'remotedesk', 'truenas',
    'proxmox', 'vzdump', 'pbs', 'auto_backup',
    'platform_backup', 'lvm', 'zfs', 'rbd',
    'remotes', 'flows', 'dashboard',
    'schedules', 'jobs', 'log',
    'settings', 'personalize', 'license', 'users', 'downloads',
    'docker', 'dbbackup', 'ai_assistant', 'k8s_backup',
    'fonrvfs',   # v5.40.0 · 多云文件管理 (FonrVFS 新主菜单)
    'cloudpool',  # v5.99.2 · CloudPool V2 智能存储池
]

# v4.44.1 · 新用户默认页 (历史行为保留: 基础三项)
DEFAULT_PAGES = ['transfer', 'downloads', 'log']


def user_create(conn, username: str, password_hash: str, role: str = 'user'):
    """创建用户 · 用户名冲突返回 None。v4.39.0: 自动生成 uuid"""
    from backend.db.uuidv7 import uuidv7 as _uuidv7
    _uuid = _uuidv7()
    try:
        cur = conn.execute(
            "INSERT INTO users (uuid, username, password_hash, role) VALUES (?, ?, ?, ?)",
            (_uuid, username, password_hash, role),
        )
        user_id = cur.lastrowid
        conn.commit()
    except sqlite3.IntegrityError:
        user_id = None
    return user_id


def user_get(conn, username: str):
    row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    return dict(row) if row else None


def user_list(conn) -> list:
    """获取所有用户（含 last_login，若列不存在则动态迁移）"""
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
        if 'last_login' not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN last_login TEXT")
            conn.commit()
    except Exception as e:
        print("[user_list] add last_login migration failed:", e)
    rows = conn.execute(
        "SELECT id, username, role, created_at, last_login FROM users ORDER BY id"
    ).fetchall()
    return [dict(r) for r in rows]


def user_touch_login(conn, user_id: int):
    """记录用户最近一次登录时间。列不存在时静默补列。"""
    try:
        conn.execute(
            "UPDATE users SET last_login = datetime('now','localtime') WHERE id=?",
            (user_id,),
        )
        conn.commit()
    except sqlite3.OperationalError as e:
        print("[user_touch_login] retry after adding column:", e)
        try:
            conn.execute("ALTER TABLE users ADD COLUMN last_login TEXT")
            conn.execute(
                "UPDATE users SET last_login = datetime('now','localtime') WHERE id=?",
                (user_id,),
            )
            conn.commit()
        except Exception as e2:
            print("[user_touch_login] failed:", e2)


def user_update(conn, user_id: int, data: dict):
    allowed = ['username', 'password_hash', 'role']
    sets, vals = [], []
    for col in allowed:
        if col in data:
            sets.append(f'{col}=?')
            vals.append(data[col])
    if sets:
        vals.append(user_id)
        conn.execute(
            f"UPDATE users SET {','.join(sets)}, updated_at=datetime('now','localtime') WHERE id=?",
            vals,
        )
    conn.commit()


def user_delete(conn, user_id: int):
    """删除用户（至少保留一个 admin）。先清关联表再删主表避免 FK 报错。"""
    admins = conn.execute("SELECT COUNT(*) FROM users WHERE role='admin'").fetchone()[0]
    user = conn.execute("SELECT role FROM users WHERE id=?", (user_id,)).fetchone()
    if not user:
        return
    if user['role'] == 'admin' and admins <= 1:
        return
    for tbl in ('api_sessions', 'user_permissions', 'configs'):
        try:
            conn.execute(f"DELETE FROM {tbl} WHERE user_id=?", (user_id,))
        except Exception as _e: logging.debug("suppressed", exc_info=True)
    conn.execute("DELETE FROM users WHERE id=?", (user_id,))
    conn.commit()


# ---- 权限 ----

def user_perms_get(conn, user_id: int) -> list:
    """返回该用户被允许访问的页面 key 列表。admin 默认全部；无记录给基础页。"""
    user_row = conn.execute("SELECT role FROM users WHERE id=?", (user_id,)).fetchone()
    if user_row and user_row['role'] == 'admin':
        return list(ALL_PAGES)
    row = conn.execute(
        "SELECT allowed_pages FROM user_permissions WHERE user_id=?", (user_id,)
    ).fetchone()
    if not row or not row['allowed_pages']:
        return list(DEFAULT_PAGES)
    parts = [p.strip() for p in row['allowed_pages'].split(',') if p.strip()]
    return [p for p in parts if p in ALL_PAGES]


def user_perms_set(conn, user_id: int, pages: list) -> bool:
    """写入该用户的允许页面列表。admin 记录会被忽略（admin 恒全通）。"""
    user_row = conn.execute("SELECT role FROM users WHERE id=?", (user_id,)).fetchone()
    if not user_row:
        return False
    if user_row['role'] == 'admin':
        return False
    valid = [p for p in (pages or []) if p in ALL_PAGES]
    joined = ','.join(valid)
    conn.execute(
        "INSERT INTO user_permissions (user_id, allowed_pages, updated_at) "
        "VALUES (?, ?, datetime('now','localtime')) "
        "ON CONFLICT(user_id) DO UPDATE SET allowed_pages=excluded.allowed_pages, "
        "updated_at=excluded.updated_at",
        (user_id, joined),
    )
    conn.commit()
    return True


def user_perms_all(conn) -> dict:
    """返回 {user_id: [pages...]}，供批量读取。"""
    rows = conn.execute(
        "SELECT user_id, allowed_pages FROM user_permissions"
    ).fetchall()
    return {r['user_id']: [p for p in r['allowed_pages'].split(',') if p] for r in rows}

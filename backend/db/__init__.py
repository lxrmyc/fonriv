import logging
#!/usr/bin/env python3
"""Fonriv - SQLite Database Layer

v2.8.0: 逻辑模块化（分组导出 · 单文件保留以避免大规模 import 迁移）
文件仍单一，但按功能划分 6 段。要真正拆成 backend/db/ 包时，
只需把每段搬到对应子模块，__init__.py 里 re-export 即可。

┌──────────────────────────────────────────────────────────────┐
│ 模块结构（section）                                            │
├──────────────────────────────────────────────────────────────┤
│ § 1  Crypto        · Fernet 加密 · encrypt_config_values      │
│ § 2  Connection    · get_conn · DB 路径                       │
│ § 3  Init & Users  · init_db · authenticate · user_* · role   │
│ § 4  Configs       · config_list/get/create/update/delete     │
│ § 5  Tasks & Logs  · task_* / log_*                           │
│ § 6  Backups       · backup_create/update/list                │
│ § 7  Permissions   · user_perms_* · ALL_PAGES                 │
│ § 8  API Sessions  · api_session_create/get/delete/gc         │
└──────────────────────────────────────────────────────────────┘
"""

import os
import json
import time
import sqlite3
import hashlib
from typing import Optional
import secrets
from datetime import datetime

try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:
    Fernet = None
    InvalidToken = None

# v2.8.0: 分组导出 —— 便于按 section 查找符号
__all__ = [
    # § 1 Crypto
    "ENCRYPTED_CONFIG_FIELDS", "encrypt_config_values", "decrypt_config_row",
    # § 2 Connection
    "DB_PATH", "DATA_DIR", "get_conn",
    # § 3 Users
    "hash_password", "check_password", "authenticate_user", "init_default_admin",
    "needs_setup", "create_first_admin", "ensure_bootstrap_admin",
    "user_create", "user_get", "user_list", "user_touch_login",
    "user_update", "user_delete",
    # § 4 Configs
    "config_list", "config_get", "config_create", "config_update", "config_delete",
    # § 5 Tasks & Logs
    "task_create", "task_update", "task_list", "task_get",
    "log_create", "log_list",
    # § 6 Backups
    "backup_create", "backup_update", "backup_list",
    # § 7 Permissions
    "ALL_PAGES", "user_perms_get", "user_perms_set", "user_perms_all",
    # § 8 API Sessions
    "api_session_create", "api_session_get", "api_session_delete", "api_session_gc",
    # Init
    "init_db",
]

# ═════════════════════════════════════════════════════════════
# § 1. Paths & Crypto (Fernet at-rest encryption)
# ═════════════════════════════════════════════════════════════

APP_DIR = os.path.dirname(os.path.abspath(__file__))
# Phase D: 数据文件集中到项目顶层 data/ 目录
# v3.3.0 兼容修复：db.py 变成 db/__init__.py 后 __file__ 目录深了一层，
# 老逻辑 join(APP_DIR, "..", "data") 会算成 backend/data，与 v3.2 前的
# rsync工具/data 不一致，导致老用户/配置查不到 → 登录密码错。
# 解决：从项目根找 data/（父目录里必须有 backend/），保证与迁移前完全一致。
_PROJECT_ROOT = os.path.abspath(os.path.join(APP_DIR, "..", ".."))
# 兼容旧路径（backend/db/../..  → 项目根）
if not os.path.isdir(os.path.join(_PROJECT_ROOT, "backend")):
    # 未按预期结构 → 兜底走原逻辑
    _PROJECT_ROOT = os.path.abspath(os.path.join(APP_DIR, ".."))
DATA_DIR = os.path.join(_PROJECT_ROOT, "data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "fonriv.db")
FERNET_KEY_PATH = os.path.join(DATA_DIR, ".fernet.key")

# Sensitive config columns that should be encrypted at rest
ENCRYPTED_CONFIG_FIELDS = {
    "auth_value", "auth_passphrase",
    "pve_auth_value",
    "vd_auth_value",
    "lvm_auth_value",
    "zfs_auth_value",
    "rbd_auth_value",
    "pbs_auth_value", "pbs_api_pass",
    "ab_auth_value", "ab_auth_passphrase",
}

_FERNET = None


def _get_fernet():
    """Lazy-initialize Fernet cipher. v3.3.1: 委托 db.crypto._load_or_create_fernet"""
    global _FERNET
    if _FERNET is not None:
        return _FERNET
    from backend.db.crypto import _load_or_create_fernet
    _FERNET = _load_or_create_fernet(FERNET_KEY_PATH)
    return _FERNET


def _encrypt_value(value: str) -> str:
    """v3.3.1: 委托 db.crypto.encrypt_value"""
    from backend.db.crypto import encrypt_value
    return encrypt_value(_get_fernet(), value)


def _decrypt_value(enc_value: str) -> str:
    """v3.3.1: 委托 db.crypto.decrypt_value"""
    from backend.db.crypto import decrypt_value
    return decrypt_value(_get_fernet(), enc_value)


def encrypt_config_values(data: dict) -> dict:
    """v3.3.1: 委托 db.crypto.encrypt_config_dict"""
    from backend.db.crypto import encrypt_config_dict
    return encrypt_config_dict(_get_fernet(), data, ENCRYPTED_CONFIG_FIELDS)


import threading

# 每线程独立连接（sqlite3 连接对象非线程安全；FastAPI 用 threadpool 处理同步 handler）
_tls = threading.local()


# ═════════════════════════════════════════════════════════════
# § 2. Database Connection
# ═════════════════════════════════════════════════════════════

def get_conn() -> sqlite3.Connection:
    """获取当前线程的数据库连接（Phase C-lite：threadlocal + WAL + busy_timeout）"""
    conn = getattr(_tls, "conn", None)
    if conn is not None:
        try:
            conn.execute("SELECT 1")
            return conn
        except sqlite3.Error:
            try:
                conn.close()
            except Exception as _e: logging.debug("suppressed", exc_info=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=30000")
    # v5.60.0 E2-1 · SQLite 调优(阶段E 结构债): 多任务并发写审计/进度时减少磁盘往返与锁等待。
    #   原有仅 WAL + synchronous + busy_timeout; 补: 页缓存 16MB / 临时表进内存 / mmap 读 / 检查点阈值。
    #   逐条 try: 受限环境(老内核/只读 fs)不接受 mmap_size 时跳过并留日志(不静默失败)。
    for _pragma in ("PRAGMA cache_size=-16000", "PRAGMA temp_store=MEMORY",
                    "PRAGMA mmap_size=268435456", "PRAGMA wal_autocheckpoint=1000"):
        try:
            conn.execute(_pragma)
        except sqlite3.Error as _pe:
            logging.info("[db] PRAGMA 不支持, 已跳过 %s: %s", _pragma, _pe)
    _tls.conn = conn
    return conn


def db_pragma_stats() -> dict:
    """v5.60.0 E2-1 · 当前连接的 SQLite 关键 PRAGMA 值(供给核心运行状况/治理面板观测)。"""
    out = {}
    try:
        conn = get_conn()
        for k in ("journal_mode", "synchronous", "cache_size", "temp_store", "mmap_size",
                  "busy_timeout", "wal_autocheckpoint", "page_count", "page_size", "freelist_count"):
            try:
                out[k] = conn.execute("PRAGMA %s" % k).fetchone()[0]
            except sqlite3.Error:
                out[k] = None
        try:
            out["db_size_mb"] = round(
                (int(out.get("page_count") or 0) * int(out.get("page_size") or 0)) / 1048576.0, 2)
        except (TypeError, ValueError):
            out["db_size_mb"] = None
    except Exception as e:
        out["error"] = str(e)[:200]
    return out


# ==================== 密码哈希 ====================

# ═════════════════════════════════════════════════════════════
# § 3. Password hashing & authentication
# ═════════════════════════════════════════════════════════════

def hash_password(password: str) -> str:
    """v3.3.0: 委托 backend.db.hashing.hash_password（拆包结构示例）"""
    from backend.db.hashing import hash_password as _impl
    return _impl(password)


def check_password(password: str, password_hashed: str) -> bool:
    """v3.3.0: 委托 backend.db.hashing.check_password"""
    from backend.db.hashing import check_password as _impl
    return _impl(password, password_hashed)


def authenticate_user(username: str, password: str) -> dict:
    """查找用户并验证密码"""
    user = user_get(username)
    if user and check_password(password, user['password_hash']):
        return user
    return None


def needs_setup() -> bool:
    """v5.91.6 · 还要不要"首次配置"? (首次部署 / 全新数据目录 = True)

    判定 = 用户表里一个人都没有。已有部署(哪怕管理员口令设得很弱)都返回 False,
    所以升级不会把老用户挡在配置页外面。

    读表失败时返回 False(宁可让用户正常登录, 也不要把系统卡在配置页), 并打日志。
    """
    try:
        conn = get_conn()
        cur = conn.execute("SELECT COUNT(*) FROM users")
        row = cur.fetchone()
        n = int(row[0]) if row is not None else 0
        return n == 0
    except Exception as e:
        print("[db] needs_setup 读取失败(按已初始化处理):", e)
        return False


def create_first_admin(username: str, password_hash: str, theme: str = 'light') -> int:
    """v5.91.6 · 首次配置向导: 创建超级管理员并写入外观偏好。已初始化则拒绝(防被用来重置口令)。"""
    if not needs_setup():
        raise ValueError("系统已完成初始化，不能重复执行首次配置")
    uid = user_create(username, password_hash, 'admin')
    if not uid:
        raise ValueError("用户名已存在: %s" % username)
    _theme = theme if theme in ('light', 'dark', 'auto', 'neon', 'quantum') else 'light'  # v6.0.0 · 新增科技双主题
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO user_ui_prefs (user_id, theme, density, sidebar_collapsed) "
        "VALUES (?, ?, 'full', 0)", (uid, _theme),
    )
    conn.commit()
    return uid


def ensure_bootstrap_admin(username: str, password: str,
                           theme: str = 'light') -> int:
    """v5.92.1 · 幂等引导管理员(仅测试/离线演示用) —— 口令必须由调用方显式传入。

    产品启动路径**不再**调用它 —— 正式部署走 /api/setup/init 由用户自己设账号口令。
    也不内置任何弱口令默认值, 测试夹具请显式传参。
    """
    existing = user_get(username)
    if existing:
        return int(existing['id'])
    if needs_setup():
        return create_first_admin(username, hash_password(password), theme)
    return user_create(username, hash_password(password), 'admin')


def init_default_admin():
    """v5.91.6 · 不再自动创建默认账号(不使用任何固定弱口令账号)。

    保留函数名以兼容既有调用方, 现在只做"未初始化"提示。
    """
    try:
        if needs_setup():
            print("=" * 58)
            print("Fonriv 首次启动: 还没有管理员账号")
            print("请用浏览器打开服务地址, 按页面引导完成初始化")
            print("(设置超级管理员用户名/密码/主题风格等)")
            print("=" * 58)
    except Exception as e:
        print("init_default_admin 检查失败:", e)


# ==================== v4.39.0 引用注册表 (Phase 1) ====================

def register_ref(source_table: str, source_uuid: str, source_field: str,
                 target_table: str, target_uuid: str, ref_kind: str = 'soft'):
    from backend.db.entity_refs import register_ref as _impl
    return _impl(get_conn(), source_table, source_uuid, source_field,
                 target_table, target_uuid, ref_kind)


def unregister_ref(source_table: str, source_uuid: str, source_field: str):
    from backend.db.entity_refs import unregister_ref as _impl
    return _impl(get_conn(), source_table, source_uuid, source_field)


def update_ref(source_table: str, source_uuid: str, source_field: str,
               target_table: str, target_uuid: str, ref_kind: str = 'soft'):
    from backend.db.entity_refs import update_ref as _impl
    return _impl(get_conn(), source_table, source_uuid, source_field,
                 target_table, target_uuid, ref_kind)


def get_refs_to(target_table: str, target_uuid: str) -> list:
    from backend.db.entity_refs import get_refs_to as _impl
    return _impl(get_conn(), target_table, target_uuid)


def get_refs_from(source_table: str, source_uuid: str) -> list:
    from backend.db.entity_refs import get_refs_from as _impl
    return _impl(get_conn(), source_table, source_uuid)


def get_blocking_refs(target_table: str, target_uuid: str) -> list:
    from backend.db.entity_refs import get_blocking_refs as _impl
    return _impl(get_conn(), target_table, target_uuid)


def safe_delete(table: str, uuid: str, *, force: bool = False) -> dict:
    from backend.db.entity_refs import safe_delete as _impl
    return _impl(get_conn(), table, uuid, force=force)


def graph_integrity_check() -> dict:
    from backend.db.entity_refs import graph_integrity_check as _impl
    return _impl(get_conn())


# ==================== 初始化 ====================

def init_db():
    """初始化数据库表结构"""
    conn = get_conn()
    cur = conn.cursor()

    # 用户表
    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)

    # v5.35.0 · G2 零遗留: configs 表退役 (单一真源 = server_profiles)

    # 任务表
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT 1,
            task_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            type TEXT DEFAULT 'rsync',
            status TEXT DEFAULT 'pending',
            progress REAL DEFAULT 0,
            command TEXT DEFAULT '',
            log_output TEXT DEFAULT '',
            started_at TEXT,
            finished_at TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    """)

    # 日志表
    cur.execute("""
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT 1,
            task_id TEXT,
            level TEXT DEFAULT 'info',
            category TEXT DEFAULT 'system',
            message TEXT NOT NULL,
            detail TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    """)

    # 备份元数据表
    cur.execute("""
        CREATE TABLE IF NOT EXISTS backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT 1,
            task_id TEXT,
            config_id INTEGER,
            source TEXT DEFAULT '',
            destination TEXT DEFAULT '',
            type TEXT DEFAULT 'rsync',
            status TEXT DEFAULT 'running',
            size_bytes INTEGER DEFAULT 0,
            file_count INTEGER DEFAULT 0,
            error_message TEXT DEFAULT '',
            started_at TEXT DEFAULT (datetime('now', 'localtime')),
            finished_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    """)

    # 创建索引
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, status)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category)")

    # v2.6.3: 用户权限表（每个用户可访问的页面列表；admin 默认全通）
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_permissions (
            user_id INTEGER PRIMARY KEY,
            allowed_pages TEXT DEFAULT '',
            updated_at TEXT DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)

    # Phase D+: 持久化 API 会话（token 存 DB，避免 server 重启后 REST 401）
    cur.execute("""
        CREATE TABLE IF NOT EXISTS api_sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            last_used_at TEXT DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_api_sessions_user ON api_sessions(user_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_backups_user ON backups(user_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_backups_config ON backups(config_id)")

    # v4.2.0: 远端存储 (S3 / Seafile / MinIO / B2 / ...)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS remote_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT 1,
            name TEXT NOT NULL,
            provider TEXT NOT NULL,        -- 's3' | 'seafile' | 'minio' | ...
            endpoint TEXT DEFAULT '',      -- S3: https://s3.amazonaws.com  Seafile: https://cloud.seafile.com
            region TEXT DEFAULT '',        -- S3 only
            bucket TEXT DEFAULT '',        -- S3: bucket name  Seafile: repo_id
            prefix TEXT DEFAULT '',        -- 对象前缀 / 子目录
            access_key TEXT DEFAULT '',    -- S3 access key id  Seafile: username/email
            secret_key TEXT DEFAULT '',    -- S3 secret access key  Seafile: password  (Fernet ENC$)
            extra_json TEXT DEFAULT '{}',  -- 平台特定选项 (path_style / storage_class / seafile_repo_pwd 等)
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_remote_configs_user ON remote_configs(user_id)")

    # v4.3.0: auto_upload 标记 —— 备份完成后自动触发到该远端的上传
    _rc_cols = [row[1] for row in cur.execute("PRAGMA table_info(remote_configs)").fetchall()]
    if 'auto_upload' not in _rc_cols:
        cur.execute("ALTER TABLE remote_configs ADD COLUMN auto_upload INTEGER DEFAULT 0")

    # v4.2.0: 上传记录 (每个 backup 可多次上传到不同 remote)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS remote_uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            backup_id INTEGER NOT NULL,
            remote_id INTEGER NOT NULL,
            remote_key TEXT DEFAULT '',    -- 对象 key / 云盘完整路径
            status TEXT DEFAULT 'running', -- running / success / failed
            size_bytes INTEGER DEFAULT 0,
            duration_sec REAL DEFAULT 0,
            etag TEXT DEFAULT '',          -- S3 ETag  或本地 sha256
            error_message TEXT DEFAULT '',
            started_at TEXT DEFAULT (datetime('now', 'localtime')),
            finished_at TEXT,
            FOREIGN KEY (backup_id) REFERENCES backups(id),
            FOREIGN KEY (remote_id) REFERENCES remote_configs(id)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_remote_uploads_backup ON remote_uploads(backup_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_remote_uploads_remote ON remote_uploads(remote_id)")

    # ═══ v5.40.0 · FonrVFS 多云文件管理 (新主菜单 🗂) ═══
    #   上传会话 (分片/断点续传) · 后台任务 (可观测/可续跑) · 收藏
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_upload_session (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sid TEXT UNIQUE NOT NULL,
            user_id INTEGER DEFAULT 1,
            storage_id TEXT NOT NULL,
            dst_path TEXT NOT NULL,
            local_path TEXT DEFAULT '',
            size INTEGER DEFAULT 0,
            sha256 TEXT DEFAULT '',
            upload_id TEXT DEFAULT '',
            part_size INTEGER DEFAULT 0,
            job_id TEXT DEFAULT '',
            status TEXT DEFAULT 'pending',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fonr_session_user ON fonr_upload_session(user_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fonr_session_st ON fonr_upload_session(storage_id, dst_path)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_job (
            id TEXT PRIMARY KEY,
            kind TEXT DEFAULT '',
            title TEXT DEFAULT '',
            storage_id TEXT DEFAULT '',
            path TEXT DEFAULT '',
            total INTEGER DEFAULT 0,
            done INTEGER DEFAULT 0,
            status TEXT DEFAULT 'running',
            msg TEXT DEFAULT '',
            error TEXT DEFAULT '',
            speed REAL DEFAULT 0,
            created_at REAL DEFAULT 0,
            updated_at REAL DEFAULT 0,
            finished_at REAL DEFAULT 0
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fonr_job_created ON fonr_job(created_at DESC)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_favorite (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT 1,
            storage_id TEXT NOT NULL,
            path TEXT NOT NULL,
            label TEXT DEFAULT '',
            icon TEXT DEFAULT '⭐',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fonr_fav_user ON fonr_favorite(user_id)")

    # v5.41.0 · FonrVFS P1: 最近访问 (每用户最多保留 500 条, 按时间倒序)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_recent (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL DEFAULT 1,
            storage_id  TEXT NOT NULL,
            path        TEXT NOT NULL,
            name        TEXT DEFAULT '',
            kind        TEXT DEFAULT '',
            size        INTEGER DEFAULT 0,
            ts          REAL NOT NULL,
            UNIQUE(user_id, storage_id, path)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fonr_recent_ts ON fonr_recent(user_id, ts DESC)")

    # v5.43.0 · FonrVFS P2: 回收站 (软删除 + 恢复 + 保留期) 与设置键
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_trash (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            storage_id  TEXT NOT NULL,
            orig_path   TEXT NOT NULL,
            trash_path  TEXT NOT NULL,
            name        TEXT DEFAULT '',
            is_dir      INTEGER DEFAULT 0,
            size        INTEGER DEFAULT 0,
            deleted_by  TEXT DEFAULT '',
            deleted_at  REAL NOT NULL,
            expires_at  REAL DEFAULT 0,
            note        TEXT DEFAULT '',
            restored_at REAL DEFAULT 0
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fonr_trash_ts ON fonr_trash(deleted_at DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fonr_trash_storage ON fonr_trash(storage_id)")
    # v5.44.0 · FonrVFS P2: 分享链接 (外发下载)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_share (
            token         TEXT PRIMARY KEY,
            storage_id    TEXT NOT NULL,
            path          TEXT NOT NULL,
            name          TEXT DEFAULT '',
            size          INTEGER DEFAULT 0,
            is_dir        INTEGER DEFAULT 0,
            created_by    TEXT DEFAULT '',
            created_at    REAL NOT NULL,
            expires_at    REAL DEFAULT 0,
            max_downloads INTEGER DEFAULT 0,
            downloads     INTEGER DEFAULT 0,
            pw_hash       TEXT DEFAULT '',
            note          TEXT DEFAULT '',
            revoked       INTEGER DEFAULT 0
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fonr_share_ts ON fonr_share(created_at DESC)")
    # v5.99.0 · 分享增强: 权限档(perm) + 可访问人数上限(max_viewers) + 访客台账
    #   · perm: preview_download(默认) / readonly / download_only / preview_only / rw
    #   · max_viewers: 0=不限; >0 时只允许这么多个**不同 IP** 打开该链接
    #   · fonr_share_visitor: 每次访问按 (token, ip) 记账 → 人数上限与"谁看过"可审计
    for _ddl in (
        "ALTER TABLE fonr_share ADD COLUMN perm TEXT DEFAULT 'preview_download'",
        "ALTER TABLE fonr_share ADD COLUMN max_viewers INTEGER DEFAULT 0",
    ):
        try:
            cur.execute(_ddl)
        except sqlite3.OperationalError:
            pass                      # 列已存在(老库升级路径, 与 db/flows.py 同一手法)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_share_visitor (
            token         TEXT NOT NULL,
            ip            TEXT NOT NULL,
            first_at      REAL NOT NULL,
            last_at       REAL NOT NULL,
            hits          INTEGER DEFAULT 0,
            ua            TEXT DEFAULT '',
            PRIMARY KEY (token, ip)
        )
    """)
    # v5.45.0 · FonrVFS P2: 操作审计 (可导出 CSV)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_audit (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ts          REAL NOT NULL,
            user        TEXT DEFAULT '',
            action      TEXT NOT NULL,
            storage_id  TEXT DEFAULT '',
            path        TEXT DEFAULT '',
            detail      TEXT DEFAULT '',
            result      TEXT DEFAULT 'ok'
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fonr_audit_ts ON fonr_audit(ts DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fonr_audit_action ON fonr_audit(action)")
    # v5.47.0 · FonrVFS P3 治理: 存储级 ACL / 配额 / 用量
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_acl (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            storage_id  TEXT NOT NULL,
            subject     TEXT NOT NULL,
            perms       INTEGER NOT NULL DEFAULT 0,
            path_prefix TEXT DEFAULT '',
            note        TEXT DEFAULT '',
            created_at  REAL
        )
    """)
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_fonr_acl_u "
                "ON fonr_acl(storage_id, subject, path_prefix)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_quota (
            storage_id TEXT PRIMARY KEY,
            max_bytes  INTEGER DEFAULT 0,
            max_files  INTEGER DEFAULT 0,
            warn_pct   INTEGER DEFAULT 90,
            updated_at REAL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_usage (
            storage_id TEXT PRIMARY KEY,
            bytes      INTEGER DEFAULT 0,
            files      INTEGER DEFAULT 0,
            dirs       INTEGER DEFAULT 0,
            scanned_at REAL,
            partial    INTEGER DEFAULT 0
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_setting (
            k           TEXT PRIMARY KEY,
            v           TEXT DEFAULT '',
            updated_at  REAL NOT NULL
        )
    """)

    # v5.54.0 · P3-14 DLP 规则 / P3-16 元数据索引 + FTS5
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_dlp (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            scope      TEXT NOT NULL DEFAULT '*',
            match_type TEXT NOT NULL DEFAULT 'glob',
            pattern    TEXT NOT NULL,
            action     TEXT NOT NULL DEFAULT 'warn',
            enabled    INTEGER NOT NULL DEFAULT 1,
            note       TEXT DEFAULT '',
            created_at REAL
        )
    """)
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_fonr_dlp_u ON fonr_dlp(scope, match_type, pattern)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_index (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            storage_id TEXT NOT NULL,
            path       TEXT NOT NULL,
            name       TEXT NOT NULL,
            is_dir     INTEGER NOT NULL DEFAULT 0,
            size       INTEGER NOT NULL DEFAULT 0,
            mtime      INTEGER NOT NULL DEFAULT 0,
            scanned_at REAL
        )
    """)
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_fonr_index_p ON fonr_index(storage_id, path)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_fonr_index_s ON fonr_index(storage_id, is_dir)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS fonr_index_scan (
            storage_id TEXT PRIMARY KEY,
            root       TEXT DEFAULT '/',
            items      INTEGER DEFAULT 0,
            truncated  INTEGER DEFAULT 0,
            scanned_at REAL
        )
    """)
    try:
        cur.execute("CREATE VIRTUAL TABLE IF NOT EXISTS fonr_index_fts USING fts5(name, path)")
        #   v5.54.0 · 教训(两层): ①初版只建 DELETE/UPDATE 触发器 → 新行从不进 FTS, 检索恒 0;
        #   ②补的 INSERT 触发器体内用 `INSERT OR REPLACE` 写 FTS5 → **第二次扫描同一文件**
        #   时 SQLite 报 `IntegrityError: constraint failed`(FTS5 在触发器上下文里对已存在
        #   rowid 的 OR REPLACE 会冲突)。结论: **FTS 同步不依赖触发器**, 由 fonr_index_upsert
        #   在显式事务里 DELETE+INSERT 维护; 这里只负责清理历史遗留触发器。
        for _tg in ("fonr_index_ai", "fonr_index_au", "fonr_index_ad"):
            try:
                cur.execute("DROP TRIGGER IF EXISTS %s" % _tg)
            except Exception as _te:
                print("[db] 清理历史 FTS 触发器 %s 失败(可忽略): %s" % (_tg, _te))
        _fts_n = cur.execute("SELECT COUNT(*) FROM fonr_index_fts").fetchone()[0]
        _idx_n = cur.execute("SELECT COUNT(*) FROM fonr_index").fetchone()[0]
        if _idx_n and not _fts_n:
            cur.execute("INSERT OR REPLACE INTO fonr_index_fts(rowid, name, path) "
                        "SELECT id, name, path FROM fonr_index")
            print("[db] fonr_index_fts 已回填 %d 行" % _idx_n)
        # 旧版遗留的 ad/au 触发器一并清掉 (au 的 OR REPLACE 写法在 FTS5 上会报
        #   IntegrityError, 是"第二次扫描失败"的直接原因)
    except Exception as _e:      # FTS5 不可用 (精简构建) → 检索自动回落 LIKE
        print("[db] FTS5 不可用, fonr_index 检索将回落 LIKE: %s" % _e)

    # v4.12.0: 备份保留策略（每个用户一条 · JSON 存 rules）
    cur.execute("""
        CREATE TABLE IF NOT EXISTS retention_policies (
            user_id INTEGER PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            keep_days INTEGER DEFAULT 0,        -- 0 = 不按天数清
            keep_count INTEGER DEFAULT 0,       -- 0 = 不按份数清
            scope TEXT DEFAULT 'all',           -- all / auto_backup / platform_backup / rsync
            delete_files INTEGER DEFAULT 0,     -- 是否同步 rm 本地文件 (需要 destination 是本地路径)
            auto_apply INTEGER DEFAULT 0,       -- v4.13.0: 定时任务完成后自动 apply
            updated_at TEXT DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    # v4.13.0: 迁移 · 老库补 auto_apply 列
    try:
        cols = {r[1] for r in cur.execute("PRAGMA table_info(retention_policies)").fetchall()}
        if "auto_apply" not in cols:
            cur.execute("ALTER TABLE retention_policies ADD COLUMN auto_apply INTEGER DEFAULT 0")
    except Exception as e:
        print(f"[db] retention_policies migrate auto_apply skipped: {e}")

    # v4.13.6: 保留策略执行历史 · 支持可视化
    cur.execute("""
        CREATE TABLE IF NOT EXISTS retention_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            run_time TEXT DEFAULT (datetime('now', 'localtime')),
            trigger TEXT DEFAULT 'manual',    -- manual | auto | scheduled
            scope TEXT,                        -- all/auto_backup/platform_backup/rsync
            keep_days INTEGER,
            keep_count INTEGER,
            deleted_records INTEGER DEFAULT 0,
            deleted_files INTEGER DEFAULT 0,
            bytes_freed INTEGER DEFAULT 0,
            duration_ms INTEGER DEFAULT 0,
            errors_json TEXT DEFAULT '[]',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_retention_runs_user_time ON retention_runs(user_id, run_time DESC)")

    # v4.12.0: 用户 UI 偏好（主题 / 显示模式 / 侧栏折叠 / 快捷键自定义）
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_ui_prefs (
            user_id INTEGER PRIMARY KEY,
            theme TEXT DEFAULT 'light',               -- v4.39.0: 默认浅色(light/dark/auto)
            density TEXT DEFAULT 'full',              -- full / compact
            sidebar_collapsed INTEGER DEFAULT 0,
            quick_actions_json TEXT DEFAULT '[]',     -- JSON 数组: [{id,label,action}]
            hide_run_log INTEGER DEFAULT 0,           -- v4.38.37: 隐藏底部运行日志 dock
            updated_at TEXT DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)

    # v4.15.24 · 全局 kv 设置表（scope_tag_rules 等用户可配项）
    cur.execute("""
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT DEFAULT '',
            updated_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)

    # v4.20.0 · 事件日志持久化（配合 backend.events 环形缓冲）
    cur.execute("""
        CREATE TABLE IF NOT EXISTS event_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            topic TEXT NOT NULL,
            payload_json TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log(ts DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_event_log_topic ON event_log(topic)")

    # v4.23.0 · 告警历史（每次告警触发记录）
    cur.execute("""
        CREATE TABLE IF NOT EXISTS alert_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            rule_name TEXT DEFAULT '',
            topic TEXT DEFAULT '',
            channel TEXT DEFAULT '',
            target TEXT DEFAULT '',
            status TEXT DEFAULT '',
            err_msg TEXT DEFAULT '',
            payload_json TEXT DEFAULT ''
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_alert_history_ts ON alert_history(ts DESC)")

    # v4.23.0 · event_log FTS5 全文索引（可选：若 sqlite 支持 FTS5）
    try:
        cur.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS event_log_fts USING fts5(
                payload_json, content='event_log', content_rowid='id'
            )
        """)
        cur.execute("""
            CREATE TRIGGER IF NOT EXISTS event_log_ai AFTER INSERT ON event_log BEGIN
                INSERT INTO event_log_fts(rowid, payload_json) VALUES (new.id, new.payload_json);
            END
        """)
        cur.execute("""
            CREATE TRIGGER IF NOT EXISTS event_log_ad AFTER DELETE ON event_log BEGIN
                INSERT INTO event_log_fts(event_log_fts, rowid, payload_json) VALUES ('delete', old.id, old.payload_json);
            END
        """)
    except Exception as _e:
        print(f"[db] FTS5 unavailable: {_e}")


    # v5.35.0 · G2: configs 列迁移 (meta_json/panel_scope/sort_order) 随表退役

    # v4.38.0: backups 表加 sha256 + verified_at 列（幂等）
    bcols = [row[1] for row in cur.execute("PRAGMA table_info(backups)").fetchall()]
    if 'sha256' not in bcols:
        cur.execute("ALTER TABLE backups ADD COLUMN sha256 TEXT DEFAULT ''")
    if 'verified_at' not in bcols:
        cur.execute("ALTER TABLE backups ADD COLUMN verified_at TEXT DEFAULT ''")

    # v4.38.37: user_ui_prefs 表加 hide_run_log 列（幂等）· 设置页「隐藏运行日志」开关
    ucols = [row[1] for row in cur.execute("PRAGMA table_info(user_ui_prefs)").fetchall()]
    if 'hide_run_log' not in ucols:
        cur.execute("ALTER TABLE user_ui_prefs ADD COLUMN hide_run_log INTEGER DEFAULT 0")

    # v4.39.0 Phase 2a · 网络共享配置表（SMB/NFS/AFP/WebDAV）
    cur.execute("""
        CREATE TABLE IF NOT EXISTS shares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT UNIQUE,
            user_id INTEGER DEFAULT 1,
            name TEXT NOT NULL,
            color TEXT DEFAULT 'var(--blue)',
            proto TEXT NOT NULL DEFAULT 'smb',
            host TEXT DEFAULT '',
            port TEXT DEFAULT '',
            share TEXT DEFAULT '',
            path TEXT DEFAULT '',
            user TEXT DEFAULT '',
            auth_type TEXT DEFAULT 'pass',
            auth_value TEXT DEFAULT '',
            domain TEXT DEFAULT '',
            vers TEXT DEFAULT '',
            ro INTEGER DEFAULT 0,
            uid TEXT DEFAULT '0',
            gid TEXT DEFAULT '0',
            opts TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            last_mounted_at TEXT DEFAULT '',
            last_status TEXT DEFAULT ''
        )
    """)
    # 回填 uuid（幂等）
    _scols = [row[1] for row in cur.execute("PRAGMA table_info(shares)").fetchall()]
    if 'uuid' in _scols:
        from backend.db.uuidv7 import uuidv7 as _share_uuidv7
        _srows = cur.execute(
            "SELECT rowid FROM shares WHERE uuid IS NULL OR uuid = ''"
        ).fetchall()
        for r in _srows:
            cur.execute(
                "UPDATE shares SET uuid=? WHERE rowid=?",
                (_share_uuidv7(), r[0])
            )
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_uuid "
            "ON shares(uuid) WHERE uuid IS NOT NULL AND uuid != ''"
        )

    conn.commit()

    # v4.39.0 · UUID v7 化迁移 (幂等; v5.35.0 剔除 configs)
    _migrate_uuid_v7(cur)
    conn.commit()

    # v5.34.1 · 连接中心 P1 表 (全新装机/测试临时库都经 init_db 建齐)
    _create_server_profiles_table(conn)
    _upgrade_server_profiles_v534(conn)
    _create_server_groups_table(conn)
    _create_conn_audit_log_table(conn)
    _create_credentials_table(conn)      # v5.34.6 · P6 凭据保险库
    conn.commit()

    # v4.39.0 · 确保 scheduler/flows 表存在(延迟 import 避免循环引用)
    try:
        from backend.scheduler import _ensure_table as _sched_ensure
        _sched_ensure()
    except Exception:
        pass
    try:
        from backend.db.flows import _ensure_tables as _flow_ensure
        _flow_ensure(conn)
    except Exception:
        pass


# ==================== CRUD 操作 ====================

# --- 配置 ---

# v5.35.0 · G2: CONFIG_META_FIELDS (configs 40 列清单) 退役

# ═════════════════════════════════════════════════════════════
# § 4. v5.35.0 · G2 零遗留: configs 委托层与 backend/db/configs.py 整体退役
# ═════════════════════════════════════════════════════════════

def _create_server_profiles_table(conn):
    """v5.33.0 · 统一服务器档案表 (GUID 主键, 多协议, 按需扩展)。"""
    conn.execute("""CREATE TABLE IF NOT EXISTS server_profiles (
        guid        TEXT PRIMARY KEY,
        user_id     INTEGER DEFAULT 1,
        name        TEXT DEFAULT '',
        color       TEXT DEFAULT '',
        tags        TEXT DEFAULT '',
        hostname    TEXT DEFAULT '',
        ssh_port    INTEGER DEFAULT 22,
        ssh_user    TEXT DEFAULT 'root',
        ssh_auth_type TEXT DEFAULT 'pass',
        ssh_auth_value TEXT DEFAULT '',
        ssh_passphrase TEXT DEFAULT '',
        protocols   TEXT DEFAULT '{}',
        os_type     TEXT DEFAULT '',
        notes       TEXT DEFAULT '',
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
    )""")



# v5.34.1 · P1 连接中心档案内核升级列 (全部带默认值, ALTER 平滑迁移)
_SP_V534_COLUMNS = {
    "kind":            "TEXT DEFAULT 'linux'",      # linux|windows|pve|nas|storage|share|cloud
    "description":     "TEXT DEFAULT ''",
    "icon":            "TEXT DEFAULT 'server'",
    "group_id":        "TEXT DEFAULT ''",            # → server_groups.guid
    "sort_order":      "INTEGER DEFAULT 0",
    "is_starred":      "INTEGER DEFAULT 0",
    "ssh_timeout":     "INTEGER DEFAULT 30",
    "ssh_keepalive":   "INTEGER DEFAULT 60",
    "ssh_proxy_jump":  "TEXT DEFAULT ''",            # 跳板机 profile guid
    "strict_host_key": "INTEGER DEFAULT 1",          # 0=accept-new 1=strict
    "os_version":      "TEXT DEFAULT ''",
    "arch":            "TEXT DEFAULT ''",
    "hostname_real":   "TEXT DEFAULT ''",
    "status":          "TEXT DEFAULT 'unknown'",     # online|offline|degraded|unknown
    "last_seen":       "TEXT DEFAULT ''",
    "last_latency_ms": "INTEGER DEFAULT -1",
    "version":         "INTEGER DEFAULT 1",          # 乐观并发
    "remote_uuid":     "TEXT DEFAULT ''",            # → remote_configs.uuid (过渡期链接)
    "share_id":        "INTEGER DEFAULT 0",          # → shares.id (过渡期链接)
}


def _upgrade_server_profiles_v534(conn):
    """v5.34.1 · 补齐 P1 新列 (幂等: 已存在的列跳过)。"""
    have = {r[1] for r in conn.execute("PRAGMA table_info(server_profiles)").fetchall()}
    for col, ddl in _SP_V534_COLUMNS.items():
        if col not in have:
            conn.execute(f"ALTER TABLE server_profiles ADD COLUMN {col} {ddl}")
    # 去重唯一索引 (部分索引: 空主机名不参与, 允许多条未填主机的草稿)
    conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_sp_endpoint
        ON server_profiles(user_id, hostname, ssh_port) WHERE hostname != ''""")


def _create_server_groups_table(conn):
    """v5.34.1 · 分组树 (parent_id 支持多层嵌套)。"""
    conn.execute("""CREATE TABLE IF NOT EXISTS server_groups (
        guid        TEXT PRIMARY KEY,
        user_id     INTEGER DEFAULT 1,
        name        TEXT DEFAULT '',
        color       TEXT DEFAULT '',
        icon        TEXT DEFAULT 'folder',
        parent_id   TEXT DEFAULT '',
        sort_order  INTEGER DEFAULT 0,
        created_at  TEXT DEFAULT (datetime('now'))
    )""")


def _create_conn_audit_log_table(conn):
    """v5.34.1 · 连接操作审计。"""
    conn.execute("""CREATE TABLE IF NOT EXISTS conn_audit_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER DEFAULT 1,
        username      TEXT DEFAULT '',
        profile_guid  TEXT DEFAULT '',
        action        TEXT DEFAULT '',
        protocol      TEXT DEFAULT '',
        detail        TEXT DEFAULT '',
        created_at    TEXT DEFAULT (datetime('now'))
    )""")
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_audit_guid
        ON conn_audit_log(profile_guid, created_at)""")


def _create_credentials_table(conn):
    """v5.34.6 · P6 凭据保险库 (跨服务器共享凭据; 全字段 Fernet)。"""
    conn.execute("""CREATE TABLE IF NOT EXISTS credentials (
        guid        TEXT PRIMARY KEY,
        user_id     INTEGER DEFAULT 1,
        name        TEXT DEFAULT '',
        type        TEXT DEFAULT 'ssh',
        username    TEXT DEFAULT '',
        password    TEXT DEFAULT '',
        private_key TEXT DEFAULT '',
        passphrase  TEXT DEFAULT '',
        extra_json  TEXT DEFAULT '{}',
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
    )""")


def conn_audit_insert(user_id: int, username: str, profile_guid: str,
                      action: str, protocol: str = "", detail: str = "") -> None:
    """v5.34.1 · 写一条连接审计 (失败不抛, 不影响业务)。"""
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO conn_audit_log(user_id, username, profile_guid, action, protocol, detail) "
                "VALUES(?,?,?,?,?,?)",
                (user_id, username[:64], profile_guid, action, protocol, detail[:2000]))
            conn.commit()
    except Exception as e:
        print(f"[db] conn_audit_insert fail: {e}")


def conn_audit_recent(profile_guid: str = "", limit: int = 50) -> list:
    """v5.34.1 · 最近审计记录 (可按档案过滤)。"""
    limit = max(1, min(int(limit or 50), 500))
    with get_conn() as conn:
        if profile_guid:
            # v5.34.2 · 同时匹配 detail 内的 guid 清单 (import/export 批量记录的档案也可追溯)
            rows = conn.execute(
                "SELECT id, user_id, username, profile_guid, action, protocol, detail, created_at "
                "FROM conn_audit_log WHERE profile_guid=? OR detail LIKE ? ORDER BY id DESC LIMIT ?",
                (profile_guid, f"%{profile_guid}%", limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, user_id, username, profile_guid, action, protocol, detail, created_at "
                "FROM conn_audit_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]



def _migrate_uuid_v7(cur):
    """v4.39.0 · UUID v7 化迁移(幂等); v5.35.0 · G2: 表清单剔除 configs。
    为所有实体表 ADD COLUMN uuid, 回填存量行, 建唯一索引 + entity_refs 引用注册表。
    """
    from backend.db.uuidv7 import uuidv7
    uuid_tables = [
        'users', 'remote_configs', 'backups',
        'backup_flows', 'backup_flow_runs',
        'schedules', 'schedule_runs',
        'remote_uploads',
        'retention_policies', 'retention_runs',
    ]
    for table in uuid_tables:
        try:
            cols = {r[1] for r in cur.execute(f"PRAGMA table_info({table})").fetchall()}
        except Exception:
            continue
        if not cols:
            continue
        if 'uuid' not in cols:
            cur.execute(f"ALTER TABLE {table} ADD COLUMN uuid TEXT DEFAULT ''")
        rows = cur.execute(f"SELECT rowid FROM {table} WHERE uuid IS NULL OR uuid=''").fetchall()
        for r in rows:
            cur.execute(f"UPDATE {table} SET uuid=? WHERE rowid=?", (uuidv7(), r[0]))
        cur.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{table}_uuid "
            f"ON {table}(uuid) WHERE uuid IS NOT NULL AND uuid != ''"
        )
    cur.execute("""
        CREATE TABLE IF NOT EXISTS entity_refs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_table TEXT NOT NULL,
            source_uuid TEXT NOT NULL,
            source_field TEXT NOT NULL,
            target_table TEXT NOT NULL,
            target_uuid TEXT NOT NULL,
            ref_kind TEXT DEFAULT 'soft',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(source_table, source_uuid, source_field, target_table, target_uuid)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_entity_refs_target ON entity_refs(target_table, target_uuid)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_entity_refs_source ON entity_refs(source_table, source_uuid)")


def register_ref(source_table: str, source_uuid: str, source_field: str,
                 target_table: str, target_uuid: str, ref_kind: str = 'soft'):
    from backend.db.entity_refs import register_ref as _impl
    return _impl(get_conn(), source_table, source_uuid, source_field,
                 target_table, target_uuid, ref_kind)


def unregister_ref(source_table: str, source_uuid: str, source_field: str):
    from backend.db.entity_refs import unregister_ref as _impl
    return _impl(get_conn(), source_table, source_uuid, source_field)


def update_ref(source_table: str, source_uuid: str, source_field: str,
               target_table: str, target_uuid: str, ref_kind: str = 'soft'):
    from backend.db.entity_refs import update_ref as _impl
    return _impl(get_conn(), source_table, source_uuid, source_field,
                 target_table, target_uuid, ref_kind)


def get_refs_to(target_table: str, target_uuid: str) -> list:
    from backend.db.entity_refs import get_refs_to as _impl
    return _impl(get_conn(), target_table, target_uuid)


def get_refs_from(source_table: str, source_uuid: str) -> list:
    from backend.db.entity_refs import get_refs_from as _impl
    return _impl(get_conn(), source_table, source_uuid)


# --- v4.39.0 Phase 2a · 网络共享 ---

def share_list(user_id: int = 1) -> list:
    from backend.db.shares import share_list as _impl
    return _impl(get_conn(), user_id)


# --- v6.4.0 批3 · 分享统一台账 share_registry ---

def share_reg_register(**kw) -> int:
    from backend.db.share_registry import register as _impl
    return _impl(get_conn(), **kw)

def share_reg_update(rid: int, **kw) -> bool:
    from backend.db.share_registry import update as _impl
    return _impl(get_conn(), rid, **kw)

def share_reg_remove(rid: int) -> bool:
    from backend.db.share_registry import remove as _impl
    return _impl(get_conn(), rid)

def share_reg_remove_by_ref(source_module: str, ref: str, type: Optional[str] = None) -> int:
    from backend.db.share_registry import remove_by_ref as _impl
    return _impl(get_conn(), source_module, ref, type)

def share_reg_get(rid) -> Optional[dict]:
    from backend.db.share_registry import get as _impl
    return _impl(get_conn(), int(rid))

def share_reg_list(source_module: str = "", type: str = "", status: str = "") -> list:
    from backend.db.share_registry import list_all as _impl
    return _impl(get_conn(), source_module=source_module, type=type, status=status)

def share_reg_prune_dead_links() -> int:
    from backend.db.share_registry import prune_dead_links as _impl
    return _impl(get_conn())

def share_reg_next_block_id() -> int:
    from backend.db.share_registry import next_block_id as _impl
    return _impl(get_conn())

def share_get(share_id=None, user_id: int = 1, *, uuid: Optional[str] = None):
    from backend.db.shares import share_get as _impl
    return _impl(get_conn(), share_id, user_id, uuid=uuid)

def share_create(data: dict, user_id: int = 1) -> int:
    from backend.db.shares import share_create as _impl
    return _impl(get_conn(), data, user_id)

def share_update(share_id: int, data: dict, user_id: int = 1, *, uuid: Optional[str] = None):
    from backend.db.shares import share_update as _impl
    return _impl(get_conn(), share_id, data, user_id, uuid=uuid)

def share_delete(share_id: int, user_id: int = 1, *, uuid: Optional[str] = None):
    from backend.db.shares import share_delete as _impl
    return _impl(get_conn(), share_id, user_id, uuid=uuid)

def share_update_status(share_uuid: str, status: str, mounted_at: str = ''):
    from backend.db.shares import share_update_status as _impl
    return _impl(get_conn(), share_uuid, status, mounted_at)

# --- 任务 ---

# ═════════════════════════════════════════════════════════════
# § 5. Tasks & Logs · v3.3.4-5: 委托子模块
# ═════════════════════════════════════════════════════════════

def task_create(task_id: str, name: str, task_type: str, user_id: int = 1, command: str = '') -> int:
    from backend.db.tasks import task_create as _impl
    return _impl(get_conn(), task_id, name, task_type, user_id, command)


def task_update(task_id: str, **kwargs):
    from backend.db.tasks import task_update as _impl
    return _impl(get_conn(), task_id, **kwargs)


def task_list(user_id: int = 1, limit: int = 50) -> list:
    from backend.db.tasks import task_list as _impl
    return _impl(get_conn(), user_id, limit)


def task_get(task_id: str, user_id: int = 1) -> dict:
    from backend.db.tasks import task_get as _impl
    return _impl(get_conn(), task_id, user_id)


# --- 日志 ---

def log_create(level: str, category: str, message: str, detail: str = '',
               task_id: str = '', user_id: int = 1):
    from backend.db.logs import log_create as _impl
    return _impl(get_conn(), level, category, message, detail, task_id, user_id)


def log_list(category: str = '', limit: int = 200, user_id: int = 1) -> list:
    from backend.db.logs import log_list as _impl
    return _impl(get_conn(), category, limit, user_id)


# --- 备份 ---

# ═════════════════════════════════════════════════════════════
# § 6. Backups · v3.3.6: 委托子模块
# ═════════════════════════════════════════════════════════════

def backup_create(config_id, source: str, destination: str,
                  backup_type: str, task_id: str = '', user_id: int = 1) -> int:
    from backend.db.backups import backup_create as _impl
    return _impl(get_conn(), config_id, source, destination, backup_type, task_id, user_id)


def backup_update(backup_id: int, **kwargs):
    from backend.db.backups import backup_update as _impl
    return _impl(get_conn(), backup_id, **kwargs)


def backup_list(user_id: int = 1, limit: int = 100) -> list:
    from backend.db.backups import backup_list as _impl
    return _impl(get_conn(), user_id, limit)


# v4.14.0-alpha1 · Dashboard 聚合
def dashboard_kpi(user_id: int = 1, start_date: str = '', end_date: str = '') -> dict:
    """总备份数 / 成功率 / 总大小 / 平均耗时 · 支持日期范围过滤 (v4.38.0)"""
    conn = get_conn()
    where = "WHERE user_id = ?"
    params = [user_id]
    if start_date:
        where += " AND started_at >= ?"
        params.append(start_date)
    if end_date:
        where += " AND started_at <= ?"
        params.append(end_date + " 23:59:59")
    row = conn.execute(f"""
        SELECT
            COUNT(*)                                  AS total,
            SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) AS fail,
            SUM(CASE WHEN status='running'   THEN 1 ELSE 0 END) AS running,
            COALESCE(SUM(size_bytes), 0)              AS total_bytes,
            COALESCE(SUM(file_count), 0)              AS total_files,
            COALESCE(AVG(CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL
                              THEN (julianday(finished_at) - julianday(started_at)) * 86400
                          END), 0)                    AS avg_duration_sec,
            MAX(started_at)                           AS last_backup_at
        FROM backups {where}
    """, params).fetchone()
    ok = int(row["ok"] or 0)
    total = int(row["total"] or 0)
    total_bytes = int(row["total_bytes"] or 0)

    # v4.38.0 · 最活跃的备份类型
    type_row = conn.execute(f"""
        SELECT type, COUNT(*) AS cnt FROM backups {where}
        GROUP BY type ORDER BY cnt DESC LIMIT 1
    """, params).fetchone()

    return {
        "total": total,
        "ok": ok,
        "failed": int(row["fail"] or 0),
        "running": int(row["running"] or 0),
        "success_rate": round(ok * 100.0 / total, 1) if total else 0.0,
        "total_bytes": total_bytes,
        "total_files": int(row["total_files"] or 0),
        "avg_duration_sec": round(float(row["avg_duration_sec"] or 0), 1),
        "avg_backup_bytes": round(total_bytes / total) if total and total_bytes else 0,
        "last_backup_at": row["last_backup_at"] or '',
        "most_active_type": type_row["type"] if type_row else '',
    }


def dashboard_timeline(user_id: int = 1, days: int = 30,
                       start_date: str = '', end_date: str = '') -> list:
    """按天聚合备份运行数 · [{date,total,ok,failed,bytes}]
    v4.38.0: 支持 start_date/end_date 自定义日期范围"""
    conn = get_conn()
    if start_date and end_date:
        rows = conn.execute("""
            SELECT
                substr(started_at, 1, 10)                       AS date,
                COUNT(*)                                        AS total,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) AS failed,
                COALESCE(SUM(size_bytes), 0)                    AS bytes
            FROM backups
            WHERE user_id = ?
              AND started_at >= ?
              AND started_at <= ?
            GROUP BY substr(started_at, 1, 10)
            ORDER BY date ASC
        """, (user_id, start_date, end_date + " 23:59:59")).fetchall()
    else:
        rows = conn.execute("""
            SELECT
                substr(started_at, 1, 10)                       AS date,
                COUNT(*)                                        AS total,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) AS failed,
                COALESCE(SUM(size_bytes), 0)                    AS bytes
            FROM backups
            WHERE user_id = ?
              AND started_at >= datetime('now', 'localtime', ?)
            GROUP BY substr(started_at, 1, 10)
            ORDER BY date ASC
        """, (user_id, "-{} days".format(int(days)))).fetchall()
    return [dict(r) for r in rows]


def dashboard_by_type(user_id: int = 1) -> list:
    """按 type 聚合 · [{type,count,bytes}]"""
    conn = get_conn()
    rows = conn.execute("""
        SELECT type, COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes
        FROM backups WHERE user_id = ?
        GROUP BY type ORDER BY count DESC
    """, (user_id,)).fetchall()
    return [dict(r) for r in rows]


# v4.15.0-alpha1 · Backup Flows 门面
def flow_create(user_id: int, name: str, **kw) -> int:
    from backend.db.flows import flow_create as _impl
    return _impl(get_conn(), user_id, name, **kw)


def flow_list(user_id: int = 1) -> list:
    from backend.db.flows import flow_list as _impl
    return _impl(get_conn(), user_id)


def flow_get(flow_id: int = None, *, uuid: Optional[str] = None):
    from backend.db.flows import flow_get as _impl
    return _impl(get_conn(), flow_id, uuid=uuid)


def flow_update(flow_id: int, **kw):
    from backend.db.flows import flow_update as _impl
    return _impl(get_conn(), flow_id, **kw)


def flow_delete(flow_id: int, *, uuid: Optional[str] = None):
    from backend.db.flows import flow_delete as _impl
    return _impl(get_conn(), flow_id, uuid=uuid)


def flow_duplicate(flow_id: int, new_name: Optional[str] = None, *, uuid: Optional[str] = None) -> int:
    from backend.db.flows import flow_duplicate as _impl
    return _impl(get_conn(), flow_id, new_name, uuid=uuid)


def flow_run_create(flow_id: int, trigger: str = "manual") -> int:
    from backend.db.flows import flow_run_create as _impl
    return _impl(get_conn(), flow_id, trigger)


def flow_run_finish(run_id: int, status: str, **kw):
    from backend.db.flows import flow_run_finish as _impl
    return _impl(get_conn(), run_id, status, **kw)


def flow_run_list(flow_id: int, limit: int = 50) -> list:
    from backend.db.flows import flow_run_list as _impl
    return _impl(get_conn(), flow_id, limit)


def flow_run_recent(user_id: int = 1, limit: int = 30) -> list:
    from backend.db.flows import flow_run_recent as _impl
    return _impl(get_conn(), user_id, limit)


def flow_run_stats(user_id: int = 1, days: int = 30, flow_id=None) -> dict:
    """v4.15.25 · flow 运行统计（Dashboard 报表）· v4.15.32 加 flow_id 可选过滤"""
    from backend.db.flows import flow_run_stats as _impl
    return _impl(get_conn(), user_id, days, flow_id)


# ═════════════════════════════════════════════════════════════
# § 6.5 Remotes (v4.2.0: S3 / Seafile 远端存储)
# ═════════════════════════════════════════════════════════════

def remote_create(user_id: int, name: str, provider: str, **kw) -> int:
    from backend.db.remotes import remote_create as _impl
    return _impl(get_conn(), user_id, name, provider, **kw)


def remote_get(remote_id: int = None, *, decrypt: bool = True, uuid: Optional[str] = None):
    from backend.db.remotes import remote_get as _impl
    return _impl(get_conn(), remote_id, decrypt=decrypt, uuid=uuid)


def remote_list(user_id: int = 1, *, mask_secret: bool = True) -> list:
    from backend.db.remotes import remote_list as _impl
    return _impl(get_conn(), user_id, mask_secret=mask_secret)


def remote_update(remote_id: int, **kwargs):
    from backend.db.remotes import remote_update as _impl
    return _impl(get_conn(), remote_id, **kwargs)


def remote_delete(remote_id: int, *, uuid: Optional[str] = None):
    from backend.db.remotes import remote_delete as _impl
    return _impl(get_conn(), remote_id, uuid=uuid)



# ═════════════════════════════════════════════════════════════
# § 6.6 FonrVFS (v5.40.0: 多云文件管理 —— 上传会话 / 任务 / 收藏)
# ═════════════════════════════════════════════════════════════

def fonr_session_create(user_id: int, **kw):
    from backend.db.fonrvfs import session_create as _impl
    return _impl(get_conn(), user_id, **kw)


def fonr_session_get(sid: str):
    from backend.db.fonrvfs import session_get as _impl
    return _impl(get_conn(), sid)


def fonr_session_update(sid: str, **fields):
    from backend.db.fonrvfs import session_update as _impl
    return _impl(get_conn(), sid, **fields)


def fonr_session_list(user_id: int = 1, **kw):
    from backend.db.fonrvfs import session_list as _impl
    return _impl(get_conn(), user_id, **kw)


def fonr_session_delete(sid: str):
    from backend.db.fonrvfs import session_delete as _impl
    return _impl(get_conn(), sid)


def fonr_job_create(job: dict):
    from backend.db.fonrvfs import job_create as _impl
    return _impl(get_conn(), job)


def fonr_job_update(job: dict):
    from backend.db.fonrvfs import job_update as _impl
    return _impl(get_conn(), job)


def fonr_job_list(limit: int = 100):
    from backend.db.fonrvfs import job_list as _impl
    return _impl(get_conn(), limit=limit)


def fonr_job_get(jid: str):
    from backend.db.fonrvfs import job_get as _impl
    return _impl(get_conn(), jid)


def fonr_job_delete(jid: str):
    from backend.db.fonrvfs import job_delete as _impl
    return _impl(get_conn(), jid)


def fonr_job_delete_by_status(statuses):
    from backend.db.fonrvfs import job_delete_by_status as _impl
    return _impl(get_conn(), statuses)


def fonr_fav_list(user_id: int = 1):
    from backend.db.fonrvfs import fav_list as _impl
    return _impl(get_conn(), user_id)


def fonr_fav_save(user_id: int, **kw):
    from backend.db.fonrvfs import fav_save as _impl
    return _impl(get_conn(), user_id, **kw)


def fonr_fav_delete(fid: int):
    from backend.db.fonrvfs import fav_delete as _impl
    return _impl(get_conn(), fid)


def fonr_recent_touch(user_id: int, storage_id: str, path: str, name: str = "",
                      kind: str = "", size: int = 0):
    from backend.db.fonrvfs import recent_touch as _impl
    return _impl(get_conn(), user_id, storage_id, path, name, kind, size)


def fonr_recent_list(user_id: int = 1, limit: int = 50):
    from backend.db.fonrvfs import recent_list as _impl
    return _impl(get_conn(), user_id, int(limit))


def fonr_recent_delete(user_id: int = 1, storage_id: str = "", path: str = ""):
    from backend.db.fonrvfs import recent_delete as _impl
    return _impl(get_conn(), user_id, storage_id, path)


def fonr_recent_clear(user_id: int = 1, storage_id: str = ""):
    from backend.db.fonrvfs import recent_clear as _impl
    return _impl(get_conn(), user_id, storage_id)


def fonr_trash_add(storage_id: str, orig_path: str, trash_path: str, **kw):
    from backend.db.fonrvfs import trash_add as _impl
    return _impl(get_conn(), storage_id, orig_path, trash_path, **kw)


def fonr_trash_list(storage_id: str = "", limit: int = 500):
    from backend.db.fonrvfs import trash_list as _impl
    return _impl(get_conn(), storage_id, int(limit))


def fonr_trash_get(tid: int):
    from backend.db.fonrvfs import trash_get as _impl
    return _impl(get_conn(), int(tid))


def fonr_trash_mark_restored(tid: int):
    from backend.db.fonrvfs import trash_mark_restored as _impl
    return _impl(get_conn(), int(tid))


def fonr_trash_delete(tid: int):
    from backend.db.fonrvfs import trash_delete as _impl
    return _impl(get_conn(), int(tid))


def fonr_trash_expired(limit: int = 200):
    from backend.db.fonrvfs import trash_expired as _impl
    return _impl(get_conn(), int(limit))


def fonr_acl_list(storage_id: str = ""):
    from backend.db.fonrvfs import acl_list as _impl
    return _impl(get_conn(), storage_id)


def fonr_acl_set(storage_id: str, subject: str, perms: int, path_prefix: str = "",
                 note: str = ""):
    from backend.db.fonrvfs import acl_set as _impl
    return _impl(get_conn(), storage_id, subject, perms, path_prefix, note)


def fonr_acl_delete(acl_id: int = 0, storage_id: str = ""):
    from backend.db.fonrvfs import acl_delete as _impl
    return _impl(get_conn(), acl_id, storage_id)


def fonr_quota_get(storage_id: str):
    from backend.db.fonrvfs import quota_get as _impl
    return _impl(get_conn(), storage_id)


def fonr_quota_set(storage_id: str, max_bytes: int = 0, max_files: int = 0,
                   warn_pct: int = 90):
    from backend.db.fonrvfs import quota_set as _impl
    return _impl(get_conn(), storage_id, max_bytes, max_files, warn_pct)


def fonr_usage_get(storage_id: str):
    from backend.db.fonrvfs import usage_get as _impl
    return _impl(get_conn(), storage_id)


def fonr_usage_set(storage_id: str, bytes: int = 0, files: int = 0, dirs: int = 0,
                   partial: int = 0):
    from backend.db.fonrvfs import usage_set as _impl
    return _impl(get_conn(), storage_id, bytes, files, dirs, partial)


def fonr_usage_add(storage_id: str, dbytes: int = 0, dfiles: int = 0, ddirs: int = 0):
    from backend.db.fonrvfs import usage_add as _impl
    return _impl(get_conn(), storage_id, dbytes, dfiles, ddirs)


# ══════════════════════════════════════════════════════════════════════════
# v5.57.0 · D3 AI 意图→动作映射审计
#   表在**每次写入前**确保存在(CREATE TABLE IF NOT EXISTS) —— 不用"只在初始化时建表"的写法,
#   因为老库上新增 DDL 未必会跑(阶段A/B 已经踩过 S3 这一类问题), 这里做到幂等自愈。
# ══════════════════════════════════════════════════════════════════════════
def _ai_intent_ensure(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS ai_intent_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, uid INTEGER,
        intent TEXT, verdict TEXT, actions TEXT, rejected TEXT,
        executed INTEGER DEFAULT 0, detail TEXT)""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ai_intent_ts ON ai_intent_log(ts DESC)")


def ai_intent_add(uid: int, intent: str = "", actions=None, executed: bool = False,
                  detail: str = "") -> int:
    """记录一次"意图→沙盒判定→是否执行"。actions 传 sandbox() 的结果字典。"""
    conn = get_conn()
    _ai_intent_ensure(conn)
    sb = actions if isinstance(actions, dict) else {}
    cur = conn.execute(
        "INSERT INTO ai_intent_log(ts,uid,intent,verdict,actions,rejected,executed,detail)"
        " VALUES(?,?,?,?,?,?,?,?)",
        (time.time(), int(uid or 0), str(intent or "")[:500], str(sb.get("verdict") or ""),
         json.dumps((sb.get("reads") or []) + (sb.get("drafts") or []), ensure_ascii=False)[:8000],
         json.dumps(sb.get("rejected") or [], ensure_ascii=False)[:4000],
         1 if executed else 0, str(detail or "")[:1000]))
    conn.commit()
    return cur.lastrowid or 0


def ai_intent_list(limit: int = 50) -> list:
    conn = get_conn()
    _ai_intent_ensure(conn)
    try:
        lim = max(1, min(int(limit), 500))
    except (TypeError, ValueError):
        lim = 50
    rows = conn.execute(
        "SELECT id, ts, uid, intent, verdict, actions, rejected, executed, detail"
        " FROM ai_intent_log ORDER BY id DESC LIMIT ?", (lim,)).fetchall()
    out = []
    for r in rows:
        d = dict(r) if hasattr(r, "keys") else {}
        for k in ("actions", "rejected"):
            try:
                d[k] = json.loads(d.get(k) or "[]")
            except (TypeError, ValueError):
                d[k] = []
        out.append(d)
    return out


def fonr_audit_add(action: str, **kw):
    from backend.db.fonrvfs import audit_add as _impl
    return _impl(get_conn(), action, **kw)


def fonr_audit_list(**kw):
    from backend.db.fonrvfs import audit_list as _impl
    return _impl(get_conn(), **kw)


def fonr_audit_count():
    from backend.db.fonrvfs import audit_count as _impl
    return _impl(get_conn())


def fonr_audit_trim(keep: int = 20000):
    from backend.db.fonrvfs import audit_trim as _impl
    return _impl(get_conn(), keep)


def fonr_audit_purge(before_ts: float):
    from backend.db.fonrvfs import audit_purge as _impl
    return _impl(get_conn(), before_ts)


def fonr_share_add(rec: dict):
    from backend.db.fonrvfs import share_add as _impl
    return _impl(get_conn(), rec)


def fonr_share_list(limit: int = 200):
    from backend.db.fonrvfs import share_list as _impl
    return _impl(get_conn(), int(limit))


def fonr_share_get(token: str):
    from backend.db.fonrvfs import share_get as _impl
    return _impl(get_conn(), token)


def fonr_share_hit(token: str, ip: str = "", ua: str = ""):
    from backend.db.fonrvfs import share_hit as _impl
    return _impl(get_conn(), token, ip, ua)


# v5.99.0 · 分享增强: 访客台账 / 幂等去重 / 删除与清空
def fonr_share_visitors(token: str, limit: int = 200):
    from backend.db.fonrvfs import share_visitors as _impl
    return _impl(get_conn(), token, int(limit))


def fonr_share_visitor_ips(token: str):
    from backend.db.fonrvfs import share_visitor_ips as _impl
    return _impl(get_conn(), token)


def fonr_share_find_recent(storage_id: str, path: str, created_by: str, within_sec: float = 15.0,
                           perm: str = "", max_downloads: int = 0, has_password: bool = False):
    from backend.db.fonrvfs import share_find_recent as _impl
    return _impl(get_conn(), storage_id, path, created_by, within_sec, perm, max_downloads,
                 has_password)


def fonr_share_visit(token: str, ip: str = "", ua: str = ""):
    """只记访客台账(不动下载计数) —— 人数上限靠它统计"哪些地址打开过"。"""
    from backend.db.fonrvfs import share_visit as _impl
    return _impl(get_conn(), token, ip, ua)


def fonr_share_delete(token: str):
    from backend.db.fonrvfs import share_delete as _impl
    return _impl(get_conn(), token)


def fonr_share_purge_all(include_active: bool = False):
    from backend.db.fonrvfs import share_purge_all as _impl
    return _impl(get_conn(), bool(include_active))


def fonr_share_revoke(token: str):
    from backend.db.fonrvfs import share_revoke as _impl
    return _impl(get_conn(), token)


def fonr_share_purge_expired(limit: int = 200):
    from backend.db.fonrvfs import share_purge_expired as _impl
    return _impl(get_conn(), limit)


def fonr_setting_get(k: str, default: str = ""):
    from backend.db.fonrvfs import setting_get as _impl
    return _impl(get_conn(), k, default)


def fonr_setting_set(k: str, v: str):
    from backend.db.fonrvfs import setting_set as _impl
    return _impl(get_conn(), k, v)


def remote_list_auto(user_id: int = 1) -> list:
    from backend.db.remotes import remote_list_auto as _impl
    return _impl(get_conn(), user_id)


def upload_create(backup_id: int, remote_id: int, remote_key: str) -> int:
    from backend.db.remotes import upload_create as _impl
    return _impl(get_conn(), backup_id, remote_id, remote_key)


def upload_update(upload_id: int, **kwargs):
    from backend.db.remotes import upload_update as _impl
    return _impl(get_conn(), upload_id, **kwargs)


def upload_list(*, backup_id: Optional[int] = None, limit: int = 100) -> list:
    from backend.db.remotes import upload_list as _impl
    return _impl(get_conn(), backup_id=backup_id, limit=limit)


def upload_clear(*, remote_id: Optional[int] = None) -> int:
    from backend.db.remotes import upload_clear as _impl
    return _impl(get_conn(), remote_id=remote_id)


# --- 用户 ---

# ═════════════════════════════════════════════════════════════
# § 7. Users (create/list/update/delete/last_login)
# ═════════════════════════════════════════════════════════════

def user_create(username: str, password_hash: str, role: str = 'user') -> int:
    """v3.3.2: 委托 db.users.user_create"""
    from backend.db.users import user_create as _impl
    return _impl(get_conn(), username, password_hash, role)


def user_get(username: str) -> dict:
    """v3.3.2: 委托 db.users.user_get"""
    from backend.db.users import user_get as _impl
    return _impl(get_conn(), username)


def user_list() -> list:
    """v3.3.2: 委托 db.users.user_list"""
    from backend.db.users import user_list as _impl
    return _impl(get_conn())


def user_touch_login(user_id: int):
    """v3.3.2: 委托 db.users.user_touch_login"""
    from backend.db.users import user_touch_login as _impl
    return _impl(get_conn(), user_id)


def user_update(user_id: int, data: dict):
    """v3.3.2: 委托 db.users.user_update"""
    from backend.db.users import user_update as _impl
    return _impl(get_conn(), user_id, data)


def user_delete(user_id: int):
    """v3.3.2: 委托 db.users.user_delete"""
    from backend.db.users import user_delete as _impl
    return _impl(get_conn(), user_id)


# ---- v2.6.3: 用户权限管理 ----
# 所有可控页面 key（与前端 tab id 对应） · v3.3.2: 从 db.users re-export
from backend.db.users import ALL_PAGES  # noqa: E402,F401


# ═════════════════════════════════════════════════════════════
# § 8. Permissions (user_perms_get/set/all + ALL_PAGES)
# ═════════════════════════════════════════════════════════════

def user_perms_get(user_id: int) -> list:
    """v3.3.2: 委托 db.users.user_perms_get"""
    from backend.db.users import user_perms_get as _impl
    return _impl(get_conn(), user_id)


def user_perms_set(user_id: int, pages: list) -> bool:
    """v3.3.2: 委托 db.users.user_perms_set"""
    from backend.db.users import user_perms_set as _impl
    return _impl(get_conn(), user_id, pages)


def user_perms_all() -> dict:
    """v3.3.2: 委托 db.users.user_perms_all"""
    from backend.db.users import user_perms_all as _impl
    return _impl(get_conn())


# ---- API Session 持久化（Phase D+） ----
# v3.3.7: 委托 backend.db.sessions（TTL 常量 re-export）
from backend.db.sessions import API_SESSION_TTL_HOURS  # noqa: E402,F401

# ═════════════════════════════════════════════════════════════
# § 9. API Sessions · v3.3.7: 委托子模块
# ═════════════════════════════════════════════════════════════

def api_session_create(token: str, user_id: int, username: str, role: str = 'user'):
    from backend.db.sessions import api_session_create as _impl
    return _impl(get_conn(), token, user_id, username, role)


def api_session_get(token: str) -> dict:
    from backend.db.sessions import api_session_get as _impl
    return _impl(get_conn(), token)


def api_session_delete(token: str):
    from backend.db.sessions import api_session_delete as _impl
    return _impl(get_conn(), token)


def api_session_gc(ttl_hours: int = None):
    from backend.db.sessions import api_session_gc as _impl, API_SESSION_TTL_HOURS as _ttl
    return _impl(get_conn(), ttl_hours if ttl_hours is not None else _ttl)


# ═════════════════════════════════════════════════════════════
# § 10. Retention Runs · v4.13.6 保留策略执行历史
# ═════════════════════════════════════════════════════════════

def retention_run_record(user_id: int, trigger: str, scope: str,
                         keep_days: int, keep_count: int,
                         deleted_records: int, deleted_files: int,
                         bytes_freed: int, duration_ms: int,
                         errors: list = None) -> int:
    """写一条保留策略执行历史。返回新记录 id。"""
    conn = get_conn()
    cur = conn.execute("""
        INSERT INTO retention_runs
          (user_id, trigger, scope, keep_days, keep_count,
           deleted_records, deleted_files, bytes_freed, duration_ms, errors_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (user_id, trigger, scope, keep_days, keep_count,
          deleted_records, deleted_files, bytes_freed, duration_ms,
          json.dumps(errors or [], ensure_ascii=False)))
    conn.commit()
    return cur.lastrowid


def retention_run_list(user_id: int, limit: int = 200) -> list:
    """列最近 N 条（DESC by run_time）。"""
    conn = get_conn()
    rows = conn.execute("""
        SELECT id, user_id, run_time, trigger, scope,
               keep_days, keep_count, deleted_records, deleted_files,
               bytes_freed, duration_ms, errors_json
        FROM retention_runs
        WHERE user_id = ?
        ORDER BY run_time DESC
        LIMIT ?
    """, (user_id, int(limit))).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["errors"] = json.loads(d.pop("errors_json") or "[]")
        except Exception as e:
            print(f"[db] retention_run_list json parse err: {e}")
            d["errors"] = []
        out.append(d)
    return out


def retention_run_stats(user_id: int, days: int = 30) -> list:
    """按日聚合最近 N 天：[{date, runs, deleted_records, deleted_files, bytes_freed}]。"""
    conn = get_conn()
    rows = conn.execute("""
        SELECT substr(run_time, 1, 10) AS date,
               COUNT(*) AS runs,
               COALESCE(SUM(deleted_records), 0) AS deleted_records,
               COALESCE(SUM(deleted_files), 0)   AS deleted_files,
               COALESCE(SUM(bytes_freed), 0)     AS bytes_freed
        FROM retention_runs
        WHERE user_id = ?
          AND run_time >= datetime('now', ?, 'localtime')
        GROUP BY date
        ORDER BY date ASC
    """, (user_id, f"-{int(days)} days")).fetchall()
    return [dict(r) for r in rows]


# ==================== v4.15.24 · app_settings kv ====================

# v5.34.0 · P0 安全加固: app_settings 敏感值落库 Fernet 加密 (ENC$ 前缀)。
# 读侧 setting_get/setting_all 透明解密 → 全部既有消费方 (pve_api/truenas_ctl/
# vnc_bridge/airgap/rest_api/security_g/enterprise) 零改动。
_APP_SETTINGS_JSON_SECRET_FIELDS = {
    # JSON 键 → (元素内需加密的字段名, ...)   支持 list[dict] 与 dict 两种形态
    "pve_servers":     ("auth_value", "token_value"),
    "truenas_servers": ("token", "password"),
    "ldap_config":     ("bind_password",),
}
_APP_SETTINGS_FLAT_SECRET_KEYS = {
    # 扁平键: 整值加密
    "pve_auth_value", "pve_api_token",
    "truenas_token", "truenas_pass",
    "mfa_totp_secret",
    "ferry_key", "ferry_rsa_priv",
    "api_keys",          # REST API Key 本体 ({key:{...}} JSON, key 即凭据)
}


def _enc_setting_value(key: str, value: str) -> str:
    """敏感 setting 落库前加密。幂等: 已 ENC$ 前缀的值跳过; 非 JSON/异常 → 原样。"""
    try:
        if not value or not isinstance(value, str):
            return value
        fields = _APP_SETTINGS_JSON_SECRET_FIELDS.get(key)
        if fields:
            data = json.loads(value)
            items = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
            for item in items:
                if not isinstance(item, dict):
                    continue
                for f in fields:
                    v = item.get(f)
                    if v and isinstance(v, str) and not v.startswith("ENC$"):
                        item[f] = _encrypt_value(v)
            return json.dumps(data, ensure_ascii=False)
        if key in _APP_SETTINGS_FLAT_SECRET_KEYS and not value.startswith("ENC$"):
            return _encrypt_value(value)
    except Exception as e:
        print(f"[db] setting 加密跳过 ({key}): {e}")
    return value


def _dec_setting_value(key: str, value: str) -> str:
    """敏感 setting 读取时透明解密。仅处理带 ENC$ 的值, 其余原样返回。"""
    try:
        if not value or not isinstance(value, str):
            return value
        fields = _APP_SETTINGS_JSON_SECRET_FIELDS.get(key)
        if fields and value[:1] in ("[", "{"):
            data = json.loads(value)
            items = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
            changed = False
            for item in items:
                if not isinstance(item, dict):
                    continue
                for f in fields:
                    v = item.get(f)
                    if v and isinstance(v, str) and v.startswith("ENC$"):
                        item[f] = _decrypt_value(v)
                        changed = True
            if changed:
                return json.dumps(data, ensure_ascii=False)
            return value
        if key in _APP_SETTINGS_FLAT_SECRET_KEYS and value.startswith("ENC$"):
            return _decrypt_value(value)
    except Exception as e:
        print(f"[db] setting 解密跳过 ({key}): {e}")
    return value


def _migrate_app_settings_secrets() -> None:
    """v5.34.0 · 一次性把存量明文敏感值加密 (幂等, 启动时执行)。"""
    try:
        keys = list(_APP_SETTINGS_FLAT_SECRET_KEYS | set(_APP_SETTINGS_JSON_SECRET_FIELDS))
        qmarks = ",".join(["?"] * len(keys))
        with get_conn() as conn:
            rows = conn.execute(
                f"SELECT key, value FROM app_settings WHERE key IN ({qmarks})", keys
            ).fetchall()
        n = 0
        for k, v in rows:
            if v and _enc_setting_value(k, v) != v:
                setting_set(k, v)
                n += 1
        if n:
            print(f"[db] v5.34.0 · app_settings 存量明文敏感值已加密迁移: {n} 个键")
    except Exception as e:
        print(f"[db] app_settings 加密迁移跳过: {e}")


def setting_get(key: str, default: str = "") -> str:
    """读一个全局设置值。找不到返回 default。敏感键透明解密 (v5.34.0)。"""
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        if not row:
            return default
        return _dec_setting_value(key, row[0])


def setting_set(key: str, value: str) -> None:
    """写/覆盖一个全局设置值。敏感键落库前加密 (v5.34.0)。"""
    _enc = _enc_setting_value(key, value)
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO app_settings(key, value, updated_at)
            VALUES(?, ?, datetime('now','localtime'))
            ON CONFLICT(key) DO UPDATE SET
                value=excluded.value,
                updated_at=excluded.updated_at
        """, (key, _enc))
        conn.commit()


def setting_delete(key: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM app_settings WHERE key=?", (key,))
        conn.commit()


def setting_all() -> dict:
    with get_conn() as conn:
        rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
        # v5.34.0 · 与 setting_get 同规则透明解密, 消费方 (设置页导出) 行为不变
        return {r[0]: _dec_setting_value(r[0], r[1]) for r in rows}


# ==================== v4.20.0 · 事件日志持久化 ====================

def event_log_insert(ts: float, topic: str, payload_json: str) -> None:
    """v4.20.0 · 写一条事件（由 backend.events.publish 调用）"""
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO event_log (ts, topic, payload_json) VALUES (?, ?, ?)",
                (ts, topic, payload_json),
            )
            conn.commit()
    except Exception as e:
        print(f"[db] event_log_insert fail: {e}")


def event_log_recent(limit: int = 100, topic_like: Optional[str] = None) -> list:
    """v4.20.0 · 拉最近 N 条事件（按 ts 降序），返回升序列表方便前端追加。
    可选 topic_like（SQL LIKE，如 'flow.%'）过滤。
    """
    limit = max(1, min(int(limit or 100), 2000))
    with get_conn() as conn:
        if topic_like:
            rows = conn.execute(
                "SELECT ts, topic, payload_json FROM event_log "
                "WHERE topic LIKE ? ORDER BY ts DESC LIMIT ?",
                (topic_like, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT ts, topic, payload_json FROM event_log "
                "ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
    import json as _json
    out = []
    for r in reversed(rows):  # 升序
        try:
            payload = _json.loads(r[2]) if r[2] else None
        except Exception:
            payload = r[2]
        out.append({"ts": r[0], "topic": r[1], "payload": payload})
    return out


def event_log_purge(older_than_days: int = 30, max_rows: int = 0) -> int:
    """v4.20.0 · 清理超过 N 天的事件（由后台定时清理调用）
    v5.50.0 · 增加按大小清理: max_rows>0 时再删除最旧的行, 使总行数不超过上限（审计报告 #7）"""
    import time as _time
    cutoff = _time.time() - older_than_days * 86400
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM event_log WHERE ts < ?", (cutoff,))
        deleted = cur.rowcount or 0
        if max_rows and max_rows > 0:
            total = conn.execute("SELECT COUNT(*) FROM event_log").fetchone()[0]
            if total > max_rows:
                cur2 = conn.execute(
                    "DELETE FROM event_log WHERE rowid IN ("
                    "  SELECT rowid FROM event_log ORDER BY ts ASC LIMIT ?)",
                    (total - max_rows,))
                deleted += cur2.rowcount or 0
        conn.commit()
        return deleted


def event_log_query(
    page: int = 1, page_size: int = 100,
    topic_like: Optional[str] = None,
    since_ts: Optional[float] = None,
    until_ts: Optional[float] = None,
) -> dict:
    """v4.21.0 · 分页查询事件历史。返回 {total, page, page_size, events:[...]}"""
    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or 100), 500))
    offset = (page - 1) * page_size
    conds = []
    args = []
    if topic_like:
        conds.append("topic LIKE ?"); args.append(topic_like)
    if since_ts is not None:
        conds.append("ts >= ?"); args.append(float(since_ts))
    if until_ts is not None:
        conds.append("ts <= ?"); args.append(float(until_ts))
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    with get_conn() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM event_log {where}", args).fetchone()[0]
        rows = conn.execute(
            f"SELECT ts, topic, payload_json FROM event_log {where} "
            f"ORDER BY ts DESC LIMIT ? OFFSET ?",
            args + [page_size, offset],
        ).fetchall()
    import json as _json
    events = []
    for r in rows:
        try:
            payload = _json.loads(r[2]) if r[2] else None
        except Exception:
            payload = r[2]
        events.append({"ts": r[0], "topic": r[1], "payload": payload})
    return {"total": total, "page": page, "page_size": page_size, "events": events}


def alert_history_insert(rule_name: str, topic: str, channel: str, target: str,
                          status: str, err_msg: str = "", payload_json: str = "") -> None:
    """v4.23.0 · 记录一次告警触发"""
    import time as _time
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO alert_history (ts, rule_name, topic, channel, target, status, err_msg, payload_json) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (_time.time(), rule_name[:64], topic[:128], channel[:16],
                 target[:512], status[:16], err_msg[:512], payload_json[:2000]),
            )
            conn.commit()
    except Exception as e:
        print(f"[db] alert_history_insert fail: {e}")


def alert_history_query(page: int = 1, page_size: int = 100,
                         rule_name: Optional[str] = None,
                         status: Optional[str] = None,
                         since_ts: Optional[float] = None) -> dict:
    """v4.23.0 · 分页查询告警历史"""
    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or 100), 500))
    offset = (page - 1) * page_size
    conds, args = [], []
    if rule_name:
        conds.append("rule_name = ?"); args.append(rule_name)
    if status:
        conds.append("status = ?"); args.append(status)
    if since_ts is not None:
        conds.append("ts >= ?"); args.append(float(since_ts))
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    with get_conn() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM alert_history {where}", args).fetchone()[0]
        rows = conn.execute(
            f"SELECT id, ts, rule_name, topic, channel, target, status, err_msg, payload_json "
            f"FROM alert_history {where} ORDER BY ts DESC LIMIT ? OFFSET ?",
            args + [page_size, offset],
        ).fetchall()
    items = [{"id": r[0], "ts": r[1], "rule_name": r[2], "topic": r[3],
              "channel": r[4], "target": r[5], "status": r[6],
              "err_msg": r[7], "payload_json": r[8]} for r in rows]
    return {"total": total, "page": page, "page_size": page_size, "items": items}


def alert_history_purge(older_than_days: int = 30) -> int:
    """v4.23.0 · 清理告警历史"""
    import time as _time
    cutoff = _time.time() - older_than_days * 86400
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM alert_history WHERE ts < ?", (cutoff,))
        conn.commit()
        return cur.rowcount


def alert_history_stats(since_ts: Optional[float] = None) -> dict:
    """v4.24.0 · 告警触发次数聚合（按规则/主题/状态）"""
    with get_conn() as conn:
        where = "WHERE ts >= ?" if since_ts is not None else ""
        args: list = [since_ts] if since_ts is not None else []
        by_rule = conn.execute(
            f"SELECT rule_name, "
            f"       SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok_cnt, "
            f"       SUM(CASE WHEN status='err' THEN 1 ELSE 0 END) err_cnt, "
            f"       COUNT(*) total, MAX(ts) last_ts "
            f"FROM alert_history {where} "
            f"GROUP BY rule_name ORDER BY total DESC LIMIT 50",
            args,
        ).fetchall()
        by_topic = conn.execute(
            f"SELECT topic, COUNT(*) c FROM alert_history {where} "
            f"GROUP BY topic ORDER BY c DESC LIMIT 20",
            args,
        ).fetchall()
        totals_row = conn.execute(
            f"SELECT COUNT(*), "
            f"       SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END), "
            f"       SUM(CASE WHEN status='err' THEN 1 ELSE 0 END) "
            f"FROM alert_history {where}",
            args,
        ).fetchone()
    return {
        "since_ts": since_ts,
        "total": totals_row[0] or 0,
        "ok": totals_row[1] or 0,
        "err": totals_row[2] or 0,
        "by_rule": [
            {"rule_name": r[0], "ok": r[1] or 0, "err": r[2] or 0,
             "total": r[3] or 0, "last_ts": r[4] or 0}
            for r in by_rule
        ],
        "by_topic": [{"topic": r[0], "count": r[1] or 0} for r in by_topic],
    }


def event_log_fts_search(query: str, limit: int = 100,
                          topic_like: Optional[str] = None,
                          since_ts: Optional[float] = None) -> list:
    """v4.23.0 · FTS5 全文搜索 event_log.payload_json"""
    limit = max(1, min(int(limit or 100), 500))
    try:
        with get_conn() as conn:
            conds = ["e.id IN (SELECT rowid FROM event_log_fts WHERE payload_json MATCH ?)"]
            args: list = [query]
            if topic_like:
                conds.append("e.topic LIKE ?"); args.append(topic_like)
            if since_ts is not None:
                conds.append("e.ts >= ?"); args.append(float(since_ts))
            where = " AND ".join(conds)
            rows = conn.execute(
                f"SELECT e.ts, e.topic, e.payload_json FROM event_log e "
                f"WHERE {where} ORDER BY e.ts DESC LIMIT ?",
                args + [limit],
            ).fetchall()
    except Exception as e:
        print(f"[db] fts search fail: {e}")
        return []
    import json as _json
    out = []
    for r in rows:
        try:
            payload = _json.loads(r[2]) if r[2] else None
        except Exception:
            payload = r[2]
        out.append({"ts": r[0], "topic": r[1], "payload": payload})
    return out


# 首次导入时自动建表并初始化管理员


# 首次导入时自动建表并初始化管理员
init_db()
init_default_admin()


# v5.33.0 · 在模块加载时确保 server_profiles 表存在
# v5.34.1 · P1: 升级列 + server_groups + conn_audit_log + 唯一索引
try:
    _sp_conn = get_conn()
    _create_server_profiles_table(_sp_conn)
    _upgrade_server_profiles_v534(_sp_conn)
    _create_server_groups_table(_sp_conn)
    _create_conn_audit_log_table(_sp_conn)
    _create_credentials_table(_sp_conn)
    _sp_conn.commit()
except Exception as _sp_e:
    print(f"[db] server_profiles v5.34.1 升级跳过: {_sp_e}")

# v5.34.0 · P0 安全加固: 启动时把 app_settings 存量明文敏感值加密迁移 (幂等)
try:
    _migrate_app_settings_secrets()
except Exception:
    pass


# ═══════════════════════════════════════════════════════════════════════════
# v5.54.0 · P3-14 DLP 规则 / P3-16 元数据索引 + 全文检索
# ═══════════════════════════════════════════════════════════════════════════
def fonr_dlp_list() -> list:
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM fonr_dlp ORDER BY enabled DESC, id ASC").fetchall()]


def fonr_dlp_set(name: str, scope: str = "*", match_type: str = "glob",
                 pattern: str = "", action: str = "warn", enabled: int = 1,
                 note: str = "") -> int:
    """新增/更新一条 DLP 规则 (按 scope+match_type+pattern 去重)。返回行 id。"""
    import time as _t
    with get_conn() as conn:
        cur = conn.execute(
            "SELECT id FROM fonr_dlp WHERE scope=? AND match_type=? AND pattern=?",
            (scope or "*", match_type, pattern))
        row = cur.fetchone()
        if row:
            conn.execute("UPDATE fonr_dlp SET name=?, action=?, enabled=?, note=? WHERE id=?",
                         (name, action, int(enabled), note, row["id"]))
            conn.commit()
            return int(row["id"])
        cur = conn.execute(
            "INSERT INTO fonr_dlp (name, scope, match_type, pattern, action, enabled, note, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (name, scope or "*", match_type, pattern, action, int(enabled), note, _t.time()))
        conn.commit()
        return int(cur.lastrowid or 0)


def fonr_dlp_delete(rid: int) -> int:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM fonr_dlp WHERE id=?", (int(rid),))
        conn.commit()
        return cur.rowcount


def fonr_index_upsert(storage_id: str, rows: list) -> int:
    """批量写入/更新索引。

    v5.54.0 · **不再依赖触发器**同步 FTS: 实测在老库上"新增的 DDL(触发器)可能从未生效"
    (本仓库无 schema 版本化迁移 —— 短板 S3), 而触发器缺失会导致"新行不进 FTS、检索恒空"
    这类**静默错误**。现在由本函数在同一事务里显式写 FTS, 并在失败时**大声记日志**。
    """
    import time as _t
    import logging as _lg
    if not rows:
        return 0
    now = _t.time()
    n = 0
    fts_rows = []
    with get_conn() as conn:
        for r in rows:
            p = r.get("path") or ""
            conn.execute(
                "INSERT INTO fonr_index (storage_id, path, name, is_dir, size, mtime, scanned_at) "
                "VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(storage_id, path) DO UPDATE SET name=excluded.name, "
                "is_dir=excluded.is_dir, size=excluded.size, mtime=excluded.mtime, "
                "scanned_at=excluded.scanned_at",
                (storage_id, p, r.get("name") or "",
                 int(r.get("is_dir") or 0), int(r.get("size") or 0),
                 int(r.get("mtime") or 0), now))
            n += 1
        # 取回本批行 id 并一次性同步 FTS (INSERT OR REPLACE → 幂等, 与触发器并存无副作用)
        try:
            for r in rows:
                row = conn.execute("SELECT id FROM fonr_index WHERE storage_id=? AND path=?",
                                   (storage_id, r.get("path") or "")).fetchone()
                if row is not None:
                    fts_rows.append((int(row["id"]), r.get("name") or "", r.get("path") or ""))
            if fts_rows:
                # FTS5 对已存在 rowid 的 OR REPLACE 会报 constraint failed → 先删后插
                conn.executemany("DELETE FROM fonr_index_fts WHERE rowid=?",
                                 [(i,) for i, _n, _p in fts_rows])
                conn.executemany("INSERT INTO fonr_index_fts(rowid, name, path) VALUES (?,?,?)",
                                 fts_rows)
        except Exception as e:
            # 不静默: FTS 不可用时检索会退化为 LIKE, 必须让运维看得见
            _lg.getLogger("fonrvfs").warning(
                "fonr_index_fts 同步失败 (%d 行未进全文索引, 检索将回落 LIKE): %s",
                len(rows), e)
            print("[db] fonr_index_fts 同步失败: %s" % e)
        conn.commit()
    return n


def fonr_index_mark_scanned(storage_id: str, root: str, items: int, truncated: bool) -> None:
    import time as _t
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO fonr_index_scan (storage_id, root, items, truncated, scanned_at) "
            "VALUES (?,?,?,?,?) ON CONFLICT(storage_id) DO UPDATE SET root=excluded.root, "
            "items=excluded.items, truncated=excluded.truncated, scanned_at=excluded.scanned_at",
            (storage_id, root or "/", int(items), 1 if truncated else 0, _t.time()))
        conn.commit()


def fonr_index_stats(storage_id: Optional[str] = None) -> dict:
    with get_conn() as conn:
        where, args = "", ()
        if storage_id:
            where, args = " WHERE storage_id=?", (storage_id,)
        row = conn.execute(
            "SELECT COUNT(*) AS items, SUM(CASE WHEN is_dir=1 THEN 1 ELSE 0 END) AS dirs, "
            "SUM(CASE WHEN is_dir=0 THEN 1 ELSE 0 END) AS files, "
            "SUM(CASE WHEN is_dir=0 THEN size ELSE 0 END) AS bytes FROM fonr_index" + where,
            args).fetchone()
        scans = [dict(r) for r in conn.execute("SELECT * FROM fonr_index_scan").fetchall()]
    return {"items": int(row["items"] or 0), "dirs": int(row["dirs"] or 0),
            "files": int(row["files"] or 0), "bytes": int(row["bytes"] or 0),
            "scans": scans}


def fonr_index_clear(storage_id: Optional[str] = None) -> int:
    with get_conn() as conn:
        if storage_id:
            cur = conn.execute("DELETE FROM fonr_index WHERE storage_id=?", (storage_id,))
            conn.execute("DELETE FROM fonr_index_scan WHERE storage_id=?", (storage_id,))
        else:
            cur = conn.execute("DELETE FROM fonr_index")
            conn.execute("DELETE FROM fonr_index_scan")
        try:
            # 显式清理 FTS (不再依赖触发器): 按存储只删该存储对应的行
            if storage_id:
                conn.execute("DELETE FROM fonr_index_fts WHERE rowid IN "
                             "(SELECT id FROM fonr_index WHERE storage_id=?)", (storage_id,))
            else:
                conn.execute("DELETE FROM fonr_index_fts")
        except Exception as _e:
            logging.warning("fonr_index_fts 清理失败 (检索可能残留旧行): %s", _e)
        conn.commit()
        return cur.rowcount


def _index_filter_sql(flt: Optional[dict], prefix: str = "") -> tuple:
    """索引过滤条件 → (where 片段列表, 参数列表)。**纯函数**, 只做拼装与转义(可单测)。

    支持的键: min_size / max_size (字节) · since / until (unix 秒) · exts (如 ['.pdf']) ·
              path_prefix (目录前缀)。未知键由上层 normalize_filters 拦下并回报, 不在这里静默吞。
    """
    where: list = []
    args: list = []
    f = flt or {}
    try:
        mn, mx = f.get("min_size"), f.get("max_size")
        p = prefix or ""
        if mn is not None:
            where.append("%ssize >= ?" % p); args.append(int(mn))
        if mx is not None:
            where.append("%ssize <= ?" % p); args.append(int(mx))
        if mn is not None or mx is not None:
            where.append("%sis_dir = 0" % p)     # 目录的 size 恒为 0, 大小条件只对文件有意义
        if f.get("since") is not None:
            where.append("%smtime >= ?" % p); args.append(int(f["since"]))
        if f.get("until") is not None:
            where.append("%smtime <= ?" % p); args.append(int(f["until"]))
        exts = [str(x) for x in (f.get("exts") or []) if str(x).strip()]
        if exts:
            ors = []
            for e in exts:
                e = e.strip().lower()
                if not e.startswith("."):
                    e = "." + e
                ors.append("%sname LIKE ?" % (prefix or ""))
                args.append("%" + e.replace("%", "").replace("_", "") )   # 通配符转义, 防注入
            where.append("(" + " OR ".join(ors) + ")")
        pp = (f.get("path_prefix") or "").strip().rstrip("/")
        if pp:
            safe = pp.replace("%", "").replace("_", "")
            where.append("%spath LIKE ?" % (prefix or ""))
            args.append(safe + "/%")
    except Exception:
        raise
    return where, args


def fonr_index_filter(flt: dict, storage_id: Optional[str] = None, limit: int = 100,
                      dirs: bool = True) -> list:
    """**只按条件**检索(无关键字): "大于 10MB / 最近 7 天 / .pdf" 这类查询的落地点。"""
    where, args = _index_filter_sql(flt)
    if storage_id:
        where.append("storage_id=?"); args.append(storage_id)
    if not dirs:
        where.append("is_dir=0")
    if not where:
        return []
    sql = ("SELECT storage_id, path, name, is_dir, size, mtime FROM fonr_index WHERE "
           + " AND ".join(where) + " ORDER BY is_dir ASC, mtime DESC LIMIT ?")
    args.append(int(limit))
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


def fonr_index_search_fts(q: str, storage_id: Optional[str] = None, limit: int = 100,
                          dirs: bool = True, flt: Optional[dict] = None) -> list:
    """FTS5 MATCH 检索 (名字/路径)。q 由 fonrvfs.index 预清洗。flt 为结构化过滤(v5.71.0)。"""
    if not q:
        return []
    where = []; args = []
    if storage_id:
        where.append("i.storage_id=?"); args.append(storage_id)
    if not dirs:
        where.append("i.is_dir=0")
    _fw, _fa = _index_filter_sql(flt, prefix="i.")      # 列名前缀由构造器负责, 不做字符串替换
    where.extend(_fw); args.extend(_fa)
    sql = ("SELECT i.storage_id, i.path, i.name, i.is_dir, i.size, i.mtime "
           "FROM fonr_index_fts f JOIN fonr_index i ON i.id = f.rowid "
           "WHERE fonr_index_fts MATCH ?")
    if where:
        sql += " AND " + " AND ".join(where)
    sql += " ORDER BY i.is_dir ASC, i.size DESC LIMIT ?"
    args = [q] + args + [int(limit)]
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


def fonr_index_search_like(q: str, storage_id: Optional[str] = None, limit: int = 100,
                           dirs: bool = True, flt: Optional[dict] = None) -> list:
    like = "%%%s%%" % (q or "").replace("%", "").replace("_", "")
    where = ["(name LIKE ? OR path LIKE ?)"]; args = [like, like]
    if storage_id:
        where.append("storage_id=?"); args.append(storage_id)
    if not dirs:
        where.append("is_dir=0")
    _fw, _fa = _index_filter_sql(flt)
    where.extend(_fw); args.extend(_fa)
    sql = ("SELECT storage_id, path, name, is_dir, size, mtime FROM fonr_index WHERE "
           + " AND ".join(where) + " ORDER BY is_dir ASC, size DESC LIMIT ?")
    args.append(int(limit))
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


# ══════════════════════════════════════════════════════════════════════════
# v5.60.0 E2-3 · **Schema 版本化迁移**（审计报告 #5 建议）
#   背景: 此前 35+ 表全靠 init_db 里的幂等 DDL + 零散「读 table_info 再 ALTER」补列。
#   代价（阶段 A 已吃到）: 老库上新增 DDL 未必生效 → "代码里有、库里没有"的隐性故障,
#   而且没有任何地方能回答「这个库现在是哪个版本、还有哪些迁移没跑」。
#   本框架提供: 版本号(SCHEMA_VERSION) + schema_migrations 台账 + **有序迁移函数** +
#   `schema_status()` 自检(供发版/排障) + 迁移失败**显式报错**(不静默跳过)。
#   约定: 新增结构性变更 → 追加一条 (版本号, 说明, 函数), 函数必须**幂等**;
#         init_db 的 CREATE TABLE IF NOT EXISTS 仍是「新库基线」, 迁移负责「老库补齐」。
# ══════════════════════════════════════════════════════════════════════════
SCHEMA_VERSION = 2   # v5.90.2 · 迁移 2 生效 (server_profiles.ssh_auth_type 归一) 时必须同步递增


def _col_names(cur, table: str) -> set:
    try:
        return {r[1] for r in cur.execute("PRAGMA table_info(%s)" % table).fetchall()}
    except sqlite3.Error:
        return set()


def _ensure_col(cur, table: str, col: str, decl: str) -> bool:
    """幂等补列。表不存在 → False; 已有该列 → False; 真的加了 → True。"""
    cols = _col_names(cur, table)
    if not cols or col in cols:
        return False
    cur.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, col, decl))
    return True


def _mig_1_fonr_index_and_ai(conn) -> list:
    """v1: 把此前「写入前自愈建表」的两张表纳入版本化迁移(FonrVFS 索引 + AI 意图审计)。幂等。"""
    done = []
    cur = conn.cursor()
    cur.execute("""CREATE TABLE IF NOT EXISTS ai_intent_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, uid INTEGER,
        intent TEXT, verdict TEXT, actions TEXT, rejected TEXT,
        executed INTEGER DEFAULT 0, detail TEXT)""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ai_intent_ts ON ai_intent_log(ts DESC)")
    done.append("ai_intent_log")
    cur.execute("""CREATE TABLE IF NOT EXISTS fonr_index(
        id INTEGER PRIMARY KEY AUTOINCREMENT, storage_id TEXT NOT NULL, path TEXT NOT NULL,
        name TEXT, is_dir INTEGER DEFAULT 0, size INTEGER DEFAULT 0, mtime INTEGER DEFAULT 0,
        scanned_at REAL)""")
    done.append("fonr_index")
    for _sql in ("CREATE UNIQUE INDEX IF NOT EXISTS idx_fonr_index_p ON fonr_index(storage_id, path)",
                 "CREATE INDEX IF NOT EXISTS idx_fonr_index_s ON fonr_index(storage_id)"):
        try:
            cur.execute(_sql)
        except sqlite3.Error as e:
            logging.info("[db] fonr_index 索引建立跳过: %s", e)
    conn.commit()
    return done


def _mig_2_fix_ssh_auth_type(conn) -> list:
    """v5.90.2 · 修复 server_profiles.ssh_auth_type 的非法取值。

    背景: 该列语义是 pass|key, 但历史/异常写入出现过 'password' 等值; 下游旧判定
    `if atype == "pass"` 会把非法值当**密钥**处理 → 连接/探测/列表全部失败且报错误导。
    现在读取侧已归一(见 `_norm_atype`), 这里把存量脏值落库修正, 让界面与数据一致。
    """
    done = []
    try:
        cur = conn.execute("SELECT COUNT(*) FROM server_profiles "
                           "WHERE ssh_auth_type IS NOT NULL AND ssh_auth_type NOT IN ('pass','key')")
        n = int(cur.fetchone()[0] or 0)
    except sqlite3.Error:
        return done
    if n:
        conn.execute("UPDATE server_profiles SET ssh_auth_type='pass' "
                     "WHERE ssh_auth_type IS NULL OR ssh_auth_type NOT IN ('pass','key')")
        conn.commit()
        done.append("server_profiles.ssh_auth_type 归一 %d 行" % n)
        logging.info("[db] 迁移 v2: 修正 ssh_auth_type 非法取值 %d 行", n)
    return done


MIGRATIONS = [
    (1, "fonr 索引与 AI 意图审计表纳入版本化(原为写入前自愈建表)", _mig_1_fonr_index_and_ai),
    (2, "修复 server_profiles.ssh_auth_type 非法取值(如 'password') → 归一到 pass", _mig_2_fix_ssh_auth_type),
]


def _migrations_table(conn) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS schema_migrations(
        version INTEGER PRIMARY KEY, applied_at REAL NOT NULL, note TEXT)""")
    conn.commit()


def schema_version() -> int:
    """已应用到该库的最高版本号（无台账 → 0；读失败 → -1）。"""
    try:
        conn = get_conn()
        _migrations_table(conn)
        row = conn.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()
        return int(row[0] or 0)
    except Exception as e:
        logging.error("[db] 读取 schema_version 失败: %s", e)
        return -1


def migrate(conn=None) -> dict:
    """按版本号升序应用未执行的迁移。返回 {before, after, applied, pending}。

    **失败即报**: 任一迁移抛错 → 该版本不记账且异常上抛（绝不把"没跑成功"伪装成"已迁移"）。
    """
    conn = conn or get_conn()
    _migrations_table(conn)
    before = int(conn.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()[0] or 0)
    applied = []
    for ver, note, fn in sorted(MIGRATIONS, key=lambda x: x[0]):
        if ver <= before:
            continue
        fn(conn)
        conn.execute("INSERT OR REPLACE INTO schema_migrations(version, applied_at, note) VALUES(?,?,?)",
                     (ver, time.time(), note))
        conn.commit()
        applied.append(ver)
        logging.info("[db] 迁移 v%s 已应用: %s", ver, note)
    after = schema_version()
    return {"before": before, "after": after, "applied": applied,
            "pending": [v for v, _n, _f in MIGRATIONS if v > after]}


def schema_status() -> dict:
    """自检: 库版本 vs 代码版本。库**新于**代码(回滚场景)只告警、不降级(数据不动)。"""
    db_v = schema_version()
    out = {"db_version": db_v, "code_version": SCHEMA_VERSION, "ok": (db_v == SCHEMA_VERSION),
           "pending": [v for v, _n, _f in MIGRATIONS if v > db_v],
           "newer_than_code": db_v > SCHEMA_VERSION}
    if out["newer_than_code"]:
        out["warning"] = ("[db] 数据库结构版本(%s)高于本程序(%s): 可能回滚了程序版本; "
                          "**不做降级**(数据安全优先), 请升级程序或恢复对应备份" % (db_v, SCHEMA_VERSION))
        logging.error(out["warning"])
    return out


try:                              # 启动即迁移(幂等); 失败大声报错, 不静默
    _mig_res = migrate()
    logging.info("[db] schema 迁移: %s → %s (本次应用 %s, 待应用 %s)",
                 _mig_res["before"], _mig_res["after"], _mig_res["applied"] or "无",
                 _mig_res["pending"] or "无")
except Exception as _me:
    logging.error("[db] ✗ schema 迁移失败(未记账, 需人工处理): %s", _me, exc_info=True)

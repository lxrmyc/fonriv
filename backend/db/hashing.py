"""Fonriv · v3.3.0 db package: password hashing (自包含 · 无 DB 依赖)

抽自 backend/db/__init__.py。作为拆包结构的第一个示例——
从这里可以看到"抽小模块 → __init__ re-export"的模板，供后续继续拆分
users / configs / tasks / logs / backups / sessions 子模块参考。
"""
from __future__ import annotations

import hashlib
import secrets


def hash_password(password: str) -> str:
    """生成盐值并哈希密码，返回 'salt$hash' 格式。"""
    salt = secrets.token_hex(16)
    pwd_hash = hashlib.pbkdf2_hmac(
        'sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000
    )
    return f"{salt}${pwd_hash.hex()}"


def check_password(password: str, password_hashed: str) -> bool:
    """验证密码 · salt$hash 格式；异常返回 False。"""
    try:
        salt, pwd_hash = password_hashed.split('$')
        new_hash = hashlib.pbkdf2_hmac(
            'sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000
        )
        return new_hash.hex() == pwd_hash
    except Exception:
        return False

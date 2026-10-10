"""Fonriv · v3.3.1 db.crypto: Fernet at-rest encryption

抽自 backend/db/__init__.py（v3.3.0 拆包战役第 2 块砖）。

设计原则（同 hashing.py）：
- 自包含：只依赖 cryptography（可选）·  不 import backend.db
- 通过 fernet_key_path 参数注入 → 便于测试用临时路径
- __init__.py 里保留同名门面，委托到这里；旧代码不动
"""
from __future__ import annotations
import logging

import os
from typing import Optional

try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:
    Fernet = None
    InvalidToken = Exception  # 兜底类型，业务侧只用它做 except


ENC_PREFIX = "ENC$"


def _load_or_create_fernet(fernet_key_path: str):
    """按 path 读或建 Fernet key 文件；返回 Fernet 实例或 None。"""
    if Fernet is None:
        return None
    if os.path.exists(fernet_key_path):
        with open(fernet_key_path, "rb") as f:
            key = f.read().strip()
    else:
        key = Fernet.generate_key()
        os.makedirs(os.path.dirname(fernet_key_path), exist_ok=True)
        with open(fernet_key_path, "wb") as f:
            f.write(key)
        try:
            os.chmod(fernet_key_path, 0o600)
        except Exception as _e: logging.debug("suppressed", exc_info=True)
    return Fernet(key)


def encrypt_value(fernet, value: str) -> str:
    """加密单个字段。fernet 可为 None（未装 cryptography）→ 原样返回。"""
    if not value:
        return value
    if fernet is None or Fernet is None:
        return value
    return ENC_PREFIX + fernet.encrypt(value.encode()).decode()


def decrypt_value(fernet, enc_value: str) -> str:
    """解密单个字段。非 ENC$ 前缀或 fernet 不可用 → 原样返回。"""
    if not enc_value:
        return enc_value
    if not isinstance(enc_value, str) or not enc_value.startswith(ENC_PREFIX):
        return enc_value
    if fernet is None:
        return enc_value
    try:
        return fernet.decrypt(enc_value[len(ENC_PREFIX):].encode()).decode()
    except Exception:
        return enc_value


def encrypt_config_dict(fernet, data: dict, encrypted_fields) -> dict:
    """给一份 config dict 加密敏感字段（配置写库前用）。"""
    result = dict(data)
    for field in encrypted_fields:
        if field in result and result[field]:
            result[field] = encrypt_value(fernet, result[field])
    return result


def decrypt_config_dict(fernet, row: dict, encrypted_fields) -> dict:
    """给一份从库里读出的 row 解密敏感字段。"""
    result = dict(row)
    for field in encrypted_fields:
        if field in result:
            result[field] = decrypt_value(fernet, result[field])
    return result

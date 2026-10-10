"""Fonriv - Curve25519 密码通道 (v2.8.1)

替代旧 `ENC:<base64>`（base64 只是编码不是加密）。新前缀 `EC1:` 表示：
    base64url(ephemeral_pub || nonce(12) || ciphertext_gcm)

流程（前端 → 后端）：
  1) 前端启动时 GET /api/pubkey → 拿服务器 X25519 公钥
  2) 前端每次加密：
     - 生成临时 X25519 私钥 esk
     - shared = ECDH(esk, server_pub)
     - key = HKDF-SHA256(shared, salt=None, info="fonriv/1.0", length=32)
     - nonce = os.urandom(12)
     - ct = AES-GCM(key, nonce, plaintext, aad=b"fonriv")
     - 发送 "EC1:" + base64url(epk || nonce || ct)
  3) 后端 decrypt_secret():
     - 解 base64url → epk(32) || nonce(12) || ct
     - shared = ECDH(server_sk, epk)
     - key = HKDF 同参数
     - plaintext = AES-GCM decrypt

服务器私钥仅在内存中，进程重启会重生成（避免落盘）。
向后兼容：仍能解 "ENC:<base64>"（老前端 / 已存 DB 的 config）。
"""
from __future__ import annotations
import logging

import base64
import os
import threading

try:
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    _CRYPTO_OK = True
except ImportError:
    _CRYPTO_OK = False


_INFO = b"fonriv/1.0"
_AAD = b"fonriv"
_PREFIX = "EC1:"

_lock = threading.Lock()
_server_sk = None
_server_pk_bytes = None


def _init_once():
    """Lazy init server key. Called on first use."""
    global _server_sk, _server_pk_bytes
    if not _CRYPTO_OK:
        return
    if _server_sk is not None:
        return
    with _lock:
        if _server_sk is None:
            _server_sk = X25519PrivateKey.generate()
            _server_pk_bytes = _server_sk.public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )


def server_pubkey_b64() -> str:
    """返回服务器 X25519 公钥 base64url（32 字节 → 43 字符）。
    禁用 curve25519 时返回空串——前端见到空即回退到 base64。
    """
    if not _CRYPTO_OK:
        return ""
    _init_once()
    return base64.urlsafe_b64encode(_server_pk_bytes).decode("ascii").rstrip("=")


def is_ec1(value) -> bool:
    return isinstance(value, str) and value.startswith(_PREFIX)


def is_legacy_enc(value) -> bool:
    return isinstance(value, str) and value.startswith("ENC:")


def decrypt_ec1(value: str) -> str:
    """解 EC1:xxx。失败返回原始输入（保持与旧 decode_password 语义一致）。"""
    if not _CRYPTO_OK or not is_ec1(value):
        return value
    try:
        _init_once()
        b64 = value[len(_PREFIX):]
        # 补齐 padding
        pad = "=" * (-len(b64) % 4)
        raw = base64.urlsafe_b64decode(b64 + pad)
        if len(raw) < 32 + 12 + 16:
            return value
        epk_bytes = raw[:32]
        nonce = raw[32:44]
        ct = raw[44:]
        epk = X25519PublicKey.from_public_bytes(epk_bytes)
        shared = _server_sk.exchange(epk)
        key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=_INFO,
        ).derive(shared)
        pt = AESGCM(key).decrypt(nonce, ct, _AAD)
        return pt.decode("utf-8", errors="replace")
    except Exception as e:
        # 静默降级，不泄漏细节
        try:
            print("[crypto_channel] decrypt failed:", type(e).__name__)
        except Exception as _e: logging.debug("suppressed", exc_info=True)
        return value

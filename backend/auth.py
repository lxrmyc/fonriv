"""Fonriv - 认证与会话管理"""

import base64
import uuid
import time

from backend import db
from backend import crypto_channel as _cc


# 全局会话状态（auth.py 定义，避免与 ssh.py 循环导入）
active_sessions = {}


def decode_password(encoded):
    """解客户端发过来的敏感字段。支持三种前缀:
       - EC1:<b64url>   → curve25519+AES-GCM（v2.8.1 新，真加密）
       - ENC:<base64>   → base64 编码（v2.6.x 旧，向后兼容）
       - 其它           → 原样返回（明文场景）
    """
    if not isinstance(encoded, str):
        return encoded
    if encoded.startswith("EC1:"):
        return _cc.decrypt_ec1(encoded)
    if encoded.startswith("ENC:") and len(encoded) > 4:
        try:
            return base64.b64decode(encoded[4:]).decode("utf-8", errors="replace")
        except Exception:
            return encoded
    return encoded


def _get_session(ws):
    """Get current session for a WebSocket connection"""
    return active_sessions.get(ws)


async def _require_admin(ws):
    """Check if current user is admin, send error if not"""
    session = _get_session(ws)
    if not session or session.get('role') != 'admin':
        await ws.send_json({"type": "result", "status": "error", "msg": "需要管理员权限"})
        return False
    return True


def _get_user_id(ws):
    session = active_sessions.get(ws)
    if session:
        return session["user_id"]
    # v4.7.0: headless / scheduler ws 支持通过 ws.user 注入
    u = getattr(ws, "user", None)
    if isinstance(u, dict) and u.get("id"):
        return int(u["id"])
    return 1


# ---------------------------------------------------------------------------
# Login rate limiting
# ---------------------------------------------------------------------------
_login_attempts = {}
_login_ip_attempts = {}   # v5.28.5 · IP 级暴力破解追踪 (跨连接生效)


def _get_client_ip(ws) -> str:
    """获取客户端 IP (用于 IP 级暴力破解追踪)"""
    try:
        if hasattr(ws, 'client') and ws.client:
            return ws.client.host or "unknown"
    except Exception:
        pass
    return "unknown"

def _check_login_limit(ws):
    """Check if this WS connection is locked out due to too many failed logins.

    v5.28.5 · 改为 IP 级追踪: 此前用 id(ws) (连接级), 攻击者新连接即绕过。
    现在 5 次失败 → 15 分钟 IP 锁定 (全局)。
    """
    ip = _get_client_ip(ws)
    now = time.time()
    lockout_window = 900  # 15 分钟

    # 清理过期 IP 条目
    expired = [k for k, v in _login_ip_attempts.items() if now - v["last"] > lockout_window]
    for k in expired:
        del _login_ip_attempts[k]

    record = _login_ip_attempts.get(ip)
    if not record:
        _login_ip_attempts[ip] = {"count": 0, "last": now}
        return True

    if now - record["last"] > lockout_window:
        _login_ip_attempts[ip] = {"count": 0, "last": now}
        return True

    if record["count"] >= 10:   # 10 次失败 → IP 锁定
        return False

    return True


def _record_login_success(ws):
    """Clear failed login attempts after a successful login."""
    key = id(ws)
    _login_attempts.pop(key, None)


def _record_login_failure(ws):
    """Record a failed login attempt (IP 级, v5.28.5)."""
    ip = _get_client_ip(ws)
    now = time.time()
    rec = _login_ip_attempts.get(ip)
    if rec:
        rec["count"] += 1
        rec["last"] = now
    else:
        _login_ip_attempts[ip] = {"count": 1, "last": now}



async def require_auth(ws):
    """Verify current WS session. If missing but a token is passed, try DB restore."""
    session = _get_session(ws)
    if not session:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": "请先登录（会话已丢失，请刷新后重新登录）"})
        return False
    return True


def restore_session_by_token(ws, token: str) -> bool:
    """v2.6.4: 通过持久化 token 恢复 WS 会话（用于页面刷新/切换后新 WS 重建）。"""
    if not token:
        return False
    try:
        row = db.api_session_get(token)
    except Exception:
        row = None
    if not row:
        return False
    active_sessions[ws] = {
        "user_id": row.get("user_id"),
        "username": row.get("username"),
        "role": row.get("role", "user"),
        "token": token,
    }
    return True

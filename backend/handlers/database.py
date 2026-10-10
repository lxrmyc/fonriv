"""Fonriv - 数据库 CRUD 处理器"""

import time
import uuid

from backend import db
from backend.auth import active_sessions, _get_session, _require_admin, _get_user_id
from backend.auth import _check_login_limit, _record_login_success, _record_login_failure
from backend.auth import decode_password  # v3.0.2: 登录支持 EC1: 真加密


def _pub(topic: str, payload: dict) -> None:
    """v4.18.1 · publish to event bus (best-effort)"""
    try:
        from backend import events
        events.publish(topic, payload)
    except Exception as e:
        print(f"[database] publish {topic} fail: {e}")


def _get_client_info(ws) -> dict:
    """v4.43.0 · 从 WS scope 取客户端 IP; 反解 DNS 主机名 (失败回退 IP)

    - X-Forwarded-For 优先 (反向代理场景)
    - 127.0.0.1/localhost -> 本机名
    """
    import socket
    ip = ""
    try:
        scope = getattr(ws, "scope", {}) or {}
        client = scope.get("client") or ("", 0)
        ip = str(client[0] or "")
        headers = scope.get("headers") or []
        for k, v in headers:
            if k.decode("latin-1", "replace").lower() == "x-forwarded-for":
                ip = v.decode("latin-1", "replace").split(",")[0].strip()
                break
    except Exception:
        ip = ""
    host = ""
    if ip:
        try:
            if ip in ("127.0.0.1", "::1", "localhost"):
                host = socket.gethostname()
            else:
                host = socket.gethostbyaddr(ip)[0]
        except Exception:
            host = ""
    return {"ip": ip, "host": host}


# ---------------------------------------------------------------------------
# Database User Auth Handlers
# ---------------------------------------------------------------------------

def _ldap_auth_fallback(username: str, password: str):
    """v5.13.0 · LDAP 认证 fallback: 本地密码不匹配时, 尝试 LDAP bind。
    LDAP 配置来自 enterprise.py 已有的 settings_kv 存储。仅当 LDAP 服务端可达且 bind 成功时返回用户。"""
    try:
        from backend import db as _db
        cfg_raw = _db.setting_get("ldap_config", "")
        if not cfg_raw:
            return None
        import json as _json
        cfg = _json.loads(cfg_raw)
        if not cfg.get("server"):
            return None
        import ldap3
        server = ldap3.Server(cfg["server"], port=int(cfg.get("port") or 389),
                              use_ssl=bool(cfg.get("ssl")))
        base_dn = cfg.get("base_dn") or ""
        user_dn = f"uid={username},{base_dn}" if base_dn else username
        conn = ldap3.Connection(server, user=user_dn, password=password,
                                auto_bind=ldap3.NONE)
        conn.unbind()
        # bind 成功 → 本地找同 username 用户; 不存在则自动创建 (LDAP 同步首登)
        user = _db.user_get(username)
        if not user:
            _db.user_create(username, _db.hash_password(uuid.uuid4().hex), 'user')
            user = _db.user_get(username)
        return user
    except ImportError:
        return None
    except Exception:
        return None


async def handle_db_user_login(ws, data):
    """Handle user login - authenticates and creates session"""
    if not _check_login_limit(ws):
        await ws.send_json({"type": "result", "status": "error", "msg": "登录失败次数过多，请15分钟后再试"})
        return
    username = data.get("username", "")
    password = data.get("password", "")
    # v3.0.2: 支持 EC1: 前缀真加密登录（前端 encodePasswordAsync 发出）
    # v3.2.1: 加密握手过期（server 重启导致 curve25519 私钥换了）→ 明确报错
    if password:
        raw_prefix_ec1 = password.startswith("EC1:")
        raw_prefix_enc = password.startswith("ENC:")
        decoded = decode_password(password)
        # 若前缀仍在 → 解密失败（EC1 找不到匹配的服务器私钥 / ENC base64 解码失败）
        if raw_prefix_ec1 and decoded.startswith("EC1:"):
            await ws.send_json({"type": "result", "status": "error",
                                "msg": "加密握手已过期（服务器可能已重启），请刷新页面后重试"})
            return
        if raw_prefix_enc and decoded.startswith("ENC:"):
            await ws.send_json({"type": "result", "status": "error",
                                "msg": "密码编码格式错误，请刷新页面后重试"})
            return
        password = decoded
    if not username or not password:
        await ws.send_json({"type": "result", "status": "error", "msg": "请输入用户名和密码"})
        return

    user = db.authenticate_user(username, password)
    if not user:
        # v5.13.0 · LDAP fallback: 本地密码不匹配 → 尝试 LDAP bind (需已配置)
        user = _ldap_auth_fallback(username, password)
        if not user:
            _record_login_failure(ws)
            await ws.send_json({"type": "result", "status": "error", "msg": "用户名或密码错误"})
        # v4.21.0 · audit: 登录失败
        _pub("audit.login.failed", {"username": username[:32], "ts": time.time()})
        return

    # v5.13.0 · MFA 强制检查: mfa_enabled=true 时要求额外 TOTP code
    _mfa_en = db.setting_get("mfa_enabled", "")
    if _mfa_en == "true":
        _mfa_code = (data.get("mfa_code") or "").strip()
        if not _mfa_code:
            # 首次: 告知需要 MFA code, 前端显示 TOTP 输入框
            await ws.send_json({"type": "result", "status": "error",
                                "code": "MFA_REQUIRED",
                                "msg": "需要 MFA 验证码"})
            return
        from backend.security_g import _totp_verify
        secret = db.setting_get("mfa_totp_secret", "")
        if not secret or not _totp_verify(secret, _mfa_code):
            _record_login_failure(ws)
            await ws.send_json({"type": "result", "status": "error",
                                "code": "MFA_INVALID",
                                "msg": "MFA 验证码错误"})
            return

    _record_login_success(ws)
    token = str(uuid.uuid4())
    # v2.6.10: 记录最近登录时间
    try:
        db.user_touch_login(user["id"])
    except Exception as e:
        print("user_touch_login failed:", e)
    # v4.43.0 · 客户端连接信息: IP + 反解主机名 (存 session, 登录响应回传)
    client_info = _get_client_info(ws)
    active_sessions[ws] = {
        "user_id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "token": token,
        "client_ip": client_info.get("ip", ""),
        "client_host": client_info.get("host", ""),
    }
    # v5.34.1 · 连接中心实时同步: 登录后自动订阅公共档案/会话/分组主题
    # (断线时 ws.py finally 的 unsubscribe_all 自动清理)
    try:
        from backend import events as _events
        for _t in ("profile.changed", "profile.deleted", "conn.changed",
                   "group.changed", "cred.changed", "transfer.progress"):
            _events.subscribe(ws, _t)
    except Exception as _e:
        print("[login] auto-subscribe fail:", _e)
    # 持久化到 DB，避免 server 重启后 REST 401
    try:
        db.api_session_create(token, user["id"], user["username"], user["role"])
    except Exception as e:
        print("api_session_create failed:", e)
    await ws.send_json({
        "type": "result",
        "status": "ok",
        "token": token,
        "user_id": user["id"],
        "username": user["username"],
        "role": user["role"],
        "permissions": db.user_perms_get(user["id"]),
        "client_ip": client_info.get("ip", ""),
        "client_host": client_info.get("host", ""),
    })
    # v4.21.0 · audit: 登录成功
    _pub("audit.login.success", {
        "user_id": user["id"], "username": user["username"],
        "role": user["role"], "ts": time.time(),
    })


async def handle_client_info_get(ws, data):
    """v4.43.0 · 当前 WS 连接的客户端 IP + 计算机名 (登录后任意时刻可查)"""
    info = _get_client_info(ws)
    # session 已有的 host 优先 (登录时反解过, 且可能填充了本机名)
    sess = _get_session(ws) or {}
    if sess.get("client_host"):
        info["host"] = sess["client_host"]
    await ws.send_json({"type": "result", "status": "ok", "req_id": data.get("req_id", ""),
                        "client_ip": info.get("ip", ""), "client_host": info.get("host", "")})


async def handle_db_user_perms_get(ws, data):
    """Get allowed pages for a user (admin only). Returns list of page keys."""
    if not await _require_admin(ws):
        return
    user_id = data.get("user_id")
    if not user_id:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 user_id"})
        return
    perms = db.user_perms_get(user_id)
    await ws.send_json({
        "type": "result", "status": "ok",
        "user_id": user_id,
        "permissions": perms,
        "all_pages": db.ALL_PAGES,
    })


async def handle_db_user_perms_set(ws, data):
    """Set allowed pages for a user (admin only)."""
    if not await _require_admin(ws):
        return
    user_id = data.get("user_id")
    pages = data.get("pages", [])
    if not user_id:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 user_id"})
        return
    if not isinstance(pages, list):
        await ws.send_json({"type": "result", "status": "error", "msg": "pages 必须是数组"})
        return
    ok = db.user_perms_set(user_id, pages)
    if ok:
        await ws.send_json({"type": "result", "status": "ok",
                            "msg": "权限已更新",
                            "permissions": db.user_perms_get(user_id)})
    else:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": "更新失败（admin 用户无需设置权限或用户不存在）"})


async def handle_db_user_list(ws, data):
    """Get list of all users (admin only)"""
    if not await _require_admin(ws):
        return
    users = db.user_list()
    await ws.send_json({"type": "result", "status": "ok", "users": users})


async def handle_db_user_create(ws, data):
    """Create a new user (admin only)"""
    if not await _require_admin(ws):
        return
    username = data.get("username", "").strip()
    password = data.get("password", "")
    role = data.get("role", "user")
    if not username or not password:
        await ws.send_json({"type": "result", "status": "error", "msg": "用户名和密码不能为空"})
        return
    if db.user_get(username):
        await ws.send_json({"type": "result", "status": "error", "msg": "用户名已存在"})
        return
    # ── 数量限额: 上限由 backend/license.limits() 给出 (开源社区版 0 = 不限) ──
    try:
        from backend import license as _L
        _mx = int((_L.limits() or {}).get("max_users") or 0)
    except Exception:
        _mx = 0
    if _mx:
        try:
            _n = len(db.user_list() or [])
        except Exception:
            _n = 0
        if _n >= _mx:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": "用户数已达上限 %d 个(当前 %d 个)。请删除不用的用户后重试。" % (_mx, _n)})
            return
    password_hashed = db.hash_password(password)
    user_id = db.user_create(username, password_hashed, role)
    if user_id:
        await ws.send_json({"type": "result", "status": "ok", "user_id": user_id, "msg": "用户创建成功"})
        _pub("user.created", {"user_id": user_id, "username": username, "role": role})
    else:
        await ws.send_json({"type": "result", "status": "error", "msg": "用户创建失败"})


async def handle_db_user_update(ws, data):
    """Update user info (admin only). Supports username / role / password."""
    if not await _require_admin(ws):
        return
    user_id = data.get("user_id")
    username = data.get("username")
    role = data.get("role")
    password = data.get("password")  # 可选：管理员重置密码
    if not user_id:
        await ws.send_json({"type": "result", "status": "error", "msg": "用户ID不能为空"})
        return
    update_data = {}
    if username is not None:
        update_data["username"] = username
    if role is not None:
        update_data["role"] = role
    if password:  # 非空才更新，避免误清空
        update_data["password_hash"] = db.hash_password(password)
    if update_data:
        db.user_update(user_id, update_data)
        await ws.send_json({"type": "result", "status": "ok", "msg": "用户信息已更新"})
        _pub("user.updated", {"user_id": int(user_id), "fields": list(update_data.keys())})
    else:
        await ws.send_json({"type": "result", "status": "error", "msg": "没有需要更新的字段"})


async def handle_db_user_delete(ws, data):
    """Delete a user (admin only)"""
    if not await _require_admin(ws):
        return
    session = _get_session(ws)
    user_id = data.get("user_id")
    if not user_id:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 user_id"})
        return
    # v2.6.9: root（id=1）不可删除
    try:
        uid_int = int(user_id)
    except Exception:
        uid_int = 0
    if uid_int == 1:
        await ws.send_json({"type": "result", "status": "error", "msg": "不能删除 root 管理员"})
        return
    if user_id == session.get("user_id"):
        await ws.send_json({"type": "result", "status": "error", "msg": "不能删除当前登录用户"})
        return
    db.user_delete(user_id)
    await ws.send_json({"type": "result", "status": "ok", "msg": "用户已删除"})
    _pub("user.deleted", {"user_id": int(user_id)})


async def handle_db_change_password(ws, data):
    """Change password for current user"""
    session = _get_session(ws)
    if not session:
        await ws.send_json({"type": "result", "status": "error", "msg": "未登录"})
        return
    old_password = data.get("old_password", "")
    new_password = data.get("new_password", "")
    if not old_password or not new_password:
        await ws.send_json({"type": "result", "status": "error", "msg": "请输入旧密码和新密码"})
        return
    user = db.user_get(session["username"])
    if not user or not db.check_password(old_password, user["password_hash"]):
        await ws.send_json({"type": "result", "status": "error", "msg": "旧密码错误"})
        return
    new_hashed = db.hash_password(new_password)
    db.user_update(session["user_id"], {"password_hash": new_hashed})
    await ws.send_json({"type": "result", "status": "ok", "msg": "密码修改成功"})


# ---------------------------------------------------------------------------
# Database Config/Task/Log/Backup Handlers
# ---------------------------------------------------------------------------

async def handle_db_task_list(ws, data):
    tasks = db.task_list(_get_user_id(ws))
    await ws.send_json({"type": "result", "status": "ok", "tasks": tasks})


async def handle_task_log_tail(ws, data):
    """v4.26.0 · 拉取指定 task_id 的日志尾（供事件抽屉/排障用）。
    payload: {task_id: str, tail: int (可选，默认返回全部 log_output)}
    """
    task_id = (data.get("task_id") or "").strip()
    if not task_id:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 task_id"})
        return
    task = db.task_get(task_id, _get_user_id(ws))
    if not task:
        # 用户隔离下取不到时回退 user_id=1（兼容旧行）
        task = db.task_get(task_id, 1)
    if not task:
        await ws.send_json({"type": "result", "status": "error", "msg": "task 不存在或无权限"})
        return
    log = task.get("log_output") or ""
    try:
        tail = int(data.get("tail") or 0)
    except Exception:
        tail = 0
    if tail > 0 and len(log) > tail:
        log = log[-tail:]
    await ws.send_json({
        "type": "result", "status": "ok",
        "task_id": task_id,
        "name": task.get("name"),
        "task_type": task.get("type"),
        "task_status": task.get("status"),
        "started_at": task.get("started_at"),
        "finished_at": task.get("finished_at"),
        "log": log,
        "log_bytes": len(log or ""),
    })


async def handle_task_log_subscribe(ws, data):
    """v4.27.0 · 订阅进程级 log buffer（tail -f）。

    payload: {task_id: str}
    返回 snapshot（历史行 + last_seq + finished 标记），之后 append 时会自动推
    type=task_log_push {task_id, seq, line, finished?} 给该 ws。
    """
    task_id = (data.get("task_id") or "").strip()
    if not task_id:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 task_id"})
        return
    from backend import log_buffers as _lb
    lines, last_seq, finished = _lb.subscribe(task_id, ws)
    # 若 buffer 空，尝试从 db.log_output 生成一次性回填
    if not lines:
        task = db.task_get(task_id, _get_user_id(ws)) or db.task_get(task_id, 1)
        if task and task.get("log_output"):
            # 把 db 里的日志一次性作为 history 塞回来（seq=0 表示历史块）
            lines = [{"seq": 0, "line": task["log_output"]}]
            # 若 task 已结束，标 finished
            if (task.get("status") or "") in ("completed", "success", "failed"):
                finished = True
    await ws.send_json({
        "type": "result", "status": "ok",
        "action": "task_log_subscribe",
        "task_id": task_id,
        "lines": lines,
        "last_seq": last_seq,
        "finished": finished,
    })


async def handle_task_log_unsubscribe(ws, data):
    """v4.27.0 · 取消 tail -f 订阅。"""
    task_id = (data.get("task_id") or "").strip()
    if not task_id:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 task_id"})
        return
    from backend import log_buffers as _lb
    _lb.unsubscribe(task_id, ws)
    await ws.send_json({"type": "result", "status": "ok",
                        "action": "task_log_unsubscribe", "task_id": task_id})


async def handle_db_log_list(ws, data):
    logs = db.log_list(data.get("category", ""), data.get("limit", 200), _get_user_id(ws))
    await ws.send_json({"type": "result", "status": "ok", "logs": logs})


async def handle_db_backup_list(ws, data):
    backups = db.backup_list(_get_user_id(ws))
    await ws.send_json({"type": "result", "status": "ok", "backups": backups})


# ---------------------------------------------------------------------------
# v4.38.0 · 备份验证 (SHA256)
# ---------------------------------------------------------------------------
async def handle_backup_verify(ws, data):
    """计算备份文件的 SHA256 并存储验证结果"""
    import hashlib
    from datetime import datetime

    backup_id = data.get("backup_id")
    if not backup_id:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 backup_id"})
        return

    conn = db.get_conn()
    row = conn.execute(
        "SELECT * FROM backups WHERE id=? AND user_id=?",
        (backup_id, _get_user_id(ws)),
    ).fetchone()
    if not row:
        await ws.send_json({"type": "result", "status": "error", "msg": "备份记录不存在"})
        return

    backup = dict(row)
    file_path = backup.get("destination", "")
    if not file_path:
        await ws.send_json({"type": "result", "status": "error", "msg": "备份记录无目标路径"})
        return

    import os
    if not os.path.exists(file_path):
        db.backup_update(conn, backup_id, status='verified_fail',
                         verified_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        await ws.send_json({"type": "backup_verify_result", "status": "fail",
                            "backup_id": backup_id, "msg": f"文件不存在: {file_path}"})
        return

    try:
        sha256 = hashlib.sha256()
        file_size = 0
        with open(file_path, 'rb') as f:
            while True:
                chunk = f.read(8192)
                if not chunk:
                    break
                sha256.update(chunk)
                file_size += len(chunk)

        digest = sha256.hexdigest()
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        old_sha = backup.get("sha256", "")
        match = (old_sha == digest) if old_sha else None

        db.backup_update(conn, backup_id,
                         sha256=digest,
                         size_bytes=file_size,
                         verified_at=now)
        from backend.log import log_operation
        log_operation("backup_verify", f"验证备份 #{backup_id}",
                      f"SHA256: {digest[:16]}... · 大小: {file_size} bytes · 匹配: {match}")

        await ws.send_json({
            "type": "backup_verify_result",
            "status": "ok",
            "backup_id": backup_id,
            "sha256": digest,
            "size_bytes": file_size,
            "verified_at": now,
            "match": match,
            "file_path": file_path,
        })
    except Exception as e:
        await ws.send_json({"type": "backup_verify_result", "status": "error",
                            "backup_id": backup_id, "msg": f"验证失败: {e}"})


async def handle_backup_verify_batch(ws, data):
    """批量验证多个备份"""
    backup_ids = data.get("backup_ids", [])
    if not backup_ids:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少 backup_ids"})
        return

    total = len(backup_ids)
    ok_count = 0
    fail_count = 0
    results = []

    await ws.send_json({"type": "batch_verify_start", "total": total})

    for idx, bid in enumerate(backup_ids):
        import asyncio as _aio
        await _aio.sleep(0.01)  # yield to event loop
        await ws.send_json({"type": "batch_verify_progress",
                            "current": idx + 1, "total": total, "backup_id": bid})
        try:
            sub_data = {"backup_id": bid, "_user_id": _get_user_id(ws)}
            await handle_backup_verify(ws, sub_data)
            ok_count += 1
            results.append({"backup_id": bid, "status": "ok"})
        except Exception as e:
            fail_count += 1
            results.append({"backup_id": bid, "status": "error", "msg": str(e)})

    await ws.send_json({"type": "batch_verify_done", "total": total,
                        "ok": ok_count, "failed": fail_count, "results": results})
    await ws.send_json({"type": "result", "status": "ok",
                        "msg": f"批量验证完成: {ok_count}/{total} 成功, {fail_count} 失败"})


async def handle_backup_verify_stats(ws, data):
    """返回备份验证统计（用于仪表盘）"""
    conn = db.get_conn()
    uid = _get_user_id(ws)

    total = conn.execute(
        "SELECT COUNT(*) FROM backups WHERE user_id=?", (uid,)
    ).fetchone()[0]
    verified = conn.execute(
        "SELECT COUNT(*) FROM backups WHERE user_id=? AND verified_at != ''", (uid,)
    ).fetchone()[0]
    healthy = conn.execute(
        "SELECT COUNT(*) FROM backups WHERE user_id=? AND status='completed' AND verified_at != ''", (uid,)
    ).fetchone()[0]
    failed = conn.execute(
        "SELECT COUNT(*) FROM backups WHERE user_id=? AND status='verified_fail'", (uid,)
    ).fetchone()[0]
    unverified = total - verified

    await ws.send_json({"type": "backup_verify_stats", "status": "ok",
                        "total": total, "verified": verified, "healthy": healthy,
                        "failed": failed, "unverified": unverified})

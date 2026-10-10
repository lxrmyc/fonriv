"""Fonriv - 连接中心 handlers

actions: conn_open / conn_close / conn_list / conn_renew
面板: conn_center · 会话按创建用户隔离, 不共享。
凭据来源 (v5.35.0 零遗留): guid → server_profiles 服务端解密; 或临时凭据。
"""
import asyncio
import os

from backend import conn_registry as cr


def _owner(ws) -> str:
    from backend.auth import active_sessions
    s = active_sessions.get(ws) or {}
    return s.get("user") or "root"


def owner_id_of(ws) -> int:
    """v5.34.4 · 用户 id (审计用)"""
    from backend.auth import active_sessions
    return (active_sessions.get(ws) or {}).get("user_id") or 1


def _owner_id_num(ws) -> int:
    from backend.auth import active_sessions
    return (active_sessions.get(ws) or {}).get("user_id") or 1


def _resolve(ws, data: dict):
    """优先级: guid(server_profiles 服务端解密) > config_id > 临时凭据。
    返回 (host, port, user, auth_type, password, key, name, config_id, passphrase) 或 (None, 错误)。
    v5.90.4 · 补 passphrase: 档案带**密钥口令**时此前整条链都丢了它 → ssh 只能去问
      /usr/bin/ssh-askpass(不存在) → 报 `ssh_askpass: exec(...): No such file or directory`,
      带口令的密钥档案永远连不上 (实测 192.168.1.90)。"""
    # v5.34.1 · guid 直连: 凭据服务端解析, 页面不再经手密码
    guid = (data.get("guid") or "").strip()
    if guid:
        # v5.61.0 E5 · **统一走 resolve_resource**: 凭据解析(ENC$ 解密)与归属校验收敛到一处,
        #   不再在这里各写一份 SELECT + 解密(此前 conn_center / vfs / 各面板各一份, 口径易漂移)。
        # v1.0.0 · FonrError 从 server_profile 取 (该模块自带无 fonrvfs 时的同构兜底类,
        #   本发行版不含 backend/fonrvfs/, 不能再直接从 fonrvfs.errors 导入)
        from backend.handlers.server_profile import resolve_resource, FonrError
        from backend.auth import active_sessions as _asess
        _sess = _asess.get(ws) or {}
        _role = "admin" if (_sess.get("role") or "") == "admin" else "user"
        try:
            _r = resolve_resource(guid, "ssh", uid=owner_id_of(ws), role=_role)
        except FonrError as e:
            return None, str(getattr(e, "message", e))
        p = _r["params"]
        at = p.get("auth_type") or "pass"
        return ((p.get("host"), int(p.get("port") or 22), p.get("user") or "root",
                 at, p.get("password") if at == "pass" else "",
                 p.get("key") if at == "key" else "",
                 p.get("name") or p.get("host"), None,
                 (p.get("passphrase") or "") if at == "key" else ""), None)
    host = (data.get("host") or "").strip()
    if not host:
        return None, "缺少 host / config_id / guid"
    return ((host, data.get("port") or 22, data.get("user") or "root",
             data.get("auth_type") or "pass", data.get("password") or "",
             data.get("key") or "", data.get("name") or host, None,
             data.get("passphrase") or ""), None)


async def handle_conn_open(ws, data: dict, task_id: str = ""):
    _req = data.get("req_id") or ""
    owner = _owner(ws)
    # v5.34.4 · P4 全协议分发: ssh 走 ControlMaster 预连接 (其余协议返回下一步指引)
    #   rdp/vnc/pve_console 的会话在打开对应控制台时建立 (guacd/PVE ticket 有时效,
    #   预建即占用目标机资源且 token 会过期), 此处返回跳转目标, 前端直接引导。
    protocol = (data.get("protocol") or "ssh").strip().lower()
    if protocol not in ("ssh", "rdp", "vnc", "pve_console"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                           "msg": f"不支持的协议: {protocol} (可选 ssh/rdp/vnc/pve_console)"})
        return
    if protocol != "ssh":
        guid = (data.get("guid") or "").strip()
        jump = {"rdp": "rdp_console", "vnc": "rdp_console", "pve_console": "pve_console"}[protocol]
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                           "protocol": protocol, "preconnected": False, "jump_tab": jump,
                           "msg": f"{protocol.upper()} 会话在控制台页面建立 (打开即连), 已为你准备跳转"})
        from backend.db import conn_audit_insert
        from backend.auth import active_sessions as _asess2
        _uname = (_asess2.get(ws) or {}).get("username") or ""
        conn_audit_insert(owner_id_of(ws), _uname, guid, "open", protocol, "jump_only")
        return
    result, err = _resolve(ws, data)
    if err:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": err})
        return
    host, port, user, auth_type, password, key, name, config_id, passphrase = result
    ttl = data.get("ttl_sec", 3600)
    loop = asyncio.get_event_loop()

    def _progress(m, lv="info"):
        try:
            from backend import events as _ev
            _ev.publish("conn.progress", {"msg": m})
        except Exception:
            pass

    def _job():
        # open_session 是协程 (内部 await sleep/子进程); 线程池无线循环 → 用 asyncio.run 驱动
        import asyncio as _aio
        return _aio.run(cr.open_session(
            owner, host, port, user, auth_type=auth_type, password=password,
            key=key, passphrase=passphrase, ttl_sec=ttl, name=name,
            config_id=config_id, progress=_progress))
    r = await loop.run_in_executor(None, _job)
    ok = r.get("state") == "connected"
    # v5.34.1 · 会话状态变化广播 + 审计 (所有已登录客户端实时刷新 🟢/下拉)
    from backend import events as _ev
    from backend.db import conn_audit_insert
    from backend.auth import active_sessions as _asess
    _uname = (_asess.get(ws) or {}).get("username") or ""
    _ev.publish("conn.changed", {
        "session_id": r.get("session_id"), "endpoint": r.get("endpoint"),
        "name": r.get("name"), "state": r.get("state"),
        "expires_at": r.get("expires_at"), "actor": _uname})
    conn_audit_insert(_owner_id_num(ws), _uname, "", "open", "ssh",
                      f'{r.get("endpoint")} ttl={ttl} {"ok" if ok else "fail"}')
    await ws.send_json({"type": "result", "status": "ok" if ok else "error", "req_id": _req,
                        "session": {k: r.get(k) for k in
                                    ("session_id", "endpoint", "name", "state",
                                     "expires_at", "remain_sec", "ttl_mode", "latency_ms")},
                        "msg": ("✓ 已连接 " + r["endpoint"]) if ok
                        else ("✗ 连接失败: " + (r.get("last_error") or "未知"))})


async def handle_conn_close(ws, data: dict):
    _req = data.get("req_id") or ""
    sid = (data.get("session_id") or "").strip()
    # v5.34.1 FIX: close_session 是协程 (内部 subprocess ssh -O exit), 须 executor 驱动
    #   原同步调用抛 TypeError → 被兜底捕获成"服务端处理异常", 停止按钮实际从未生效
    loop = asyncio.get_event_loop()

    def _job():
        import asyncio as _aio
        return _aio.run(cr.close_session(sid, _owner(ws)))
    ok, msg = await loop.run_in_executor(None, _job)
    from backend import events as _ev
    from backend.db import conn_audit_insert
    from backend.auth import active_sessions as _asess
    _uname = (_asess.get(ws) or {}).get("username") or ""
    _ev.publish("conn.changed", {"session_id": sid, "state": "disconnected", "actor": _uname})
    conn_audit_insert(_owner_id_num(ws), _uname, "", "close", "ssh", f"{sid} {'ok' if ok else 'fail'}")
    await ws.send_json({"type": "result", "status": "ok" if ok else "error",
                        "req_id": _req, "msg": msg})


async def handle_conn_list(ws, data: dict):
    _req = data.get("req_id") or ""
    owner = _owner(ws)
    loop = asyncio.get_event_loop()

    from backend import probe_pool as _pp

    def _verify():
        """连接中的会话做真实 -O check (线程池执行, 不阻塞事件循环)。

        v5.98.1 · 逐个 `ssh -O check` 旧实现是串行: N 个会话 × 8s 超时 = N×8s(实测该动作
        46 次、均值 12.8s、最大 60.2s), 而它又跑在**默认线程池**里 → 不可达主机多时把默认池
        占满, 连本地列目录都要排队。现在: 有界并发(4) + 结果 5s TTL 缓存(UI 轮询不再重复打)。
        """
        sessions = cr.list_sessions(owner)

        def _one(s):
            if s["state"] != "connected":
                return False
            sess = cr.SESSIONS.get(s["session_id"])
            if not sess:
                return False
            ck = "conn_alive:%s:%s" % (s["session_id"], sess.get("control_path") or "")
            hit = _pp._cache_get(ck)
            if hit:
                return hit[1]
            ok = bool(cr.alive(sess["control_path"], sess["endpoint"]))
            _pp.cache_put(ck, ok, 5.0 if ok else 3.0)     # 不通的结论也短缓存, 避免连环重试
            return ok

        alive_map = _pp.map_bounded(sessions, _one, workers=4, timeout=10.0)
        for s, ok in zip(sessions, alive_map):
            if s["state"] == "connected" and ok is False:
                sess = cr.SESSIONS.get(s["session_id"])
                if sess:
                    sess["state"] = "disconnected"
                s["state"] = "disconnected"
        return sessions

    sessions = cr.list_sessions(owner)
    sessions = await loop.run_in_executor(None, _verify)
    # v5.60.0 E2-2 · 连接池可观测量(存活/上限/驱逐/最久空闲), 供连接中心显示
    try:
        _pool = cr.pool_stats()
    except Exception as _pe:
        _pool = {"error": str(_pe)[:120]}
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "sessions": sessions, "pool": _pool})


async def handle_conn_renew(ws, data: dict):
    _req = data.get("req_id") or ""
    ok, msg = cr.renew_session((data.get("session_id") or "").strip(),
                               data.get("ttl_sec", 3600), _owner(ws))
    await ws.send_json({"type": "result", "status": "ok" if ok else "error",
                        "req_id": _req, "msg": msg})



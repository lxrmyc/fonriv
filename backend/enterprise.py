"""Fonriv - F1 AD/LDAP 认证 + F2 多租户 + F3 SIEM 对接 (v4.89.0)

F1: LDAP/AD 认证 (登录时 fallback 到 LDAP)
F2: Namespace 部门隔离 (数据按 namespace_id 隔离)
F3: SIEM Syslog 转发 (审计日志→Syslog RFC5424)

WS 动作:
  ldap_config      读/写 LDAP 配置
  ldap_test        测试 LDAP 连接
  namespace_list   列出 Namespace
  namespace_create 创建 Namespace
  namespace_delete 删除 Namespace
  siem_config      读/写 SIEM Syslog 配置
  siem_test        发送测试 Syslog 消息
"""
from __future__ import annotations

import asyncio
import json
import socket
import time

from fastapi import WebSocket, WebSocketDisconnect

from backend import db
from backend.log import log_operation

# ── F1: LDAP/AD ──

DEFAULT_LDAP = {
    "enabled": False,
    "server": "", "port": 389, "use_ssl": False,
    "bind_dn": "", "bind_password": "",
    "base_dn": "", "user_filter": "(uid={username})",
    "ad_mode": False,  # Active Directory 模式 (sAMAccountName)
}


def _get_ldap() -> dict:
    cfg = dict(DEFAULT_LDAP)
    try:
        raw = db.setting_get("ldap_config", "")
        if raw:
            cfg.update(json.loads(raw))
    except Exception:
        pass
    return cfg


def _save_ldap(cfg: dict):
    clean = {k: v for k, v in cfg.items() if k in DEFAULT_LDAP}
    db.setting_set("ldap_config", json.dumps(clean, ensure_ascii=False))


async def _ldap_bind_and_search(server: str, port: int, use_ssl: bool,
                                bind_dn: str, bind_pw: str,
                                base_dn: str, user_filter: str, username: str) -> dict:
    """LDAP 绑定 + 搜索用户。返回 {found, dn, attrs}"""
    try:
        import ldap3
    except ImportError:
        return {"error": "ldap3 库未安装 (pip install ldap3)"}

    server_obj = ldap3.Server(server, port=port, use_ssl=use_ssl, get_info=ldap3.NONE)
    conn = ldap3.Connection(server_obj, bind_dn, bind_pw, auto_bind=True)
    search_filter = user_filter.replace("{username}", username)
    conn.search(base_dn, search_filter, attributes=["*"])
    if not conn.entries:
        conn.unbind()
        return {"found": False}
    entry = conn.entries[0]
    user_dn = str(entry.entry_dn)
    attrs = {k: str(v) for k, v in entry.attributes.items()} if entry.attributes else {}
    conn.unbind()
    return {"found": True, "dn": user_dn, "attrs": attrs}


async def handle_ldap_config(ws, data: dict):
    """读/写 LDAP 配置"""
    _req = data.get("req_id") or ""
    if data.get("set"):
        cfg = _get_ldap()
        for k in DEFAULT_LDAP:
            if k in data:
                cfg[k] = data[k]
        _save_ldap(cfg)
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "config": cfg, "msg": "LDAP 配置已保存"})
        return
    cfg = _get_ldap()
    try:
        import ldap3
        cfg["ldap3_installed"] = True
    except ImportError:
        cfg["ldap3_installed"] = False
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "config": cfg})


async def handle_ldap_test(ws, data: dict):
    """测试 LDAP 连接 + 用户搜索。params: server, port, bind_dn, bind_password, base_dn, test_user"""
    _req = data.get("req_id") or ""
    cfg = _get_ldap()
    server = data.get("server") or cfg.get("server") or ""
    port = int(data.get("port") or cfg.get("port") or 389)
    use_ssl = data.get("use_ssl", cfg.get("use_ssl", False))
    bind_dn = data.get("bind_dn") or cfg.get("bind_dn") or ""
    bind_pw = data.get("bind_password") or cfg.get("bind_password") or ""
    base_dn = data.get("base_dn") or cfg.get("base_dn") or ""
    user_filter = data.get("user_filter") or cfg.get("user_filter") or "(uid={username})"
    test_user = data.get("test_user") or "test"

    if not server:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 server"})
        return
    try:
        r = await _ldap_bind_and_search(server, port, use_ssl, bind_dn, bind_pw,
                                        base_dn, user_filter, test_user)
        if r.get("error"):
            await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": r["error"]})
        elif r.get("found"):
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                                "msg": f"✓ LDAP 连接成功 · 找到用户 {test_user} · DN: {r['dn'][:80]}"})
        else:
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                                "msg": "✓ LDAP 连接成功 · 未找到测试用户 (请检查 base_dn/filter)"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"LDAP 连接失败: {e}"})


# ── F2: Namespace 多租户 ──

async def _ensure_ns_table(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS namespaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            description TEXT DEFAULT '',
            quota_bytes INTEGER DEFAULT 0,
            max_users INTEGER DEFAULT 5,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_namespace (
            user_id INTEGER PRIMARY KEY,
            namespace_id INTEGER REFERENCES namespaces(id),
            role TEXT DEFAULT 'member'
        )
    """)
    conn.commit()


async def handle_namespace_list(ws, data: dict):
    from backend import db as _db
    conn = _db.get_conn()
    await _ensure_ns_table(conn)
    rows = conn.execute("SELECT * FROM namespaces ORDER BY id").fetchall()
    members = conn.execute(
        "SELECT ns_id, COUNT(*) as cnt FROM user_namespace GROUP BY ns_id"
    ).fetchall() if True else []
    ns_counts = {m[0]: m[1] for m in members}
    await ws.send_json({"type": "result", "status": "ok",
                        "namespaces": [dict(**dict(r), users=ns_counts.get(r["id"], 0)) for r in rows]})


async def handle_namespace_create(ws, data: dict):
    from backend import db as _db
    _req = data.get("req_id") or ""
    name = (data.get("name") or "").strip()
    if not name:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 name"})
        return
    conn = _db.get_conn()
    await _ensure_ns_table(conn)
    try:
        conn.execute("INSERT INTO namespaces (name, description, quota_bytes, max_users) VALUES (?,?,?,?)",
                     (name, data.get("description") or "", int(data.get("quota_bytes") or 0),
                      int(data.get("max_users") or 5)))
        conn.commit()
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "msg": f"Namespace '{name}' 已创建"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": str(e)})


async def handle_namespace_delete(ws, data: dict):
    from backend import db as _db
    _req = data.get("req_id") or ""
    ns_id = int(data.get("id") or 0)
    conn = _db.get_conn()
    await _ensure_ns_table(conn)
    conn.execute("DELETE FROM user_namespace WHERE namespace_id=?", (ns_id,))
    conn.execute("DELETE FROM namespaces WHERE id=?", (ns_id,))
    conn.commit()
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "msg": "已删除"})


# ── F3: SIEM Syslog 转发 ──

DEFAULT_SIEM = {
    "enabled": False,
    "syslog_host": "", "syslog_port": 514, "syslog_proto": "udp",
    "facility": "local0", "severity": "info",
    "forward_events": ["task.finished", "drill.result", "stats.anomaly", "alert.ransomware"],
}


def _get_siem() -> dict:
    cfg = dict(DEFAULT_SIEM)
    try:
        raw = db.setting_get("siem_config", "")
        if raw:
            cfg.update(json.loads(raw))
    except Exception:
        pass
    return cfg


def _syslog_send(host: str, port: int, proto: str, facility: int, severity: int, msg: str):
    """发送 Syslog RFC5424 消息。"""
    pri = facility * 8 + severity
    ts = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    hostname = socket.gethostname()
    data = f"<{pri}>{ts} {hostname} fonriv - - - {msg}"
    if proto == "tcp":
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.connect((host, port))
        sock.send(data.encode())
        sock.close()
    else:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.sendto(data.encode(), (host, port))
        sock.close()


async def handle_siem_config(ws, data: dict):
    """读/写 SIEM 配置"""
    _req = data.get("req_id") or ""
    if data.get("set"):
        cfg = _get_siem()
        for k in DEFAULT_SIEM:
            if k in data:
                cfg[k] = data[k]
        db.setting_set("siem_config", json.dumps(cfg, ensure_ascii=False))
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "config": cfg, "msg": "SIEM 配置已保存"})
        return
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "config": _get_siem()})


async def handle_siem_test(ws, data: dict):
    """发送测试 Syslog 消息"""
    _req = data.get("req_id") or ""
    cfg = _get_siem()
    host = data.get("syslog_host") or cfg.get("syslog_host") or ""
    port = int(data.get("syslog_port") or cfg.get("syslog_port") or 514)
    proto = data.get("proto") or cfg.get("syslog_proto") or "udp"
    if not host:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 syslog_host"})
        return
    try:
        msg = f"Fonriv SIEM test message at {time.strftime('%Y-%m-%d %H:%M:%S')}"
        _syslog_send(host, port, proto, 16, 6, msg)  # local0.info
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": f"✓ Syslog 测试消息已发送到 {host}:{port} ({proto})"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"发送失败: {e}"})

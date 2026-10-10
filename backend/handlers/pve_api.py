"""Fonriv - PVE REST API 集成 (v4.79.0 · D1)

替代 SSH 扫描: 通过 PVE REST API (端口 8006) 获取 VM/CT/存储池 i节点/快照信息。
支持 API Token 认证 (更安全, 细粒度权限) 或用户名密码 (获取 ticket)。

动作:
  pve_api_test     测试连通性 + 认证
  pve_api_nodes    节点列表
  pve_api_vms      VM/CT 列表 (跨节点汇总)
  pve_api_storages 存储池列表
  pve_api_snapshots 指定 VM/CT 快照列表
"""
from __future__ import annotations

import asyncio
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request

from fastapi import WebSocket

from backend.log import log_operation


def _ssl_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _host_of(data: dict, host: str) -> str:
    """v5.31.1 · 把配置端口并入 host (host:port), 供 _pve_get/_pve_post 使用。
    这样「系统设置/远程桌面」里改的 API 端口才会真正生效。"""
    h = (host or "").strip().rstrip("/")
    if not h:
        return h
    if h.startswith("http://") or h.startswith("https://"):
        return h
    if ":" in h:
        return h
    port = str(data.get("port") or data.get("pve_port") or "").strip() or "8006"
    return f"{h}:{port}" if port else h


def _pve_base(host: str) -> str:
    """v5.31.1 · 支持 host 里带端口 (host:port), 默认 8006。
    原来硬编码 8006, 用户把 API 端口改成别的就必然连不上。"""
    h = (host or "").strip().rstrip("/")
    if h.startswith("http://") or h.startswith("https://"):
        h = h.split("://", 1)[1]
    return h if ":" in h else (h + ":8006")


def _pve_url(host: str, path: str) -> str:
    """v5.31.1 · FIX 路径重复拼接: 全部调用点传的都是完整路径 (/api2/json/nodes...),
    而 _pve_get/_pve_post 又无条件前缀了一层 /api2/json → 实际请求变成
    /api2/json/api2/json/nodes → pveproxy 回 501 "Method not implemented",
    整个 PVE API 集成 (VM 列表/节点/快照/集群) 因此全部不可用。
    现按是否已含前缀自动判断。"""
    pth = path or ""
    if not pth.startswith("/api2/json"):
        pth = "/api2/json" + (pth if pth.startswith("/") else "/" + pth)
    return f"https://{_pve_base(host)}{pth}"


async def _pve_get(host: str, path: str, token: str = "", ticket: str = "", csrf: str = "") -> dict:
    """PVE API GET 请求"""
    url = _pve_url(host, path)
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"PVEAPIToken={token}")
    elif ticket:
        req.add_header("Cookie", f"PVEAuthCookie={ticket}")
        if csrf:
            req.add_header("CSRFPreventionToken", csrf)
    loop = asyncio.get_event_loop()
    def _do():
        ctx = _ssl_ctx()
        try:
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                return json.loads(resp.read())
        except Exception as _e:
            print(f"[pve-debug] GET {url} → {type(_e).__name__}: {_e}", flush=True)
            raise
    return await loop.run_in_executor(None, _do)


async def _pve_post(host: str, path: str, data: dict) -> dict:
    """PVE API POST (登录获取 ticket)"""
    url = _pve_url(host, path)
    body = "&".join(f"{k}={v}" for k, v in data.items()).encode()
    req = urllib.request.Request(url, data=body)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    loop = asyncio.get_event_loop()
    def _do():
        ctx = _ssl_ctx()
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            return json.loads(resp.read())
    return await loop.run_in_executor(None, _do)


async def _get_auth(data: dict) -> tuple[str, str, str]:
    """返回 (token_or_empty, ticket_or_empty, csrf_or_empty)

    v5.31.1 · FIX 键名不一致: 本函数原先只认 pve_user / pve_password, 但
      ① 前端「远程桌面 → PVE 虚拟控制台」表单提交的是 user / password;
      ② 无参调用时的 DB 回退分支写入的也是 data["password"];
    → 两条路径都拿不到密码, 恒报「需要 API Token 或用户名密码」, 表现为
      "保存成功但载入 VM 列表始终为空"。现两种键名都接受。
    """
    token = (data.get("api_token") or "").strip()
    # v5.98.12 · FIX(用户报: PVE 控制台连得上但「载入 VM 列表」401):
    #   PVE 要求 `Authorization: PVEAPIToken=user@realm!tokenid=secret`, 但面板/档案里
    #   通常只存**密钥本身**(或整串)。此前直接拿裸密钥当整串发 → 必然 401。
    #   这里: 有 token_id 且当前值不含 "!" 时自动拼成 user@realm!tokenid=secret。
    _tid = (data.get("token_id") or "").strip()
    if token and _tid and "!" not in token:
        _u = (data.get("pve_user") or data.get("user") or "").strip()
        if _u and "@" not in _u:
            _u += "@pam"
        if _u:
            token = _u + "!" + _tid + "=" + token
    if token:
        return token, "", ""
    user = (data.get("pve_user") or data.get("user") or "root@pam").strip()
    # v5.31.4 · PVE 的 /access/ticket 要求用户名带 realm 后缀 (user@realm)。
    #   不带时 PVE 直接回 401 authentication failure —— 实测 lxrmyc 失败 / lxrmyc@pam 成功。
    #   这里自动补默认 realm pam (PVE 默认 realm), 用户也可显式写 user@pve 等。
    if user and "@" not in user:
        user = user + "@pam"
    pw = data.get("pve_password") or data.get("password") or ""
    if pw:
        r = await _pve_post(data.get("host") or "", "/access/ticket",
                            {"username": user, "password": pw})
        d = r.get("data") or {}
        return "", d.get("ticket", ""), d.get("CSRFPreventionToken", "")
    return "", "", ""


def _err_msg(e) -> str:
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code}: {e.reason}"
    if isinstance(e, urllib.error.URLError):
        return f"连接失败: {e.reason}"
    if isinstance(e, asyncio.TimeoutError):
        return "请求超时"
    return str(e)


async def handle_pve_api_test(ws, data: dict):
    """测试 PVE API 连通性 + 版本"""
    _req = data.get("req_id") or ""
    host = _host_of(data, (data.get("host") or "").strip())
    if not host:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 host"})
        return
    try:
        token, ticket, csrf = await _get_auth(data)
        r = await _pve_get(host, "/api2/json/version", token=token, ticket=ticket, csrf=csrf)
        ver = (r.get("data") or {}).get("version", "?")
        auth_mode = "API Token" if token else "用户名密码"
        log_operation("PVE API", f"连通测试 {host} · v{ver}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "version": ver, "auth_mode": auth_mode,
                            "msg": f"✓ 连接成功 · PVE v{ver} · 认证: {auth_mode}"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"连接失败: {_err_msg(e)}"})


async def handle_pve_api_nodes(ws, data: dict):
    """节点列表 (状态/CPU/内存/磁盘)"""
    _req = data.get("req_id") or ""
    host = _host_of(data, (data.get("host") or "").strip())
    if not host:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 host"})
        return
    try:
        token, ticket, csrf = await _get_auth(data)
        r = await _pve_get(host, "/api2/json/nodes", token=token, ticket=ticket, csrf=csrf)
        nodes = []
        for n in r.get("data") or []:
            nodes.append({
                "node": n.get("node", ""), "status": n.get("status", ""),
                "cpu_pct": round(n.get("cpu", 0) * 100, 1),
                "mem_used": n.get("mem", 0), "mem_total": n.get("maxmem", 0),
                "disk_used": n.get("disk", 0), "disk_total": n.get("maxdisk", 0),
                "uptime": n.get("uptime", 0), "pve_version": n.get("pveversion", ""),
            })
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "nodes": nodes})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"获取节点失败: {_err_msg(e)}"})


async def handle_pve_api_vms(ws, data: dict):
    """VM/CT 列表 (跨节点汇总)。params: host, api_token 或 pve_user/pve_password, node(可选, 空=全部)
    v5.27.0 · 远程桌面页: 不传参时回退 DB 设置 (pve_host/pve_user/pve_auth_value/pve_api_token)"""
    _req = data.get("req_id") or ""
    host = _host_of(data, (data.get("host") or "").strip())
    if not host:
        # v5.35.0 · G2 零遗留: 无参回退改读档案 (第一台启用 pve_api 的服务器)
        try:
            _e0 = (_pve_servers_read(1) or [{}])[0]
        except Exception:
            _e0 = {}
        if _e0.get("host"):
            data["host"] = _e0["host"]
            data.setdefault("port", _e0.get("port") or "8006")
            data["user"] = _e0.get("user") or "root@pam"
            data["pve_user"] = data["user"]
            if not (data.get("password") or data.get("pve_password")):
                data["password"] = _e0.get("auth_value") or ""
            if not data.get("api_token") and (_e0.get("token_value") or ""):
                data["api_token"] = _e0["token_value"]
                # v5.98.12 · 带上 token_id: 只有"密钥"时 _get_auth 才能拼出完整 PVE Token
                if _e0.get("token_id"):
                    data.setdefault("token_id", _e0["token_id"])
    # v5.98.12 · FIX(用户报: PVE 控制台连得上但「载入 VM 列表」永远失败):
    #   上面回退分支把档案里的主机写进了 **data["host"]**, 这里却仍然判断**局部变量 host**
    #   (它还是空串) → 只要请求不带 host 就必然报"未配置 PVE 主机", 即使档案里已配好。
    #   判据改为 data["host"](与回退写入的位置一致)。
    if not (data.get("host") or "").strip():
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "未配置 PVE 主机 — 请在「远程桌面 → PVE 虚拟控制台」填写连接信息并保存"})
        return
    host = (data.get("host") or "").strip()
    try:
        token, ticket, csrf = await _get_auth(data)
        if not token and not ticket:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": "需要 API Token 或用户名密码"})
            return
        # 节点列表
        # v5.98.12 · PVE Token 失效兜底: 实测(用户档案) Token 三种拼法全 401, 而同一档案里
        #   的用户名+密码能通。故 Token 认证 401 且档案里存有密码时, **自动改用密码认证重试一次**,
        #   并在操作日志留痕(不是静默回落: 日志写清了"Token 401 → 回退密码认证")。
        try:
            nr = await _pve_get(host, "/api2/json/nodes", token=token, ticket=ticket, csrf=csrf)
        except Exception as _e1:
            _pw = (data.get("password") or data.get("pve_password") or "").strip()
            if token and _pw and "401" in _err_msg(_e1):
                _u = (data.get("pve_user") or data.get("user") or "root@pam").strip()
                _r = await _pve_post(data.get("host") or host, "/access/ticket",
                                     {"username": _u, "password": _pw})
                _d = (_r.get("data") or {})
                ticket, csrf = _d.get("ticket", ""), _d.get("CSRFPreventionToken", "")
                if not ticket:
                    raise
                token = ""
                try:
                    log_operation("PVE API", "Token 认证失败已自动回退密码认证",
                                  "host=%s user=%s (Token 401 → 密码认证成功, 建议重新签发 Token 或改用密码)"
                                  % (host, _u))
                except Exception:
                    pass
                nr = await _pve_get(host, "/api2/json/nodes", ticket=ticket, csrf=csrf)
            else:
                raise
        nodes = [n["node"] for n in (nr.get("data") or [])]
        if data.get("node"):
            nodes = [data["node"]]
        vms = []
        for node in nodes:
            for vtype in ("qemu", "lxc"):
                try:
                    vr = await _pve_get(host, f"/api2/json/nodes/{node}/{vtype}",
                                        token=token, ticket=ticket, csrf=csrf)
                    for v in vr.get("data") or []:
                        vms.append({
                            "vmid": v.get("vmid"), "name": v.get("name", ""),
                            "type": vtype, "node": node,
                            "status": v.get("status", ""),
                            "cpus": v.get("cpus", 0),
                            "mem": v.get("maxmem", 0),
                            "disk": v.get("maxdisk", 0),
                            "uptime": v.get("uptime", 0),
                            "tags": v.get("tags", ""),
                        })
                except Exception:
                    pass
        vms.sort(key=lambda x: (x["type"], x["vmid"]))
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "vms": vms})
    except Exception as e:
        _m = _err_msg(e)
        if "401" in _m:
            _m += (" — PVE 认证失败: Token 可能已失效/被撤销, 或 Token ID/密钥不匹配。"
                   "请到「PVE 服务器连接」重新填写并「保存连接」后再试 (也可改用用户名+密码认证)。")
        try:
            # v5.98.13 · 模块级已有 log_operation —— 不许在函数内重复 import
            #   (重复 import 会让该名字在整个函数内变成局部, 分支外使用点会 UnboundLocalError,
            #    静态检查 scripts/check_import_shadowing.py 已把这条定为"真危险")
            log_operation("PVE API", "载入 VM 列表失败", "host=%s user=%s auth=%s → %s"
                          % (host, data.get("user") or data.get("pve_user") or "",
                             "token" if data.get("api_token") else "password", _m))
        except Exception:
            pass
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"获取 VM 列表失败: {_m}"})


async def handle_pve_api_storages(ws, data: dict):
    """存储池列表 (跨节点)。params: host + auth, content 可选过滤 (backup/isos/rootdir)"""
    _req = data.get("req_id") or ""
    host = _host_of(data, (data.get("host") or "").strip())
    if not host:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 host"})
        return
    content = data.get("content") or ""
    try:
        token, ticket, csrf = await _get_auth(data)
        nr = await _pve_get(host, "/api2/json/nodes", token=token, ticket=ticket, csrf=csrf)
        nodes = [n["node"] for n in (nr.get("data") or [])]
        seen = set()
        storages = []
        for node in nodes:
            path = f"/api2/json/nodes/{node}/storage"
            if content:
                path += f"?content={content}"
            try:
                sr = await _pve_get(host, path, token=token, ticket=ticket, csrf=csrf)
                for s in sr.get("data") or []:
                    key = s.get("storage")
                    if key in seen:
                        continue
                    seen.add(key)
                    storages.append({
                        "storage": key, "type": s.get("type", ""),
                        "content": s.get("content", ""),
                        "total": s.get("total", 0), "used": s.get("used", 0),
                        "avail": s.get("avail", 0), "active": s.get("active", 0),
                    })
            except Exception:
                pass
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "storages": storages})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"获取存储失败: {_err_msg(e)}"})


async def handle_pve_api_snapshots(ws, data: dict):
    """快照列表。params: host + auth, node, vmid, type(qemu|lxc)"""
    _req = data.get("req_id") or ""
    host = _host_of(data, (data.get("host") or "").strip())
    node = (data.get("node") or "").strip()
    vmid = data.get("vmid")
    vtype = (data.get("type") or "qemu").strip()
    if not host or not node or not vmid:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "缺少 host/node/vmid"})
        return
    try:
        token, ticket, csrf = await _get_auth(data)
        r = await _pve_get(host, f"/api2/json/nodes/{node}/{vtype}/{vmid}/snapshot",
                           token=token, ticket=ticket, csrf=csrf)
        snaps = []
        for s in r.get("data") or []:
            if s.get("name") == "current":
                continue
            snaps.append({
                "name": s.get("name", ""), "description": s.get("description", ""),
                "time": s.get("snaptime", 0), "parent": s.get("parent", ""),
                "vmstate": bool(s.get("vmstate")),
            })
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "snapshots": snaps})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"获取快照失败: {_err_msg(e)}"})


async def handle_pve_api_snapshot_create(ws, data: dict):
    """v4.92.0 · D1 快照创建。params: host+auth, node, vmid, type, snapname, description(可选), include_ram(0|1)"""
    _req = data.get("req_id") or ""
    host = _host_of(data, (data.get("host") or "").strip())
    node = (data.get("node") or "").strip()
    vmid = data.get("vmid")
    vtype = (data.get("type") or "qemu").strip()
    snapname = (data.get("snapname") or "").strip()
    if not (host and node and vmid and snapname):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "缺少 host/node/vmid/snapname"})
        return
    try:
        token, ticket, csrf = await _get_auth(data)
        import urllib.parse
        params = {"snapname": snapname}
        if data.get("description"):
            params["description"] = str(data["description"])
        if vtype == "qemu" and str(data.get("include_ram") or "0") == "1":
            params["vmstate"] = "1"
        body = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        url = f"https://{_pve_base(host)}/api2/json/nodes/{node}/{vtype}/{vmid}/snapshot"
        req = urllib.request.Request(url, data=body.encode())
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        if token:
            req.add_header("Authorization", f"PVEAPIToken={token}")
        elif ticket:
            req.add_header("Cookie", f"PVEAuthCookie={ticket}")
            req.add_header("CSRFPreventionToken", csrf)
        loop = asyncio.get_event_loop()
        def _do():
            with urllib.request.urlopen(req, timeout=30, context=_ssl_ctx()) as resp:
                return json.loads(resp.read())
        r = await loop.run_in_executor(None, _do)
        upid = (r.get("data") or "")
        log_operation("PVE 快照", f"创建 {vtype}/{vmid}@{snapname} @ {node}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": f"✓ 快照创建任务已提交: {vtype}/{vmid}@{snapname}", "upid": upid})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"快照创建失败: {_err_msg(e)}"})


async def handle_pve_api_snapshot_rollback(ws, data: dict):
    """v4.92.0 · D1 快照回滚。params: host+auth, node, vmid, type, snapname"""
    _req = data.get("req_id") or ""
    host = _host_of(data, (data.get("host") or "").strip())
    node = (data.get("node") or "").strip()
    vmid = data.get("vmid")
    vtype = (data.get("type") or "qemu").strip()
    snapname = (data.get("snapname") or "").strip()
    if not (host and node and vmid and snapname):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "缺少 host/node/vmid/snapname"})
        return
    try:
        token, ticket, csrf = await _get_auth(data)
        url = f"https://{_pve_base(host)}/api2/json/nodes/{node}/{vtype}/{vmid}/snapshot/{urllib.parse.quote(snapname)}/rollback"
        req = urllib.request.Request(url, data=b"")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.method = "POST"
        if token:
            req.add_header("Authorization", f"PVEAPIToken={token}")
        elif ticket:
            req.add_header("Cookie", f"PVEAuthCookie={ticket}")
            req.add_header("CSRFPreventionToken", csrf)
        loop = asyncio.get_event_loop()
        def _do():
            with urllib.request.urlopen(req, timeout=30, context=_ssl_ctx()) as resp:
                return json.loads(resp.read())
        r = await loop.run_in_executor(None, _do)
        upid = (r.get("data") or "")
        log_operation("PVE 快照", f"回滚 {vtype}/{vmid} → {snapname} @ {node}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": f"✓ 回滚任务已提交: {vtype}/{vmid} → {snapname} (运行中 VM 将被暂停)", "upid": upid})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"快照回滚失败: {_err_msg(e)}"})


# ── v5.20.0 · VM/CT 控制台 (noVNC 通路) ──
async def handle_pve_console_ready(ws, data: dict):
    """报告控制台可用性 + 是否装好 noVNC 静态资源。

    前端据此决定: 显示「🖥 控制台」按钮, 还是提示"先上传 noVNC"。
    params: 无 (读服务端 PVE 配置)
    """
    _req = data.get("req_id") or ""
    import os as _os
    from backend import db as _db
    novnc_ok = _os.path.isfile(_os.path.join(
        _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
        "frontend", "static", "vendor", "novnc", "vnc_lite.html"))
    try:
        host = (_pve_servers_read(1) or [{}])[0].get("host", "")
    except Exception:
        host = ""
    await ws.send_json({
        "type": "result", "status": "ok", "req_id": _req,
        "novnc_installed": novnc_ok,
        "pve_configured": bool(host),
        "pve_host": host,
        "ws_path": "/ws/vnc",
        "hint": ("" if novnc_ok else
                 "缺少 noVNC 静态资源: 运行 scripts/fetch_novnc.sh 获取 "
                 "(前端控制台页面依赖它渲染画面)"),
    })


async def handle_pve_console_url(ws, data: dict):
    """为一个 VM/CT 生成控制台 URL (含鉴权 token), 供前端 iframe 打开。

    安全: 只回本机相对路径 + 已签发的会话 token, **不下发 PVE 凭据**;
          PVE ticket 由 /ws/vnc 建连时才在服务端现取。
    """
    _req = data.get("req_id") or ""
    node = (data.get("node") or "").strip()
    vmid = str(data.get("vmid") or "").strip()
    kind = (data.get("kind") or "qemu").strip().lower()
    if kind not in ("qemu", "lxc"):
        kind = "qemu"
    if not vmid:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "缺少 vmid"})
        return
    # v5.20.0 · node 可省略: 用 /cluster/resources 反查该 VM/CT 实际所在节点。
    #   前端(SSH 扫描路径)拿不到节点名, 让它去猜不如后端查准 —— 集群环境下尤其重要。
    if not node:
        try:
            from backend import db as _db2
            _host = (data.get("host") or "").strip()
            if not _host:
                try:
                    _host = (_pve_servers_read(1) or [{}])[0].get("host", "")
                except Exception:
                    _host = ""
            _tok, _tik, _csrf = await _get_auth(data)
            if _host and (_tok or _tik):
                cr = await _pve_get(_host, "/api2/json/cluster/resources?type=vm",
                                    token=_tok, ticket=_tik, csrf=_csrf)
                for _r in (cr.get("data") or []):
                    if str(_r.get("vmid")) == vmid:
                        node = _r.get("node") or ""
                        if _r.get("type") in ("qemu", "lxc"):
                            kind = _r["type"]
                        break
        except Exception as _ne:
            print(f"[pve] 反查节点失败: {_ne}")
    if not node:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"无法确定 VM {vmid} 所在节点 (可显式传 node, 或检查 PVE 连接配置)"})
        return
    # 会话 token 由前端随消息带上 (与 /ws 端点一致: data.auth_token)
    token = (data.get("auth_token") or "").strip()
    q = urllib.parse.urlencode({"node": node, "vmid": vmid, "kind": kind,
                                "auth_token": token})
    await ws.send_json({
        "type": "result", "status": "ok", "req_id": _req,
        "url": f"/novnc.html?{q}",
        "ws_url": f"/ws/vnc?{q}",
        "node": node, "vmid": vmid, "kind": kind,
        "has_token": bool(token),
    })


# ── v5.28.0 · PVE 连接配置保存 (远程桌面 → PVE 虚拟控制台) ──
async def handle_pve_save_config(ws, data: dict):
    """v5.35.0 · G2: 旧扁平保存口 → 转发为档案 upsert (pve_servers save 同路径)。"""
    from backend.auth import _require_admin
    from backend import db as _db
    _req = data.get("req_id") or ""
    if not await _require_admin(ws):
        return
    from backend.auth import active_sessions as _as
    _uid = (_as.get(ws) or {}).get("user_id") or 1
    host = (data.get("host") or "").strip()
    if not host:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 host"})
        return
    ent = {"name": (data.get("name") or host), "host": host,
           "port": str(data.get("port") or "8006"),
           "user": (data.get("user") or "root@pam").strip(),
           "auth_type": "token" if data.get("token_value") else "password",
           "auth_value": (data.get("password") or "").strip(),
           "token_id": (data.get("token_id") or "").strip(),
           "token_value": (data.get("token_value") or "").strip()}
    _pve_profile_upsert(_uid, ent)
    try:
        from backend.log import log_operation
        log_operation("远程桌面", f"保存 PVE 连接 {host}:{ent['port']}")
    except Exception:
        pass
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "msg": f"✓ PVE 连接已保存到档案: {host}"})

# ═══════════════════════════════════════════════════════════════
# v5.31.5 · PVE 多服务器管理 (用户要求: 支持多台 Proxmox + 已保存列表可编辑/删除/载入)
#   存储: app_settings.pve_servers = JSON [{id,name,host,port,user,auth_type,auth_value,token_id,token_value}]
#   兼容: 保存时同步写旧扁平键 (pve_host/...), 保证无参 pve_api_vms 的 DB 回退继续可用。
# ═══════════════════════════════════════════════════════════════

_PVE_SERVERS_KEY = "pve_servers"


def _pve_servers_read(uid: int = 1) -> list:
    """v5.34.5 · P5 档案化: server_profiles 为真源的合并读取。
    ① 档案中 protocols.pve_api.enabled 的条目 → 旧条目格式 (凭据解密, 页面零改动)
    ② 旧 app_settings.pve_servers 中 host 未被档案覆盖的条目 (兼容未迁移数据)
    """
    import json as _json
    from backend import db as _db
    from backend.db.crypto import decrypt_value
    from backend.db import _get_fernet
    out = []
    hosts_seen = set()
    try:
        rows = _db.get_conn().execute(
            "SELECT guid,name,hostname,ssh_port,ssh_user,protocols FROM server_profiles "
            "WHERE user_id=?", (uid,)).fetchall()
        for r in rows:
            try:
                proto = _json.loads(r["protocols"] or "{}")
            except Exception:
                continue
            blk = proto.get("pve_api") or {}
            if not (isinstance(blk, dict) and blk.get("enabled")):
                continue
            api_pass = blk.get("api_pass") or ""
            if api_pass and str(api_pass).startswith("ENC$"):
                api_pass = decrypt_value(_get_fernet(), api_pass)
            tok = blk.get("token_value") or ""
            if tok and str(tok).startswith("ENC$"):
                tok = decrypt_value(_get_fernet(), tok)
            out.append({
                "id": r["guid"],
                "name": r["name"] or r["hostname"],
                "host": r["hostname"],
                "port": str(blk.get("port") or 8006),
                "user": blk.get("api_user") or "root@pam",
                "auth_type": "token" if tok else "password",
                "auth_value": api_pass,
                "token_id": blk.get("token_id") or "",
                "token_value": tok,
            })
            hosts_seen.add((r["hostname"], str(blk.get("api_user") or "root@pam")))
    except Exception as e:
        print(f"[pve_servers] profile read fail: {e}")
    # ② 旧数组里未被档案覆盖的条目 (未迁移)
    raw = (_db.setting_get(_PVE_SERVERS_KEY, "") or "").strip()
    try:
        arr = _json.loads(raw) if raw else []
    except Exception:
        arr = []
    if isinstance(arr, list):
        for e in arr:
            if not isinstance(e, dict):
                continue
            if (e.get("host"), e.get("user")) in hosts_seen:
                continue
            out.append(e)
    return out


def _pve_profile_upsert(uid: int, ent: dict) -> str:
    """v5.34.5 · PVE 条目 → server_profiles (按 hostname upsert, 凭据 ENC$)。返回 guid。"""
    import json as _json
    import time as _time
    import uuid as _uuid
    from backend import db as _db
    from backend.db.crypto import encrypt_value
    from backend.db import _get_fernet
    host = (ent.get("host") or "").strip()
    conn = _db.get_conn()
    row = conn.execute(
        "SELECT guid,protocols FROM server_profiles WHERE user_id=? AND hostname=?",
        (uid, host)).fetchone()
    blk = {
        "enabled": True,
        "port": str(ent.get("port") or 8006),
        "api_user": ent.get("user") or "root@pam",
        "auth_type": "token" if (ent.get("token_value") or "") else "password",
        "token_id": (ent.get("token_id") or ""),
        "verify_ssl": False,
    }
    if ent.get("auth_value"):
        blk["api_pass"] = encrypt_value(_get_fernet(), ent["auth_value"])
    if ent.get("token_value"):
        blk["token_value"] = encrypt_value(_get_fernet(), ent["token_value"])
    now = _time.strftime("%Y-%m-%d %H:%M:%S")
    if row:
        guid = row["guid"]
        try:
            proto = _json.loads(row["protocols"] or "{}")
        except Exception:
            proto = {}
        proto["pve_api"] = blk
        conn.execute("UPDATE server_profiles SET name=?, kind='pve', protocols=?, "
                     "version=version+1, updated_at=? WHERE guid=?",
                     (ent.get("name") or host, _json.dumps(proto, ensure_ascii=False), now, guid))
    else:
        guid = "pve_" + _uuid.uuid4().hex[:8]
        conn.execute("""INSERT OR IGNORE INTO server_profiles
            (guid, user_id, name, hostname, kind, icon, protocols, version, created_at, updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (guid, uid, ent.get("name") or host, host, "pve", "pve",
             _json.dumps({"pve_api": blk}, ensure_ascii=False), 1, now, now))
    conn.commit()
    # 已被档案接管 → 从旧数组剥离该条目 (零凭据残留)
    try:
        raw = _db.setting_get(_PVE_SERVERS_KEY, "") or ""
        arr = _json.loads(raw) if raw else []
        arr2 = [x for x in arr if not (isinstance(x, dict) and x.get("host") == host)]
        _db.setting_set(_PVE_SERVERS_KEY, _json.dumps(arr2, ensure_ascii=False))
    except Exception:
        pass
    return guid


def _pve_profile_del(uid: int, ident: str) -> bool:
    """v5.34.5 · 删除: 档案移除 pve_api 块 (SSH 等其他能力保留) + 旧数组剥条目。"""
    import json as _json
    import time as _time
    from backend import db as _db
    conn = _db.get_conn()
    row = None
    for key in ("guid",):
        row = conn.execute(f"SELECT guid,protocols FROM server_profiles WHERE user_id=? AND {key}=?",
                           (uid, ident)).fetchone()
        if row:
            break
    if not row:
        # 也许 ident 是旧数组 id (未迁移条目) → 按旧数组删
        try:
            raw = _db.setting_get(_PVE_SERVERS_KEY, "") or ""
            arr = _json.loads(raw) if raw else []
            arr2 = [x for x in arr if not (isinstance(x, dict) and x.get("id") == ident)]
            if len(arr2) != len(arr):
                _db.setting_set(_PVE_SERVERS_KEY, _json.dumps(arr2, ensure_ascii=False))
                return True
        except Exception:
            pass
        return False
    try:
        proto = _json.loads(row["protocols"] or "{}")
    except Exception:
        proto = {}
    proto.pop("pve_api", None)
    conn.execute("UPDATE server_profiles SET protocols=?, version=version+1, updated_at=? WHERE guid=?",
                 (_json.dumps(proto, ensure_ascii=False), _time.strftime("%Y-%m-%d %H:%M:%S"), row["guid"]))
    conn.commit()
    return True


async def handle_pve_servers(ws, data: dict):
    """PVE 服务器列表: sub=get | save | del (admin)"""
    _req = data.get("req_id") or ""
    from backend.auth import _require_admin
    from backend import db as _db
    if not await _require_admin(ws):
        return
    sub = (data.get("sub") or "get").strip().lower()
    arr = _pve_servers_read()

    if sub == "get":
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "servers": arr})
        return

    if sub == "save":
        host = (data.get("host") or "").strip()
        if not host:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 host"})
            return
        ent = {
            "id": (data.get("id") or "").strip() or ("pve_" + __import__("uuid").uuid4().hex[:8]),
            "name": (data.get("name") or "").strip() or host,
            "host": host,
            "port": str(data.get("port") or "8006"),
            "user": (data.get("user") or "root@pam").strip(),
            "auth_type": "token" if (data.get("token_value") or "") else "password",
            "auth_value": (data.get("password") or "").strip(),
            "token_id": (data.get("token_id") or "").strip(),
            "token_value": (data.get("token_value") or "").strip(),
        }
        # v5.34.5 · P5 档案化: 密码留空 → 保留旧凭据 (档案或旧数组里找)
        if not ent["auth_value"] or not ent["token_value"]:
            for x in arr:
                if x.get("host") == ent["host"] and x.get("user") == ent["user"]:
                    if not ent["auth_value"] and x.get("auth_value"):
                        ent["auth_value"] = x["auth_value"]
                    if not ent["token_value"] and x.get("token_value"):
                        ent["token_value"] = x["token_value"]
                    break
        # 档案 upsert (凭据 ENC$; 旧数组同 host 条目自动剥离)
        from backend.auth import active_sessions as _as
        _uid = (_as.get(ws) or {}).get("user_id") or 1
        ent["id"] = _pve_profile_upsert(_uid, ent)   # v5.34.5 · 回复/后续 del 用档案真实 guid
        arr = _pve_servers_read(_uid)
        # v5.35.0 · G2: 扁平键同步写移除 (档案即唯一存储)
        try:
            from backend.log import log_operation
            log_operation("远程桌面", f"保存 PVE 服务器 {ent['name']} ({ent['host']}:{ent['port']})")
        except Exception:
            pass
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "servers": arr,
                            "server": ent, "msg": f"✓ 已保存 PVE 服务器: {ent['name']}"})
        return

    if sub == "del":
        sid = (data.get("id") or "").strip()
        from backend.auth import active_sessions as _as2
        _uid2 = (_as2.get(ws) or {}).get("user_id") or 1
        if not _pve_profile_del(_uid2, sid):
            await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "未找到该条目"})
            return
        arr2 = _pve_servers_read(_uid2)
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "servers": arr2,
                            "msg": "✓ 已删除"})
        return

    await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"未知 sub: {sub}"})


async def handle_pve_console(ws, data: dict):
    """v5.31.5 · 为 noVNC 控制台创建 vncproxy 并返回一次性 ticket (作为 VNC 密码传给浏览器)。"""
    _req = data.get("req_id") or ""
    from backend.auth import _require_admin
    if not await _require_admin(ws):
        return
    node = (data.get("node") or "").strip()
    vmid = (data.get("vmid") or "").strip()
    kind = (data.get("kind") or "qemu").strip().lower()
    if not node or not vmid:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 node/vmid"})
        return
    from backend.vnc_bridge import open_vnc_proxy
    info, err = open_vnc_proxy(node, vmid, kind)
    if err:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": err})
        return
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "vpassword": info.get("ticket", ""), "vncport": info.get("vnc_port")})

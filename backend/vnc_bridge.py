"""Fonriv · VM/主机 远程控制台桥 (v5.20.0)

目标: 浏览器里直接看 Proxmox VM 的控制台 —— 不装额外客户端, VM 没系统/没网络也能看启动界面。

为什么先做 PVE 而不是通用 RDP/VNC
--------------------------------
Proxmox 自带 VNC 代理: `vncproxy` 拿 ticket, 再连 `vncwebsocket` 就是标准 RFB over WS。
于是**不需要 guacd**、不需要被控端装 VNC 服务, 一条通路就能出画面。
(通用 RDP/VNC 走 guacd 的方案见 docs/下一阶段规划_v2 §6, 是后续期次。)

架构 (与 JSON 分发器的关系 —— 重要)
----------------------------------
本项目的 WebSocket 主入口 `/ws` 是**按 JSON action 分发**的 (backend/ws.py)。
而 Guacamole/RFB 这类协议是**二进制字节流**, 塞进 JSON 帧会破坏协议且无法对齐。
因此控制台走**独立 WS 端点** `/ws/vnc`, 只做字节透传, 不经过 JSON 分发器。
这一点在原参考方案里被忽略, 但它是集成时第一个会撞上的问题。

安全
----
· 连接前必须持有效 auth_token (复用主会话校验)。
· PVE 凭据只从服务端 DB 读取, 不下发到浏览器。
· ticket 短时效: 每次连接现取, 不在前端保存。
· PVE 通常自签证书 → 该端点内固定不校验证书 (与既有 pve_api.py 同策略), 但仅限内网使用。
"""
from __future__ import annotations

import asyncio
import json
import logging
import ssl
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

# 单次控制台会话上限 (防挂死连接堆积)
MAX_SESSION_SEC = 8 * 3600
_CHUNK = 64 * 1024


def _ssl_ctx() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _pve_creds() -> dict:
    """从 DB 取 PVE 连接信息。

    v5.31.5 · FIX: 原来只读旧扁平键 (pve_host/...), 与 pve_servers 多服务器列表脱节 ——
    列表里保存/切换服务器后, 扁平键可能指向别的条目 (甚至已删除的条目),
    PVE 控制台就会连到错误主机或报 No route to host。现改为:
    列表非空 → 取第一条 (即最近保存/使用的服务器); 列表为空 → 回退旧扁平键。
    """
    from backend import db
    # v5.34.5 · P5: 改走 pve_api 合并读取 (server_profiles 真源 + 旧数组兼容)
    try:
        from backend.handlers.pve_api import _pve_servers_read
        arr = _pve_servers_read(1)
    except Exception:
        arr = []
    if isinstance(arr, list) and arr and isinstance(arr[0], dict):
        e = arr[0]
        try:
            port = int(e.get("port") or 8006)
        except (TypeError, ValueError):
            port = 8006
        # v5.98.13 · FIX(用户报: PVE 控制台点「控制台」→ vncproxy 401):
        #   ① 档案里 token 模式的**密钥在 token_value**, 密码在 auth_value —— 原先一律取 auth_value,
        #      于是把**密码**当成 Token 发 (`PVEAPIToken=<密码>`) → 必然 401;
        #   ② PVE 要 `user@realm!tokenid=secret`, 但档案里通常只存"密钥本身" → 这里按需拼装;
        #   ③ 记下密码, 供 Token 失效时兜底(见 open_vnc_proxy)。
        _at = (e.get("auth_type") or "password").strip().lower()
        _av = e.get("auth_value") or ""
        _tok = e.get("token_value") or ""
        _u = (e.get("user") or "").strip()
        _tid = (e.get("token_id") or "").strip()
        if _at == "token" and _tok:
            if _u and "@" not in _u:
                _u_pve = _u + "@pam"
            else:
                _u_pve = _u
            if _tid and "!" not in _tok:
                _tok = _u_pve + "!" + _tid + "=" + _tok
        return {
            "host": (e.get("host") or "").strip(),
            "port": port,
            "user": _u,
            "auth_type": _at,
            "auth_value": (_tok if (_at == "token" and _tok) else _av),
            "password": _av,           # v5.98.13 · Token 失效时回退用
        }
    # v5.35.0 · G2: 扁平键回退移除; 档案列表空 → 未配置
    return {"host": "", "port": 8006, "user": "root@pam",
            "auth_type": "password", "auth_value": ""}


def _token_or_ticket(creds: dict) -> tuple:
    """返回 (auth_headers, err)。auth_type=token 时直接可用; 否则需换取 ticket。"""
    at, av = creds.get("auth_type", ""), creds.get("auth_value", "")
    if at == "token" and av:
        return {"Authorization": f"PVEAPIToken={av}"}, ""
    if not creds.get("user") or not av:
        return {}, "PVE 未配置用户名/密码或 API Token (请先在 PVE 连接里配置)"
    return {}, ""


def _login_ticket(creds: dict) -> tuple:
    """用户名密码 → (ticket, csrf)。返回 (dict, err)。"""
    url = f"https://{creds['host']}:{creds['port']}/api2/json/access/ticket"
    # v5.31.5 · 与 pve_api._get_auth 同步: 用户名不带 realm 后缀时 PVE 直接 401
    user = (creds["user"] or "").strip()
    if user and "@" not in user:
        user = user + "@pam"
    body = urllib.parse.urlencode({
        "username": user, "password": creds["auth_value"],
    }).encode()
    req = urllib.request.Request(url, data=body)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=15, context=_ssl_ctx()) as r:
            d = json.loads(r.read()).get("data") or {}
        return {"ticket": d.get("ticket", ""), "csrf": d.get("CSRFPreventionToken", "")}, ""
    except Exception as e:
        return {}, f"PVE 登录失败: {type(e).__name__}: {e}"


def _auth_headers(creds: dict) -> tuple:
    """统一得到可用的鉴权头。"""
    h, err = _token_or_ticket(creds)
    if h:
        return h, ""
    if err:
        return {}, err
    t, err = _login_ticket(creds)
    if err:
        return {}, err
    out = {"Cookie": f"PVEAuthCookie={t['ticket']}"}
    if t.get("csrf"):
        out["CSRFPreventionToken"] = t["csrf"]
    return out, ""


def _api_post(creds: dict, path: str, headers: dict) -> tuple:
    url = f"https://{creds['host']}:{creds['port']}/api2/json{path}"
    req = urllib.request.Request(url, data=b"", method="POST")
    for k, v in headers.items():
        req.add_header(k, v)
    req.add_header("Content-Length", "0")
    try:
        with urllib.request.urlopen(req, timeout=20, context=_ssl_ctx()) as r:
            return json.loads(r.read()).get("data") or {}, ""
    except Exception as e:
        return {}, f"{type(e).__name__}: {e}"


def open_vnc_proxy(node: str, vmid: str, kind: str = "qemu") -> tuple:
    """POST vncproxy → 返回 (info, err)。info 含 ticket/port。

    kind: qemu (VM) | lxc (容器, 走 termproxy 之外的 vncproxy 亦可用)
    """
    creds = _pve_creds()
    if not creds["host"]:
        return {}, "未配置 PVE 主机 (设置页 → PVE 连接)"
    headers, err = _auth_headers(creds)
    if err:
        return {}, err
    path = f"/nodes/{urllib.parse.quote(node)}/{kind}/{urllib.parse.quote(str(vmid))}/vncproxy"
    data, err = _api_post(creds, path, headers)
    if err and "401" in err and creds.get("auth_type") == "token" and creds.get("password"):
        # v5.98.13 · PVE Token 认证 401 且档案里存有密码 → 自动改用用户名+密码重试一次(留日志, 不静默)
        _c2 = dict(creds); _c2["auth_type"] = "password"; _c2["auth_value"] = creds["password"]
        _h2, _e2 = _auth_headers(_c2)
        if _h2:
            _d2, _err2 = _api_post(_c2, path, _h2)
            if not _err2:
                _msg = ("Token 认证失败已自动回退密码认证 host=%s user=%s "
                        "(Token 401 → 密码认证成功, 建议重新签发 Token 或改用密码)" % (creds["host"], creds["user"]))
                print("[vnc-bridge] " + _msg, flush=True)
                try:
                    from backend.log import log_operation
                    log_operation("PVE 控制台", "Token 认证失败已自动回退密码认证", _msg)
                except Exception:
                    pass
                data, err = _d2, ""
    if err:
        return {}, f"vncproxy 调用失败: {err}"
    if not data.get("ticket") or not data.get("port"):
        return {}, f"vncproxy 未返回 ticket/port: {data}"
    print(f"[vnc-bridge] vncproxy OK: port={data.get('port')} ticket={str(data.get('ticket',''))[:16]}...", flush=True)
    import logging as _lg
    _lg.info("[vnc] vncproxy 成功: port=%s ticket=%s...", data.get("port"), str(data.get("ticket",""))[:20])
    return {
        "host": creds["host"], "port": creds["port"],
        "ticket": data["ticket"], "vnc_port": data["port"],
        "user": data.get("user", ""), "cert": data.get("cert", ""),
    }, ""


def vnc_ws_url(info: dict, node: str, vmid: str, kind: str = "qemu") -> str:
    """拼 PVE 的 vncwebsocket URL (vncticket 必须 URL 编码)。"""
    q = urllib.parse.urlencode({
        "port": info["vnc_port"],
        "vncticket": info["ticket"],
    })
    return (f"wss://{info['host']}:{info['port']}/api2/json/nodes/"
            f"{urllib.parse.quote(node)}/{kind}/{urllib.parse.quote(str(vmid))}/vncwebsocket?{q}")


async def bridge(ws, *, node: str, vmid: str, kind: str = "qemu", check_auth=True,
                 query: dict = None) -> None:
    """把浏览器的 RFB 字节流与 PVE vncwebsocket 对接 (双向透传)。

    浏览器侧期望的就是普通 VNC/RFB over WebSocket —— noVNC 可直接连。
    """
    from fastapi import WebSocketDisconnect
    if check_auth:
        try:
            from backend.ws import require_auth
            if not await require_auth(ws):
                await ws.close(code=4401)
                return
        except Exception as e:
            log.info("控制台鉴权失败: %s", e)
            await ws.close(code=4401)
            return

    # v5.98.16 · FIX(用户报: PVE 点「控制台」→ 连接断开):
    #   本函数此前引用了 **未定义的 `query`**(只有 handle_ws_vnc_query 有那个局部变量)
    #   → 一进函数就 NameError, WS 被直接丢弃(客户端看到 1006), 且因为 print 没 flush,
    #   日志里连报错都看不到。现改为显式接收 query 参数。
    query = query or {}
    vnticket = (query.get("vncticket") or "").strip()
    print(f"[vnc-bridge] vncticket 模式: ticket={bool(vnticket)}", flush=True)
    if vnticket:
        # v5.31.5 · noVNC 流程: proxy 已由 pve_console action 创建, ticket 由 URL 带入
        creds0 = _pve_creds()
        try:
            vnc_port = int(query.get("vncport") or 5900)
        except (TypeError, ValueError):
            vnc_port = 5900
        info = {"host": creds0["host"], "port": creds0["port"],
                "ticket": vnticket, "vnc_port": vnc_port, "user": creds0.get("user", "")}
        err = ""
    else:
        print(f'[vnc-bridge] open_vnc_proxy node={node} vmid={vmid} kind={kind}', flush=True)
        # v5.98.16 · 仅在没有 URL 传入 ticket 时才自己开一张 —— 否则桥用新票、noVNC 手里是旧票,
        #   RFB 密码校验会不一致(实测必须"桥复用 noVNC 手上那张票")
        info, err = open_vnc_proxy(node, vmid, kind)
    if err:
        try:
            # 用文本帧回一条可读错误 —— noVNC 会把它当作协议错误显示出来
            await ws.send_text(json.dumps({"rp_error": err}, ensure_ascii=False))
        except Exception:
            pass
        await ws.close(code=4500)
        return

    try:
        import websockets  # type: ignore
    except ImportError:
        try:
            await ws.send_text(json.dumps({"rp_error": "服务端缺少 websockets 依赖 (pip install websockets)"}))
        except Exception:
            pass
        await ws.close(code=4501)
        return

    url = vnc_ws_url(info, node, vmid, kind)
    sslctx = _ssl_ctx()
    print("[vnc-bridge] 连接 PVE vncwebsocket: %s" % url[:100], flush=True)
    try:
        # v5.98.16 · 鉴权候选按顺序试: 先用档案声明的认证方式, 401 再退到**同一档案里的密码票据**
        #   (实测该档案的 Token 已被撤销 → 只用 Token 时 vncwebsocket 恒 401; 密码可通)
        creds = _pve_creds()
        _cands = []
        if creds.get("auth_type") == "token" and creds.get("auth_value"):
            _cands.append(("token", {"Authorization": f"PVEAPIToken={creds['auth_value']}"}))
        if creds.get("password") and creds.get("user"):
            _auth, _aerr = _login_ticket({**creds, "auth_value": creds["password"]})
            if not _aerr and _auth.get("ticket"):
                _cands.append(("password", {"Cookie": f"PVEAuthCookie={_auth['ticket']}"}))
        if not _cands and creds.get("auth_type") != "token" and creds.get("user") and creds.get("auth_value"):
            _auth, _aerr = _login_ticket(creds)
            if not _aerr and _auth.get("ticket"):
                _cands.append(("password", {"Cookie": f"PVEAuthCookie={_auth['ticket']}"}))
        _hdrs = _cands[0][1] if _cands else {}
        _alt = _cands[1:]
        # v5.98.16 · FIX(用户报: PVE 点「控制台」→ 连接断开, 实测根因):
        #   本机 websockets 新 API 把握手头参数从 `extra_headers` 改名为 `additional_headers`,
        #   旧写法直接抛 `TypeError: create_connection() got an unexpected keyword argument
        #   'extra_headers'` → 桥连 PVE vncwebsocket **次次失败**。这里两种 API 都兼容。
        _kw = dict(ssl=sslctx, max_size=None, open_timeout=20, close_timeout=5)

        def _mk_cm(_h):
            """建连上下文管理器: 兼容 websockets 新旧 API 的握手头参数名。"""
            try:
                return websockets.connect(url, additional_headers=_h, **_kw)
            except TypeError:
                return websockets.connect(url, extra_headers=_h, **_kw)

        _up = None
        _tries = [(_cands[0][0] if _cands else "none", _hdrs)] + _alt
        for _i, (_how, _h) in enumerate(_tries):
            try:
                async with _mk_cm(_h) as up:
                    print("[vnc-bridge] ✓ PVE vncwebsocket 已建立 (鉴权: %s), 等 RFB 数据…" % _how, flush=True)
                    await _pump(ws, up)
                    return
            except Exception as _e:
                _s = "%s: %s" % (type(_e).__name__, _e)
                print("[vnc-bridge] 建连失败(鉴权=%s): %s" % (_how, _s), flush=True)
                # 只对"认证被拒(401)"换下一种鉴权, 其它错误直接抛出去
                if "401" not in _s or _i == len(_tries) - 1:
                    raise
                try:
                    from backend.log import log_operation
                    log_operation("PVE 控制台", "vncwebsocket 鉴权被拒, 自动换下一种",
                                  "host=%s user=%s 已试=%s → 改用=%s" %
                                  (creds.get("host"), creds.get("user"), _how, _tries[_i + 1][0]))
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    except Exception as e:
        # v5.98.16 · 失败必须**打得出来**: 这里原来用 log.info, 而默认级别会把它过滤掉,
        #   于是"控制台连接断开"在日志里一句话都没有(排查成本极高)。改为 print + flush。
        print("[vnc-bridge] ✗ PVE vncwebsocket 异常: %s: %s" % (type(e).__name__, e), flush=True)
        try:
            from backend.log import log_operation
            log_operation("PVE 控制台", "控制台桥接失败", "%s: %s" % (type(e).__name__, str(e)[:300]))
        except Exception:
            pass
        try:
            await ws.close(code=1011)
        except Exception:
            pass


async def _pump(ws, up) -> None:
    """双向透传, 任一方向结束即收尾。"""
    from fastapi import WebSocketDisconnect

    async def b2p():
        try:
            while True:
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    await up.send(msg["bytes"])
                elif msg.get("text") is not None:
                    await up.send(msg["text"])
        except WebSocketDisconnect:
            pass
        except Exception as e:
            log.debug("浏览器→PVE 转发结束: %s", e)

    async def p2b():
        try:
            async for m in up:
                if isinstance(m, (bytes, bytearray)):
                    await ws.send_bytes(bytes(m))
                else:
                    await ws.send_text(str(m))
        except Exception as e:
            log.debug("PVE→浏览器 转发结束: %s", e)

    t1 = asyncio.create_task(b2p())
    t2 = asyncio.create_task(p2b())
    done, pending = await asyncio.wait({t1, t2}, timeout=MAX_SESSION_SEC,
                                       return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    for t in done | pending:
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass


async def raw_bridge(ws, *, vhost: str, vport: int = 5900,
                     password: str = "", check_auth: bool = True) -> None:
    """通用 VNC 桥: 浏览器 WS ↔ 任意标准 RFB (VNC) 服务器 (裸 TCP)。

    与 pve_bridge 的区别: PVE 走它自带的 vncwebsocket (服务端拿 ticket 再连);
    这里直接对标准 VNC 端口 (5900) 做字节透传 — 不需要目标装任何东西,
    只要它开了 VNC 服务 (Linux x11vnc/tigervnc · macOS 屏幕共享 · Windows VNC server)。
    VNC 密码认证由 RFB 协议自身完成 (noVNC 会弹 credentialsrequired, 我们透传)。
    """
    from fastapi import WebSocketDisconnect
    if check_auth:
        try:
            from backend.ws import require_auth
            if not await require_auth(ws):
                await ws.close(code=4401)
                return
        except Exception:
            await ws.close(code=4401)
            return
    if not vhost:
        try:
            await ws.send_text(json.dumps({"rp_error": "缺少 VNC 主机"}))
        except Exception:
            pass
        await ws.close(code=4400)
        return

    import asyncio as _aio
    try:
        reader, writer = await _aio.wait_for(
            _aio.open_connection(vhost, int(vport)), timeout=12)
    except Exception as e:
        try:
            await ws.send_text(json.dumps(
                {"rp_error": f"无法连接 VNC 服务 {vhost}:{vport} — {type(e).__name__}: {e}"},
                ensure_ascii=False))
        except Exception:
            pass
        await ws.close(code=4510)
        return

    async def b2t():
        try:
            while True:
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                data = msg.get("bytes")
                if data is None and msg.get("text") is not None:
                    data = str(msg["text"]).encode("utf-8", "replace")
                if data:
                    writer.write(data)
                    await writer.drain()
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    async def t2b():
        try:
            while True:
                data = await reader.read(64 * 1024)
                if not data:
                    break
                await ws.send_bytes(data)
        except Exception:
            pass

    t1 = _aio.create_task(b2t())
    t2 = _aio.create_task(t2b())
    done, pending = await _aio.wait({t1, t2}, timeout=MAX_SESSION_SEC,
                                    return_when=_aio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    for t in done | pending:
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass
    try:
        writer.close()
        await writer.wait_closed()
    except Exception:
        pass


async def handle_ws_vnc_query(ws, query: dict) -> None:
    """从主 /ws 通道的 query 参数进入 VNC 桥 (vnc=1 触发)。

    query: vnc=1&mode=pve|raw&node=&vmid=&kind=&vhost=&vport=&auth_token=
    这是唯一从主通道进入 VNC 模式的入口 — /ws/vnc 独立端点保留但不再使用
    (它在某些环境下 403, 根因未明)。
    """
    mode = (query.get("mode") or "raw").strip().lower()
    if mode == "pve":
        node = (query.get("node") or "").strip()
        vmid = (query.get("vmid") or "").strip()
        kind = (query.get("kind") or "qemu").strip().lower()
        if kind not in ("qemu", "lxc"):
            kind = "qemu"
        if not node or not vmid:
            await ws.close(code=4400)
            return
        from backend.guacd_bridge import authenticate_ws
        if not await authenticate_ws(ws, query):
            await ws.close(code=4401)
            return
        await bridge(ws, node=node, vmid=vmid, kind=kind, check_auth=False, query=query)
    else:
        vhost = (query.get("vhost") or "").strip()
        vport = int(query.get("vport") or 5900)
        if not vhost:
            await ws.close(code=4400)
            return
        # v5.25.0 · SEC: 此前 check_auth=False = 任何人可达端口即可开 VNC 桥。
        #   改为用 query 的 auth_token 恢复会话 + 真实鉴权 (与 guacd 桥同口径)。
        from backend.guacd_bridge import authenticate_ws
        if not await authenticate_ws(ws, query):
            try:
                await ws.send_text(json.dumps({"rp_error": "会话已失效, 请刷新页面重新登录"},
                                              ensure_ascii=False))
            except Exception:
                pass
            await ws.close(code=4401)
            return
        await raw_bridge(ws, vhost=vhost, vport=vport, check_auth=False)

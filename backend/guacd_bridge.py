"""Fonriv - Apache Guacamole (guacd) WS 桥 · v5.25.0

为什么需要 guacd:
  VNC 直连只覆盖"目标已开标准 VNC"的场景。Windows / Linux Wayland (GNOME 46+)
  / macOS 的现代远程桌面都是 **RDP**，浏览器里没有原生 RDP 能力。
  guacd 是 Apache Guacamole 的 C 守护进程 (apt install guacd 或
  docker run guacamole/guacd), 把 RDP/VNC/SSH 转成 Guacamole 协议, 多年生产验证。
  我们只写"浏览器 WS ↔ guacd TCP"的桥, 不自己实现 RDP 协议栈。

协议 (已对 guacd 1.5.5 实测确认, 源码 src/guacd/connection.c + src/libguac/user-handshake.c):
  帧格式:  每条指令 = len.value,len.value,...;   (len 为值的字符数)
  握手:
    C→S  select,<协议>                      ← **只收 1 个参数** (src/guacd/connection.c:257 argc!=1 报错)
    S→C  args,VERSION_1_5_0,<参数名>...     ← 参数名列表 (RDP 有 81 个)
    C→S  size,<宽>,<高>,<DPI>               ┐
    C→S  audio,<mime> / video / image,<mime>... │ 这些是**握手期指令**,
    C→S  timezone,<tz> / name,<名>          ┘ 必须在 connect **之前**发
    C→S  connect,<协议版本>,<按参数名顺序的值...>
    S→C  ready,$<连接ID>
    ...  之后双向透传 (浏览器发 size/键鼠/mouse/键盘事件, guacd 回 img/blob/sync/cursor)

ℹ️ 上面"顺序"是实测踩出来的: 若把 size 发在 connect 之后, guacd 计算出的
   user->info.optimal_* 全为 0 → RDP 插件里 `width = 0 * dpi / optimal_dpi`
   直接得出 0 尺寸, 表现为"握手成功 (ready) 但永远没有画面", 且 guacd 不报错。
   实测对照: 错误顺序 49B (仅 ready) vs 正确顺序 296KB (46 blob/13 img, 真实桌面)。

浏览器侧用 guacamole-common-js (Apache-2.0, 见 frontend/static/vendor/guacamole/)。
注意它**不处理 args 指令** (官方 webapp 由 Java 服务端代填参数值), 所以参数值
必须由本桥代发 —— 这正是"自研桥"要干的活。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time as _time
import socket
from typing import Optional

log = logging.getLogger("guacd_bridge")

MAX_SESSION_SEC = 8 * 3600
DEFAULT_GUACD_HOST = "127.0.0.1"
DEFAULT_GUACD_PORT = 4822
_HS_TIMEOUT = 25          # 握手总超时 (RDP 协商 + TLS + NLA 可能十几秒)
_PROBE_SEC = 7.0          # v5.31.5 · RDP 安全模式探测窗口 (秒): 内部无画面即换下一种
_SUBPROTOCOL = "guacamole"   # guacamole-common-js: new WebSocket(url, "guacamole")

# ── v6.16.2 批23 · 一次性控制台工单 (凭据不再经 URL 传递) ─────────────────────
#   旧流程: 主界面把 user/password 拼进 /guac.html?...&user=..&password=.. →
#           浏览器地址栏/历史记录 + 服务端访问日志三处泄漏凭据 (用户实测报告)。
#   新流程: 主界面经已登录 WS 调 guac_ticket_create 把参数存到服务端 → 浏览器只拿
#           随机 ticket → guac.html WS 只带 ticket; 工单一次性/限时/限量重连。
import secrets as _secrets

TICKET_TTL_SEC = 300        # 工单有效期 (秒): 覆盖弹窗加载 + 网络抖动重连
TICKET_MAX_USES = 6         # 允许的 WS 重连次数 (guac 客户端断线自动重连用)
_TICKETS: dict = {}         # ticket -> {"params": dict, "exp": float, "uses": int}


def ticket_create(params: dict) -> str:
    tid = _secrets.token_hex(16)
    now = _time.time()
    for k in [k for k, v in _TICKETS.items() if v["exp"] < now]:
        _TICKETS.pop(k, None)
    _TICKETS[tid] = {"params": {k: str(v) for k, v in (params or {}).items() if v is not None},
                     "exp": now + TICKET_TTL_SEC, "uses": TICKET_MAX_USES}
    return tid


def ticket_take(tid: str):
    t = _TICKETS.pop(str(tid or ""), None)
    if not t:
        return None
    if t["exp"] < _time.time() or t["uses"] <= 0:
        return None
    t["uses"] -= 1
    if t["uses"] > 0:                       # 留给断线重连
        _TICKETS[str(tid)] = t
    return dict(t["params"])


async def handle_guac_ticket_create(ws, data: dict) -> None:
    """WS action: guac_ticket_create — 主界面用已登录会话换取一次性控制台工单。
    params: 与旧 URL 参数同构 ({proto,host,port,user,password,...}); 返回 {ticket,ttl}"""
    req = data.get("req_id") or ""
    p = data.get("params")
    if not isinstance(p, dict) or not str(p.get("host") or "").strip():
        await ws.send_json({"type": "result", "status": "error", "req_id": req,
                            "msg": "缺少目标主机, 无法创建控制台工单"})
        return
    tid = ticket_create(p)
    log.info("控制台工单已创建: %s %s:%s (ticket=%s…)",
             p.get("proto") or "rdp", p.get("host"), p.get("port"), tid[:8])
    await ws.send_json({"type": "result", "status": "ok", "req_id": req,
                        "ticket": tid, "ttl": TICKET_TTL_SEC, "uses": TICKET_MAX_USES})


# ── guacd 地址 (DB 设置 > 环境变量 > 默认) ──

# ── v5.26.0 · 多 guacd 后端 (可并存, 按目标自动选) ──
#   为什么要多个: guacamole 的 RDP 能力绑死 FreeRDP 代数 ——
#     1.5.x 配 FreeRDP 2 (官方 docker 镜像同款, 兼容性最好)
#     1.6.x 配 FreeRDP 3 (新系统只有 FreeRDP 3, 但实测 FreeRDP 3.31 上"握手/帧缓冲正常却
#     不发图像帧" → 目标无关, Windows 与 Linux xrdp 都一样)
#   所以两个版本都留着, 由产品**按连接协议/目标自动挑**, 也允许用户显式指定。
#   flavor: freerdp2 (1.5.x) | freerdp3 (1.6.x) | any

_BACKENDS_KEY = "guacd_backends"       # JSON: [{id,name,host,port,flavor,note}]
_DEFAULT_KEY = "guacd_default"         # backend id 或 "auto"


def list_backends() -> list:
    """已配置的 guacd 后端列表 (若从未配置过, 用历史单机设置合成一条)。"""
    out = []
    try:
        from backend import db
        raw = db.setting_get(_BACKENDS_KEY, "") or ""
        if raw:
            import json as _json
            out = _json.loads(raw) or []
    except Exception:
        out = []
    if not out:
        # v5.38.0 · P0 加固 (官方根因确认): 注册表为空时不再盲取 legacy 地址 —
        #   官方 Dockerfile 构建 FreeRDP 3 时缺 -DCMAKE_BUILD_TYPE=Release → WINPR_ASSERT 开启,
        #   边缘情况 abort() → guacd 子进程静默崩溃 (无日志/无 SYN, 表现为纯黑屏;
        #   本机 strace 实测 SIGSEGV 一致)。修复 PR #660 已并入 staging/1.6.1。
        #   在此之前: 默认优先 4823 (docker guacd 1.5.5 / FreeRDP 2, 稳定), 4822 (源码 1.6.0) 仅回退。
        _first = None
        for _h, _p, _fl, _nm in (("127.0.0.1", 4823, "freerdp2", "Docker guacd 1.5.5 (FreeRDP 2, 推荐)"),
                                 (DEFAULT_GUACD_HOST, DEFAULT_GUACD_PORT, "any", "默认 guacd")):
            if _reachable(_h, _p):
                _first = {"id": "default", "name": _nm, "host": _h, "port": _p,
                          "flavor": _fl, "note": "注册表空 · 默认探测 (4823→4822, FreeRDP 3 崩溃规避)"}
                break
        if _first:
            out = [_first]
        else:
            h, p = _legacy_addr()
            out = [{"id": "default", "name": f"本机 guacd {h}:{p}",
                    "host": h, "port": p, "flavor": "any", "note": "由旧版 guacd_host/port 设置合成"}]
    for b in out:
        try:
            b["port"] = int(b.get("port") or DEFAULT_GUACD_PORT)
        except (TypeError, ValueError):
            b["port"] = DEFAULT_GUACD_PORT
        b.setdefault("flavor", "any")
        b.setdefault("id", "default")
    return out


def save_backends(items: list) -> dict:
    import json as _json
    from backend import db
    clean = []
    for it in (items or []):
        if not (it.get("host") or "").strip():
            continue
        clean.append({"id": (it.get("id") or "").strip() or f"gw{len(clean)+1}",
                      "name": (it.get("name") or it.get("host") or "").strip(),
                      "host": it["host"].strip(),
                      "port": int(it.get("port") or DEFAULT_GUACD_PORT),
                      "flavor": (it.get("flavor") or "any").strip(),
                      "note": (it.get("note") or "").strip()})
    db.setting_set(_BACKENDS_KEY, _json.dumps(clean, ensure_ascii=False))
    # 兼容旧字段: 首个后端同时写回 guacd_host/port
    if clean:
        db.setting_set("guacd_host", clean[0]["host"])
        db.setting_set("guacd_port", str(clean[0]["port"]))
    return {"backends": clean, "count": len(clean)}


def set_default(gw: str) -> dict:
    from backend import db
    db.setting_set(_DEFAULT_KEY, (gw or "auto").strip())
    return {"default": (gw or "auto").strip()}


def _legacy_addr() -> tuple:
    host, port = DEFAULT_GUACD_HOST, DEFAULT_GUACD_PORT
    try:
        from backend import db
        host = (db.setting_get("guacd_host", "") or "").strip() or host
        port = int(db.setting_get("guacd_port", "") or port)
    except Exception:
        pass
    host = os.environ.get("RP_GUACD_HOST", host)
    try:
        port = int(os.environ.get("RP_GUACD_PORT", port))
    except (TypeError, ValueError):
        pass
    return host, port


def pick_backend(proto: str = "rdp", gw: str = "", width_hint: str = "", flavor: str = "") -> dict:
    """按协议/指定网关选后端。

    规则 (实测驱动):
      · 指定 gw → 用它 (但要求可达)
      · guacd_default 指定了具体 id → 用它
      · RDP → 优先 flavor=freerdp2 (兼容性最好); 没有就退任何可达的
      · VNC/SSH/telnet → 优先 flavor=freerdp3 (新版本对 VNC/SSH 无差异), 再退
      · 全不可达 → 返回第一个 (让上层报"不可达"错误)
    """
    bks = list_backends()
    if not bks:
        # v5.37.1 · FIX 加固: 注册表为空 (清库/首装) 时不再盲取 legacy 地址 —
        #   实测源码编译的 guacd 1.6.0 + FreeRDP 3.31 在 RDP 连接时 SIGSEGV 崩溃 (静默黑屏,
        #   无 SYN 无日志); docker guacd 1.5.5 (FreeRDP 2) 正常。故默认探测:
        #   4823 (docker 1.5.5, 历史约定端口) → 4822 (本机/legacy) 顺序取第一个可达。
        _cands = [("127.0.0.1", 4823, "freerdp2", "docker guacd 1.5.5 (FreeRDP 2)"),
                  (DEFAULT_GUACD_HOST, DEFAULT_GUACD_PORT, "any", "默认 guacd")]
        for _h, _p, _fl, _nm in _cands:
            if _reachable(_h, _p):
                return {"id": "default", "name": _nm, "host": _h, "port": _p,
                        "flavor": _fl, "auto": True, "chosen": "无注册表 · 默认探测 4823→4822"}
        h, p = _legacy_addr()
        return {"id": "default", "name": "默认", "host": h, "port": p, "flavor": "any", "auto": True}
    if gw:
        for b in bks:
            if b["id"] == gw or b["name"] == gw:
                return dict(b, auto=False, forced=True)
    try:
        from backend import db
        dflt = (db.setting_get(_DEFAULT_KEY, "auto") or "auto").strip()
    except Exception:
        dflt = "auto"
    if dflt and dflt != "auto":
        for b in bks:
            if b["id"] == dflt or b["name"] == dflt:
                return dict(b, auto=True, chosen="default-setting")
    # v5.31.3 · FIX 默认后端代次: 实测 (2026-09-17, 本机 guacd 双后端对照)
    #   · 目标 192.168.1.92 (Linux/xrdp, 强制 NLA): freerdp2 → 5KB/4 图像/有 size ✅
    #     freerdp3 → 0KB/无图像/无 size ✗ (会话建立后静默无画面)
    #   · 目标 192.168.1.192 (Win10, 强制 NLA): 两者都无画面, 但原因是该账号**无密码** ——
    #     Windows 策略禁止空密码账户远程登录, NLA 直接失败 (与后端代次无关)
    #   结论: RDP 一律优先 FreeRDP 2 (guacd 1.5.5/docker), freerdp3 仅作回退。
    #   原实现 RDP 优先 freerdp3, 正是"远程桌面连上却黑屏"的直接原因。
    if flavor:
        pref = (flavor,)
    else:
        pref = ("freerdp2", "freerdp3")
    for fl in pref:
        _cands = [b for b in bks
                  if (b.get("flavor") or "any") == fl and _reachable(b["host"], b["port"])]
        if _cands:
            # v5.38.2 · P2: 同代次内选活跃连接最少者 (负载均衡)
            _best = min(_cands, key=_backend_load)
            _ld = _backend_load(_best)
            return dict(_best, auto=True,
                        chosen=f"proto={proto} 优先 {fl}" + (f" · 负载 {_ld}" if len(_cands) > 1 else ""))
    for b in bks:                      # 任意 flavor 但可达
        if _reachable(b["host"], b["port"]):
            return dict(b, auto=True, chosen="任一可达后端")
    return dict(bks[0], auto=True, chosen="均不可达(取首个以便报错)")


def _reachable(host: str, port: int, timeout: float = 1.2) -> bool:
    import socket as _s
    try:
        with _s.create_connection((host, int(port)), timeout=timeout):
            return True
    except Exception:
        return False


def guacd_addr() -> tuple:
    h, p = _legacy_addr()
    return h, p


def probe(host: str = "", port: int = 0, timeout: float = 4.0) -> dict:
    """TCP 可达性 + 协议握手探测 (发 select,rdp 看是否回 args)。

    返回 {ok, msg, host, port, params(参数个数), version}
    """
    h, p = (host or guacd_addr()[0]), int(port or guacd_addr()[1])
    try:
        s = socket.create_connection((h, p), timeout=timeout)
    except Exception as e:
        return {"ok": False, "host": h, "port": p,
                "msg": f"guacd 不可达 {h}:{p} — {type(e).__name__}: {e}"}
    try:
        s.settimeout(timeout)
        s.sendall(_instr("select", "rdp"))
        buf = b""
        try:
            buf = s.recv(65536)
        except socket.timeout:
            pass
        text = buf.decode("utf-8", "replace")
        if not text.startswith("4.args,"):
            return {"ok": False, "host": h, "port": p,
                    "msg": f"{h}:{p} 有响应但不是 guacd (收到 {text[:40]!r})"}
        ins = parse_instructions(text)
        names = ins[0][1][1:] if ins and ins[0][0] == "args" else []
        ver = ins[0][1][0] if ins and ins[0][0] == "args" else ""
        return {"ok": True, "host": h, "port": p, "params": len(names), "version": ver,
                "msg": f"✓ guacd 就绪 {h}:{p} · 协议 {ver} · RDP 参数 {len(names)} 项"}
    finally:
        try:
            s.close()
        except Exception:
            pass


# ── Guacamole 协议编解码 ──

def _instr(*els) -> bytes:
    """拼一条 Guacamole 指令: len.value,len.value,...;"""
    return (",".join(f"{len(str(e))}.{e}" for e in els) + ";").encode("utf-8")


def parse_instructions(text: str) -> list:
    """把已收到的文本解析成 [(opcode, [args...]), ...] (容忍半条指令, 半条丢弃)。"""
    out, els, i, n = [], [], 0, len(text)
    while i < n:
        j = text.find(".", i)
        if j < 0 or not text[i:j].isdigit():
            break
        ln = int(text[i:j])
        val = text[j + 1:j + 1 + ln]
        if len(val) < ln:      # 半条指令 (长度未到)
            break
        els.append(val)
        i = j + 1 + ln
        if i < n and text[i] == ",":
            i += 1
            continue
        if i < n and text[i] == ";":
            if els:
                out.append((els[0], els[1:]))
            els = []
            i += 1
            continue
        break
    return out


# ── v5.30.0 · 增量指令解析器 (参考 guapy 2.0 InstructionParser, Apache-2.0) ──
#   为什么要换掉上面的正则式解析:
#     ① decode("utf-8","replace") 在 TCP 分片切进多字节字符中段时产生损坏字符
#        (剪贴板中文文本指令是重灾区 — 表现为粘贴中文偶发乱码);
#     ② 旧解析对长度前缀无上限、无元素数上限, 损坏流可撑爆内存;
#     ③ read_instructions 用 _instr() 重序列化算消费量, buf 残留时错位。
_MAX_INSTR_LEN = 16 * 1024 * 1024   # blob 大图/剪贴板大文本 (base64 后 ~1.3x)
_MAX_ELEMENTS = 512
_MAX_LEN_DIGITS = 8


class GuacParser:
    """流式增量解析器: 任意分片的字节流 → 完整指令列表, UTF-8 跨界安全。"""

    def __init__(self):
        import codecs
        self._dec = codecs.getincrementaldecoder("utf-8")("replace")
        self._buf = ""

    def feed(self, data: bytes) -> list:
        """喂一批字节, 返回其中所有完整指令 [(opcode, [args...]), ...]。"""
        self._buf += self._dec.decode(data, final=False)
        out = []
        while True:
            parsed = self._parse_one()
            if parsed is None:
                break
            ins, consumed = parsed
            out.append(ins)
            self._buf = self._buf[consumed:]
        if len(self._buf) > _MAX_INSTR_LEN:
            # 残留超限 (半条指令过大) → 丢弃缓冲防内存膨胀
            self._buf = ""
        return out

    def _parse_one(self):
        buf = self._buf
        pos, els = 0, []
        while True:
            dot = buf.find(".", pos)
            if dot < 0:
                return None
            prefix = buf[pos:dot]
            if not prefix.isdigit() or len(prefix) > _MAX_LEN_DIGITS:
                # 长度前缀非法 → 损坏流: 丢弃整个缓冲自愈 (返回空消费)
                if not buf:
                    return None
                self._buf = ""
                return None
            ln = int(prefix)
            end = dot + 1 + ln
            if end >= len(buf):
                return None
            els.append(buf[dot + 1:end])
            if len(els) > _MAX_ELEMENTS:
                self._buf = ""
                return None
            term = buf[end]
            if term == ";":
                return (els[0], els[1:]), end + 1
            if term != ",":
                # 非法分隔符 → 丢弃已累计的这条, 跳过
                pos = end + 1
                els = []
                if pos > len(buf):
                    return None
                continue
            pos = end + 1


# ── v5.30.0 · guacd error 状态码 → 用户可读文案 (参考 guapy status.py 全表) ──
_STATUS_ZH = {
    0x0000: "成功",
    0x0100: "不支持的操作",
    0x0200: "服务端内部错误",
    0x0201: "服务端繁忙",
    0x0202: "上游连接超时 (远端无响应)",
    0x0203: "上游返回错误",
    0x0204: "资源未找到",
    0x0205: "资源冲突 (会话已存在?)",
    0x0206: "连接已被关闭",
    0x0207: "上游未找到 (目标主机不可达/端口错误)",
    0x0208: "上游不可用 (远端拒绝连接 — 检查远程桌面是否开启)",
    0x0209: "会话冲突 (该目标已有活动会话)",
    0x020A: "会话超时",
    0x020B: "会话已关闭",
    0x0300: "客户端请求无效",
    0x0301: "认证失败 (用户名或密码错误)",
    0x0303: "没有权限 (账户被禁止远程访问?)",
    0x0308: "客户端超时",
    0x030D: "缓冲区溢出 (画面数据过大)",
    0x030F: "不支持的类型",
    0x031D: "并发会话数已达上限",
}


def status_zh(args: list) -> str:
    """error 指令 args=[msg, code?] → '中文状态 (code): 原始信息'。"""
    msg = args[0] if args else "未知错误"
    code = None
    if len(args) > 1:
        try:
            code = int(args[1])
        except (TypeError, ValueError):
            code = None
    if code is None:
        return msg
    zh = _STATUS_ZH.get(code, "")
    base = f"{zh} (0x{code:04X})" if zh else f"错误码 0x{code:04X}"
    return f"{base}: {msg}" if msg else base


# ── 参数映射: 我们的 UI 字段 → guacd 参数名 ──

def _common(q: dict) -> dict:
    """两端通用参数 (尺寸/DPI/时区等)。"""
    try:
        w = max(320, min(7680, int(q.get("width") or 1280)))
        h = max(240, min(4320, int(q.get("height") or 800)))
    except (TypeError, ValueError):
        w, h = 1280, 800
    return {"width": w, "height": h, "dpi": 96,
            "resize-method": q.get("resize") or "display-update",
            "timezone": q.get("timezone") or "Asia/Shanghai"}


def _truthy(v, default: bool = False) -> bool:
    """query 里布尔值统一解析 (前端传 '1'/'0'/'true'/'false'/空)。"""
    if v is None or v == "":
        return default
    return str(v).lower() not in ("0", "false", "off", "no")


def _quality_apply(q: dict, p: dict):
    """v5.31.0 · 画质预设 → 具体参数 (best/balanced/fast)。

    参考 remmina/官方 webapp 的常见组合; 显式传参优先于预设。
    """
    qual = (q.get("quality") or "").strip().lower()
    preset = {
        "best":     {"color-depth": "24", "enable-wallpaper": "true",  "enable-font-smoothing": "true",
                     "enable-theming": "true",  "disable-bitmap-caching": "false"},
        "balanced": {"color-depth": "16", "enable-wallpaper": "false", "enable-font-smoothing": "true",
                     "enable-theming": "false", "disable-bitmap-caching": "false"},
        "fast":     {"color-depth": "8",  "enable-wallpaper": "false", "enable-font-smoothing": "false",
                     "enable-theming": "false", "disable-bitmap-caching": "true"},
    }.get(qual)
    if preset:
        p.update(preset)


def rdp_params(q: dict) -> dict:
    p = _common(q)
    p.update({
        "hostname": (q.get("host") or "").strip(),
        "port": str(q.get("port") or 3389),
        "username": q.get("user") or "",
        "password": q.get("password") or "",
        "domain": q.get("domain") or "",
        "security": (q.get("security") or "any").lower(),
        "ignore-cert": "true" if str(q.get("ignore_cert", "1")) not in ("0", "false") else "false",
        # v5.28.0 · 音频输出模式: local=浏览器播放(重定向) · remote=远端自己出声 · off=静音
        "disable-audio": "true" if (q.get("audio") or "local") in ("remote", "off") else "false",
        "enable-wallpaper": "true" if _truthy(q.get("wallpaper")) else "false",
        "enable-font-smoothing": "true" if _truthy(q.get("font_smooth"), True) else "false",
        "enable-theming": "true" if _truthy(q.get("theming")) else "false",
        "enable-desktop-composition": "true" if _truthy(q.get("composition")) else "false",
        "color-depth": str(q.get("color_depth") or 24),
        "disable-copy": "true" if _truthy(q.get("disable_copy")) else "false",
        "disable-paste": "true" if _truthy(q.get("disable_paste")) else "false",
        "disable-bitmap-caching": "true" if (q.get("bitmap_cache") is not None
                                            and not _truthy(q.get("bitmap_cache"), True)) else "false",
        "enable-drive": "true" if _truthy(q.get("drive")) else "false",
    })
    # v5.31.0 · 画质预设 (显式参数在下面覆盖预设)
    _quality_apply(q, p)
    for k_src, k_dst in (("color_depth", "color-depth"), ("wallpaper", "enable-wallpaper"),
                         ("font_smooth", "enable-font-smoothing"), ("theming", "enable-theming")):
        v = q.get(k_src)
        if v is not None and v != "":
            if k_dst == "color-depth":
                p[k_dst] = str(v)
            else:
                p[k_dst] = "true" if _truthy(v) else "false"
    if q.get("drive"):
        p["drive-name"] = q.get("drive_name") or "Fonriv-Share"
        p["drive-path"] = q.get("drive_path") or "/tmp/fonriv_guac_drive"
    if q.get("console"):
        p["console"] = "true"
    # v5.38.1 · P1.3 多显示器 (需 guacd 1.6.x+; 1.5.5 会忽略该参数, 无害)
    if _truthy(q.get("multi_monitor")):
        p["multi-monitor"] = "true"
        p["width"] = "0"
        p["height"] = "0"
    # ── v5.38.0 · P1.1 SFTP 文件传输通道 (guacd 已支持, 接通即用) ──
    #   凭据回退链: sftp_user/sftp_pass (显式) → SSH 档案凭据 (sftp_ssh_user/sftp_ssh_pass)
    #   → RDP 凭据。目标默认同 RDP, 可被 sftp_host 覆盖 (RDP 网关场景: SFTP 直连真实主机)。
    #   sftp=0 显式关闭。Windows 目标无 SSH 时 guacd 会优雅降级 (文件系统不出现, 桌面不受影响)。
    if str(q.get("sftp", "1")) not in ("0", "false", "off"):
        p["enable-sftp"] = "true"
        p["sftp-hostname"] = (q.get("sftp_host") or q.get("host") or "").strip()
        p["sftp-port"] = str(q.get("sftp_port") or q.get("ssh_port") or 22)
        p["sftp-username"] = (q.get("sftp_user") or q.get("sftp_ssh_user")
                              or q.get("user") or "").strip()
        p["sftp-password"] = (q.get("sftp_pass") or q.get("sftp_ssh_pass")
                              or q.get("password") or "")
        _sk = q.get("sftp_key") or q.get("sftp_ssh_key") or ""
        if _sk:
            p["sftp-private-key"] = _sk
            p["sftp-passphrase"] = q.get("sftp_passphrase") or q.get("sftp_ssh_passphrase") or ""
            p["sftp-password"] = ""      # 密钥模式清空密码
        p["sftp-directory"] = q.get("sftp_dir") or "/"
        p["sftp-root-directory"] = "/"
        p["sftp-server-alive-interval"] = "60"
    return p


def vnc_params(q: dict) -> dict:
    p = _common(q)
    p.update({
        "hostname": (q.get("host") or "").strip(),
        "port": str(q.get("port") or 5900),
        "password": q.get("password") or "",
        "color-depth": str(q.get("color_depth") or 24),
        "read-only": "true" if q.get("read_only") else "false",
        "authtype": q.get("authtype") or "vnc",
        "swap-red-blue": "true" if _truthy(q.get("swap_red_blue")) else "false",
        "cursor": "local" if _truthy(q.get("local_cursor"), True) else "remote",
        "disable-copy": "true" if _truthy(q.get("disable_copy")) else "false",
        "disable-paste": "true" if _truthy(q.get("disable_paste")) else "false",
    })
    return p


def ssh_params(q: dict) -> dict:
    p = _common(q)
    p.update({
        "hostname": (q.get("host") or "").strip(),
        "port": str(q.get("port") or 22),
        "username": q.get("user") or "",
        "password": q.get("password") or "",
        "font-size": str(q.get("font_size") or 12),
        "color-scheme": q.get("color_scheme") or "gray-black",
        "backspace": "8",
        "terminal-type": "xterm-256color",
    })
    return p


_PARAM_BUILDERS = {"rdp": rdp_params, "vnc": vnc_params, "ssh": ssh_params}


def build_params(proto: str, q: dict) -> dict:
    fn = _PARAM_BUILDERS.get(proto)
    return fn(q) if fn else _common(q)


# v5.38.2 · P2 多后端负载感知: 各 guacd 后端的活跃连接计数 (进程内)
_ACTIVE_BY_BACKEND = {}


def _backend_key(b: dict) -> str:
    return f"{b.get('host')}:{b.get('port')}"


def _backend_load(b: dict) -> int:
    return _ACTIVE_BY_BACKEND.get(_backend_key(b), 0)


# v5.38.2 · P2 录制目录 (宿主侧; 容器内挂载点 /recordings)
RECORDINGS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              "data", "vnc_sessions")


def _rec_base_of(n: str) -> str:
    """流分片 → 主名。仅当剥离 .N 后的主文件真实存在才剥离
    (v5.38.2 FIX: 主机名如 192.168.1.92 的 .92 不能被误剥)。"""
    m = re.match(r"^(.*)\.\d+$", n)
    if m and os.path.isfile(os.path.join(RECORDINGS_DIR, m.group(1))):
        return m.group(1)
    return n


def _rec_group_files(name: str) -> list:
    """同组录制文件: guacd 给每条流生成 <name>、<name>.1、<name>.2 … 转码需全带上。"""
    base = _rec_base_of(name)
    grp = []
    for cand in os.listdir(RECORDINGS_DIR):
        if cand == base or (re.match(r"^" + re.escape(base) + r"\.\d+$", cand)
                            and _rec_base_of(cand) == base):
            if os.path.isfile(os.path.join(RECORDINGS_DIR, cand)):
                grp.append(cand)
    return sorted(grp)


def recording_list() -> list:
    """列出会话录制 (多流文件归并为一条)。kind=guac 原始 / webm 已转码。"""
    out = []
    try:
        names = os.listdir(RECORDINGS_DIR)
        # 主名集合: 去掉 .N 后缀 + 去掉 .webm 后归组
        mains = set()
        for n in names:
            if n.endswith(".webm") or n.endswith(".m4v"):
                mains.add(re.sub(r"\.(webm|m4v)$", "", n))
            else:
                mains.add(_rec_base_of(n))
        for base in sorted(mains):
            grp = _rec_group_files(base)
            if not grp:
                continue
            total = sum(os.path.getsize(os.path.join(RECORDINGS_DIR, g)) for g in grp)
            mt = max(os.path.getmtime(os.path.join(RECORDINGS_DIR, g)) for g in grp)
            vid_p = os.path.join(RECORDINGS_DIR, base + ".m4v")
            out.append({"name": base, "size": total, "streams": len(grp),
                        "mtime": _time.strftime("%Y-%m-%d %H:%M:%S", _time.localtime(mt)),
                        "kind": "guac",
                        "converted": os.path.isfile(vid_p),
                        "video_size": (os.path.getsize(vid_p) if os.path.isfile(vid_p) else 0)})
    except Exception as e:
        print(f"[recording] list fail: {e}")
    return sorted(out, key=lambda x: x["mtime"], reverse=True)


def recording_convert(name: str) -> dict:
    """guacenc 转码 → <base>.m4v (H.264/MP4, 浏览器可直接播放)。

    v5.38.2 实测要点: guacenc 不接受输出文件名参数 —— 产物固定为
    "<第一个输入的基名>.m4v"; 多条流各自有画面时还会输出 "<输入名>.m4v"。
    """
    import subprocess as _sp
    base = _rec_base_of(os.path.basename(name))
    src_p = os.path.join(RECORDINGS_DIR, base)
    if not os.path.isfile(src_p):
        return {"ok": False, "msg": "录制文件不存在"}
    grp = [os.path.join(RECORDINGS_DIR, g) for g in _rec_group_files(base)]
    out_p = os.path.join(RECORDINGS_DIR, base + ".m4v")
    try:
        r = _sp.run(["guacenc", "-f", "-r", "25"] + grp,
                    capture_output=True, text=True, timeout=1800)
        # guacenc 有时 rc!=0 但仍产出有效文件 (如个别流无画面); 以产物为准
        if not os.path.isfile(out_p):
            tail = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
            return {"ok": False, "msg": "guacenc 失败: " + " | ".join(tail)[:200]}
        sz = os.path.getsize(out_p)
        if sz < 200:
            return {"ok": False, "msg": f"产物过小 ({sz}B), 录制可能无画面"}
        return {"ok": True, "msg": f"✓ 已转码 {os.path.basename(out_p)} ({sz // 1024} KB)",
                "webm": os.path.basename(out_p), "m4v": os.path.basename(out_p)}
    except _sp.TimeoutExpired:
        return {"ok": False, "msg": "转码超时 (30 分钟)"}
    except FileNotFoundError:
        return {"ok": False, "msg": "本机未安装 guacenc (bash scripts/build_guacd.sh 可编译; "
                                    "远程机器缺 ffmpeg 依赖时可在本机下载 .guac 后转码)"}
    except Exception as e:
        return {"ok": False, "msg": f"转码异常: {e}"}


def recording_delete(name: str) -> dict:
    """删除录制文件 (含同名 .webm)。"""
    base = os.path.basename(name)
    n = 0
    for cand in _rec_group_files(base) + [base + ".webm", base + ".m4v"]:
        p = os.path.join(RECORDINGS_DIR, cand)
        if os.path.isfile(p):
            try:
                os.remove(p)
                n += 1
            except Exception:
                pass
    return {"ok": n > 0, "msg": f"✓ 已删除 {n} 个文件" if n else "文件不存在"}


def _recording_params(q: dict) -> dict:
    """会话录制: guacd 服务端录制 (.guac, guacenc 可转视频)。

    与浏览器 MediaRecorder 录制互补 —— 服务端录制不经浏览器, 更像"取证记录"。
    """
    if str(q.get("recording") or "") not in ("1", "true", "True"):
        return {}
    try:
        from backend import license as lic
        if not lic.feature_enabled("vnc_record"):
            return {}
    except Exception:
        return {}
    # v5.38.2 · P2 录制落地: guacd 跑在 docker 容器内 → 录制路径必须是**容器内路径**
    #   (/recordings = 宿主 data/vnc_sessions 的挂载点), 否则 .guac 落在容器层丢失。
    #   宿主侧目录由 RECORDINGS_DIR 常量统一 (列表/转换/回放都从这里读)。
    os.makedirs(RECORDINGS_DIR, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9.-]", "_", (q.get("host") or "remote"))[:40]
    import time as _t
    name = f"rec_{_t.strftime('%Y%m%d_%H%M%S')}_{safe}"
    # v5.38.2 FIX: exclude-output 必须为 false —— 曾误设 true 导致"排除画面输出",
    #   录出的 .guac 全为 0 字节 (实测踩坑)。include-keys=false 保留 (不录键盘输入)。
    return {"recording-path": "/recordings", "recording-name": name,
            "create-recording-path": "true", "recording-exclude-output": "false",
            "recording-include-keys": "false"}


# ── 桥本体 ──

class _Upstream:
    """guacd 侧 TCP 连接的读写封装 (握手阶段按指令读, 之后透传)。"""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.r = reader
        self.w = writer
        self.parser = GuacParser()   # v5.30.0 · 增量解析 (UTF-8 跨界安全 + 上限保护)

    async def read_instructions(self, timeout: float) -> list:
        """读一批指令 (累计缓冲里解析出完整的; 半条留在内部缓冲)。"""
        while True:
            ins = self.parser.feed(b"")   # 先试已有缓冲 (含上次残尾)
            if ins:
                return ins
            data = await asyncio.wait_for(self.r.read(262144), timeout)
            if not data:
                return []
            ins = self.parser.feed(data)
            if ins:
                return ins


_TOKEN_RE = re.compile(r"[A-Za-z0-9._-]{8,}")


def extract_token(raw) -> str:
    """从 query 里稳健地取出 token。

    坑: guacamole-common-js 的 WebSocketTunnel 用 `tunnelURL + "?" + data` 连接,
    于是我们 URL 里本来就带的 auth_token 后面会被追加一个 `?` —— 查表时变成
    "150e41d2-…?" 这种带尾问号的值, 会话恢复必然失败 (表现为 4401/请先登录)。
    同类问题 noVNC 页也可能遇到, 故统一在提取时按字符集裁一次。
    """
    t = str(raw or "").strip().strip('"').strip("'")
    m = _TOKEN_RE.search(t)
    return m.group(0) if m else ""


async def authenticate_ws(ws, query: dict) -> bool:
    """给"主通道特殊模式"(vnc/guacd 桥) 用的鉴权: 先用 query 里的 auth_token 恢复会话。

    为什么单独做: 主通道的 token 自动恢复逻辑在每个 action 分发时执行, 而桥模式
    在分发之前就 return 了 —— 不补这一步, 桥要么 4401 拒掉, 要么(更糟)只能裸奔。
    """
    from backend.auth import active_sessions, require_auth, restore_session_by_token
    try:
        if ws not in active_sessions:
            tok = extract_token(query.get("auth_token"))
            if tok:
                restore_session_by_token(ws, tok)
    except Exception:
        pass
    try:
        return bool(await require_auth(ws))
    except Exception:
        return False


async def _start_jump_tunnel(jump_guid: str, target_host: str, target_port: int,
                             sftp_port: int = 0):
    """v5.38.1 · P1.2 跳板机 SSH 隧道 (本地端口转发)。

    流程: ssh -N -L <gw>:lp:target:port -L <gw>:lp2:target:22 user@jump
      · 绑定 docker 网关 172.17.0.1 —— guacd 跑在容器内, 宿主 127.0.0.1 对容器不可见
      · 返回 (proc, "", lp_rdp, lp_sftp) 或 (None, err, None, None)
      · 跳板机凭据服务端从档案解密 (页面不经手)
    """
    import os as _os
    import socket as _sock
    try:
        from backend.db import get_conn
        from backend.db.crypto import decrypt_value as _dv
        from backend.db import _get_fernet as _gf
        row = get_conn().execute(
            "SELECT hostname,ssh_port,ssh_user,ssh_auth_type,ssh_auth_value,ssh_passphrase "
            "FROM server_profiles WHERE guid=?", (jump_guid,)).fetchone()
        if not row:
            return None, "跳板机档案不存在", None, None
        d = dict(row)
        jhost = (d["hostname"] or "").strip()
        if not jhost:
            return None, "跳板机档案缺少主机地址", None, None
        jport = int(d["ssh_port"] or 22)
        juser = d["ssh_user"] or "root"
        av = d["ssh_auth_value"] or ""
        if str(av).startswith("ENC$"):
            av = _dv(_gf(), av)
        pp = d["ssh_passphrase"] or ""
        if str(pp).startswith("ENC$"):
            pp = _dv(_gf(), pp)

        # 绑定地址: docker0 网关 (容器内 guacd 可达); 无 docker 时回退 127.0.0.1
        gw = "172.17.0.1"
        try:
            _s = _sock.socket(); _s.bind((gw, 0)); _s.close()
        except Exception:
            gw = "127.0.0.1"

        def _free():
            s = _sock.socket(); s.bind((gw, 0)); p = s.getsockname()[1]; s.close(); return p
        lp_rdp = _free()
        lp_sftp = _free() if sftp_port else None

        fwd = [f"{gw}:{lp_rdp}:{target_host}:{int(target_port)}"]
        if lp_sftp:
            fwd.append(f"{gw}:{lp_sftp}:{target_host}:{int(sftp_port)}")
        cmd = ["ssh", "-N", "-o", "StrictHostKeyChecking=accept-new",
               "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
               "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=10",
               "-p", str(jport)]
        for f in fwd:
            cmd += ["-L", f]
        env = dict(_os.environ)
        if (d["ssh_auth_type"] or "pass") == "key":
            cmd += ["-i", av or "~/.ssh/id_rsa"]
            if pp:
                cmd = ["sshpass", "-e"] + cmd
                env["SSHPASS"] = pp
        else:
            cmd = ["sshpass", "-e"] + cmd
            env["SSHPASS"] = av or ""
        cmd.append(f"{juser}@{jhost}")

        proc = await asyncio.create_subprocess_exec(
            *cmd, env=env,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        # 等隧道就绪 (端口可连)
        for _ in range(28):
            await asyncio.sleep(0.25)
            if proc.returncode is not None:
                try:
                    err = (await proc.stderr.read()).decode(errors="replace")[:220]
                except Exception:
                    err = ""
                return None, f"隧道进程退出: {err}", None, None
            try:
                _r, _w = await asyncio.wait_for(asyncio.open_connection(gw, lp_rdp), 1)
                _w.close()
                log.info("跳板机隧道就绪: %s@%s:%s → %s:%s (本地 %s:%s%s)",
                         juser, jhost, jport, target_host, target_port, gw, lp_rdp,
                         (" + sftp %s" % lp_sftp) if lp_sftp else "")
                return proc, "", lp_rdp, lp_sftp
            except Exception:
                continue
        try:
            proc.kill()
        except Exception:
            pass
        return None, "隧道建立超时 (12 秒)", None, None
    except Exception as e:
        return None, f"隧道异常: {e}", None, None


async def handle_ws_guacd(ws, query: dict) -> None:
    """主通道入口: /ws?guacd=1&proto=rdp&host=..&port=..&user=..&password=..

    必须在 handler 内 accept(subprotocol='guacamole') —— guacamole-common-js 用
    `new WebSocket(url, "guacamole")` 连接, 服务端不回声子协议时浏览器会直接断开。
    """
    from fastapi import WebSocketDisconnect

    proto = (query.get("proto") or "rdp").strip().lower()
    if proto not in _PARAM_BUILDERS:
        proto = "rdp"
    _tunnel_proc = None

    # v6.16.2 批23 · 工单置换: URL 只带 ticket, 真实参数(含凭据)取自服务端工单
    _tid = (query.get("ticket") or "").strip()
    if _tid:
        _tp = ticket_take(_tid)
        if not _tp:
            await ws.accept(subprotocol=_SUBPROTOCOL)
            try:
                await ws.send_text(_instr("error", "770", "控制台工单无效或已过期, 请回主界面重新发起连接").decode())
            except Exception:
                pass
            await ws.close(code=4400)
            return
        _SENS = ("user", "password", "domain", "sftp_pass", "sftp_ssh_pass", "auth_token")
        query = {k: v for k, v in query.items() if k not in _SENS}
        query.update(_tp)                    # 工单参数(含凭据/auth_token)最优先
    elif (query.get("user") or query.get("password")):
        # 批23 前的旧入口已停用: 凭据不再接受经 URL 传递 (防浏览器历史/访问日志泄漏)
        await ws.accept(subprotocol=_SUBPROTOCOL)
        try:
            await ws.send_text(_instr("error", "771", "控制台入口已升级: 请刷新主界面后重新发起连接").decode())
        except Exception:
            pass
        await ws.close(code=4400)
        return

    await ws.accept(subprotocol=_SUBPROTOCOL)

    try:
        if not await authenticate_ws(ws, query):
            try:
                await ws.send_text(_instr("error", "769", "会话已失效, 请刷新页面重新登录").decode())
            except Exception:
                pass
            await ws.close(code=4401)
            return

        params = build_params(proto, query)
        params.update(_recording_params(query))
        if not params.get("hostname"):
            await ws.send_text(_instr("error", "768", "缺少目标主机").decode())
            await ws.close(code=4400)
            return

        # v5.38.1 · P1.2 跳板机: 有 jump_guid → 建 SSH 隧道, guacd 改连本地转发端口
        _tunnel_proc = None
        _jump_guid = (query.get("jump_guid") or "").strip()
        if _jump_guid:
            _t_host = params.get("hostname") or ""
            try:
                _t_port = int(params.get("port") or 3389)
            except (TypeError, ValueError):
                _t_port = 3389
            _need_sftp = str(params.get("enable-sftp") or "") == "true"
            try:
                _tp, _terr, _lp, _lps = await _start_jump_tunnel(
                    _jump_guid, _t_host, _t_port, 22 if _need_sftp else 0)
            except Exception as _te:
                _tp, _terr, _lp, _lps = None, str(_te), None, None
            if not _tp:
                await ws.send_text(_instr("error", "512", f"跳板机隧道失败: {_terr}").decode())
                await ws.close(code=4404)
                return
            _tunnel_proc = _tp
            # guacd (容器内) 连 docker 网关上的转发端口
            _gw = "172.17.0.1" if _lp else "127.0.0.1"
            try:
                import socket as _sk2
                _s2 = _sk2.socket(); _s2.bind(("172.17.0.1", 0)); _s2.close()
            except Exception:
                _gw = "127.0.0.1"
            params["hostname"] = _gw
            params["port"] = str(_lp)
            if _lps:
                params["sftp-hostname"] = _gw
                params["sftp-port"] = str(_lps)

        _bk = pick_backend(proto, query.get("gw") or "", flavor=(query.get("flavor") or "").strip())
        host, port = _bk["host"], int(_bk["port"])
        _bk_key = _backend_key(_bk)
        _ACTIVE_BY_BACKEND[_bk_key] = _ACTIVE_BY_BACKEND.get(_bk_key, 0) + 1   # v5.38.2 负载计数
        log.info("guacd 后端: %s (%s:%s) · flavor=%s · %s",
                 _bk.get("name"), host, port, _bk.get("flavor"), _bk.get("chosen", query.get("gw") and "用户指定"))

        # v5.31.5 · RDP 安全模式自动轮换。
        #   实测背景: 目标 192.168.1.92 (Linux/xrdp) 强制 NLA, 但 guacd 用 NLA 去谈却被对端
        #   拒绝 —— guacd 日志: "RDP server closed/refused connection: Security negotiation
        #   failed (wrong security type?)"。会话瞬间结束 → 只推 1 帧 → 客户端画布恒 0x0 → 黑屏。
        #   此前只能靠用户手工反复切换 NLA/TLS 去试(且看起来像玄学)。现由服务端自动依次尝试:
        #   用户指定的模式优先, 之后 nla → tls → rdp → any, 哪个先出画面就用哪个。
        _SEC_ORDER = ("nla", "tls", "rdp", "any")
        _req_sec = (params.get("security") or "").strip().lower()
        cands = []
        if proto == "rdp":
            if _req_sec and _req_sec not in ("any", "auto", ""):
                cands.append(_req_sec)
            for _m in _SEC_ORDER:
                if _m not in cands:
                    cands.append(_m)
        else:
            cands = [params.get("security") or ""]

        last_err = ""
        for _i, _sec in enumerate(cands):
            _is_last = (_i == len(cands) - 1)
            if proto == "rdp":
                params["security"] = _sec
            try:
                r, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=8)
            except Exception as e:
                await ws.send_text(_instr("error", "1026",
                                          f"guacd 不可达 {host}:{port} — {type(e).__name__}。"
                                          f"请在「远程桌面 → RDP 网关」部署 guacd: 源码编译 (scripts/build_guacd.sh, "
                                          f"离线源码包已随程序入库) / apt install guacd / docker run guacamole/guacd。").decode())
                await ws.close(code=4510)
                return
            up = _Upstream(r, w)
            try:
                info = await _do_handshake(ws, up, proto, params)
            except Exception as e:
                last_err = str(e)
                log.info("guacd 握手失败 (security=%s): %s", _sec, e)
                try:
                    w.close()
                except Exception:
                    pass
                # 握手阶段失败: 若是中间尝试则静默换下一个; 最后一次才把错误给用户
                if _is_last:
                    try:
                        await ws.send_text(_instr("error", "514", f"guacd 握手失败: {e}").decode())
                    except Exception:
                        pass
                continue

            log.info("guacd 桥建立: proto=%s target=%s:%s id=%s · security=%s%s",
                     proto, params.get("hostname"), params.get("port"), info.get("id", ""), _sec,
                     ("" if _is_last else " (探测窗口 %.0fs)" % _PROBE_SEC))
            # 中间尝试: 给一个短探测窗口, 出画面即成功; 无画面则断开换下一种
            ok = await _pump(ws, up, probe_sec=(0.0 if _is_last else _PROBE_SEC), quiet=(not _is_last))
            if ok:
                if _i > 0:
                    log.info("安全模式自动切换成功: %s", _sec)
                return
            if _is_last:
                return
            log.info("安全模式 %s 未出画面 → 自动尝试下一种", _sec)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.info("guacd 桥异常结束: %s", e)
    finally:
        # v5.38.2 · 负载计数回收
        try:
            _k = locals().get("_bk_key")
            if _k and _k in _ACTIVE_BY_BACKEND:
                _ACTIVE_BY_BACKEND[_k] = max(0, _ACTIVE_BY_BACKEND[_k] - 1)
        except Exception:
            pass
        # v5.38.1 · 跳板机隧道随会话终止
        if _tunnel_proc is not None:
            try:
                _tunnel_proc.terminate()
                log.info("跳板机隧道已关闭")
            except Exception:
                pass


_VERSION_RE = re.compile(r"VERSION_(\d+)_(\d+)(?:_(\d+))?")
_MAX_PROTO_VER = (1, 5, 0)   # guacamole-common-js 1.5.5 支持到 VERSION_1_5_0


def _negotiate_version(offered: str) -> str:
    """guacd 报的协议版本与我们支持上限取 min (参考 guapy handshake)。"""
    m = _VERSION_RE.match(offered or "")
    if not m:
        return offered or "VERSION_1_0_0"
    v = tuple(int(g or 0) for g in m.groups())
    eff = min(v, _MAX_PROTO_VER)
    return f"VERSION_{eff[0]}_{eff[1]}_{eff[2]}" if len(v) == 3 else f"VERSION_{eff[0]}_{eff[1]}"


async def _do_handshake(ws, up: _Upstream, proto: str, params: dict) -> dict:
    """select → args → (size/audio/image/timezone/name) → connect → ready"""
    up.w.write(_instr("select", proto))
    await up.w.drain()

    names, version, id_ = [], "", ""
    deadline = asyncio.get_event_loop().time() + _HS_TIMEOUT
    while True:
        left = deadline - asyncio.get_event_loop().time()
        if left <= 0:
            raise TimeoutError("等待 guacd args/ready 超时")
        batch = await up.read_instructions(min(left, 10))
        if not batch:
            raise ConnectionError("guacd 关闭了连接 (未完成握手)")
        for op, args in batch:
            if op == "args":
                version = _negotiate_version(args[0] if args else "")
                names = args[1:]
                # 客户端能力声明 + 参数值, 一次发完 (顺序是实测要求)
                up.w.write(_instr("size", str(params.get("width", 1280)),
                                  str(params.get("height", 800)), str(params.get("dpi", 96))))
                # 音频: L16 全兼容; ogg 由 guacd 视编码器能力取舍 (交集协商)
                up.w.write(_instr("audio", "audio/L16", "audio/ogg"))
                up.w.write(_instr("video"))
                up.w.write(_instr("image", "image/png", "image/jpeg", "image/webp"))
                up.w.write(_instr("timezone", str(params.get("timezone") or "Asia/Shanghai")))
                up.w.write(_instr("name", "Fonriv"))
                vals = [version] + [str(params.get(n, "")) for n in names]
                up.w.write(_instr("connect", *vals))
                await up.w.drain()
            elif op == "ready":
                id_ = args[0] if args else ""
                # v5.31.4 · FIX (黑屏最后一环): ready 必须**转发给浏览器**。
                #   guacamole-common-js 的 Client 依赖 ready 才能把自身状态切到 CONNECTED;
                #   原来桥把它自己消费掉, 客户端永远停在 CONNECTING →
                #   后续 size 不生效 (getDisplay() 恒 0x0) → 画面数据到了也显示不出来。
                #   实测症状: 服务端已发 size + img/blob(PNG), 但页面 displaySize=0x0、状态灯 amber。
                try:
                    await ws.send_text(_instr("ready", *args).decode())
                except Exception:
                    pass
                return {"id": id_, "version": version, "params": len(names)}
            elif op == "error":
                # guacd 握手期报错 (参数非法等) → 翻译状态码后转给浏览器
                zh = status_zh(args)
                log.info("guacd 握手错误: %s", zh[:300])
                try:
                    await ws.send_text(_instr("error", zh).decode())
                except Exception:
                    pass
                raise RuntimeError(zh)
            else:
                # 其它握手期指令 (如 argv) 直接转给浏览器
                try:
                    await ws.send_text(_instr(op, *args).decode())
                except Exception:
                    pass


async def _pump(ws, up: _Upstream, probe_sec: float = 0.0, quiet: bool = False) -> bool:
    """双向透传。

    v5.31.5 · 新增自动重试支持:
      probe_sec > 0 → 只观察这么多秒, 期间若始终没有图像帧就**主动结束本次尝试**
                      (返回 False), 由上层换下一个安全模式重试;
      quiet=True    → 本次是中间尝试, 失败时**不要**下发诊断 (避免误导用户),
                      也不启动看门狗与"无画面"提示。
    返回 True 表示确实收到过图像 (画面已出来)。
    """
    """双向透传: WS 文本帧 ↔ guacd TCP 字节流。

    v5.30.0 增强 (参考 guapy 的过滤器/保活设计):
      · u2b 旁路解析 (不改动透传字节): 识别 error → 状态码中文化, 识别 disconnect → 记日志
      · UTF-8 边界安全: TCP 分片切进多字节字符时保留残尾字节到下一批 (剪贴板中文不再乱码)
      · keepalive: 双向空闲 25s 插发 nop (防 NAT/中间设备静默断流; guacd 与 JS 端均忽略 nop)
    """
    from fastapi import WebSocketDisconnect

    _NOP = _instr("nop")
    _IDLE_NOP_SEC = 25.0

    async def b2u():
        last = asyncio.get_event_loop().time()
        try:
            while True:
                idle = asyncio.get_event_loop().time() - last
                try:
                    msg = await asyncio.wait_for(ws.receive(), timeout=max(0.1, _IDLE_NOP_SEC - idle))
                except asyncio.TimeoutError:
                    up.w.write(_NOP)      # 浏览器空闲 → 保 guacd TCP 活
                    await up.w.drain()
                    last = asyncio.get_event_loop().time()
                    continue
                if msg.get("type") == "websocket.disconnect":
                    break
                if msg.get("text") is not None:
                    up.w.write(str(msg["text"]).encode("utf-8"))
                elif msg.get("bytes") is not None:
                    up.w.write(bytes(msg["bytes"]))
                else:
                    continue
                await up.w.drain()
                last = asyncio.get_event_loop().time()
        except WebSocketDisconnect:
            pass
        except Exception as e:
            log.debug("浏览器→guacd 转发结束: %s", e)

    # v5.25.1 · "连上但没画面" 要给出可执行诊断, 不能只让用户看到黑屏。
    _t0 = asyncio.get_event_loop().time()
    _saw_image = False
    _saw_size = False
    _bytes = 0
    _side = GuacParser()   # 旁路解析器 (只读观察, 不干预转发)

    # v5.31.0 · "静默黑屏"看门狗 —— 实测: RDP 认证未真正通过时 (密码错/NLA 未过/
    #   目标已有冲突会话), guacd 仍会回 ready, 但**永不下发 size 与任何图像**, 且
    #   保持连接不关闭 → 浏览器端只能看到黑屏, 用户完全无从判断原因。
    #   这里在首帧迟迟不来时主动给出可执行的诊断 (而不是等上游关闭, 那可能永不发生)。
    async def _first_frame_watchdog():
        for _ in range(24):                      # 最多等 12s
            await asyncio.sleep(0.5)
            if _saw_image or _saw_size:
                return
        if _saw_image or _saw_size:
            return
        log.info("会话建立后 12s 内无 size/图像 → 判定为静默黑屏, 下发诊断")
        try:
            await ws.send_text(_instr(
                "error", "514",
                "连接已建立但远端未下发任何画面 (静默黑屏)。按可能性排查:\n"
                "① 账号/密码不对 —— RDP 认证失败时 guacd 仍会报「已连接」, 但不会给画面;\n"
                "② Windows 需改用「安全模式 = TLS」(仅用 NLA 时空密码/本地账号常被拒);\n"
                "③ Linux (xrdp / GNOME 远程桌面) 优先选「NLA」或「TLS」, 并确认账号已在桌面会话中;\n"
                "④ 该账号已有其它活动会话 → 勾选「强制新建会话」后重连;\n"
                "⑤ 域名/工作组建的账号需填「域」。\n"
                "可在「⚙ 高级」里切换安全模式与画质后点「应用并重连」逐一验证。").decode())
        except Exception:
            pass

    _wd = None if quiet else asyncio.create_task(_first_frame_watchdog())

    # v5.31.5 · 探测窗口: 中间尝试时, probe_sec 秒内没有图像就主动断开上游 → 本次尝试结束
    async def _probe_cut():
        if probe_sec <= 0:
            return
        await asyncio.sleep(probe_sec)
        if not _saw_image:
            log.info("安全模式探测: %.0fs 内无图像 → 结束本次尝试, 换下一种", probe_sec)
            try:
                up.w.close()
            except Exception:
                pass
    _pc = asyncio.create_task(_probe_cut()) if probe_sec > 0 else None

    async def u2b():
        nonlocal _saw_image, _bytes
        tail = b""          # 多字节字符跨界残尾
        last = asyncio.get_event_loop().time()
        try:
            while True:
                idle = asyncio.get_event_loop().time() - last
                try:
                    data = await asyncio.wait_for(up.r.read(262144),
                                                  timeout=max(0.1, _IDLE_NOP_SEC - idle))
                except asyncio.TimeoutError:
                    try:
                        await ws.send_text(_NOP.decode())   # guacd 空闲 → 保浏览器 WS 活
                    except Exception:
                        break
                    last = asyncio.get_event_loop().time()
                    continue
                if not data:
                    break
                _bytes += len(data)
                # v5.31.5 · 静默尝试 (安全模式轮换的中间步骤): 解析→过滤→重序列化,
                #   把 guacd 对失败尝试下发的 disconnect/error **拦下不转发** ——
                #   否则浏览器收到 disconnect 会立即断开重连, 新连接又从第一种模式开始,
                #   服务端的自动轮换永远走不到第二种。
                #   成功尝试 (已见图像) 后切回原始透传 (blob 量大, 重序列化浪费 CPU)。
                if quiet and not _saw_image:
                    _kept = []
                    for op, args in _side.feed(data):
                        if op in ("disconnect", "error"):
                            continue
                        _kept.append(_instr(op, *args))
                    if _kept:
                        try:
                            await ws.send_text(b"".join(_kept).decode("utf-8"))
                        except Exception:
                            break
                    last = asyncio.get_event_loop().time()
                    continue
                # UTF-8 边界安全: strict 解码失败 → 残尾 (≤3B) 留到下一批再解
                chunk = tail + data
                try:
                    txt = chunk.decode("utf-8")
                    tail = b""
                except UnicodeDecodeError:
                    if len(chunk) > 3:
                        try:
                            txt = chunk[:-3].decode("utf-8")
                            tail = chunk[-3:]
                        except UnicodeDecodeError:
                            txt = chunk.decode("utf-8", "replace")
                            tail = b""
                    else:
                        tail = chunk
                        continue
                # 旁路解析: error → 中文提示; disconnect → 记日志
                for op, args in _side.feed(data):
                    if op == "size":
                        _saw_size = True
                    elif op == "error":
                        zh = status_zh(args)
                        log.info("guacd 会话错误: %s", zh[:300])
                        try:
                            await ws.send_text(_instr("error", zh).decode())
                        except Exception:
                            pass
                    elif op == "disconnect":
                        log.info("guacd 会话结束 (disconnect 指令), 时长 %.0fs, %.1fMB",
                                 asyncio.get_event_loop().time() - _t0, _bytes / 1048576)
                if not _saw_image and ("3.img," in txt or "4.blob," in txt):   # sync/cursor 不算画面
                    _saw_image = True
                await ws.send_text(txt)
                last = asyncio.get_event_loop().time()
        except Exception as e:
            log.debug("guacd→浏览器 转发结束: %s", e)
        # 上游断开: 若极短时间内断开且一张图都没来过 → 明确告诉用户原因
        elapsed = asyncio.get_event_loop().time() - _t0
        if not _saw_image and elapsed < 30 and not quiet:
            try:
                await ws.send_text(_instr(
                    "error", "514",
                    "远端未返回画面 (连接已结束)。常见原因与处理: "
                    "① Windows 账户是空密码 → 默认策略禁止空密码远程登录 (需给账号设密码, "
                    "或在目标机 secpol.msc 关闭「账户: 使用空密码的本地账户只允许进行控制台登录」); "
                    "② 该账户不在「远程桌面用户」组 → 目标机 系统属性→远程→选择用户 里加入; "
                    "③ 目标机已有该账号的残留会话 (Linux xrdp) → 勾「强制新建会话」重连; "
                    "④ 密码错误。").decode())
            except Exception:
                pass

    t1 = asyncio.create_task(b2u())
    t2 = asyncio.create_task(u2b())
    done, pending = await asyncio.wait({t1, t2}, timeout=MAX_SESSION_SEC,
                                       return_when=asyncio.FIRST_COMPLETED)
    for _t in (_wd, _pc):
        try:
            if _t:
                _t.cancel()
        except Exception:
            pass
    for t in pending:
        t.cancel()
    for t in done | pending:
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass
    try:
        up.w.close()
    except Exception:
        pass
    return _saw_image


# ═════════════════════════════════════════════════════════════
# v5.25.0 · guacd 网关部署助手 (WS action: guacd_status / guacd_deploy / guacd_save)
# ═════════════════════════════════════════════════════════════

def _have(cmd: str) -> bool:
    import shutil as _sh
    return bool(_sh.which(cmd))


def deploy_plan() -> dict:
    """给出本机可行的 guacd 部署路径 (apt / docker / 源码), 按可行性排序。"""
    import subprocess as _sp
    steps = []
    # ① apt (Ubuntu ≤25.04 / Debian / RHEL+EPEL 有 guacd; Ubuntu 26.04 已移除)
    apt_ok = False
    if _have("apt-get"):
        try:
            r = _sp.run(["apt-cache", "policy", "guacd"], capture_output=True, text=True, timeout=10)
            apt_ok = "Candidate:" in (r.stdout or "") and "Installed" not in (r.stdout or "").split("Candidate:")[0][-20:]
        except Exception:
            apt_ok = False
    if apt_ok:
        steps.append({"kind": "apt", "label": "apt 安装 (推荐)",
                      "cmd": "apt-get install -y guacd && systemctl enable --now guacd"})
    # ② 源码编译 (不依赖 docker; 离线可用 — 源码包已随程序入库 third_party/)
    _src_pkg = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "third_party", "guacamole-server-1.5.5.tar.gz")
    steps.append({"kind": "source",
                  "label": "源码编译 (不装 docker)" + ("（离线源码包已随程序入库）" if os.path.exists(_src_pkg) else ""),
                  "cmd": "sudo bash scripts/build_guacd.sh   # 编到 /usr/local + systemd 单元 guacd.service",
                  "offline_pkg": os.path.basename(_src_pkg) if os.path.exists(_src_pkg) else "",
                  "doc": "只需一次性编译; 之后是普通系统服务, 无容器开销、无 docker 依赖"})
    # ③ docker (通用; 国内可用镜像加速)
    if _have("docker"):
        try:
            r = _sp.run(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"],
                        capture_output=True, text=True, timeout=10)
            imgs = (r.stdout or "")
            local = "guacamole/guacd" in imgs or "docker.m.daocloud.io/guacamole/guacd" in imgs
        except Exception:
            local = False
        steps.append({"kind": "docker", "label": "Docker 容器" + ("（镜像已就位）" if local else ""),
                      "cmd": ("docker run -d --name guacd --restart unless-stopped "
                              "-p 4822:4822 guacamole/guacd:1.5.5"),
                      "cmd_mirror": ("docker pull docker.m.daocloud.io/guacamole/guacd:1.5.5 && "
                                     "docker tag docker.m.daocloud.io/guacamole/guacd:1.5.5 guacamole/guacd:1.5.5"),
                      "have_image": local})
    # ③ 远端 guacd
    steps.append({"kind": "remote", "label": "使用其它主机上的 guacd",
                  "cmd": "在下方把 guacd 地址改成那台主机的 IP:4822 (guacd 可远程接入)"})
    return {"steps": steps, "note": ("guacd 只作出站连接 (到目标 RDP/VNC), 不需要公网暴露。三种部署方式按需选: 源码编译=零容器依赖(推荐自管服务器) · apt=最省事(Debian/Ubuntu≤25.04) · docker=环境已容器化时。不需要每台被控机都装 guacd — 一台作网关即可服务多台目标。")}


async def handle_guacd_action(ws, data: dict) -> None:
    """sub=status 探测 / sub=deploy 起容器 (confirm) / sub=save 保存地址 (confirm)。"""
    import asyncio as _aio

    req_id = data.get("req_id") or ""
    sub = (data.get("sub") or "status").strip().lower()
    loop = _aio.get_event_loop()

    if sub == "save":
        if not data.get("confirm"):
            await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                "msg": "保存 guacd 地址需 confirm=true"})
            return
        from backend import db
        host = (data.get("host") or "").strip() or DEFAULT_GUACD_HOST
        try:
            port = int(data.get("port") or DEFAULT_GUACD_PORT)
        except (TypeError, ValueError):
            port = DEFAULT_GUACD_PORT
        db.setting_set("guacd_host", host)
        db.setting_set("guacd_port", str(port))
        r = await loop.run_in_executor(None, lambda: probe(host, port))
        await ws.send_json({"type": "result", "status": "ok" if r.get("ok") else "error",
                            "req_id": req_id, "guacd_result": True, "saved": {"host": host, "port": port},
                            **r})
        return

    if sub in ("status", "backends"):
        from backend import probe_pool as _pp
        # 逐个后端探活 (状态页要看清"哪个能用")
        def _probe_all():
            bs = list_backends()

            def _one(b):
                pb = probe(b["host"], b["port"], timeout=2.0)
                return {**b, "ok": bool(pb.get("ok")), "msg": pb.get("msg", ""),
                        "version": pb.get("version", "")}
            # v5.98.1 · 旧实现串行探活 + 借用默认线程池: 后端多/网络不通时单次 57.7s(实测),
            #   期间默认池被占满 → 交互任务(列目录/缩略图)全部排队。现在: 有界并发 + 专用探测池
            #   + 5s 结论缓存(前端轮询该动作很频繁), 探测再慢也不拖累其它面板。
            return _pp.map_bounded(bs, _one, workers=4, timeout=4.0)
        bks = await _pp.run_cached("guacd:backends", 5.0, _probe_all, timeout=15.0, default=[]) or []
        any_ok = any(x.get("ok") for x in bks)
        plan = await _pp.run(deploy_plan, timeout=8.0, default={}) or {}
        pick_rdp = await _pp.run(lambda: pick_backend("rdp"), timeout=5.0, default={}) or {}
        pick_vnc = await _pp.run(lambda: pick_backend("vnc"), timeout=5.0, default={}) or {}
        await ws.send_json({
            "type": "result", "status": "ok" if any_ok else "error", "req_id": req_id,
            "guacd_result": True, "sub": sub,
            "backends": bks, "plan": plan,
            "auto_rdp": {k: pick_rdp.get(k) for k in ("id", "name", "host", "port", "flavor", "chosen")},
            "auto_vnc": {k: pick_vnc.get(k) for k in ("id", "name", "host", "port", "flavor", "chosen")},
            "msg": ("✓ " + " · ".join(f"{x['name']}{'(✓)' if x['ok'] else '(✗)'}"
                                      + (f" [{x['flavor']}]" if x.get('flavor') != 'any' else "")
                                      for x in bks)) if bks else "未配置任何 guacd 后端",
        })
        return

    if sub in ("save_backend", "del_backend", "default"):
        if not data.get("confirm"):
            await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                "msg": f"{sub} 会改变网关配置, 需要 confirm=true"})
            return
        if sub == "default":
            r = set_default(data.get("gw") or "auto")
            await ws.send_json({"type": "result", "status": "ok", "req_id": req_id,
                                "guacd_result": True, "sub": sub,
                                "msg": f"✓ 默认网关已设为 {r['default']} (auto = 按协议/目标自动选)"})
            return
        items = list_backends()
        if sub == "save_backend":
            b = {"id": (data.get("id") or "").strip(),
                 "name": (data.get("name") or "").strip(),
                 "host": (data.get("host") or "").strip(),
                 "port": int(data.get("port") or DEFAULT_GUACD_PORT),
                 "flavor": (data.get("flavor") or "any").strip(),
                 "note": (data.get("note") or "").strip()}
            if not b["host"]:
                await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                    "msg": "缺少 host"})
                return
            if not b["id"]:
                b["id"] = f"gw{len(items)+1}"
            items = [x for x in items if x["id"] != b["id"] and x["name"] != b["name"]] + [b]
        else:   # del_backend
            gid = (data.get("id") or "").strip()
            items = [x for x in items if x["id"] != gid and x["name"] != gid]
        r = save_backends(items)
        await ws.send_json({"type": "result", "status": "ok", "req_id": req_id,
                            "guacd_result": True, "sub": sub, "backends": r["backends"],
                            "msg": f"✓ 网关配置已更新 (共 {r['count']} 个后端)"})
        return

    if sub == "deploy":
        if not data.get("confirm"):
            await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                "msg": "启动 guacd 容器需 confirm=true"})
            return
        if not _have("docker"):
            await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                "msg": "本机没有 docker — 请按部署指引用 apt 或在其它主机运行 guacd"})
            return
        kind = (data.get("kind") or "docker").strip().lower()

        async def _run_cmd(args: list, timeout: int = 1800, stream: bool = False):
            p = await _aio.create_subprocess_exec(*args, stdout=_aio.subprocess.PIPE,
                                                  stderr=_aio.subprocess.STDOUT)
            if stream:
                # 源码编译耗时数分钟, 边跑边把关键行推给前端 (否则用户以为卡死)
                tail = []
                last = 0.0
                while True:
                    line = await p.stdout.readline()
                    if not line:
                        break
                    txt = line.decode("utf-8", "replace").rstrip()
                    if "[guacd]" in txt or "error" in txt.lower():
                        now = _aio.get_event_loop().time()
                        if now - last > 0.6:      # 限流, 避免刷屏
                            last = now
                            try:
                                await ws.send_json({"type": "log", "level": "info", "msg": txt[:200]})
                            except Exception:
                                pass
                    tail.append(txt)
                return await p.wait(), "\n".join(tail[-40:])

        ver_used = "1.5.5"
        try:
            ver_used = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                         "third_party", "VERSION_GUACD"), encoding="utf-8").read().strip() or "1.6.0"
        except Exception:
            pass
        if kind == "source":
            script = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                  "scripts", "build_guacd.sh")
            if not os.path.exists(script):
                await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                    "msg": "未找到 scripts/build_guacd.sh"})
                return
            await ws.send_json({"type": "log", "level": "info",
                                "msg": "🔧 源码编译 guacd (首次约 3~10 分钟, 只此一次; 之后是普通系统服务, 无 docker 依赖)…"})
            rc, out = await _run_cmd(["bash", script], timeout=2400, stream=True)
            r = await loop.run_in_executor(None, probe)
            await ws.send_json({"type": "result",
                                "status": "ok" if (r.get("ok") or rc == 0) else "error",
                                "req_id": req_id, "guacd_result": True, "sub": "deploy_source",
                                **r, "msg": (r.get("msg") if r.get("ok") else "编译输出尾部: " + out[-400:])})
            return

        if kind != "docker":
            await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                "msg": f"未知部署方式: {kind}"})
            return

        mirror_img = "docker.m.daocloud.io/guacamole/guacd:1.5.5"
        img = (data.get("image") or "guacamole/guacd:1.5.5").strip()
        await ws.send_json({"type": "log", "level": "info",
                            "msg": f"🐳 准备 guacd 容器 (镜像 {img})…"})
        # 已有同名容器 → 复用/重启
        rc, out = await _run_cmd(["docker", "inspect", "-f", "{{.State.Status}}", "guacd"], timeout=30)
        if rc == 0:
            st = (out or "").strip()
            if st != "running":
                await _run_cmd(["docker", "start", "guacd"], timeout=60)
            await ws.send_json({"type": "log", "level": "info", "msg": "已有 guacd 容器, 已确保运行"})
        else:
            rc, out = await _run_cmd(["docker", "images", "-q", img], timeout=30)
            if rc != 0 or not (out or "").strip():
                # 拉取: 先试常规, 失败再试国内镜像
                await ws.send_json({"type": "log", "level": "info", "msg": f"拉取镜像 {img} …"})
                rc, out = await _run_cmd(["docker", "pull", img])
                if rc != 0:
                    await ws.send_json({"type": "log", "level": "warn",
                                        "msg": "常规拉取失败 (内网/Docker Hub 受限), 换国内镜像源重试…"})
                    rc, out = await _run_cmd(["docker", "pull", mirror_img])
                    if rc != 0:
                        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                            "msg": "镜像拉取失败: " + (out or "")[-200:]})
                        return
                    await _run_cmd(["docker", "tag", mirror_img, img], timeout=60)
            rc, out = await _run_cmd(["docker", "run", "-d", "--name", "guacd", "--restart",
                                      "unless-stopped", "-e", "GUACD_LOG_LEVEL=info",
                                      "-p", "4822:4822", img], timeout=120)
            if rc != 0:
                await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                    "msg": "容器启动失败: " + (out or "")[-200:]})
                return
        await _aio.sleep(2)
        r = await loop.run_in_executor(None, probe)
        # 登记为后端 (flavor 由 guacamole 版本推断: 1.5.x=freerdp2, 1.6.x=freerdp3)
        flavor = "any"
        try:
            if kind == "source":
                flavor = "freerdp2" if str(ver_used).startswith("1.5") else "freerdp3"
            else:
                flavor = "freerdp2"      # 官方 docker 镜像 (1.5.5) 内置 FreeRDP 2
        except Exception:
            pass
        try:
            items = list_backends()
            nm = f"{'源码' if kind == 'source' else 'Docker'} guacd {ver_used if kind == 'source' else '1.5.5'}"
            items = [x for x in items if x["name"] != nm]
            items.append({"id": f"gw{len(items)+1}", "name": nm, "host": "127.0.0.1",
                          "port": DEFAULT_GUACD_PORT, "flavor": flavor,
                          "note": f"{'源码编译' if kind == 'source' else 'docker'} 部署于 " + __import__("time").strftime("%Y-%m-%d %H:%M")})
            save_backends(items)
        except Exception as _e:
            log.info("登记 guacd 后端失败: %s", _e)
        await ws.send_json({"type": "result", "status": "ok" if r.get("ok") else "error",
                            "req_id": req_id, "guacd_result": True, "sub": "deploy",
                            "flavor": flavor, **r})
        return

    await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                        "msg": f"未知 sub: {sub}"})

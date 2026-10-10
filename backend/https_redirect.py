"""Fonriv - HTTP→HTTPS 跳转服务 (v5.30.1)

启用 HTTPS 后, 原 web_port (如 8000) 上跑这个极简跳转服务:
  http://ip:8000/任何路径?query → 301 https://ip:https_port/同样路径?query
用户的旧书签/习惯地址无需修改, 自动落到 HTTPS。

为什么不用 uvicorn 再起一个 app: 跳转口不需要 FastAPI 的任何能力,
原生 asyncio 手写 (零依赖), 响应恒为 301, 不解析不落盘, 同时天然拒绝
任何非 GET/HEAD 的方法体 (Connection: close 直接断)。
"""

from __future__ import annotations

import asyncio
import logging

log = logging.getLogger("https_redirect")

_RESP_TMPL = (
    "HTTP/1.1 301 Moved Permanently\r\n"
    "Location: {location}\r\n"
    "Content-Length: 0\r\n"
    "Connection: close\r\n"
    "Referrer-Policy: no-referrer\r\n"
    "\r\n"
)


async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                  https_port: int):
    try:
        peer = writer.get_extra_info("peername")
        # 首行: METHOD PATH HTTP/x
        line = await asyncio.wait_for(reader.readline(), timeout=5)
        parts = line.decode("latin1", "ignore").strip().split(" ")
        path = parts[1] if len(parts) > 1 else "/"
        if not path.startswith("/"):
            path = "/" + path
        # 取 Host 头 (保留用户输入的 IP/域名)
        host = ""
        while True:
            h = await asyncio.wait_for(reader.readline(), timeout=3)
            if h in (b"\r\n", b"\n", b""):
                break
            if h.lower().startswith(b"host:"):
                host = h.split(b":", 1)[1].strip().decode("latin1", "ignore")
                break
        if not host:
            peer = peer[0] if peer else "unknown"
            host = str(peer)
        # 去掉 host 里原有的端口 → 换成 https_port
        host_noport = host.rsplit(":", 1)[0] if ":" in host else host
        # IPv6 裸地址补方括号
        if host_noport.count(":") > 0 and not host_noport.startswith("["):
            host_noport = f"[{host_noport}]"
        location = f"https://{host_noport}:{https_port}{path}"
        # 防御性净化: 剔除控制字符 (CR/LF/CTL) 防响应头注入; 空格转义
        location = "".join(ch for ch in location if ch >= " ").replace(" ", "%20")
        writer.write(_RESP_TMPL.format(location=location).encode("latin1", "ignore"))
        await writer.drain()
        log.info("301 %s → %s", path[:60], location[:100])
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def start(port: int, https_port: int):
    """启动跳转服务 (在 app startup 事件里 create_task 调用)。"""
    async def _srv(r, w):
        await _handle(r, w, https_port)
    server = await asyncio.start_server(_srv, host="0.0.0.0", port=port,
                                        reuse_address=True)
    log.info("HTTP→HTTPS 跳转服务已启动 :%s → :%s", port, https_port)
    return server

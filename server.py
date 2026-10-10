#!/usr/bin/env python3
"""Fonriv - Entry Point

CLI:
  python server.py                            # 默认 0.0.0.0:8000
  python server.py --host 127.0.0.1 --port 9000
  python server.py --workers 1               # uvicorn workers (仅 non-reload)
  FONRIV_HOST=127.0.0.1 FONRIV_PORT=9000 python server.py   # 亦可用环境变量
"""
import argparse
import os
import sys

import uvicorn
from backend.app import app, setup_websocket, register_signal_handlers


def _parse_args(argv=None):
    p = argparse.ArgumentParser(prog="fonriv", description="Fonriv 服务入口")
    p.add_argument("--host", default=os.environ.get("FONRIV_HOST", "0.0.0.0"),
                   help="监听地址 (默认 0.0.0.0 · env: FONRIV_HOST)")
    p.add_argument("--port", type=int, default=int(os.environ.get("FONRIV_PORT", "8000")),
                   help="监听端口 (默认 8000 · env: FONRIV_PORT)")
    p.add_argument("--log-level", default=os.environ.get("FONRIV_LOG_LEVEL", "info"),
                   choices=["critical", "error", "warning", "info", "debug", "trace"],
                   help="uvicorn 日志级别 (默认 info · env: FONRIV_LOG_LEVEL)")
    p.add_argument("--version", action="store_true", help="打印版本号并退出")
    return p.parse_args(argv)


def _resolve_port(cli_port, argv) -> int:
    """v4.43.0 · 端口解析优先级: CLI 显式 --port > DB web_port > env FONRIV_PORT > 8000

    用户在「系统设置 → WEB 服务端口」保存后 (写入 app_settings.web_port + /etc/default/fonriv),
    重启服务即按新端口监听; CLI 显式传 --port 时以 CLI 为准 (运维 override)。
    """
    cli_given = "--port" in (argv or sys.argv[1:])
    if cli_given:
        return cli_port
    try:
        from backend.db import setting_get
        saved = setting_get("web_port", "")
        if saved:
            p = int(saved)
            if 1 <= p <= 65535:
                return p
    except Exception:
        pass
    return cli_port  # 已是 env/默认 合并后的值


def _resolve_https() -> dict:
    """v5.29.0 · HTTPS 解析: env FONRIV_HTTPS_CERT/FONRIV_HTTPS_KEY 显式指定 >
    DB https_enabled=1 时用内置 data/https/server.crt|key > 关闭 (HTTP)。

    TLS 参数只能在 uvicorn 启动时定格 → 启用/停用需重启后台服务。"""
    cert = os.environ.get("FONRIV_HTTPS_CERT", "")
    key = os.environ.get("FONRIV_HTTPS_KEY", "")
    def _https_port(default=8443) -> int:
        try:
            from backend.db import setting_get as _sg
            p = int(_sg("https_port", "") or default)
            if 1 <= p <= 65535:
                return p
        except Exception:
            pass
        return default
    if cert and key and os.path.exists(cert) and os.path.exists(key):
        os.environ["FONRIV_HTTPS_ACTIVE"] = "1"
        return {"ssl_certfile": cert, "ssl_keyfile": key, "_https_port": _https_port()}
    try:
        from backend.db import setting_get
        if setting_get("https_enabled", "0") == "1":
            from backend import https_cert as _hc
            if os.path.exists(_hc.CERT_PATH) and os.path.exists(_hc.KEY_PATH):
                _hc.apply_key_permissions()
                os.environ["FONRIV_HTTPS_ACTIVE"] = "1"
                return {"ssl_certfile": _hc.CERT_PATH, "ssl_keyfile": _hc.KEY_PATH,
                        "_https_port": _https_port()}
            print("[https] ⚠ https_enabled=1 但证书文件缺失, 回落 HTTP (先到安全中心签发证书)")
    except Exception as e:
        print(f"[https] 配置读取失败, 走 HTTP: {e}")
    os.environ["FONRIV_HTTPS_ACTIVE"] = "0"
    return {}


def _enable_faulthandler():
    """v5.98.3 · 卡顿现场抓栈(用户报「整机卡几十秒、刷新不出列表、点了没反应」)。

    现象: 服务会偶发整体无响应(HTTP 与 WS 一起卡, 实测 /api/version 单次 2~60s),
    但事后看日志只能看到耗时, **看不到那一刻线程到底卡在哪一行**。
    做法: 启用 faulthandler 并注册 SIGUSR1 —— 卡住的当口 `kill -USR1 <pid>` 就把
    全部线程的 Python 栈打进 stderr(= /var/log/fonriv.log), 直接指出阻塞帧。
    平时零开销、不发信号不产生任何输出。
    """
    try:
        import faulthandler
        import signal as _sig
        faulthandler.enable()
        faulthandler.register(_sig.SIGUSR1, all_threads=True)
        print("[diag] faulthandler 已启用 · 卡顿时可 `kill -USR1 %d` 导出全部线程栈" % os.getpid())
    except Exception as e:      # 平台不支持也不影响启动
        print("[diag] faulthandler 启用失败(忽略):", e)


def main(argv=None):
    args = _parse_args(argv)
    if args.version:
        try:
            from backend.version import VERSION
            print(f"Fonriv v{VERSION}")
        except ImportError:
            print("Fonriv (version unknown)")
        return 0
    _enable_faulthandler()
    setup_websocket()
    register_signal_handlers()
    port = _resolve_port(args.port, argv)
    if port != args.port:
        print(f"[web_port] 使用系统设置端口 {port} (DB app_settings.web_port; CLI --port 可强制覆盖)")
    # v4.43.0 · 记录实际生效端口, 供 web_port_get 探测「当前监听端口」
    os.environ["FONRIV_EFFECTIVE_PORT"] = str(port)
    # v6.2.0 · 回写实际监听地址: 在线更新重启时沿用同一 host(否则 --host 127.0.0.1 的实例
    #   重启后会变成 0.0.0.0, 监听面意外扩大)
    os.environ["FONRIV_HOST"] = str(args.host)
    ssl_args = _resolve_https()
    if ssl_args:
        _cert = ssl_args["ssl_certfile"]  # py3.7 兼容: f-string 内不嵌同类引号
        _hport = ssl_args.pop("_https_port", 8443)   # 内部键, 不传给 uvicorn
        # v5.30.1 · HTTP→HTTPS 自动跳转: 原端口 (web_port) 保留给跳转服务,
        #   HTTPS 实际监听 https_port (默认 8443) — 旧书签 http://ip:8000 自动 301
        if _hport != port:
            os.environ["FONRIV_HTTPS_REDIRECT_FROM"] = str(port)
            os.environ["FONRIV_HTTPS_PORT"] = str(_hport)
            print(f"[https] OK HTTPS 已启用 ({_cert}) :{_hport} · 原端口 :{port} 自动 301 跳转")
            port = _hport
        else:
            print(f"[https] OK HTTPS 已启用 ({_cert}) 同端口 :{port} (无跳转口, http 访问不可用)")
    uvicorn.run(app, host=args.host, port=port, log_level=args.log_level, **ssl_args)
    return 0


if __name__ == "__main__":
    sys.exit(main())

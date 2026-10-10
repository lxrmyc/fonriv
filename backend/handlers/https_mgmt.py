"""Fonriv - HTTPS/SSL 证书管理 handlers (v5.29.0)

actions: https_get / https_set / https_issue / https_upload
面板: security · 管理员专属 (与既有安全模块一致走通用 admin gate)
"""

import asyncio
import os

from backend import https_cert as hc
from backend.db import setting_get, setting_set

_CFG_KEYS = ("https_enabled", "https_mode", "https_domains", "https_acme_email",
             "https_acme_staging", "https_auto_renew", "https_renew_before_days")


def _cfg() -> dict:
    c = {
        "https_enabled": setting_get("https_enabled", "0") == "1",
        "https_mode": setting_get("https_mode", "selfsigned"),
        "https_domains": setting_get("https_domains", ""),
        "https_acme_email": setting_get("https_acme_email", ""),
        "https_acme_staging": setting_get("https_acme_staging", "1") == "1",
        "https_auto_renew": setting_get("https_auto_renew", "1") == "1",
        "https_renew_before_days": setting_get("https_renew_before_days", "30"),
    }
    return c


async def handle_https_get(ws, data: dict):
    """配置 + 证书状态 + 生效情况"""
    _req = data.get("req_id") or ""
    cfg = _cfg()
    info = hc.cert_info()
    # uvicorn 是否已带 TLS (对比启动时 env 快照)
    import urllib.request
    serving = os.environ.get("FONRIV_HTTPS_ACTIVE", "0") == "1"
    pending_restart = cfg["https_enabled"] != serving
    cfg["https_port"] = int(setting_get("https_port", "8443") or 8443)
    cfg["redirect_from"] = int(os.environ.get("FONRIV_HTTPS_REDIRECT_FROM", "0") or 0)
    # v5.91.1 · 证书缺失时给出显式状态: 界面要提示"已勾选启用但证书不存在 → 当前仍是 HTTP,
    #   8443 不会监听", 而不是只显示"需重启生效"(用户实测就是这样被误导的)
    cert_missing = False
    try:
        cert_missing = not (os.path.exists(hc.CERT_PATH) and os.path.exists(hc.KEY_PATH))
    except Exception:
        cert_missing = True
    warn = ""
    if cert_missing and cfg["https_enabled"]:
        warn = "已勾选启用 HTTPS 但证书不存在: 服务重启后会回落 HTTP, 8443 不会监听。请先签发证书。"
    elif cert_missing:
        warn = "当前没有证书: 需要先签发(自签名/ACME)或上传证书, 才能启用 HTTPS。"
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "cfg": cfg, "cert": info, "serving_https": serving,
                        "pending_restart": pending_restart,
                        "cert_missing": cert_missing, "https_warn": warn,
                        "cert_path": hc.CERT_PATH, "key_path": hc.KEY_PATH})


async def handle_https_set(ws, data: dict):
    """保存配置。enabled 变更需重启服务生效 (uvicorn ssl 参数启动时定格)。"""
    _req = data.get("req_id") or ""
    try:
        enabled = bool(data.get("enabled"))
        mode = data.get("mode") or "selfsigned"
        if mode not in ("selfsigned", "acme", "manual"):
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": f"未知模式: {mode}"})
            return
        days = data.get("renew_before_days")
        try:
            days = max(7, min(90, int(days)))
        except (TypeError, ValueError):
            days = 30
        # v5.91.1 · FIX(用户实测: 启用 HTTPS 后网页打不开/8443 不通): 此前只写 https_enabled=1,
        #   若证书还没签发, 重启时 server._resolve_https 找不到证书 → 静默回落 HTTP,
        #   用户在 8443/https 上自然什么都连不上, 而界面只提示"需重启生效"。
        #   现在: 开启前先确保证书就位 —— selfsigned 缺证书就**当场自动签发**;
        #   acme/manual 缺证书则拒绝开启并说明原因(不让用户停在半开状态)。
        if enabled:
            try:
                _has_cert = os.path.exists(hc.CERT_PATH) and os.path.exists(hc.KEY_PATH)
            except Exception:
                _has_cert = False
            if not _has_cert:
                if mode == "selfsigned":
                    try:
                        _rr = hc.issue_now("selfsigned", [d for d in (data.get("domains") or "").split(",") if d.strip()])
                        _has_cert = bool(_rr.get("ok")) and os.path.exists(hc.CERT_PATH)
                        if not _has_cert:
                            setting_set("https_enabled", "0")
                            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": "自签名证书生成失败, 已保持 HTTP: " + str(_rr.get("reason") or _rr.get("msg") or _rr)})
                            return
                    except Exception as e:
                        setting_set("https_enabled", "0")
                        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "自签名证书生成失败, 已保持 HTTP: %s" % e})
                        return
                else:
                    setting_set("https_enabled", "0")
                    await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                        "msg": "还没有证书: 请先在下方点击「签发证书」(%s 模式), 签发成功后再勾选启用 HTTPS" % mode})
                    return
        setting_set("https_enabled", "1" if enabled else "0")
        setting_set("https_mode", mode)
        setting_set("https_domains", (data.get("domains") or "").strip())
        setting_set("https_acme_email", (data.get("acme_email") or "").strip())
        setting_set("https_acme_staging", "1" if data.get("acme_staging") else "0")
        setting_set("https_auto_renew", "1" if data.get("auto_renew", True) else "0")
        setting_set("https_renew_before_days", str(days))
        try:
            hport = int(data.get("https_port") or 8443)
            assert 1 <= hport <= 65535
        except (TypeError, ValueError, AssertionError):
            hport = 8443
        setting_set("https_port", str(hport))
        msg = "✓ 配置已保存"
        import urllib.request
        serving = os.environ.get("FONRIV_HTTPS_ACTIVE", "0") == "1"
        if enabled != serving:
            msg += " · 需重启后台服务后 " + ("启用 HTTPS" if enabled else "恢复 HTTP")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "msg": msg,
                            "pending_restart": enabled != serving})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"保存失败: {e}"})


async def handle_https_issue(ws, data: dict):
    """立即签发/续期 (线程池执行, acme 全程 30~120s; selfsigned 秒级)"""
    _req = data.get("req_id") or ""
    cfg = _cfg()
    mode = data.get("mode") or cfg["https_mode"]
    domains = [d for d in (data.get("domains") or cfg["https_domains"]).split(",") if d.strip()]
    loop = asyncio.get_event_loop()

    def _pub(m):
        # 经由事件总线推送进度 → 前端运行日志
        try:
            from backend import events as _ev
            _ev.publish("https.progress", {"msg": m})
        except Exception:
            pass

    def _job():
        return hc.issue_now(mode, domains,
                            email=data.get("acme_email") or cfg["https_acme_email"],
                            staging=bool(data.get("acme_staging", cfg["https_acme_staging"])),
                            log=_pub)

    r = await loop.run_in_executor(None, _job)
    if r.get("ok"):
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": "✓ " + mode + " 证书已就绪", "cert": r.get("info")})
    else:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": r.get("msg", "签发失败")})


async def handle_https_upload(ws, data: dict):
    """手动上传 PEM 证书 + 私钥"""
    _req = data.get("req_id") or ""
    cert_pem = (data.get("cert_pem") or "").strip()
    key_pem = (data.get("key_pem") or "").strip()
    if "BEGIN CERTIFICATE" not in cert_pem:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "证书 PEM 无效 (缺少 BEGIN CERTIFICATE)"})
        return
    if "PRIVATE KEY" not in key_pem:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "私钥 PEM 无效 (缺少 PRIVATE KEY)"})
        return
    loop = asyncio.get_event_loop()
    r = await loop.run_in_executor(None, lambda: hc.upload_cert(cert_pem, key_pem))
    if r.get("ok"):
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": "✓ 证书已上传" + (" (与配置匹配)" if r.get("info", {}).get("exists") else ""),
                            "cert": r.get("info")})
    else:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": r.get("msg", "")})

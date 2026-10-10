"""v4.21.0 · 告警规则 WS handlers · 读/写/测试"""
from __future__ import annotations

import json
import time
import urllib.request
import urllib.error

from backend import db as _db
from backend import alerting


async def handle_alert_rules_get(ws, data: dict):
    """读取当前告警规则（存储在 app_settings.alert_rules）"""
    try:
        raw = _db.setting_get("alert_rules", "")
        rules = json.loads(raw) if raw else []
        if not isinstance(rules, list):
            rules = []
        await ws.send_json({"type": "result", "status": "ok", "rules": rules})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": str(e)})


async def handle_alert_rules_set(ws, data: dict):
    """写入告警规则并热重载"""
    rules = data.get("rules", [])
    if not isinstance(rules, list):
        await ws.send_json({"type": "result", "status": "error", "msg": "rules 必须是数组"})
        return
    # 规则校验：每条必须有 name + topic + (webhook_url 或 email_to)
    cleaned = []
    for r in rules:
        if not isinstance(r, dict):
            continue
        name = str(r.get("name", "")).strip()
        topic = str(r.get("topic", "")).strip()
        typ = str(r.get("type", "webhook")).strip() or "webhook"
        if not name or not topic:
            continue
        cleaned_row = {
            "name": name[:64], "topic": topic[:128], "type": typ,
            "enabled": bool(r.get("enabled", True)),
        }
        # v4.23.0 · 通用可选字段
        tmpl = str(r.get("template", "generic")).strip().lower() or "generic"
        if tmpl in ("generic", "feishu", "dingtalk", "wecom", "slack"):
            cleaned_row["template"] = tmpl
        try:
            silence = int(r.get("silence_sec", 0) or 0)
        except Exception:
            silence = 0
        if silence < 0: silence = 0
        if silence > 86400: silence = 86400
        cleaned_row["silence_sec"] = silence
        if r.get("at_mobiles"):
            cleaned_row["at_mobiles"] = str(r["at_mobiles"])[:256]
        if r.get("at_all"):
            cleaned_row["at_all"] = bool(r.get("at_all"))
        if r.get("secret"):
            cleaned_row["secret"] = str(r["secret"])[:128]
        if typ == "email":
            to_addr = str(r.get("email_to", "")).strip()
            if not to_addr or "@" not in to_addr:
                continue
            cleaned_row["email_to"] = to_addr[:256]
        else:
            url = str(r.get("webhook_url", "")).strip()
            if not (url.startswith("http://") or url.startswith("https://")):
                continue
            cleaned_row["webhook_url"] = url[:512]
            cleaned_row["method"] = (r.get("method") or "POST").upper()
        cleaned.append(cleaned_row)
    try:
        _db.setting_set("alert_rules", json.dumps(cleaned, ensure_ascii=False))
        n = alerting.force_reload()
        await ws.send_json({"type": "result", "status": "ok",
                            "saved": len(cleaned), "active": n})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": str(e)})


async def handle_alert_test_email(ws, data: dict):
    """v4.22.0 · 发送测试邮件到指定地址（使用 app_settings 里的 SMTP 配置）"""
    to_addr = str(data.get("email_to", "")).strip()
    if not to_addr or "@" not in to_addr:
        await ws.send_json({"type": "result", "status": "error", "msg": "收件人无效"})
        return
    try:
        ok, err = alerting.send_email(
            to_addr,
            "[Fonriv] SMTP 测试邮件",
            "这是一封 Fonriv 告警管道的测试邮件。\n\n"
            f"发送时间: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
            "如收到此邮件，说明 SMTP 配置正确。",
        )
        if ok:
            await ws.send_json({"type": "result", "status": "ok"})
        else:
            await ws.send_json({"type": "result", "status": "error", "msg": err})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": str(e)})


async def handle_alert_test(ws, data: dict):
    """立即测试一个 webhook_url（不落盘），5s 超时"""
    url = str(data.get("webhook_url", "")).strip()
    method = (data.get("method") or "POST").upper()
    if not url or not (url.startswith("http://") or url.startswith("https://")):
        await ws.send_json({"type": "result", "status": "error", "msg": "webhook_url 无效"})
        return
    body = {
        "topic": "audit.test",
        "ts": time.time(),
        "event": {"msg": "这是一条测试事件（来自 Fonriv 告警管道）"},
    }
    try:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        if method == "GET":
            sep = "&" if "?" in url else "?"
            req = urllib.request.Request(f"{url}{sep}topic=audit.test", method="GET")
        else:
            req = urllib.request.Request(url, data=payload, method="POST",
                                          headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            code = resp.getcode()
            snippet = resp.read(512).decode("utf-8", errors="replace")
        await ws.send_json({"type": "result", "status": "ok",
                            "http_code": code, "response": snippet})
    except urllib.error.URLError as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": f"URL 错误: {e}"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": str(e)})


async def handle_alert_history_query(ws, data: dict):
    """v4.23.0 · 分页查询告警历史"""
    try:
        page = int(data.get("page") or 1)
        page_size = int(data.get("page_size") or 100)
        rule_name = data.get("rule_name") or None
        status = data.get("status") or None
        since_ts = data.get("since_ts")
        if since_ts is not None:
            since_ts = float(since_ts)
        r = _db.alert_history_query(page, page_size, rule_name, status, since_ts)
        await ws.send_json({"type": "result", "status": "ok", **r})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": str(e)})


async def handle_alert_history_purge(ws, data: dict):
    """v4.23.0 · 清理告警历史（默认 30 天前）"""
    try:
        days = int(data.get("older_than_days") or 30)
        n = _db.alert_history_purge(days)
        await ws.send_json({"type": "result", "status": "ok", "purged": n})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": str(e)})


async def handle_alert_history_stats(ws, data: dict):
    """v4.24.0 · 告警触发次数聚合（按规则/主题/状态）"""
    try:
        since_ts = data.get("since_ts")
        if since_ts is not None:
            since_ts = float(since_ts)
        r = _db.alert_history_stats(since_ts)
        await ws.send_json({"type": "result", "status": "ok", **r})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": str(e)})


async def handle_alert_rules_export(ws, data: dict):
    """v4.24.0 · 导出告警规则（含 SMTP 配置去密码）"""
    try:
        import json as _json
        rules_txt = _db.setting_get("alert_rules", "[]")
        rules = _json.loads(rules_txt) if rules_txt else []
        # 脱敏 secret，导出为纯 JSON
        for r in rules:
            r.pop("secret", None)
        smtp_txt = _db.setting_get("alert_smtp", "{}")
        smtp = _json.loads(smtp_txt) if smtp_txt else {}
        smtp.pop("password", None)
        await ws.send_json({
            "type": "result", "status": "ok",
            "export": {"version": 1, "rules": rules, "smtp": smtp},
        })
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": str(e)})


async def handle_alert_rules_import(ws, data: dict):
    """v4.24.0 · 导入告警规则；mode=append/replace"""
    try:
        import json as _json
        payload = data.get("import") or {}
        rules = payload.get("rules") or []
        if not isinstance(rules, list):
            raise ValueError("rules 必须是数组")
        mode = (data.get("mode") or "append").lower()
        cur_txt = _db.setting_get("alert_rules", "[]")
        cur = _json.loads(cur_txt) if cur_txt else []
        if mode == "replace":
            merged = rules
        else:
            # 按 name 合并（同名以导入的为准）
            names = {r.get("name") for r in rules if r.get("name")}
            merged = [r for r in cur if r.get("name") not in names] + rules
        _db.setting_set("alert_rules", _json.dumps(merged, ensure_ascii=False))
        await ws.send_json({"type": "result", "status": "ok",
                             "imported": len(rules), "total": len(merged)})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": str(e)})

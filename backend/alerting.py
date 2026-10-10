"""v4.23.0 · 事件告警管道（Webhook + Email · 消息模板 · 去抖 · 历史记录）

- 用户在 app_settings.alert_rules 存 JSON 数组，每条：
  { name, topic (支持 fnmatch *), type: webhook|email,
    webhook_url, method, template, silence_sec, at_mobiles,
    email_to, enabled }
- 模板：generic(默认) / feishu / dingtalk / wecom / slack
- 去抖：同名规则在 silence_sec（默认 0=不限）内命中只触发一次
- 每次触发（含失败）写入 alert_history
"""

from __future__ import annotations

import hmac
import base64
import hashlib
import json
import fnmatch
import smtplib
import threading
import time
import urllib.parse
import urllib.request
import urllib.error
from email.mime.text import MIMEText
from email.header import Header
from email.utils import formataddr
from typing import Any, Dict, List, Optional


_rules_cache: List[Dict[str, Any]] = []
_last_load = 0.0
_LOAD_INTERVAL = 30.0

# rule_name → last fired ts（去抖）
_silence: Dict[str, float] = {}
_silence_lock = threading.Lock()


def _load_rules() -> List[Dict[str, Any]]:
    global _rules_cache, _last_load
    now = time.time()
    if now - _last_load < _LOAD_INTERVAL and _rules_cache is not None:
        return _rules_cache
    _last_load = now
    try:
        from backend import db as _db
        raw = _db.setting_get("alert_rules", "")
        if not raw:
            _rules_cache = []; return _rules_cache
        rules = json.loads(raw)
        if not isinstance(rules, list):
            _rules_cache = []; return _rules_cache
        _rules_cache = [r for r in rules if isinstance(r, dict) and r.get("enabled", True)]
    except Exception as e:
        print(f"[alerting] load rules fail: {e}")
        _rules_cache = []
    return _rules_cache


def force_reload() -> int:
    global _last_load
    _last_load = 0.0
    _load_rules()
    return len(_rules_cache)


# ============ 消息模板 ============

def _tmpl_generic(body: dict, rule: dict) -> dict:
    return body


def _tmpl_feishu(body: dict, rule: dict) -> dict:
    """飞书群机器人 · text 类型 + 可选 signature"""
    topic = body.get("topic", "")
    ev = body.get("event", {})
    text = f"[Fonriv 告警] {topic}\n\n"
    try:
        text += json.dumps(ev, ensure_ascii=False, indent=2, default=str)[:1500]
    except Exception:
        text += str(ev)[:1500]
    payload: dict = {"msg_type": "text", "content": {"text": text}}
    # 签名（可选）
    secret = rule.get("secret", "").strip()
    if secret:
        ts_sec = int(time.time())
        sign_str = f"{ts_sec}\n{secret}"
        h = hmac.new(secret.encode("utf-8"), sign_str.encode("utf-8"), hashlib.sha256).digest()
        payload["timestamp"] = str(ts_sec)
        payload["sign"] = base64.b64encode(h).decode("utf-8")
    return payload


def _tmpl_dingtalk(body: dict, rule: dict) -> dict:
    topic = body.get("topic", "")
    ev = body.get("event", {})
    text = f"**[Fonriv] {topic}**\n\n```\n"
    try:
        text += json.dumps(ev, ensure_ascii=False, indent=2, default=str)[:1500]
    except Exception:
        text += str(ev)[:1500]
    text += "\n```"
    at_list = [m.strip() for m in (rule.get("at_mobiles") or "").split(",") if m.strip()]
    return {
        "msgtype": "markdown",
        "markdown": {"title": f"Fonriv 告警 · {topic}", "text": text},
        "at": {"atMobiles": at_list, "isAtAll": rule.get("at_all", False)},
    }


def _tmpl_wecom(body: dict, rule: dict) -> dict:
    """企业微信群机器人 · markdown"""
    topic = body.get("topic", "")
    ev = body.get("event", {})
    md = f"### Fonriv 告警 · {topic}\n>```\n"
    try:
        md += json.dumps(ev, ensure_ascii=False, indent=2, default=str)[:1500]
    except Exception:
        md += str(ev)[:1500]
    md += "\n```"
    return {"msgtype": "markdown", "markdown": {"content": md}}


def _tmpl_slack(body: dict, rule: dict) -> dict:
    return {"text": f"*Fonriv 告警*: `{body.get('topic')}`\n```{json.dumps(body.get('event', {}), ensure_ascii=False, indent=2, default=str)[:1500]}```"}


TEMPLATES = {
    "generic": _tmpl_generic,
    "feishu": _tmpl_feishu,
    "dingtalk": _tmpl_dingtalk,
    "wecom": _tmpl_wecom,
    "slack": _tmpl_slack,
}


def _apply_dingtalk_sign(url: str, secret: str) -> str:
    """钉钉自定义机器人签名：URL 追加 &timestamp=&sign="""
    ts_ms = str(round(time.time() * 1000))
    sign_str = f"{ts_ms}\n{secret}"
    h = hmac.new(secret.encode("utf-8"), sign_str.encode("utf-8"), hashlib.sha256).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(h).decode("utf-8"))
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}timestamp={ts_ms}&sign={sign}"


# ============ SMTP ============

def send_email(to_addr: str, subject: str, body_text: str) -> tuple:
    try:
        from backend import db as _db
        host = _db.setting_get("smtp_host", "").strip()
        port = int(_db.setting_get("smtp_port", "465") or 465)
        user = _db.setting_get("smtp_user", "").strip()
        pwd = _db.setting_get("smtp_pass", "")
        from_addr = _db.setting_get("smtp_from", "").strip() or user
        ssl_mode = _db.setting_get("smtp_ssl", "ssl")
        if not host or not from_addr:
            return (False, "SMTP 未配置（缺少 host 或 from）")
        msg = MIMEText(body_text, "plain", "utf-8")
        msg["Subject"] = Header(subject, "utf-8")
        msg["From"] = formataddr(("Fonriv", from_addr))
        msg["To"] = to_addr
        if ssl_mode == "ssl":
            with smtplib.SMTP_SSL(host, port, timeout=10) as s:
                if user: s.login(user, pwd)
                s.sendmail(from_addr, [to_addr], msg.as_string())
        elif ssl_mode == "starttls":
            with smtplib.SMTP(host, port, timeout=10) as s:
                s.ehlo(); s.starttls(); s.ehlo()
                if user: s.login(user, pwd)
                s.sendmail(from_addr, [to_addr], msg.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=10) as s:
                if user: s.login(user, pwd)
                s.sendmail(from_addr, [to_addr], msg.as_string())
        return (True, "")
    except Exception as e:
        return (False, str(e))


def _fire_email(to_addr: str, body: dict, rule: dict) -> None:
    from backend import db as _db
    topic = body.get("topic", "")
    name = rule.get("name", "?")
    subject = f"[Fonriv] 告警 · {topic}"
    text = json.dumps(body, ensure_ascii=False, indent=2, default=str)
    ok, err = send_email(to_addr, subject, text)
    if not ok:
        print(f"[alerting] email '{name}' → {to_addr} fail: {err}")
    _db.alert_history_insert(name, topic, "email", to_addr,
                              "ok" if ok else "err", err,
                              json.dumps(body, ensure_ascii=False, default=str)[:2000])


def _fire_webhook(url: str, method: str, body: dict, rule: dict) -> None:
    from backend import db as _db
    name = rule.get("name", "?")
    topic = body.get("topic", "")
    tmpl = (rule.get("template") or "generic").lower()
    fn = TEMPLATES.get(tmpl, _tmpl_generic)
    try:
        payload_obj = fn(body, rule)
        # 钉钉 URL 签名
        real_url = url
        if tmpl == "dingtalk" and rule.get("secret"):
            real_url = _apply_dingtalk_sign(url, rule["secret"])
        data = json.dumps(payload_obj, ensure_ascii=False, default=str).encode("utf-8")
        req_method = (method or "POST").upper()
        if req_method == "GET":
            sep = "&" if "?" in real_url else "?"
            u = f"{real_url}{sep}topic={topic}&ts={body.get('ts','')}"
            req = urllib.request.Request(u, method="GET")
        else:
            req = urllib.request.Request(real_url, data=data, method="POST",
                                          headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            code = resp.getcode()
            status = "ok" if code < 400 else "err"
            err = "" if code < 400 else f"HTTP {code}"
            if code >= 400:
                print(f"[alerting] webhook '{name}' HTTP {code}")
    except urllib.error.URLError as e:
        status = "err"; err = f"url error: {e}"
        print(f"[alerting] webhook '{name}' {err}")
    except Exception as e:
        status = "err"; err = str(e)
        print(f"[alerting] webhook '{name}' fail: {e}")
    _db.alert_history_insert(name, topic, "webhook", url, status, err,
                              json.dumps(body, ensure_ascii=False, default=str)[:2000])


def _should_silence(name: str, silence_sec: int) -> bool:
    if silence_sec <= 0:
        return False
    now = time.time()
    with _silence_lock:
        last = _silence.get(name, 0)
        if now - last < silence_sec:
            return True
        _silence[name] = now
    return False


def _on_event(topic: str, payload: Any) -> None:
    if topic == "system.heartbeat" or topic == "system.stats":
        return
    rules = _load_rules()
    if not rules:
        return
    body = {"topic": topic, "ts": time.time(), "event": payload}
    for r in rules:
        pat = r.get("topic", "*")
        try:
            if not fnmatch.fnmatch(topic, pat):
                continue
            name = r.get("name", pat)
            silence_sec = int(r.get("silence_sec", 0) or 0)
            if _should_silence(name, silence_sec):
                continue
            typ = r.get("type", "webhook")
            if typ == "email":
                to_addr = (r.get("email_to") or "").strip()
                if not to_addr:
                    continue
                t = threading.Thread(target=_fire_email,
                                     args=(to_addr, body, r), daemon=True)
                t.start()
            else:
                url = r.get("webhook_url") or ""
                if not url:
                    continue
                method = r.get("method", "POST")
                t = threading.Thread(target=_fire_webhook,
                                     args=(url, method, body, r), daemon=True)
                t.start()
        except Exception as e:
            print(f"[alerting] rule '{r.get('name','?')}' dispatch fail: {e}")


_started = False


def start() -> None:
    global _started
    if _started:
        return
    _started = True
    try:
        from backend import events as _events
        _events.subscribe_all(_on_event)
        print("[alerting] started · subscribed to all events")
    except Exception as e:
        print(f"[alerting] start fail: {e}")

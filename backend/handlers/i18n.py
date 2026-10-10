"""Fonriv - 界面语言偏好 WS handler (v4.74.0)"""
from __future__ import annotations

from fastapi import WebSocket

from backend import db
from backend.i18n import user_lang, set_user_lang, EN as EN_DICT

_ALLOWED = {"zh", "en"}


def _uid(ws) -> int:
    try:
        u = getattr(ws, "user", None) or {}
        return int(u.get("id") or 1)
    except Exception:
        return 1


async def handle_ui_lang_set(ws, data: dict):
    _req_id = data.get("req_id") or ""
    code = (data.get("lang") or "").strip().lower()
    if code not in _ALLOWED:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"不支持的语言: {code}"})
        return
    uid = _uid(ws)
    set_user_lang(uid, code)
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                        "lang": code, "msg": "语言偏好已保存"})


async def handle_ui_lang_get(ws, data: dict):
    uid = _uid(ws)
    await ws.send_json({"type": "result", "status": "ok",
                        "lang": user_lang(uid),
                        "available": [{"code": "zh", "label": "简体中文", "flag": "🇨🇳"},
                                      {"code": "en", "label": "English", "flag": "🇺🇸"}],
                        "translated": len(EN_DICT)})

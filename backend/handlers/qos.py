"""Fonriv - QoS 带宽时间表 WS handler (v4.59.0)"""
from __future__ import annotations

from fastapi import WebSocket

from backend.qos import get_config, set_config


async def handle_qos_get(ws, data: dict):
    await ws.send_json({"type": "result", "status": "ok", "qos": get_config()})


async def handle_qos_set(ws, data: dict):
    _req_id = data.get("req_id") or ""
    enabled = bool(data.get("enabled"))
    rules = data.get("rules") or []
    try:
        cfg = set_config(enabled, rules)
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "msg": f"QoS 已{'启用' if cfg['enabled'] else '停用'} · {len(cfg['rules'])} 条时段规则",
                            "qos": cfg})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"保存失败: {e}"})

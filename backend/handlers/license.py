"""Fonriv 社区版 · 授权状态 handler (WS action)

前端可见的授权状态:
    license_get     -> 当前授权摘要 (版本 / 功能开关 / 限额)
    license_install -> 社区版无需授权, 礼貌拒绝 (保留动作名, 前端不再提供入口)
    license_remove  -> 同上
"""
from __future__ import annotations

from backend import license as lic
from backend.auth import _require_admin


async def handle_license_get(ws, data):
    """查询当前授权状态 + 功能开关表

    v4.44.1 修复: 原回包 dict 里写了两个 "status" 键 (WS 层 "ok" + license 状态),
    Python 后值覆盖前值 -> WS 层 status 恒等于 license 状态 (valid/...),
    license.js 面板 `r.status === 'ok'` 判断从未通过。现 license 状态只留在
    summary["status"], WS 层恒为 "ok"。
    """
    try:
        summary = lic.get_status_summary()
        await ws.send_json({"type": "result", "status": "ok", "req_id": data.get("req_id", ""),
                            "license": summary,
                            "edition": summary.get("edition"),
                            "feature_editions": summary.get("feature_editions") or {},
                            "limits": summary.get("limits") or {}})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": data.get("req_id", ""),
                            "msg": f"授权状态查询失败: {e}"})


async def handle_license_install(ws, data):
    """安装 license —— 开源社区版无需授权, 礼貌拒绝"""
    if not await _require_admin(ws):
        return
    await ws.send_json({"type": "result", "status": "ok", "req_id": data.get("req_id", ""),
                        "msg": "社区版为开源软件 (AGPL-3.0), 永久免费, 无需安装授权文件"})


async def handle_license_remove(ws, data):
    """移除 license —— 开源社区版无需授权, 礼貌拒绝"""
    if not await _require_admin(ws):
        return
    await ws.send_json({"type": "result", "status": "ok", "req_id": data.get("req_id", ""),
                        "msg": "社区版为开源软件 (AGPL-3.0), 无需移除授权"})

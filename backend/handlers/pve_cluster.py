"""Fonriv - D4 PVE 集群视图 + 跨节点 VM 迁移 (v4.86.0)

基于 pve_api.py 的 Token/Ticket 认证, 扩展:
  - 集群状态汇总 (所有节点资源/VM/CT 一屏视图)
  - 跨节点 VM 迁移 (online/offline)
  - 节点级 VM 批量操作

动作:
  pve_api_cluster   集群视图 (节点+VM+CT+存储 汇总)
  pve_api_migrate   跨节点 VM 迁移
  pve_api_vm_op     VM/CT 电源操作 (start/stop/reboot/shutdown)
"""
from __future__ import annotations

import asyncio
import json
import os
import shlex
import urllib.error
import urllib.parse
import urllib.request

from fastapi import WebSocket, WebSocketDisconnect

from backend.log import log_operation
from backend.handlers.pve_api import _pve_get, _pve_post, _get_auth, _err_msg, _ssl_ctx


async def _pve_action(host, node, vtype, vmid, action, token, ticket, csrf, params=None):
    """对 VM/CT 执行操作 (start/stop/reboot/shutdown/migrate)。"""
    url = f"/api2/json/nodes/{node}/{vtype}/{vmid}/{action}"
    if action == "migrate" and params:
        body = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
        req = urllib.request.Request(
            f"https://{host}:8006/api2/json{url}", data=body.encode())
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    else:
        req = urllib.request.Request(f"https://{host}:8006/api2/json{url}")
        req.method = "POST"
    if token:
        req.add_header("Authorization", f"PVEAPIToken={token}")
    elif ticket:
        req.add_header("Cookie", f"PVEAuthCookie={ticket}")
        req.add_header("CSRFPreventionToken", csrf)
    loop = asyncio.get_event_loop()
    def _do():
        ctx = _ssl_ctx()
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            return json.loads(resp.read())
    return await loop.run_in_executor(None, _do)


async def handle_pve_api_cluster(ws, data: dict):
    """集群视图: 汇总所有节点+VM+CT+存储。"""
    _req = data.get("req_id") or ""
    host = (data.get("host") or "").strip()
    if not host:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 host"})
        return
    try:
        token, ticket, csrf = await _get_auth(data)
        # 节点
        nr = await _pve_get(host, "/api2/json/nodes", token=token, ticket=ticket, csrf=csrf)
        nodes = []
        vms_all = []
        for n in (nr.get("data") or []):
            node = n.get("node", "")
            nodes.append({
                "node": node, "status": n.get("status", ""),
                "cpu_pct": round((n.get("cpu") or 0) * 100, 1),
                "mem_used": n.get("mem", 0), "mem_total": n.get("maxmem", 0),
                "disk_used": n.get("disk", 0), "disk_total": n.get("maxdisk", 0),
                "uptime": n.get("uptime", 0),
            })
            # VM/CT
            for vtype in ("qemu", "lxc"):
                try:
                    vr = await _pve_get(host, f"/api2/json/nodes/{node}/{vtype}",
                                        token=token, ticket=ticket, csrf=csrf)
                    for v in vr.get("data") or []:
                        vms_all.append({
                            "vmid": v.get("vmid"), "name": v.get("name", ""),
                            "type": vtype, "node": node, "status": v.get("status", ""),
                            "cpus": v.get("cpus", 0), "maxmem": v.get("maxmem", 0),
                            "maxdisk": v.get("maxdisk", 0), "tags": v.get("tags", ""),
                        })
                except Exception:
                    pass
        # 存储 (第一个在线节点)
        storages = []
        online = [n for n in nodes if n["status"] == "online"]
        if online:
            try:
                sr = await _pve_get(host, f"/api2/json/nodes/{online[0]['node']}/storage",
                                    token=token, ticket=ticket, csrf=csrf)
                for s in sr.get("data") or []:
                    storages.append({
                        "storage": s.get("storage", ""), "type": s.get("type", ""),
                        "content": s.get("content", ""), "total": s.get("total", 0),
                        "used": s.get("used", 0), "avail": s.get("avail", 0),
                    })
            except Exception:
                pass
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "nodes": nodes, "vms": vms_all, "storages": storages})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"集群视图获取失败: {_err_msg(e)}"})


async def handle_pve_api_migrate(ws, data: dict):
    """跨节点 VM 迁移。params: host, node(源), vmid, type(qemu|lxc), target(目标节点), online(0|1)"""
    _req = data.get("req_id") or ""
    host = (data.get("host") or "").strip()
    node = (data.get("node") or "").strip()
    vmid = data.get("vmid")
    vtype = (data.get("type") or "qemu").strip()
    target_node = (data.get("target") or "").strip()
    online = int(data.get("online") or 0)
    if not host or not node or not vmid or not target_node:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "缺少 host/node/vmid/target"})
        return
    if node == target_node:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "源与目标节点相同"})
        return
    try:
        token, ticket, csrf = await _get_auth(data)
        params = {"target": target_node, "online": online}
        r = await _pve_action(host, node, vtype, vmid, "migrate", token, ticket, csrf, params)
        upid = (r.get("data") or "")
        log_operation("PVE 迁移", f"{vtype}/{vmid} {node} → {target_node} · UPID={upid[:60]}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": f"迁移任务已提交: {vtype}/{vmid} {node} → {target_node}" +
                                   (" (在线)" if online else " (离线)"),
                            "upid": upid})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"迁移失败: {_err_msg(e)}"})


async def handle_pve_api_vm_op(ws, data: dict):
    """VM/CT 电源操作。params: host, node, vmid, type, op(start|stop|reboot|shutdown)"""
    _req = data.get("req_id") or ""
    host = (data.get("host") or "").strip()
    node = (data.get("node") or "").strip()
    vmid = data.get("vmid")
    vtype = (data.get("type") or "qemu").strip()
    op = (data.get("op") or "").strip()
    if op not in ("start", "stop", "reboot", "shutdown"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"不支持: {op}"})
        return
    try:
        token, ticket, csrf = await _get_auth(data)
        r = await _pve_action(host, node, vtype, vmid, op, token, ticket, csrf)
        upid = r.get("data") or ""
        log_operation("PVE VM 操作", f"{op} {vtype}/{vmid} @ {node}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": f"✓ {op} {vtype}/{vmid} 已提交", "upid": upid})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"操作失败: {_err_msg(e)}"})

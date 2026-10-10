"""v5.19.1 · 核心运行状况 WS 入口 (薄封装 backend.core_fabric.vitals / resilience)"""
from __future__ import annotations

from fastapi import WebSocket, WebSocketDisconnect


async def handle_vitals_overview(ws, data: dict):
    """板块1: 核心模块 / 端点类型 / 引擎注册 / 任务注册 / 分层架构 / 路由模式"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import vitals
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **vitals.overview()})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"概览失败: {e}"})


async def handle_vitals_endpoints(ws, data: dict):
    """板块2: 端点抽象模型连接状况 (按 EndpointKind 分组) + 传输方向统计"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import vitals
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **vitals.endpoints_status()})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"端点查询失败: {e}"})


async def handle_vitals_host(ws, data: dict):
    """板块6: 宿主机 CPU/内存/磁盘/网络 + 告警"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import vitals
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **vitals.host_health()})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"资源查询失败: {e}"})


async def handle_vitals_selfcheck(ws, data: dict, task_id: str = ""):
    """综合自检: 服务/资源/任务/日志 汇总 + 总体结论"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import vitals
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **vitals.selfcheck()})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"自检失败: {e}"})


async def handle_vitals_resilience(ws, data: dict):
    """容错回退链: 降级命中统计 + 内置回退策略清单"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import vitals, resilience
        payload = vitals.resilience_stats()
        payload["live"] = resilience.fallback_summary()
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **payload})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"回退统计失败: {e}"})


async def handle_vitals_kill_stalled(ws, data: dict):
    """卡死任务检测/处置。params: threshold(秒), force(1=真正终止, 默认只报告)"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import resilience, vitals
        th = int(data.get("threshold") or vitals.thresholds().get("task_stall_sec", 900))
        force = bool(data.get("force"))
        res = await resilience.kill_stalled(threshold_sec=th, dry_run=not force)
        if force and res.get("killed"):
            try:
                from backend.log import log_operation
                log_operation("核心自检", f"终止卡死任务 {len(res['killed'])} 个 (阈值 {th}s)")
            except Exception:
                pass
        msg = (f"发现 {len(res['stalled'])} 个卡死任务" + (f", 已终止 {len(res['killed'])} 个" if force else " (未处置, 仅报告)")) \
              if res["stalled"] else "未发现卡死任务"
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "msg": msg, **res})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"卡死检测失败: {e}"})


# ═══ 第二期: 板块 3/4/5 ═══

async def handle_vitals_engines(ws, data: dict):
    """板块3: 引擎与路由矩阵 (引擎能力 + 工具版本 + 路由模式实现状态)"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import vitals
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **vitals.engines_matrix()})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"引擎矩阵失败: {e}"})


async def handle_vitals_security(ws, data: dict):
    """板块4: 三层安全 + 授权状态 + 用户权限矩阵"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import vitals
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **vitals.security_matrix()})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"安全矩阵失败: {e}"})


async def handle_vitals_plugins(ws, data: dict):
    """板块5: 插件/工具探测 + 功能分组 + 页面清单"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import vitals
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **vitals.plugins_matrix()})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"插件矩阵失败: {e}"})


async def handle_run_trace(ws, data: dict):
    """日志链路回溯: 串起 Planner 决策 → Executor 执行 → Ledger 对账 → 操作日志
    params: run_id (必填)"""
    _req = data.get("req_id") or ""
    rid = (data.get("run_id") or "").strip()
    if not rid:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 run_id"})
        return
    try:
        from backend.core_fabric import runlog
        res = runlog.trace(rid)
        if not res.get("run") and not res.get("stages"):
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": f"未找到任务 {rid} 的链路记录 (可能已轮转清理)"})
            return
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **res})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"链路回溯失败: {e}"})


# ═══ v5.19.4 · 跨网段节点直连协调 ═══

async def handle_punch_create(ws, data: dict):
    """创建直连协商会话。params: name, note"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import punch
        s = punch.create_session(data.get("name") or "", data.get("note") or "")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "session": s["id"], "name": s["name"],
                            "msg": f"✓ 直连协商会话已创建: {s['id']} — 两端分别调用 punch_register 登记"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"创建失败: {e}"})


async def handle_punch_register(ws, data: dict):
    """登记一端候选地址。params: session, side(a|b), listen_port, advertise(列表)
    控制面观测到的来源 IP 自动填入 (网络地址转换外侧地址)。"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import punch
        sid = (data.get("session") or "").strip()
        side = (data.get("side") or "").strip().lower()
        observed = ""
        try:
            observed = ws.client.host if getattr(ws, "client", None) else ""
        except Exception:
            observed = ""
        adv = data.get("advertise") or []
        if isinstance(adv, str):
            adv = [x.strip() for x in adv.split(",") if x.strip()]
        r = punch.register_peer(sid, side, observed_ip=observed, advertise=adv,
                                listen_port=int(data.get("listen_port") or 0))
        if not r.get("ok"):
            await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": r.get("msg")})
            return
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **r,
                            "observed_ip": observed,
                            "msg": f"✓ {side} 端已登记 (控制面观测来源地址: {observed or '未知'}, "
                                   f"候选 {r.get('candidate_count')} 个)"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"登记失败: {e}"})


async def handle_punch_attempt(ws, data: dict):
    """执行直连探测 (探测候选可达性并给出结论)。params: session, timeout"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import punch
        sid = (data.get("session") or "").strip()
        to = float(data.get("timeout") or 2.0)
        r = await punch.attempt(sid, timeout=min(6.0, max(0.5, to)))
        await ws.send_json({"type": "result", "status": "ok" if r.get("verdict", True) else "warn",
                            "req_id": _req, **r,
                            "msg": ("✓ " if r.get("direct_feasible") else "⚠ ") + str(r.get("reason") or r.get("msg"))})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"直连探测失败: {e}"})


async def handle_punch_list(ws, data: dict):
    """列出活跃直连协商会话"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import punch
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "sessions": punch.list_sessions(),
                            "local_ips": punch.local_addresses()})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": str(e)[:120]})


async def handle_punch_cancel(ws, data: dict):
    """取消直连协商会话。params: session"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import punch
        ok = punch.cancel_session((data.get("session") or "").strip())
        await ws.send_json({"type": "result", "status": "ok" if ok else "error", "req_id": _req,
                            "msg": "✓ 已取消" if ok else "会话不存在"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": str(e)[:120]})


async def handle_punch_fallback(ws, data: dict):
    """根据直连探测结论给出传输路径建议 (直连 / 中继回退)。params: session"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import punch
        r = punch.fallback_plan((data.get("session") or "").strip())
        await ws.send_json({"type": "result", "status": "ok" if r.get("ok") else "error",
                            "req_id": _req, **r, "msg": r.get("msg") or ""})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": str(e)[:120]})


# ═══ v5.19.5 · 引擎命令清单 / 跨任务链路 ═══

async def handle_vitals_commands(ws, data: dict):
    """引擎命令清单: 对每引擎以代表性参数展开 build() → 可读命令列表。
    这回答「引擎支持哪些命令、命令长什么样、一共多少条」。"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric.providers import build, TransferSpec
        results = []
        # rsync: 三种方向 + 变体
        cases = [
            ("rsync", "push (SSH)", TransferSpec(src="/data/src/", dst="/backup/", direction="up",
                                                 engine="rsync", host="192.0.2.10", user="root",
                                                 flags=["-a", "-v", "-z", "--partial"])),
            ("rsync", "pull (SSH)", TransferSpec(src="/remote/data/", dst="/local/", direction="down",
                                                 engine="rsync", host="192.0.2.10", user="root",
                                                 flags=["-a", "-v", "--partial"])),
            ("rsync", "local", TransferSpec(src="/a/", dst="/b/", direction="local", engine="rsync")),
            ("rsync", "bwlimit", TransferSpec(src="/a/", dst="/b/", direction="local", engine="rsync",
                                              bwlimit="2m", flags=["-a"])),
            ("rsync", "exclude", TransferSpec(src="/a/", dst="/b/", direction="local", engine="rsync",
                                              exclude="*.log, .git", flags=["-a"])),
            ("rclone", "push (SFTP)", TransferSpec(src="/data/", dst="/backup/", direction="up",
                                                   engine="rclone", host="192.0.2.10", user="root",
                                                   password="pw")),
            ("rclone", "concurrency", TransferSpec(src="/data/", dst="/backup/", direction="up",
                                                   engine="rclone", host="192.0.2.10",
                                                   password="pw", rclone_transfers=8)),
        ]
        for engine, label, spec in cases:
            try:
                b = build(spec)
                argv = b.get("argv") or []
                results.append({
                    "engine": engine, "label": label, "ok": bool(b.get("ok", True)),
                    "cmd": " ".join(str(x) for x in argv)[:400],
                    "count": len(argv),
                    "kind": b.get("kind") or ("local" if engine == "rsync" else "ssh"),
                })
            except Exception as e:
                results.append({"engine": engine, "label": label, "ok": False,
                                "cmd": f"构建失败: {e}", "count": 0})
        # 每引擎的 flag 集 (来自 build 内部常量, 展示用户可配置项)
        flags_doc = {
            "rsync": ["-a 归档模式", "-v 详细", "-z 压缩", "--partial 保留半传",
                      "--bwlimit=2m 限速", "--exclude 排除", "--files-from 分片",
                      "--delete 镜像删除", "--checksum 校验优先", "--link-dest 硬链接快照"],
            "rclone": ["--transfers 并发", "--checkers 校验并发", "--bwlimit 限速",
                       "--checksum", "--dry-run", "--backup-dir 版本化"],
        }
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "cases": results,
                            "total": len(results),
                            "flags_doc": flags_doc})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"命令清单失败: {e}"})


async def handle_trace_tree(ws, data: dict):
    """跨任务链路关联树。params: flow_id 或 parent_run_id"""
    _req = data.get("req_id") or ""
    flow_id = int(data.get("flow_id") or 0)
    parent = (data.get("parent_run_id") or "").strip()
    if not flow_id and not parent:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "缺少 flow_id 或 parent_run_id"})
        return
    try:
        from backend.core_fabric import runlog
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            **runlog.tree(flow_id=flow_id, parent_run_id=parent)})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"关联树失败: {e}"})


async def handle_punch_attempt_quic(ws, data: dict):
    """UDP 通道探测 (与 TCP 直连探测互补)。params: session, timeout"""
    _req = data.get("req_id") or ""
    try:
        from backend.core_fabric import punch
        sid = (data.get("session") or "").strip()
        to = float(data.get("timeout") or 3.0)
        r = await punch.attempt_quic(sid, timeout=min(8.0, max(0.5, to)))
        ok = r.get("quic_feasible")
        await ws.send_json({"type": "result", "status": "ok" if ok else "warn",
                            "req_id": _req, **r,
                            "msg": ("✓ UDP 通道可达 — 可走多流数据通道" if ok
                                    else "⚠ UDP 通道不可达 — " + str(r.get("note") or ""))})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"UDP 通道探测失败: {e}"})

"""Fonriv - 平台检测 handler (v4.0.0-alpha1)。

新增两个 WebSocket action：
  - platform_list    : 返回所有已注册平台的静态元信息（不需要 SSH）
  - platform_detect  : SSH 到目标机跑探针，返回最佳匹配 + 各平台评分
"""
from __future__ import annotations
import logging

from backend.ssh_lib import SSHTarget, sanitize_output
from backend.platforms import all_platforms, pick_best, get_platform
from backend.platforms.detector import probe as _probe


def _pwd(target) -> str:
    return getattr(target.auth, "password", "") or ""


def _key(target) -> str:
    return getattr(target.auth, "key_path", "") or ""


async def handle_platform_list(ws, data):
    """无需 SSH：返回全部平台的静态元信息，供前端渲染下拉/徽章。"""
    platforms = [cls.describe() for cls in all_platforms()]
    await ws.send_json({
        "type": "result", "status": "ok",
        "msg": f"共 {len(platforms)} 个平台适配器",
        "platforms": platforms,
    })


async def handle_platform_detect(ws, data):
    """SSH 探针：识别目标机是什么平台。全程只读，绝不改远端。

    可选参数 with_workloads=True/1 → 顺带调用 platform.detect_workloads()，
    返回 workloads 数组（vm/ct/storage/docker/systemd/share/plugin ...）。
    """
    target = SSHTarget.from_ws_data(data)
    host = target.host
    if not host:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少服务器地址"})
        return

    with_workloads = bool(data.get("with_workloads"))

    await ws.send_json({"type": "log", "level": "info",
                        "msg": f"正在探测平台 {host} ..."})
    await ws.send_json({"type": "progress", "pct": 20, "text": "连接服务器..."})

    workloads = []
    workloads_error = ""
    try:
        async with target.runner() as run:
            await ws.send_json({"type": "progress", "pct": 40, "text": "运行只读探针..."})
            parsed = await _probe(run)
            best_cls, confidence, scores = pick_best(parsed)
            if with_workloads:
                await ws.send_json({"type": "progress", "pct": 70,
                                    "text": f"扫描 {best_cls.DISPLAY} 工作负载..."})
                try:
                    inst = best_cls()
                    ws_list = await inst.detect_workloads(run)
                    workloads = [w.to_dict() for w in ws_list]
                except NotImplementedError:
                    workloads_error = "该平台 detect_workloads 未实现"
                except Exception as e:
                    workloads_error = sanitize_output(str(e), _pwd(target), _key(target))[:200]
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "result", "status": "error", "msg": safe})
        return

    describe = best_cls.describe()

    await ws.send_json({"type": "progress", "pct": 100, "text": "探测完成"})
    await ws.send_json({
        "type": "result", "status": "ok",
        "msg": f"识别为 {describe['display']} (置信度 {confidence})"
               + (f" · workloads={len(workloads)}" if with_workloads else ""),
        "host": host,
        "platform": describe["name"],
        "display": describe["display"],
        "icon": describe["icon"],
        "notes": describe["notes"],
        "confidence": confidence,
        "scores": scores,
        "probe": {
            "os_id":        parsed.get("os_id", ""),
            "uname":        parsed.get("uname", ""),
            "hostname":     parsed.get("hostname", ""),
            "is_pve":       bool(parsed.get("is_pve")),
            "is_omv":       bool(parsed.get("is_omv")),
            "is_syno":      bool(parsed.get("is_syno")),
            "has_qm":       bool(parsed.get("has_qm")),
            "has_pct":      bool(parsed.get("has_pct")),
            "has_docker":   bool(parsed.get("has_docker")),
            "has_zfs":      bool(parsed.get("has_zfs")),
            "has_systemctl":bool(parsed.get("has_systemctl")),
        },
        "manifest": describe["manifest"],
        "workloads_hint": describe["workloads_hint"],
        "workloads": workloads,
        "workloads_error": workloads_error,
    })
    await ws.send_json({"type": "log", "level": "info",
                        "msg": f"✓ 探测完成: {describe['name']} (conf={confidence}) "
                               f"workloads={len(workloads)} scores={scores}"})


async def handle_platform_plan_backup(ws, data):
    """(alpha3) 只读预演备份计划。

    payload:
      host/port/user/auth_type/...    · 标准 SSHTarget
      platform  (可选)                · 强制平台 · 缺则自动探测
      selected_keys (可选 list[str])  · manifest 中的 key 列表 · 缺则用默认选项
    """
    target = SSHTarget.from_ws_data(data)
    host = target.host
    if not host:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少服务器地址"})
        return

    forced = (data.get("platform") or "").strip()
    selected_keys = data.get("selected_keys")
    if isinstance(selected_keys, str):
        selected_keys = [k.strip() for k in selected_keys.split(",") if k.strip()]

    await ws.send_json({"type": "log", "level": "info",
                        "msg": f"预演备份计划 {host} ..."})
    await ws.send_json({"type": "progress", "pct": 10, "text": "连接服务器..."})

    try:
        async with target.runner() as run:
            if forced:
                best_cls = get_platform(forced)
                confidence = 100
                scores = {forced: 100}
            else:
                await ws.send_json({"type": "progress", "pct": 25, "text": "探测平台..."})
                parsed = await _probe(run)
                best_cls, confidence, scores = pick_best(parsed)

            await ws.send_json({"type": "progress", "pct": 45,
                                "text": f"扫描 {best_cls.DISPLAY} 备份项..."})
            try:
                plan = await best_cls().plan_backup(run, selected_keys)
            except NotImplementedError:
                await ws.send_json({"type": "result", "status": "error",
                                    "msg": f"{best_cls.DISPLAY} 尚未实现 plan_backup（alpha3 只完成 linux_generic/OMV）"})
                return
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "result", "status": "error", "msg": safe})
        return

    summary = plan.get("summary", {})
    await ws.send_json({"type": "progress", "pct": 100, "text": "预演完成"})
    await ws.send_json({
        "type": "result", "status": "ok",
        "msg": (f"预演完成: {summary.get('existing_items', 0)}/{summary.get('total_items', 0)} 项存在 · "
                f"合计 {summary.get('total_size_bytes', 0)} 字节"),
        "host": host,
        "platform": best_cls.NAME,
        "display": best_cls.DISPLAY,
        "confidence": confidence,
        "scores": scores,
        "plan": plan,
    })


async def handle_platform_execute_backup(ws, data):
    """(alpha4) 真备份执行：远端 tar 走 stdout · 本地文件落盘 · sha256 校验。

    payload:
      host/port/user/auth_type/...     · SSHTarget
      platform      (可选)             · 强制平台 · 缺则自动探测
      selected_keys (可选 list[str])   · 缺则备份 default_selected 项
      compressor    (可选)             · gzip|zstd|none · 默认 gzip
      local_dir     (可选)             · 相对/绝对目录 · 默认 data/backups/generic/<host>/
      label         (可选)             · 文件名后缀 · 默认时间戳
    """
    import os, time, uuid
    from backend import db as _db

    target = SSHTarget.from_ws_data(data)
    host = target.host
    if not host:
        await ws.send_json({"type": "result", "status": "error", "msg": "缺少服务器地址"})
        return

    forced = (data.get("platform") or "").strip()
    selected_keys = data.get("selected_keys")
    if isinstance(selected_keys, str):
        selected_keys = [k.strip() for k in selected_keys.split(",") if k.strip()]
    compressor = (data.get("compressor") or "gzip").strip()
    label = (data.get("label") or time.strftime("%Y%m%d_%H%M%S")).strip()
    local_dir = (data.get("local_dir") or f"data/backups/generic/{host}").rstrip("/")
    local_dst = f"{local_dir}/{label}"

    # v4.25.0 · 用户手动追加的额外路径
    extra_paths = data.get("extra_paths") or []
    if isinstance(extra_paths, str):
        extra_paths = [p.strip() for p in extra_paths.split("\n") if p.strip()]
    extra_paths = [p for p in extra_paths if isinstance(p, str) and p.strip()]

    task_id = f"platform_backup_{uuid.uuid4().hex[:12]}"
    try:
        _db.task_create(task_id, f"备份 {host}", "platform_backup", command="tar")
    except Exception as _e: logging.debug("suppressed", exc_info=True)
    # v4.27.0 · 进程级 log buffer 供 tail -f
    from backend import log_buffers as _lb
    _lb.append(task_id, f"[platform_backup] task_id={task_id} host={host}")

    await ws.send_json({"type": "log", "level": "info",
                        "msg": f"开始备份 {host} → {local_dst} ..."})
    await ws.send_json({"type": "progress", "pct": 5, "text": "连接服务器..."})

    async def _prog(bytes_transferred, elapsed):
        # 走进度条 · 由于 tar 是流 · 不知道总大小 · 只回报字节数和速度
        speed = (bytes_transferred / max(elapsed, 0.001)) / 1024 / 1024
        await ws.send_json({
            "type": "progress", "pct": 60,  # 保持在 60% · 前端可自定义
            "text": f"已传输 {bytes_transferred / 1024 / 1024:.1f} MB · {speed:.1f} MB/s",
        })

    backup_id = None
    try:
        async with target.runner() as run:
            # 平台选定
            if forced:
                best_cls = get_platform(forced)
                confidence = 100
            else:
                await ws.send_json({"type": "progress", "pct": 15, "text": "探测平台..."})
                parsed = await _probe(run)
                best_cls, confidence, _ = pick_best(parsed)

            # 预演
            await ws.send_json({"type": "progress", "pct": 30, "text": "预演备份计划..."})
            try:
                plan = await best_cls().plan_backup(run, selected_keys)
            except NotImplementedError:
                await ws.send_json({"type": "result", "status": "error",
                                    "msg": f"{best_cls.DISPLAY} 尚未实现 plan_backup"})
                return

            existing = plan["summary"]["existing_items"]
            if existing == 0 and not extra_paths:
                await ws.send_json({"type": "result", "status": "error",
                                    "msg": "预演结果无可备份项"})
                return

            # v4.25.0 · 把用户额外路径追加为虚拟备份项（stat 一下拿到 exists/size）
            if extra_paths:
                await ws.send_json({"type": "progress", "pct": 35,
                                    "text": f"追加 {len(extra_paths)} 条额外路径..."})
                import shlex as _shlex
                for idx, p in enumerate(extra_paths):
                    qp = _shlex.quote(p)
                    stat_cmd = (
                        f"if [ -e {qp} ]; then "
                        f"sz=$(du -sb {qp} 2>/dev/null | awk '{{print $1}}'); "
                        f"cnt=$(find {qp} -type f 2>/dev/null | wc -l); "
                        f"echo OK $sz $cnt; else echo MISS 0 0; fi"
                    )
                    try:
                        code, out, _ = await run.exec(stat_cmd, timeout=30, merge_stderr=True)
                        exists = False; sz = 0; cnt = 0
                        if code == 0 and out.startswith("OK"):
                            parts = out.strip().split()
                            exists = True
                            try: sz = int(parts[1])
                            except Exception: sz = 0
                            try: cnt = int(parts[2])
                            except Exception: cnt = 0
                    except Exception:
                        exists = False; sz = 0; cnt = 0
                    plan.setdefault("items", []).append({
                        "key": f"__extra_{idx}",
                        "display": f"📎 额外: {p}",
                        "kind": "path",
                        "paths": [p],
                        "exists": exists,
                        "size_bytes": sz,
                        "count": cnt,
                    })
                    # 更新 summary
                    s = plan.setdefault("summary", {})
                    s["total_items"] = s.get("total_items", 0) + 1
                    if exists:
                        s["existing_items"] = s.get("existing_items", 0) + 1
                        s["total_size_bytes"] = s.get("total_size_bytes", 0) + sz
                existing = plan["summary"].get("existing_items", 0)
                if existing == 0:
                    await ws.send_json({"type": "result", "status": "error",
                                        "msg": "所有备份项和额外路径在远端都不存在"})
                    return

            # 写 db (running)
            try:
                # config_id=NULL (通过 platform 备份不关联特定 config)
                # v4.7.0: 透传当前登录用户 · 多用户隔离
                from backend.auth import _get_user_id as _auth_uid
                _uid = _auth_uid(ws)
                backup_id = _db.backup_create(None, host, local_dst,
                                               "platform", task_id=task_id,
                                               user_id=_uid)
            except Exception as e:
                await ws.send_json({"type": "log", "level": "warn",
                                    "msg": f"db backup_create 失败: {e}"})

            # 执行
            await ws.send_json({"type": "progress", "pct": 40,
                                "text": f"打包 {existing} 项 · 压缩 {compressor} ..."})
            try:
                result = await best_cls().execute_backup(
                    run, plan, local_dst,
                    compressor=compressor, progress_cb=_prog, task_id=task_id,
                )
            except NotImplementedError:
                await ws.send_json({"type": "result", "status": "error",
                                    "msg": f"{best_cls.DISPLAY} 尚未实现 execute_backup"})
                return
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        if backup_id:
            try:
                _db.backup_update(backup_id, status="failed",
                                   error_message=safe[:500],
                                   finished_at=time.strftime("%Y-%m-%d %H:%M:%S"))
            except Exception as _e: logging.debug("suppressed", exc_info=True)
        try:
            _db.task_update(task_id, status="failed")
        except Exception as _e: logging.debug("suppressed", exc_info=True)
        await ws.send_json({"type": "result", "status": "error", "msg": safe})
        return

    ok = bool(result.get("ok"))
    size = result.get("size_bytes", 0)

    # 写 db (final)
    if backup_id:
        try:
            _db.backup_update(
                backup_id,
                status=("success" if ok else "failed"),
                size_bytes=size,
                file_count=result.get("item_count", 0),
                error_message=(result.get("error", "") or "")[:500],
                finished_at=time.strftime("%Y-%m-%d %H:%M:%S"),
            )
        except Exception as _e: logging.debug("suppressed", exc_info=True)
    try:
        # v4.26.0 · 汇总 platform 备份日志尾（供 task_log_tail）
        _log_lines = [
            f"platform_backup task_id={task_id}",
            f"host={host} platform={best_cls.NAME} compressor={compressor}",
            f"local_dst={local_dst}",
            f"selected_keys={selected_keys}",
            f"extra_paths={extra_paths}",
        ]
        try:
            summary = plan.get("summary", {})
            _log_lines.append(f"plan_summary={summary}")
            for it in (plan.get("items") or []):
                if it.get("exists"):
                    _log_lines.append(f"  ✓ {it.get('key')} · {it.get('display')} · {it.get('size_bytes')} B")
        except Exception as _e: logging.debug("suppressed", exc_info=True)
        _log_lines.append(f"result_ok={ok} size={size} sha256={result.get('sha256','')} error={result.get('error','')}")
        _log_tail = "\n".join(_log_lines)[-32768:]
        _db.task_update(task_id, status=("success" if ok else "failed"),
                        log_output=_log_tail)
        # ═══ v4.67.0 · E1 备份异常检测 (文件数/体积 3σ 偏离) ═══
        if ok:
            try:
                from backend import stats as _st
                _items = plan.get("items") or []
                _nfiles = len(_items)
                _host = ""
                try:
                    _host = (plan.get("target") or {}).get("host") or ""
                except Exception:
                    pass
                _an = _st.check_anomaly("backup_platform", _nfiles, int(size or 0), _host)
                _st.record_run("backup_platform", target=_host, files=_nfiles,
                               bytes_=int(size or 0), note=f"{_nfiles} 项 · {_log_tail[-200:]}")
                if _an.get("anomaly"):
                    await ws.send_json({"type": "log",
                                        "level": "warn" if _an["level"] == "warn" else "info",
                                        "msg": "📈 备份异常检测: " + _an["msg"]})
                    if _an["level"] == "warn":
                        try:
                            from backend.events import publish as _pub3
                            _pub3("stats.anomaly", {"kind": "backup_platform", "msg": _an["msg"],
                                                    "files": _nfiles, "bytes": int(size or 0)})
                        except Exception:
                            pass
            except Exception as _ste:
                logging.debug("stats hook fail: %s", _ste)
        # v4.27.0 · 把汇总各行也 push 到 buffer，然后 finalize
        try:
            from backend import log_buffers as _lb
            for _ln in _log_lines:
                _lb.append(task_id, _ln)
            _lb.finalize(task_id)
        except Exception as _e: logging.debug("suppressed", exc_info=True)
    except Exception as _e: logging.debug("suppressed", exc_info=True)
    if not ok:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": f"备份失败: {result.get('error', '未知错误')}",
                            "detail": result})
        return

    await ws.send_json({"type": "progress", "pct": 100, "text": "备份完成"})

    # v4.3.0: 自动云备份钩子 —— 触发所有 auto_upload=1 远端
    # v4.7.0: 用 ws 当前 user_id · 不再硬编码 user_id=1
    auto_results = []
    try:
        from backend.handlers.remotes import auto_upload_after_backup
        from backend.auth import _get_user_id as _auth_uid
        if backup_id:
            local_file = result.get("path") or local_dst
            auto_results = await auto_upload_after_backup(
                ws, backup_id, local_file, user_id=_auth_uid(ws),
            )
    except Exception as e:
        await ws.send_json({"type": "log", "level": "warn",
                            "msg": f"auto_upload 钩子异常: {e}"})

    await ws.send_json({
        "type": "result", "status": "ok",
        "msg": (f"备份完成 · {size / 1024 / 1024:.2f} MB · "
                f"{result.get('duration_sec', 0)}s · "
                f"sha256={result.get('sha256', '')[:12]}..."),
        "host": host,
        "platform": best_cls.NAME,
        "backup": result,
        "backup_id": backup_id,
        "task_id": task_id,
        "auto_uploads": auto_results,
    })
    await ws.send_json({"type": "log", "level": "info",
                        "msg": f"✓ 备份完成 · {result.get('path')} · "
                               f"{size} B · sha256={result.get('sha256')}"})
    # v4.18.3 · publish platform.backup.finished
    try:
        from backend import events
        events.publish("platform.backup.finished", {
            "task_id": task_id, "backup_id": backup_id,
            "host": host, "platform": best_cls.NAME,
            "size_bytes": size, "status": "success",
            "duration_sec": result.get("duration_sec", 0),
        })
    except Exception as _e:
        print(f"[platform] publish backup.finished fail: {_e}")


async def handle_platform_backup_history(ws, data):
    """(alpha5) 拉取 type=platform 的备份历史（供前端列表展示）。

    payload: {limit?:int (默认 50), host?:str (可选过滤)}
    """
    from backend import db as _db
    limit = int(data.get("limit") or 50)
    host_filter = (data.get("host") or "").strip()
    try:
        rows = _db.backup_list(limit=max(limit, 200))
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": f"读取备份历史失败: {e}"})
        return
    # 只保留 type=platform 且可选按 host（source 字段存的就是 host）过滤
    filtered = []
    for r in rows:
        if r.get("type") != "platform":
            continue
        if host_filter and r.get("source") != host_filter:
            continue
        filtered.append(r)
        if len(filtered) >= limit:
            break
    await ws.send_json({
        "type": "result", "status": "ok",
        "msg": f"共 {len(filtered)} 条平台备份记录",
        "history": filtered,
    })

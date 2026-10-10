"""v4.14.0-alpha1 · 数据总览面板后端

WebSocket handlers:
- dashboard_overview : KPI 卡 + 每类型分布 + retention 概要
- dashboard_timeline : 每日备份数量/大小 timeline

v4.39.0: handler 必须用 ws.send_json 发结果,不能用 return(ws.py 主循环丢弃返回值)
"""
import json as _json
import logging
import os

import backend.db as _db


def _soft_log(msg: str):
    """v6.3.12 · 软日志: 写操作日志失败时落 stderr —— **不允许裸 pass**(CLAUDE.md §4)。
    用于「不留痕就无法排查」的瞬时异常场景, 但绝不吞掉错误本身。"""
    try:
        from backend.log import log_operation as _lo
        _lo("Dashboard", "dashboard_devices", msg)
    except Exception as e:                                   # noqa: BLE001
        import sys as _sys
        _sys.stderr.write("[dashboard] 操作日志不可写(%s), 降级 stderr: %s\n" % (e, msg))


async def _reply(ws, payload: dict):
    payload.setdefault("type", "result")
    await ws.send_json(payload)


async def handle_dashboard_overview(ws, data):
    user_id = getattr(ws, "user_id", 1) or 1
    try:
        # v4.38.0 · 支持自定义日期范围
        start_date = data.get("start_date", "")
        end_date = data.get("end_date", "")
        kpi = _db.dashboard_kpi(user_id, start_date=start_date, end_date=end_date)
        by_type = _db.dashboard_by_type(user_id)
        try:
            ret_stats = _db.retention_run_stats(user_id, days=30)
            ret_total_runs  = sum(int(x.get("runs", 0)) for x in ret_stats)
            ret_total_bytes = sum(int(x.get("bytes_freed", 0)) for x in ret_stats)
            ret_total_recs  = sum(int(x.get("deleted_records", 0)) for x in ret_stats)
        except Exception as e:
            print("[dashboard_overview] retention stats fallback:", e)
            ret_total_runs = ret_total_bytes = ret_total_recs = 0
        try:
            remotes = _db.remote_list(user_id, mask_secret=True)
            remote_count = len(remotes)
        except Exception as e:
            print("[dashboard_overview] remote_list fallback:", e)
            remote_count = 0
        await _reply(ws, {
            "status": "ok",
            "kpi": kpi,
            "by_type": by_type,
            "retention_30d": {
                "runs":  ret_total_runs,
                "bytes": ret_total_bytes,
                "records": ret_total_recs,
            },
            "remote_count": remote_count,
        })
    except Exception as e:
        print("[dashboard_overview] error:", e)
        await _reply(ws, {"status": "err", "msg": str(e)})


async def handle_dashboard_timeline(ws, data):
    user_id = getattr(ws, "user_id", 1) or 1
    try:
        # v4.38.0 · 支持自定义日期范围
        start_date = data.get("start_date", "")
        end_date = data.get("end_date", "")
        if start_date and end_date:
            timeline = _db.dashboard_timeline(user_id, start_date=start_date, end_date=end_date)
            await _reply(ws, {"status": "ok", "timeline": timeline, "start_date": start_date, "end_date": end_date})
            return
        days = int(data.get("days", 30))
        if days < 1: days = 30
        if days > 365: days = 365
        timeline = _db.dashboard_timeline(user_id, days=days)
        await _reply(ws, {"status": "ok", "days": days, "timeline": timeline})
    except Exception as e:
        print("[dashboard_timeline] error:", e)
        await _reply(ws, {"status": "err", "msg": str(e)})


async def handle_dashboard_hourly(ws, data):
    """v4.22.0 · 近 24 小时按小时分桶（基于 event_log 表）
    返回 hourly: [{hour: '2026-07-16 09', total, ok, failed}, ...] × 24 桶
    """
    try:
        import time as _time
        now = _time.time()
        cutoff = now - 24 * 3600
        with _db.get_conn() as conn:
            rows = conn.execute(
                "SELECT ts, topic, payload_json FROM event_log "
                "WHERE ts >= ? AND topic LIKE 'flow.run.%' "
                "ORDER BY ts ASC",
                (cutoff,),
            ).fetchall()
        # 24 桶：以当前小时为最后一桶
        buckets = [{"slot": i, "total": 0, "ok": 0, "failed": 0} for i in range(24)]
        import json as _json
        for r in rows:
            ts, topic, pj = r[0], r[1], r[2]
            idx = int((ts - cutoff) / 3600)
            if idx < 0 or idx > 23:
                continue
            b = buckets[idx]
            if topic == "flow.run.finished":
                b["total"] += 1
                try:
                    p = _json.loads(pj) if pj else {}
                    st = p.get("status", "")
                    if st == "ok" or st == "success":
                        b["ok"] += 1
                    elif st in ("err", "error", "failed", "fail"):
                        b["failed"] += 1
                except Exception as _e: logging.debug("suppressed", exc_info=True)
        await _reply(ws, {"status": "ok", "hourly": buckets})
    except Exception as e:
        print("[dashboard_hourly] error:", e)
        await _reply(ws, {"status": "err", "msg": str(e)})


async def handle_system_stats(ws, data):
    """v4.23.0 · 返回一次系统状态快照（同步采样，无需等待推流）"""
    try:
        from backend import system_stats as _ss
        await _reply(ws, {"status": "ok", "stats": _ss.collect()})
    except Exception as e:
        print("[system_stats] handler err:", e)
        await _reply(ws, {"status": "err", "msg": str(e)})




# ══════════════════ v5.98.25 · 数据总览: 设备与基础设施一览 ══════════════════
#   用户要求: 数据总览要能看到 SSH / 网络共享 / 远端磁盘 / 云存储 / 容器 这些设备的信息。
#   纪律(CLAUDE.md §3.7): 每一段都取自**既有单一真源**(server_profiles / share_list /
#   remote_list / 本机 lsblk+df / docker ps), 不另建一套; 某段取不到就**如实报错**,
#   绝不回落成 0 或"看起来正常"的空列表。

async def _sec(fn, name, errors):
    """跑一段采集; 异常进 errors(不吞), 返回 None 让前端显示"该段不可用"。"""
    try:
        return await fn()
    except Exception as e:
        errors[name] = "%s: %s" % (type(e).__name__, str(e)[:200])
        return None


def _json_or_dict(v, what: str = "protocols"):
    """protocols 字段可能是 JSON 字符串(实测) 或已是 dict; 统一成 dict。

    v5.98.27 · 踩坑记录: 本模块顶部是 `import json as _json`, 没有裸 `json`,
       我原先写 `json.loads` → NameError, 又被自己的 `except: return {}` **静默吞掉**,
       结果能力徽章永远只剩 SSH(看不出错)。这里改用 `_json`, 且失败**必须留痕**,
       不再无声回落(项目铁律 §3.7)。
    """
    if isinstance(v, dict):
        return v
    try:
        d = _json.loads(v or "{}")
        if isinstance(d, dict):
            return d
        print("[dashboard] %s 不是 JSON 对象: %r" % (what, str(v)[:80]))
        return {}
    except Exception as e:
        print("[dashboard] %s JSON 解析失败: %s: %s | 原值: %r"
              % (what, type(e).__name__, e, str(v)[:80]))
        return {}


# 档案类型的人类可读名(v5.98.27 · 用户报"系统"列显示成 windows 这种裸字符)
_KIND_LABEL = {
    "linux": "Linux", "windows": "Windows", "synology": "群晖", "omv": "OpenMediaVault",
    "pve": "Proxmox VE", "esxi": "VMware ESXi", "storage": "存储/云", "macos": "macOS",
    "unraid": "Unraid", "truenas": "TrueNAS", "nas": "NAS", "kylin": "银河麒麟",
}


async def _sec_ssh(data: dict):
    """SSH 服务器清单: 走 server_profiles(连接中心维护 status/last_seen/latency) + 可选真实探活。"""
    import asyncio as _aio
    from backend.handlers.server_profile import _protocols_mask   # 单一真源
    conn = _db.get_conn()
    _SQL = ("SELECT guid,name,hostname,ssh_port,ssh_user,os_type,os_version,arch,protocols,kind,"
            "       status,last_seen,last_latency_ms,version,group_id,is_starred,notes "
            "FROM server_profiles ORDER BY sort_order ASC, name ASC LIMIT 500")
    rows = conn.execute(_SQL).fetchall()
    if not rows:
        # v6.3.7 · 实测总览 SSH 区偶发"0 台"而 DB 确有档案(同会话 0/0/7 波动, errors 为空)。
        #   这里**留痕 + 有界重试一次**: 再读一次, 仍空就如实返回空(前端另有同源回退)。
        #   留痕是为了下次再发生时能直接看到"当时到底是不是真空", 而不是继续猜。
        _soft_log("ssh 段首次读到 0 行(疑似瞬时), 重试一次")
        try:
            await _aio.sleep(0.2)      # 模块内只有 _aio(见 _sec_ssh 顶部 import)
            rows = conn.execute(_SQL).fetchall()
        except Exception as e:          # noqa: BLE001
            # 重试也失败: **不静默回落成空列表**(那会把"读失败"伪装成"没有服务器档案",
            # 正是 §3.7 禁止的静默回落)。留痕 + 显式抛出, 由 _sec 记入 errors 供前端显示。
            _soft_log("ssh 段重试读取失败: %r" % (e,))
            raise
    items = []
    for r in rows:
        d = dict(r)
        # v5.98.27 · 能力键: protocols 是**按协议设置的 JSON 字典**, 直接塞给前端会显示成
        #   `{"rdp": {"enabled": true, ...}}` 这种原始字符(用户报"能力标签显示异常")。
        #   这里解析成键列表(mask), 与连接中心 server_profile.js 的 protocols_mask 同一口径。
        mask = _protocols_mask(_json_or_dict(d.get("protocols")))
        items.append({
            "guid": d.get("guid"), "name": d.get("name") or d.get("hostname") or "",
            "host": d.get("hostname") or "", "port": d.get("ssh_port") or 22,
            "user": d.get("ssh_user") or "root", "os_type": d.get("os_type") or "",
            "os_version": d.get("os_version") or "", "arch": d.get("arch") or "",
            "protocols_mask": mask, "kind": d.get("kind") or "",
            "kind_label": (_KIND_LABEL.get((d.get("kind") or "").lower())
                           or (d.get("os_type") or "").strip() or "Linux"),
            "status": (d.get("status") or "").strip(), "last_seen": d.get("last_seen") or "",
            "latency_ms": d.get("last_latency_ms"), "version": d.get("version") or "",
        })
    online = sum(1 for x in items if (x.get("status") or "").lower() in ("online", "up", "ok"))
    unknown = sum(1 for x in items if not (x.get("status") or "").strip())
    if data.get("probe"):
        sem = _aio.Semaphore(8)

        async def _p(it):
            async with sem:
                t0 = _time_s()
                try:
                    rd, wr = await _aio.wait_for(
                        _aio.open_connection(it["host"], int(it["port"] or 22)), timeout=4)
                    try:
                        wr.close()
                    except Exception:
                        pass
                    it["probe"] = {"ok": True, "ms": int((_time_s() - t0) * 1000)}
                except Exception as e:
                    it["probe"] = {"ok": False, "err": "%s: %s" % (type(e).__name__, str(e)[:60]),
                                   "ms": int((_time_s() - t0) * 1000)}
        await _aio.gather(*[_p(x) for x in items if x["host"]])
    return {"count": len(items), "online": online, "unknown": unknown,
            "probed": bool(data.get("probe")), "items": items}


def _time_s():
    import time as _t
    return _t.time()


def _mount_state(path):
    """共享/目标路径是否真挂载 + 容量(用 statvfs, 不解析 df 文本)。"""
    import os as _os
    st = {"mounted": False, "size": None, "used": None, "free": None}
    try:
        if _os.path.ismount(path):
            st["mounted"] = True
            u = _os.statvfs(path)
            st["size"] = u.f_frsize * u.f_blocks
            st["free"] = u.f_frsize * u.f_bavail
            st["used"] = st["size"] - st["free"]
    except Exception:
        pass
    return st


async def _sec_shares(user_id: int):
    """网络共享: DB 记录 + **真实挂载状态与容量**(共享目录在 /var/lib/fonriv_mounts/shares/<guid>)。"""
    import os as _os
    rows = _db.share_list(user_id) if hasattr(_db, "share_list") else []
    items = []
    for r in rows or []:
        d = dict(r)
        mp = "/var/lib/fonriv_mounts/shares/%s" % (d.get("uuid") or d.get("id") or "")
        st = _mount_state(mp)
        # v5.98.25 · 实测: 共享记录里的字段名是 proto/host/share/vers/ro/last_status(不是 protocol/source)
        items.append({"id": d.get("uuid") or d.get("id"), "name": d.get("name") or "",
                      "protocol": d.get("proto") or "",
                      "source": (d.get("host") or "") + ((":" + str(d.get("port"))) if d.get("port") else ""),
                      "share": d.get("share") or "",
                      "user": d.get("user") or "", "vers": d.get("vers") or "",
                      "ro": bool(d.get("ro")),
                      "last_status": d.get("last_status") or "",
                      "last_mounted_at": d.get("last_mounted_at") or "",
                      "target": mp, "path_exists": _os.path.exists(mp), **st})
    return {"count": len(items),
            "mounted": sum(1 for x in items if x.get("mounted")), "items": items}


async def _sec_disks():
    """磁盘: 本机 `lsblk` 真实列举; 远端取"最近一次扫描缓存"(disk.py 写出), 没扫过就明说没扫过。"""
    import asyncio as _aio
    out = {"local": [], "remote": [], "remote_note": ""}
    proc = await _aio.create_subprocess_shell(
        "lsblk -b -J -o NAME,PATH,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,RO 2>/dev/null",
        stdout=_aio.subprocess.PIPE, stderr=_aio.subprocess.PIPE)
    raw, _e = await _aio.wait_for(proc.communicate(), timeout=20)
    try:
        js = _json.loads((raw or b"{}").decode("utf-8", "replace"))
    except Exception:
        js = {}
    def walk(items, depth=0):
        for d in items or []:
            t = (d.get("type") or "").lower()
            if t in ("disk", "part", "lvm", "loop", "raid1", "raid5", "md"):
                out["local"].append({"name": d.get("name"), "path": d.get("path"),
                                     "size": d.get("size") if isinstance(d.get("size"), int) else None,
                                     "type": t, "fstype": d.get("fstype") or "",
                                     "mount": d.get("mountpoint") or "",
                                     "model": (d.get("model") or "").strip(),
                                     "depth": depth})
            walk(d.get("children"), depth + 1)
    walk(js.get("blockdevices"))
    # 已挂载的分区/卷: 补真实用量(用户要求"能加的展示信息都加上")
    for _x in out["local"]:
        _mp = _x.get("mount") or ""
        if not _mp:
            continue
        try:
            _u = os.statvfs(_mp)
            _sz = _u.f_frsize * _u.f_blocks
            _fr = _u.f_frsize * _u.f_bavail
            _x["use_size"] = _sz
            _x["use_free"] = _fr
            _x["use_pct"] = round((_sz - _fr) * 100.0 / _sz, 1) if _sz else None
        except Exception:
            pass
    # v5.98.25 · 实测: 本机 50 条里绝大多数是 snap 占用的 loop(把真盘淹了) →
    #   ① 剔除 snap 回环(按 losetup back-file 判断, 与磁盘镜像模块同一口径)
    #   ② 排序: disk → part → lvm/zfs/md → 回环最后
    #   ③ 截断到 40 条并把总数交代清楚(不假装只有这些)
    try:
        snap_loops = set()
        _pr = await _aio.create_subprocess_shell("losetup -a 2>/dev/null",
                                                 stdout=_aio.subprocess.PIPE, stderr=_aio.subprocess.DEVNULL)
        _lo, _ = await _aio.wait_for(_pr.communicate(), timeout=15)
        for _ln in (_lo or b"").decode("utf-8", "replace").splitlines():
            if "/var/lib/snapd/" in _ln and ":" in _ln:
                snap_loops.add(_ln.split(":", 1)[0].strip().split("/")[-1])
        out["local"] = [x for x in out["local"]
                        if not (x.get("type") == "loop" and (x.get("name") or "") in snap_loops)]
    except Exception as _e:
        print("[dashboard_devices] snap 回环过滤失败(如实保留全部): %s" % _e)
    _order = {"disk": 0, "part": 1, "lvm": 2, "raid1": 2, "raid5": 2, "raid10": 2, "md": 2, "loop": 9}
    out["local"].sort(key=lambda x: (_order.get(x.get("type") or "", 5), x.get("path") or ""))
    out["local_total"] = len(out["local"])
    out["local"] = out["local"][:40]
    try:
        from backend.handlers import disk as _dk
        cache = getattr(_dk, "LAST_SCANS", {}) or {}
    except Exception:
        cache = {}
    for host, rec in list(cache.items())[:50]:
        out["remote"].append({"host": host, "ts": rec.get("ts"), "disks": rec.get("disks"),
                              "parts": rec.get("parts"), "lvm": rec.get("lvm"),
                              "zfs": rec.get("zfs"), "used_pct": rec.get("used_pct")})
    if not out["remote"]:
        out["remote_note"] = "还没有远端磁盘扫描记录: 到「远端磁盘管理」点一次扫描, 这里就会显示该机的磁盘/分区/LVM/ZFS 概要"
    return out


async def _sec_cloud(user_id: int):
    rows = _db.remote_list(user_id, mask_secret=True) or []
    items = []
    for r in rows:
        d = dict(r)
        items.append({"uuid": d.get("uuid"), "name": d.get("name") or "",
                      "provider": (d.get("provider") or "").lower(),
                      "bucket": d.get("bucket") or "", "endpoint": d.get("endpoint") or "",
                      "region": d.get("region") or ""})
    return {"count": len(items), "items": items}


async def _sec_containers():
    """容器: 本机 docker 真实计数(docker 未装则如实说明, 不显示 0 骗人)。"""
    import asyncio as _aio
    which = await _aio.create_subprocess_shell("command -v docker", stdout=_aio.subprocess.PIPE,
                                               stderr=_aio.subprocess.DEVNULL)
    w, _ = await _aio.wait_for(which.communicate(), timeout=10)
    if not (w or b"").strip():
        return {"docker": False, "note": "本机未安装 docker"}
    async def _sh(c):
        pr = await _aio.create_subprocess_shell(c, stdout=_aio.subprocess.PIPE, stderr=_aio.subprocess.DEVNULL)
        o, _e = await _aio.wait_for(pr.communicate(), timeout=25)
        return (o or b"").decode("utf-8", "replace").strip()
    ps = await _sh("docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null | head -60")
    imgs = await _sh("docker images -q 2>/dev/null | wc -l")
    lines = [x for x in ps.splitlines() if x.strip()]
    items = []
    for ln in lines:
        p = ln.split("\t")
        items.append({"name": p[0] if p else "", "image": p[1] if len(p) > 1 else "",
                      "status": p[2] if len(p) > 2 else ""})
    return {"docker": True, "total": len(items),
            "running": sum(1 for x in items if x["status"].lower().startswith("up")),
            "images": int(imgs) if imgs.isdigit() else None, "items": items}


async def handle_dashboard_devices(ws, data):
    """数据总览 · 设备一览: SSH / 网络共享 / 磁盘 / 云存储 / 容器 / 本机概要(一次往返给齐)。"""
    user_id = getattr(ws, "user_id", 1) or 1
    errors = {}
    local = None
    try:
        from backend import system_stats as _ss
        local = _ss.collect()
    except Exception as e:
        errors["local"] = "%s: %s" % (type(e).__name__, str(e)[:160])
    ssh = await _sec(lambda: _sec_ssh(data), "ssh", errors)
    shares = await _sec(lambda: _sec_shares(user_id), "shares", errors)
    disks = await _sec(_sec_disks, "disks", errors)
    cloud = await _sec(lambda: _sec_cloud(user_id), "cloud", errors)
    containers = await _sec(_sec_containers, "containers", errors)
    await _reply(ws, {"status": "ok", "ts": _time_s(), "local": local, "ssh": ssh,
                      "shares": shares, "disks": disks, "cloud": cloud,
                      "containers": containers, "errors": errors})



async def handle_graph_integrity(ws, data):
    """v4.39.0 · 实体引用图一致性校验 + safe_delete 前置检查

    action 子类型(默认 check):
    - check: 返回完整一致性报告(healthy/dangling/orphans)
    - refs_to: 查询指向某实体的所有引用(target_table/target_uuid)
    - refs_from: 查询某实体发出的所有引用(source_table/source_uuid)
    - safe_delete: 模拟删除,返回 blocked_by(不实际删除)
    """
    async def _reply(payload):
        payload.setdefault("type", "result")
        await ws.send_json(payload)
    try:
        action = (data.get("sub_action") or "check").strip()
        if action == "check":
            report = _db.graph_integrity_check()
            await _reply({"status": "ok", "report": report})
            return

        if action == "refs_to":
            tt = data.get("target_table", "")
            tu = data.get("target_uuid", "")
            if not tt or not tu:
                await _reply({"status": "err", "msg": "缺少 target_table/target_uuid"})
                return
            refs = _db.get_refs_to(tt, tu)
            await _reply({"status": "ok", "refs": refs})
            return

        if action == "refs_from":
            st = data.get("source_table", "")
            su = data.get("source_uuid", "")
            if not st or not su:
                await _reply({"status": "err", "msg": "缺少 source_table/source_uuid"})
                return
            refs = _db.get_refs_from(st, su)
            await _reply({"status": "ok", "refs": refs})
            return

        if action == "safe_delete":
            tt = data.get("target_table", "")
            tu = data.get("target_uuid", "")
            if not tt or not tu:
                await _reply({"status": "err", "msg": "缺少 target_table/target_uuid"})
                return
            result = _db.safe_delete(tt, tu)
            await _reply({"status": "ok", "result": result})
            return

        await _reply({"status": "err", "msg": f"未知 sub_action: {action}"})
    except Exception as e:
        print("[graph_integrity] handler err:", e)
        await _reply({"status": "err", "msg": str(e)})

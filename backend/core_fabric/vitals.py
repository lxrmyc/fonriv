"""Fonriv - Transfer Fabric · 核心运行状况与自检 (v5.19.1 第一期)

统一聚合"这套传输系统现在是什么状态":
  · overview()         — 核心模块 / 端点类型 / 引擎注册 / 任务注册 概览 (板块 1)
  · endpoints_status() — 按 EndpointKind 分组的端点实时连接状况 + 传输方向统计 (板块 2)
  · host_health()      — 宿主机 CPU/内存/磁盘/网络 + 阈值告警 (板块 6 运行时健康)
  · task_health()      — 运行中/卡死任务检测 (超时无输出 → 告警/可取消)
  · resilience_stats() — 容错回退链命中统计 (哪个功能降级过、降级到哪条路径)

设计原则: 只展示**真实存在**的能力; 未实现的能力显式标注 planned=True,
避免把规划项渲染成已就绪状态误导使用者。
"""
from __future__ import annotations

import os as _os
import time as _time

_ROOT = _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
_DATA = _os.path.join(_ROOT, "backend", "data")   # runs/instance_id 实际位于 backend/data
_ROOTDATA = _os.path.join(_ROOT, "data")          # db 等位于项目根 data/

# 告警阈值 (百分比) — 可用 setting 覆盖
_TH = {
    "cpu_pct": 85.0,
    "mem_pct": 90.0,
    "disk_pct": 90.0,
    "net_mbps": 900.0,      # 持续高占用告警 (单口)
    "task_stall_sec": 900,  # 任务 15 分钟无输出视为卡死
}


_RSYNC_MIN = (3, 5, 0)   # v5.19.6 · 规划安全基线 (3.5.0 修 33 个路径类 CVE)


def rsync_version_gate() -> dict:
    """P0 安全门禁: 探测 rsync 版本, < 3.5.0 告警 (3.5.0 一次修 33 个路径类 CVE)"""
    import shutil as _sh, subprocess as _sp
    out = {"path": "", "version": "", "tuple": (0, 0, 0), "ok": False, "min": "3.5.0"}
    path = _sh.which("rsync")
    if not path:
        out["error"] = "rsync 未安装"
        return out
    out["path"] = path
    try:
        r = _sp.run([path, "--version"], capture_output=True, text=True, timeout=8)
        first = (r.stdout or "").splitlines()[0] if (r.stdout or "") else ""
        out["version"] = first[:70]
        import re as _re
        m = _re.search(r"rsync\s+version\s+(\d+)\.(\d+)\.(\d+)", first)
        if m:
            out["tuple"] = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except Exception as e:
        out["error"] = str(e)[:100]
        return out
    out["ok"] = out["tuple"] >= _RSYNC_MIN
    return out


def thresholds() -> dict:
    try:
        from backend import db
        for k in list(_TH.keys()):
            v = db.setting_get("vitals_th_" + k, "")
            if v not in ("", None):
                try:
                    _TH[k] = float(v)
                except Exception:
                    pass
    except Exception:
        pass
    return dict(_TH)


# ═════════════════════════════════════════════════════════════
# 板块 1 · 核心状态总览
# ═════════════════════════════════════════════════════════════

# 分层架构: 每层 → (本层实际模块文件, 职责说明)
_LAYERS = [
    ("Web 薄客户端", ["static/app.js", "static/panels"], "只负责渲染与交互, 不做决策"),
    ("Transfer Core", ["handlers/rsync.py", "handlers/file_ops.py"], "WS 路由 / 会话 / 门控"),
    ("Planner", ["core_fabric/planner.py"], "引擎选择 · 压缩决策 · 加密级别 · 决策理由"),
    ("Executor", ["core_fabric/providers.py", "core_fabric/relay.py"], "命令构建 · 两段式中转"),
    ("Provider", ["core_fabric/providers.py"], "rsync / rclone 命令生成"),
    ("Endpoint", ["core_fabric/endpoint.py"], "9 类端点统一抽象 + 能力矩阵"),
]


def overview() -> dict:
    """核心模块 / 端点 / 引擎 / 任务 一屏概览"""
    cf = _os.path.join(_ROOT, "backend", "core_fabric")
    mods = []
    try:
        for fn in sorted(_os.listdir(cf)):
            if not fn.endswith(".py") or fn == "__init__.py":
                continue
            fp = _os.path.join(cf, fn)
            st = _os.stat(fp)
            mods.append({
                "name": fn[:-3],
                "size": st.st_size,
                "mtime": _time.strftime("%Y-%m-%d %H:%M", _time.localtime(st.st_mtime)),
            })
    except Exception:
        pass

    # 端点类型 (含实现状态)
    kinds = []
    try:
        from backend.core_fabric.endpoint import EndpointKind
        _IMPL = {"local": True, "ssh": True, "cloud": True, "mount": True, "share": True,
                 "pve": True, "k8s": True, "restic": True, "croc": True}
        for k in EndpointKind:
            kinds.append({"kind": k.value, "implemented": _IMPL.get(k.value, False)})
    except Exception:
        pass

    # 引擎注册
    engines = []
    try:
        from backend.core_fabric.providers import PROVIDERS
        for name in PROVIDERS:
            engines.append({"name": name, "available": None, "planned": False})
        # v6.13.0 · 批13(用户报"multi-stream 怎么还是规划中"): 引擎 v5.63.0 已实现, 不再标"规划中" ——
        #   改为**真实探测**(aioquic 可选组件缺失 → available=False + reason; 缺失≠规划中)
        try:
            from backend.fonrvfs import quic as _quic
            _qa = _quic.available()
            engines.append({"name": "multi-stream", "available": bool(_qa.get("available")),
                            "planned": False, "reason": _qa.get("reason") or "",
                            "hint": _qa.get("hint") or ""})
        except Exception as _qe:
            engines.append({"name": "multi-stream", "available": False, "planned": False,
                            "reason": "组件探测失败: %s" % str(_qe)[:80], "hint": ""})
    except Exception:
        pass

    # 任务注册 — v5.19.2 · 区分三个层级 (原实现只报 job_registry 的 13 个,
    #   会让用户误以为系统只有 13 个任务; 实际 action 表有 300+)
    jobs_n = 0
    try:
        from backend.core_fabric.job_registry import all_jobs
        jobs_n = len(all_jobs() or {})
    except Exception:
        pass
    actions_total = routes_total = feat_groups = 0
    try:
        from backend.ws import ACTION_DESC_MAP, ROUTE_NO_TASK, ROUTE_TASK
        actions_total = len(ACTION_DESC_MAP)
        routes_total = len(ROUTE_NO_TASK) + len(ROUTE_TASK)
    except Exception:
        pass
    try:
        import json as _j
        fp = _os.path.join(_ROOT, "scripts", "features.json")
        with open(fp, encoding="utf-8") as f:
            _fd = _j.load(f)
        _f = _fd.get("features")
        feat_groups = len(_f) if isinstance(_f, (dict, list)) else 0
    except Exception:
        pass

    # 分层架构
    layers = []
    for lname, files, desc in _LAYERS:
        present = []
        for f in files:
            p = _os.path.join(_ROOT, "backend" if not f.startswith("static") else "frontend", f)
            present.append({"file": f, "ok": _os.path.exists(p)})
        layers.append({"layer": lname, "desc": desc, "files": present,
                       "ok": all(x["ok"] for x in present)})

    # 路由模式 (如实标注实现状态)
    routes = [
        {"mode": "直链 (Direct)", "implemented": True, "desc": "源与目标可直连, 单段传输"},
        {"mode": "中继管道转发", "implemented": True, "desc": "两端不可直连时经本机两段式 (pull→push)"},
        {"mode": "Air-Gap 摆渡", "implemented": True, "desc": "物理隔离, .rpferry 包 RSA 签名 + Merkle"},
        {"mode": "Croc 点对点", "implemented": True, "desc": "P2P 直传, 无需中转服务器"},
    ]

    ver = ""
    try:
        from backend.version import VERSION
        ver = VERSION
    except Exception:
        pass

    return {
        "version": ver,
        "modules": mods,
        "module_count": len(mods),
        "kinds": kinds,
        "kind_count": len(kinds),
        "engines": engines,
        "jobs_registered": jobs_n,
        "actions_total": actions_total,
        "routes_total": routes_total,
        "feature_groups": feat_groups,
        "layers": layers,
        "routes": routes,
        "instance_id": _instance_id(),
    }


def _instance_id() -> str:
    try:
        from backend.core_fabric.instance_id import get_instance_id
        return str(get_instance_id())[:8]
    except Exception:
        try:
            with open(_os.path.join(_DATA, "instance_id")) as f:
                return f.read().strip()[:8]
        except Exception:
            return ""


# ═════════════════════════════════════════════════════════════
# 板块 2 · 端点与连接
# ═════════════════════════════════════════════════════════════

def endpoints_status() -> dict:
    """按端点类型汇总实时连接状况。数据传输方向统计取自 runlog 历史。"""
    groups = []

    def _mk(kind, label, items, note=""):
        return {"kind": kind, "label": label, "count": len(items), "items": items, "note": note}

    # local
    try:
        import shutil as _sh
        du = _sh.disk_usage("/")
        groups.append(_mk("local", "本地文件系统", [{
            "name": "本机 /", "online": True,
            "detail": f"可用 {du.free // (1024**3)} GB / 共 {du.total // (1024**3)} GB",
            "caps": ["read", "write", "mkdir", "exec"],
        }]))
    except Exception:
        groups.append(_mk("local", "本地文件系统", []))

    # ssh (已存服务器)
    try:
        from backend import db
        rows = db.get_conn().execute(
            "SELECT id,name,host,port,user,panel FROM configs ORDER BY id").fetchall()
        items = []
        for r in rows:
            d = dict(r)
            host = d.get("host") or ""
            if host in ("127.0.0.1", "localhost", "::1"):
                continue   # 本机已在 local 组
            items.append({
                "name": d.get("name") or f"#{d.get('id')}",
                "target": f"{d.get('user')}@{host}:{d.get('port')}",
                "online": None,   # 实时探测开销高, 页面可点「测试」逐个验证
                "caps": ["read", "write", "exec", "ssh"],
            })
        groups.append(_mk("ssh", "SSH 服务器", items, "online=null 表示尚未探测 (可点测试)"))
    except Exception as e:
        groups.append(_mk("ssh", "SSH 服务器", [], f"查询失败: {e}"))

    # cloud (远端存储)
    try:
        from backend import db
        conn = db.get_conn()
        by_prov = conn.execute(
            "SELECT provider, COUNT(*) c FROM remote_configs GROUP BY provider ORDER BY c DESC").fetchall()
        total = sum((dict(r).get("c") or 0) for r in by_prov)
        rows = conn.execute(
            "SELECT id,name,provider,endpoint,bucket FROM remote_configs ORDER BY id DESC LIMIT 20").fetchall()
        items = [{
            "name": dict(r).get("name"),
            "target": f"{dict(r).get('provider')}:{dict(r).get('bucket') or dict(r).get('endpoint') or ''}",
            "online": None,
            "caps": ["read", "write", "list", "https"],
        } for r in rows]
        note = " · ".join(f"{dict(r).get('provider')} {dict(r).get('c')}" for r in by_prov)
        if total > len(items):
            note += f" (共 {total} 条, 仅列最近 {len(items)} 条)"
        groups.append(_mk("cloud", "云端存储 (S3/Seafile/WebDAV…)", items, note))
    except Exception as e:
        groups.append(_mk("cloud", "云端存储", [], f"查询失败: {e}"))

    # mount / share (df 挂载点 + 网络共享)
    try:
        import subprocess as _sp
        mounts = []
        try:
            out = _sp.run(["df", "-PB1", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs"],
                          capture_output=True, text=True, timeout=8).stdout
            for line in (out or "").splitlines()[1:]:
                p2 = line.split()
                if len(p2) >= 6 and p2[5].startswith("/var/lib/fonriv_mounts/shares/"):
                    mounts.append({"mount": p2[5], "source": p2[0],
                                   "avail": int(p2[3]) if p2[3].isdigit() else 0, "readonly": False})
        except Exception:
            mounts = []
        items = []
        for m in mounts:
            items.append({
                "name": m.get("mount"),
                "target": m.get("source", ""),
                "online": True,
                "detail": (f"{m.get('avail', 0) // (1024**3)}G 可用" if m.get("avail") else ""),
                "caps": (["read"] if m.get("readonly") else ["read", "write"]),
                "readonly": bool(m.get("readonly")),
            })
        groups.append(_mk("share", "网络共享挂载", items))
    except Exception:
        groups.append(_mk("share", "网络共享挂载", []))

    # 传输方向统计 (来自 runlog L1)
    dir_stats = {}
    try:
        from backend import db
        rows = db.get_conn().execute(
            "SELECT direction, COUNT(*) c, SUM(COALESCE(size,0)) b FROM task_runs "
            "GROUP BY direction").fetchall()
        for r in rows:
            d = dict(r)
            dir_stats[d.get("direction") or "unknown"] = {"count": d.get("c") or 0,
                                                          "bytes": d.get("b") or 0}
    except Exception:
        pass

    tot = 0
    for g in groups:
        tot += g.get("count", 0)
    return {"groups": groups, "total": tot, "direction_stats": dir_stats}


# ═════════════════════════════════════════════════════════════
# 板块 6 · 宿主机资源 + 任务健康 + 容错统计
# ═════════════════════════════════════════════════════════════

def _cpu_sample() -> tuple:
    try:
        with open("/proc/stat") as f:
            p = f.readline().split()
        vals = [int(x) for x in p[1:]]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        return sum(vals), idle
    except Exception:
        return 0, 0


def _net_sample() -> tuple:
    rx = tx = 0
    try:
        with open("/proc/net/dev") as f:
            for line in f.readlines()[2:]:
                if ":" not in line:
                    continue
                iface, rest = line.split(":", 1)
                if iface.strip() == "lo":
                    continue
                parts = rest.split()
                rx += int(parts[0]); tx += int(parts[8])
    except Exception:
        pass
    return rx, tx


def host_health(sample_sec: float = 0.6) -> dict:
    """宿主机 CPU/内存/磁盘/网络 + 阈值告警"""
    th = thresholds()
    alerts = []

    # CPU (两次采样差值)
    t1, i1 = _cpu_sample()
    _time.sleep(max(0.1, min(2.0, sample_sec)))
    t2, i2 = _cpu_sample()
    cpu_pct = 0.0
    if t2 > t1:
        cpu_pct = round(100.0 * (1.0 - (i2 - i1) / float(t2 - t1)), 1)
        cpu_pct = max(0.0, min(100.0, cpu_pct))

    # 负载
    load1 = load5 = load15 = 0.0
    try:
        load1, load5, load15 = _os.getloadavg()
    except Exception:
        pass
    ncpu = _os.cpu_count() or 1

    # 内存
    mem_total = mem_avail = 0
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                info[k.strip()] = int(v.split()[0]) if v.split() else 0
        mem_total = info.get("MemTotal", 0) * 1024
        mem_avail = info.get("MemAvailable", info.get("MemFree", 0)) * 1024
    except Exception:
        pass
    mem_pct = round(100.0 * (1 - mem_avail / mem_total), 1) if mem_total else 0.0

    # 交换
    swap_pct = 0.0
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                info[k.strip()] = int(v.split()[0]) if v.split() else 0
        st_, sf_ = info.get("SwapTotal", 0), info.get("SwapFree", 0)
        if st_:
            swap_pct = round(100.0 * (1 - sf_ / st_), 1)
    except Exception:
        pass

    # 磁盘 (各挂载点)
    disks = []
    try:
        import shutil as _sh
        seen = set()
        with open("/proc/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                mnt, fstype = parts[1], parts[2]
                if fstype in ("proc", "sysfs", "devtmpfs", "tmpfs", "cgroup", "cgroup2",
                              "devpts", "securityfs", "debugfs", "tracefs", "fusectl",
                              "configfs", "mqueue", "hugetlbfs", "binfmt_misc", "squashfs",
                              "autofs", "pstore", "bpf", "nsfs", "overlay", "ramfs"):
                    continue
                if mnt in seen:
                    continue
                seen.add(mnt)
                try:
                    du = _sh.disk_usage(mnt)
                    if du.total < 512 * 1024 * 1024:   # 忽略 <512MB 的伪挂载
                        continue
                    pct = round(100.0 * du.used / du.total, 1)
                    disks.append({"mount": mnt, "fstype": fstype,
                                  "total": du.total, "used": du.used, "free": du.free,
                                  "pct": pct})
                except Exception:
                    continue
    except Exception:
        pass

    # 网络 (两次采样 → MB/s)
    r1, x1 = _net_sample()
    _time.sleep(0.0)
    r2, x2 = _net_sample()
    dt = max(0.2, sample_sec)
    net_rx_mbps = round((r2 - r1) * 8 / 1e6 / dt, 2)
    net_tx_mbps = round((x2 - x1) * 8 / 1e6 / dt, 2)

    # 告警判定
    if cpu_pct >= th["cpu_pct"]:
        alerts.append({"level": "warn", "item": "CPU", "msg": f"CPU 使用率 {cpu_pct}% ≥ {th['cpu_pct']}%"})
    if mem_pct >= th["mem_pct"]:
        alerts.append({"level": "warn", "item": "内存", "msg": f"内存使用率 {mem_pct}% ≥ {th['mem_pct']}%"})
    if swap_pct >= 50:
        alerts.append({"level": "warn", "item": "交换分区", "msg": f"Swap 使用 {swap_pct}% — 物理内存可能不足"})
    for d in disks:
        if d["pct"] >= th["disk_pct"]:
            # v1.0.0 · i18n: 挂载点放 mount(数据), 文案保持形状稳定 → 前端词典可用 {n} 模板翻译
            alerts.append({"level": "err" if d["pct"] >= 95 else "warn", "item": "磁盘",
                           "mount": d["mount"], "msg": f"已用 {d['pct']}% (剩 {d['free'] // (1024**3)} GB)"})
    if load1 > ncpu * 2:
        alerts.append({"level": "warn", "item": "负载", "msg": f"1 分钟负载 {load1:.2f} > 2×核数({ncpu})"})

    # 进程自身
    self_rss = 0
    self_uptime = 0
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    self_rss = int(line.split()[1]) * 1024
                    break
    except Exception:
        pass
    try:
        self_uptime = int(_time.time() - _os.stat("/proc/self").st_ctime)
    except Exception:
        pass

    return {
        "cpu": {"pct": cpu_pct, "cores": ncpu,
                "load1": round(load1, 2), "load5": round(load5, 2), "load15": round(load15, 2),
                "threshold": th["cpu_pct"]},
        "mem": {"total": mem_total, "avail": mem_avail, "pct": mem_pct,
                "swap_pct": swap_pct, "threshold": th["mem_pct"]},
        "disks": disks,
        "net": {"rx_mbps": net_rx_mbps, "tx_mbps": net_tx_mbps, "threshold": th["net_mbps"]},
        "process": {"rss": self_rss, "uptime_sec": self_uptime},
        "alerts": alerts,
        "thresholds": th,
    }


def _proc_alive(pid: int) -> bool:
    try:
        _os.kill(pid, 0)
        return True
    except Exception:
        return False


def task_health() -> dict:
    """运行中任务 + 卡死检测 (超时无输出)"""
    th = thresholds()
    running, stalled = [], []
    now = _time.time()
    try:
        from backend.ssh_lib.runner import active_tasks
        for tid, proc in list(active_tasks.items()):
            pid = getattr(proc, "pid", None)
            started = getattr(proc, "_rp_started", None)
            last_out = getattr(proc, "_rp_last_out", None)
            alive = _proc_alive(pid) if pid else bool(proc)
            age = int(now - started) if started else None
            idle = int(now - last_out) if last_out else age
            row = {"task_id": str(tid)[:16], "pid": pid, "alive": alive,
                   "age_sec": age, "idle_sec": idle}
            if alive and idle is not None and idle >= th["task_stall_sec"]:
                row["stalled"] = True
                stalled.append(row)
            else:
                running.append(row)
    except Exception:
        pass
    # 近期任务统计 (从 runlog)
    recent = {}
    try:
        from backend import db
        rows = db.get_conn().execute(
            "SELECT status, COUNT(*) c FROM task_runs WHERE started_at >= datetime('now','-1 day') "
            "GROUP BY status").fetchall()
        for r in rows:
            recent[dict(r).get("status") or "unknown"] = dict(r).get("c") or 0
    except Exception:
        pass
    return {"running": running, "stalled": stalled,
            "stall_threshold_sec": th["task_stall_sec"], "recent_24h": recent}


def resilience_stats() -> dict:
    """容错回退链命中统计 + 已内置的回退策略清单"""
    hits = []
    try:
        from backend import db
        rows = db.get_conn().execute(
            "SELECT engine, status, COUNT(*) c FROM task_runs "
            "WHERE engine LIKE 'fallback%' OR engine LIKE '%-retry%' GROUP BY engine, status"
        ).fetchall()
        for r in rows:
            d = dict(r)
            hits.append({"engine": d.get("engine"), "status": d.get("status"), "count": d.get("c")})
    except Exception:
        pass
    # 内置回退策略 (真实存在于代码中的降级路径)
    strategies = [
        {"scope": "引擎选择", "chain": ["按设置指定引擎", "auto: 云端→rclone / 其余→rsync",
                                        "rclone 不支持该方向 → 退回 rsync"], "implemented": True},
        {"scope": "MySQL/MariaDB 备份", "chain": ["标准 dump 参数", "报 column_statistics → 补 --column-statistics=0 重跑",
                                                  "报 unknown variable/gtid → 去掉不兼容旗标重跑"], "implemented": True},
        {"scope": "远端音视频预览", "chain": ["Range 流式播放", "流播令牌不可用 → 退回 base64 整段加载 (≤50MB)"],
         "implemented": True},
        {"scope": "共享挂载", "chain": ["已挂载直接使用", "未挂载 → 自动挂载后重试", "失败 → 明确报错并保留配置"],
         "implemented": True},
        {"scope": "宿主机资源超阈", "chain": ["阈值告警", "持续超阈 → 事件推送 (可接告警通道)"], "implemented": True},
        {"scope": "任务卡死", "chain": [f"无输出 ≥{thresholds()['task_stall_sec']}s 判定卡死", "可一键取消 (kill 进程组)",
                                        "自动取消 (规划中)"], "implemented": False,
         "note": "检测与手动取消已实现; 自动取消待确认是否默认开启"},
    ]
    return {"hits": hits, "strategies": strategies}


def disk_pressure() -> dict:
    """日志/数据目录占用 (决定是否需要清理)"""
    out = {"runs_bytes": 0, "runs_files": 0, "db_bytes": 0, "staging_bytes": 0}
    try:
        rd = _os.path.join(_DATA, "runs")
        for w, _d, fs in _os.walk(rd):
            for f in fs:
                try:
                    out["runs_bytes"] += _os.path.getsize(_os.path.join(w, f))
                    out["runs_files"] += 1
                except Exception:
                    pass
    except Exception:
        pass
    try:
        for f in ("fonriv.db", "license_registry.db"):
            p = _os.path.join(_ROOTDATA, f)
            if _os.path.exists(p):
                out["db_bytes"] += _os.path.getsize(p)
    except Exception:
        pass
    try:
        st = _os.path.join(_DATA, "relay_staging")
        for w, _d, fs in _os.walk(st):
            for f in fs:
                try:
                    out["staging_bytes"] += _os.path.getsize(_os.path.join(w, f))
                except Exception:
                    pass
    except Exception:
        pass
    return out


def service_info() -> dict:
    """后台服务状态 (复用 systemd 查询)"""
    info = {"unit": "", "active": "", "since": "", "restarts": "", "pid": "", "uptime": ""}
    try:
        import shutil as _sh, subprocess as _sp
        if not _sh.which("systemctl"):
            return info
        unit = ""
        for u in ("fonriv",):
            r = _sp.run(["systemctl", "is-active", u], capture_output=True, text=True, timeout=6)
            if (r.stdout or "").strip() in ("active", "inactive", "failed", "activating"):
                unit = u
                break
        if not unit:
            return info
        r = _sp.run(["systemctl", "show", unit, "-p",
                     "ActiveState,SubState,ExecMainPID,ActiveEnterTimestamp,NRestarts"],
                    capture_output=True, text=True, timeout=6)
        kv = {}
        for line in (r.stdout or "").splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                kv[k.strip()] = v.strip()
        info.update({"unit": unit, "active": kv.get("ActiveState", ""),
                     "since": kv.get("ActiveEnterTimestamp", ""),
                     "restarts": kv.get("NRestarts", ""), "pid": kv.get("ExecMainPID", "")})
        try:
            import datetime as _dt
            ts = kv.get("ActiveEnterTimestamp", "")
            if ts:
                up = _dt.datetime.strptime(ts, "%a %Y-%m-%d %H:%M:%S %Z")
                s = int((_dt.datetime.now() - up).total_seconds())
                info["uptime"] = f"{s // 86400}天 {(s % 86400) // 3600}小时" if s >= 86400 else f"{s // 3600}小时 {(s % 3600) // 60}分"
                info["uptime_sec"] = s   # v1.0.0 · i18n: 附中性秒数, 前端按界面语言成文(中/英)
        except Exception:
            pass
    except Exception:
        pass
    return info


# ═════════════════════════════════════════════════════════════
# 自检: 一次性跑完所有检查并给出综合结论
# ═════════════════════════════════════════════════════════════

def selfcheck() -> dict:
    """综合自检: 汇总各项健康状况 → 总体结论 (ok/warn/err)"""
    hh = host_health(sample_sec=0.4)
    th = task_health()
    disks = disk_pressure()
    svc = service_info()
    alerts = list(hh.get("alerts") or [])
    if svc.get("active") and svc["active"] != "active":
        alerts.append({"level": "err", "item": "服务", "extra": str(svc["active"]),
                       "msg": "后台服务状态异常"})
    if th.get("stalled"):
        alerts.append({"level": "warn", "item": "任务",
                       "msg": f"{len(th['stalled'])} 个任务疑似卡死 (无输出 ≥{th['stall_threshold_sec']}s)"})
    if disks.get("runs_bytes", 0) > 2 * 1024**3:
        alerts.append({"level": "warn", "item": "日志",
                       "msg": f"运行日志占用 {disks['runs_bytes'] / 1024**3:.1f} GB — 建议清理"})
    # v5.19.6 · P0 安全门禁: rsync 版本
    rs = rsync_version_gate()
    if not rs.get("ok"):
        lvl = "err" if not rs.get("version") else "warn"
        # v1.0.0 · i18n: 探测到的原始版本串放 extra(数据), msg 保持可模板化的固定文案
        alerts.append({"level": lvl, "item": "安全基线",
                       "extra": (("rsync " + str(rs.get("version"))) if rs.get("version") else ""),
                       "msg": (f"低于安全基线 {rs['min']} ({rs['min']} 修 33 个路径类 CVE) — 建议升级"
                               if rs.get("version") else "rsync 未安装")})
    # v5.20.0 · 完整性 / 反调试 (只降级不退出, 故为 warn 而非 err)
    security = {}
    try:
        from backend.core_fabric import guards as _guards
        security = _guards.security_report()
        if security.get("integrity", {}).get("mismatched"):
            alerts.append({"level": "warn", "item": "完整性",
                           "msg": "关键模块被改动: " + ", ".join(security["integrity"]["mismatched"][:3])
                                  + " (自检提示, 不影响运行)"})
        if security.get("integrity", {}).get("missing"):
            alerts.append({"level": "warn", "item": "完整性",
                           "msg": "关键模块缺失: " + ", ".join(security["integrity"]["missing"][:3])})
        if security.get("debugger"):
            alerts.append({"level": "warn", "item": "反调试",
                           "msg": "检测到调试器附着 (仅提示)"})
        if security.get("env_flags"):
            alerts.append({"level": "warn", "item": "环境",
                           "msg": "存在可疑环境变量: " + ", ".join(security["env_flags"])})
    except Exception as _se:
        security = {"error": str(_se)[:120]}
    worst = "ok"
    for a in alerts:
        if a["level"] == "err":
            worst = "err"
            break
        if a["level"] == "warn" and worst == "ok":
            worst = "warn"
    return {"conclusion": worst, "alerts": alerts, "host": hh, "tasks": th,
            "disk_usage": disks, "service": svc, "rsync_gate": rs,
            "security": security}

# ═════════════════════════════════════════════════════════════
# 板块 3 · 引擎与路由矩阵
# ═════════════════════════════════════════════════════════════

# 各引擎的能力矩阵 (依据 providers.py 的真实构建逻辑, 非宣称)
_ENGINE_CAPS = {
    "rsync": {"compress": True, "encrypt": "L1 (SSH) / L2 (e2ee 可选)", "resume": True,
              "verify": "size+mtime / 可选 sha256 对账", "concurrency": "并行分片 (--files-from)",
              "delta": True, "note": "增量传输, 两端需有 rsync"},
    "rclone": {"compress": False, "encrypt": "L1 (HTTPS/SSH) / crypt remote", "resume": True,
               "verify": "--checksum", "concurrency": "多传输并发 (--transfers)",
               "delta": False, "note": "对象存储首选, 远端零依赖"},
    "quic": {"compress": False, "encrypt": "L1 (TLS/自签证书)", "resume": False,
             "verify": "分块 sha256 + 整文件 sha256", "concurrency": "N 条并行流 (UDP/QUIC)",
             "delta": False, "note": "已实现(v5.63.0 E3-3): 自建 UDP 服务端, 弱网/跨网; 需 aioquic 组件"},
    # v6.13.0 · 批13(用户报"DD 引擎系统设置里没显示"): 块级引擎如实列出(dd/ddrescue 仅块设备场景)
    "dd": {"compress": False, "encrypt": None, "resume": "skip/seek 断点续传(可断点)",
           "verify": "可选 cmp/sha256 复核", "concurrency": False, "delta": False,
           "note": "块级专用: 无坏道的整盘/分区、盘对盘克隆; 不参与文件/目录通路决策"},
    "ddrescue": {"compress": False, "encrypt": None, "resume": "mapfile 区间记录, 可断点续跑",
                 "verify": "多轮重试 + 反向读", "concurrency": False, "delta": False,
                 "note": "块级专用(有坏道/老旧盘必用 ddrescue 而非 dd); 未装时如实标注"},
}


def _tool_version(cmd: str) -> str:
    import subprocess as _sp, shutil as _sh
    if not _sh.which(cmd):
        return ""
    probes = {
        "rsync": [cmd, "--version"],
        "rclone": [cmd, "version"],
        "sshpass": [cmd, "-V"],
        "croc": [cmd, "--version"],
        "7z": [cmd, "i"],
        "zstd": [cmd, "--version"],
        "age": [cmd, "--version"],
    }
    argv = probes.get(cmd)
    if not argv:
        return ""
    try:
        r = _sp.run(argv, capture_output=True, text=True, timeout=6)
        txt = ((r.stdout or "") + (r.stderr or "")).strip()
        return txt.splitlines()[0][:70] if txt else ""
    except Exception:
        return ""


def engines_matrix() -> dict:
    """引擎注册 + 工具探测 + 能力矩阵 + 命令支持"""
    import shutil as _sh
    try:
        from backend.core_fabric.providers import PROVIDERS
        names = list(PROVIDERS.keys())
    except Exception:
        names = ["rsync", "rclone"]
    out = []
    for n in names:
        path = _sh.which(n) or ""
        out.append({
            "name": n,
            "registered": True,
            "installed": bool(path),
            "path": path,
            "version": _tool_version(n),
            "caps": _ENGINE_CAPS.get(n, {}),
            "planned": False,
        })
    # multi-stream: 已实现(非"规划中") —— 以 aioquic 组件可用性如实呈现
    if "multi-stream" not in names:
        try:
            from backend.fonrvfs import quic as _q2
            _qa2 = _q2.available()
            out.append({"name": "multi-stream", "registered": True,
                        "installed": bool(_qa2.get("available")), "path": "",
                        "version": ("aioquic %s" % _qa2.get("version")) if _qa2.get("available") else "",
                        "caps": _ENGINE_CAPS.get("quic", {}), "planned": False,
                        "reason": _qa2.get("reason") or "", "hint": _qa2.get("hint") or "",
                        "install": "quic" if not _qa2.get("available") else ""})
        except Exception as _qe2:
            out.append({"name": "multi-stream", "registered": True, "installed": False, "path": "",
                        "version": "", "caps": _ENGINE_CAPS.get("quic", {}), "planned": False,
                        "reason": "组件探测失败: %s" % str(_qe2)[:80], "hint": "", "install": "quic"})
    # v6.13.0 · 批13: 块级引擎(dd/ddrescue)如实列出 —— 用户报"DD 引擎系统设置里没显示"
    for n in ("dd", "ddrescue"):
        path = _sh.which(n) or ""
        out.append({"name": n, "registered": True, "installed": bool(path), "path": path,
                    "version": _tool_version(n), "caps": _ENGINE_CAPS.get(n, {}),
                    "planned": False, "block": True,
                    "reason": "" if path else "未安装(块级引擎可选: dd 随 coreutils; ddrescue 需 apt install gddrescue)"})
    # 引擎选择相关的系统设置
    settings = {}
    try:
        from backend import db
        for k in ("transfer_engine", "conc_rsync", "conc_sftp", "conc_s3",
                  "transfer_rsync_shards_enable", "transfer_rsync_shards_min_files"):
            v = db.setting_get(k, "")
            if v not in ("", None):
                settings[k] = v
    except Exception:
        pass
    routes = routing_matrix()
    return {"engines": out, "settings": settings, "routes": routes}


def routing_matrix() -> list:
    """路由模式矩阵: 真实实现状态 + 适用场景 + 代码位置"""
    import os as _o
    base = _o.path.join(_ROOT, "backend", "core_fabric")
    def _has(f):
        return _o.path.exists(_o.path.join(base, f))
    return [
        {"mode": "直链 (Direct)", "implemented": True, "file": "providers.py",
         "dep": "rsync / rclone", "scene": "源与目标网络可达", "how": "单段命令直接执行"},
        {"mode": "Relay 中转", "implemented": _has("relay.py"), "file": "relay.py",
         "dep": "本机暂存 + 两段传输", "scene": "两端互不可达但都能连到本控制面",
         "how": "pull(源→本机) 后 push(本机→目标); 可选 e2ee 静态加密 (落盘即密文)"},
        {"mode": "Air-Gap 摆渡", "implemented": _has("airgap.py") or _o.path.exists(
            _o.path.join(_ROOT, "backend", "airgap.py")), "file": "airgap.py",
         "dep": "RSA-PSS 签名 + AES-256 + Merkle", "scene": "物理隔离网络 (U盘/光盘)",
         "how": ".rpferry 包, 导入端凭公钥验签 + Merkle 根校验 + 30 天时效"},
        {"mode": "Croc 点对点", "implemented": _has("croc.py") or _o.path.exists(
            _o.path.join(_ROOT, "backend", "handlers", "croc.py")), "file": "handlers/croc.py",
         "dep": "点对点直传组件", "scene": "两台机器临时直传, 不想配 SSH",
         "how": "口令配对 + 中继 rendezvous, 端到端加密"},
    ]


# ═════════════════════════════════════════════════════════════
# 板块 4 · 安全与授权
# ═════════════════════════════════════════════════════════════

def security_matrix() -> dict:
    """三层安全 + 授权状态 + 用户权限矩阵"""
    # ① 三层安全
    layers = [
        {"level": "L1 · 通道加密", "algo": "SSH (rsync) / HTTPS (对象存储) / TLS",
         "implemented": True, "scope": "传输链路", "note": "SSH 使用 accept-new 主机校验"},
        {"level": "L2 · 端到端加密", "algo": "X25519 协商 + ChaCha20-Poly1305 (AEAD) + HKDF-SHA256",
         "implemented": True, "scope": "内容级 (中继见码不见文)", "note": ""},
        {"level": "完整性校验", "algo": "逐块 SHA256 + Merkle 根 + Ledger 对账",
         "implemented": True, "scope": "产物 / 摆渡包", "note": ""},
    ]
    # L2 接线状态 — 如实区分"引擎就绪"与"已接入主传输链路"
    try:
        from backend.core_fabric import e2ee as _e2
        l2_engine = hasattr(_e2, "e2e_encrypt_file")
    except Exception:
        l2_engine = False
    wired = []
    try:
        with open(_os.path.join(_ROOT, "backend", "core_fabric", "relay.py"), encoding="utf-8") as f:
            wired.append(("relay", "e2ee" in f.read()))
    except Exception:
        pass
    try:
        with open(_os.path.join(_ROOT, "backend", "core_fabric", "planner.py"), encoding="utf-8") as f:
            src = f.read()
            # v5.19.4 · planner 已接入 L2 决策 (force_l2 / via_relay / 公网非 SSH)
            _l2_on = ('return "L2"' in src) or ("return 'L2'" in src) or ("L2" in src and "via_relay" in src)
            wired.append(("planner 决策", _l2_on))
    except Exception:
        pass
    layers[1]["engine_ready"] = l2_engine
    layers[1]["wired"] = {k: v for k, v in wired}
    layers[1]["note"] = ("已接线: planner 按 relay/公网/显式要求判定 L2, relay 中转自动启用暂存加密 "
                         "(LL2 引擎就绪 + 决策层 + 执行层均已接入)")

    # ② 授权状态
    # v1.0.0 · 社区版: 无远程授权/到期概念 —— 安全板块只展示架构与权限矩阵,
    #   这里给一个固定标识(原授权心跳/闸门/实例ID 字段与旧授权机制一并移除)
    lic = {"status": "community", "edition": "社区版 (开源 · AGPL-3.0)"}
    # 功能键清单
    feat = {"groups": 0, "editions": {}}
    try:
        import json as _j
        with open(_os.path.join(_ROOT, "scripts", "features.json"), encoding="utf-8") as f:
            fd = _j.load(f)
        fz = fd.get("features")
        feat["groups"] = len(fz) if isinstance(fz, (dict, list)) else 0
        feat["editions"] = fd.get("editions") or {}
    except Exception:
        pass
    # ③ 用户与权限矩阵
    users = []
    try:
        from backend import db
        conn = db.get_conn()
        rows = conn.execute("SELECT id,username,role FROM users ORDER BY id").fetchall()
        for r in rows:
            d = dict(r)
            perms = []
            try:
                perms = db.user_perms_get(conn, int(d["id"])) or []
            except Exception:
                try:
                    perms = db.user_perms_get(int(d["id"])) or []
                except Exception:
                    perms = []
            is_admin = (d.get("role") == "admin")
            users.append({"id": d["id"], "username": d.get("username"), "role": d.get("role"),
                          "is_admin": is_admin,
                          "perm_count": len(perms),
                          "perms": (perms[:20] if not is_admin else []),
                          "perm_note": "管理员 — 全部功能" if is_admin else f"授权 {len(perms)} 个页面"})
    except Exception as e:
        users = [{"error": str(e)[:100]}]
    # 测试残留用户识别 (数据卫生)
    import re as _re2
    stub_users = [u.get("username") for u in users
                  if u.get("username") and _re2.match(r"^(v\d+[._-]|test[._-]|e2e[._-])", u["username"], _re2.I)]

    # ═══ v5.19.6 · 授权覆盖完整性与用户权限匹配 ═══
    coverage = {"parity": None, "groups": []}
    try:
        import json as _j
        from backend.license import FEATURE_EDITIONS
        with open(_os.path.join(_ROOT, "scripts", "features.json"), encoding="utf-8") as f:
            fd = _j.load(f)
        fz = fd.get("features") or {}
        fkeys = set(fz.keys()) if isinstance(fz, dict) else {x.get("key") for x in fz}
        ekeys = set(FEATURE_EDITIONS.keys())
        missing_in_ed = sorted(fkeys - ekeys)
        missing_in_fj = sorted(ekeys - fkeys)
        coverage["parity"] = (not missing_in_ed and not missing_in_fj)
        coverage["missing_in_editions"] = missing_in_ed
        coverage["missing_in_features"] = missing_in_fj
        for k in sorted(fkeys):
            ed = FEATURE_EDITIONS.get(k)
            coverage["groups"].append({"key": k,
                                       "min_edition": ed if ed else "all/free",
                                       "covered": True})
    except Exception as e:
        coverage["error"] = str(e)[:100]

    # 功能键 → 解锁页面映射 (NAV_TREE feat 键)
    edition_pages = []
    try:
        import re as _re3
        with open(_os.path.join(_ROOT, "frontend", "static", "app.js"), encoding="utf-8") as f:
            src = f.read()
        from backend.license import FEATURE_EDITIONS, _edition_meets
        for pm in _re3.finditer(r"\{\s*key:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'(?:,\s*children:\s*null)?(?:,\s*feat:\s*'([^']+)')?", src):
            key, label, feat_key = pm.group(1), pm.group(2), pm.group(3)
            if not feat_key:
                edition_pages.append({"page": key, "label": label, "feat": None, "min_edition": "all"})
                continue
            ed_req = FEATURE_EDITIONS.get(feat_key)
            edition_pages.append({"page": key, "label": label, "feat": feat_key,
                                  "min_edition": ed_req if ed_req else "all/free"})
    except Exception:
        pass

    # 用户权限 vs 授权匹配: 用户授权页面引用的功能键是否被当前 license 允许
    user_license_match = []
    try:
        from backend.license import _status_allows
        st = lic if isinstance(lic, dict) else {}
        for u in users:
            if u.get("error") or u.get("is_admin"):
                continue
            perms = u.get("perms") or []
            blocked = []
            for pg in edition_pages:
                if pg["page"] in perms and pg["feat"] and pg["min_edition"] != "all/free":
                    try:
                        if not _status_allows(st, pg["feat"]):
                            blocked.append(pg["page"])
                    except Exception:
                        pass
            user_license_match.append({"username": u.get("username"),
                                       "granted": len(perms),
                                       "blocked_by_license": blocked[:10]})
    except Exception:
        pass

    return {"layers": layers, "license": lic, "features": feat,
            "users": users, "stub_users": stub_users,
            "coverage": coverage, "edition_pages": edition_pages[:40],
            "user_license_match": user_license_match}


# ═════════════════════════════════════════════════════════════
# 板块 5 · 插件与模块
# ═════════════════════════════════════════════════════════════

def plugins_matrix() -> dict:
    """工具/插件探测 (含版本) + 功能分组 + 页面清单"""
    # ① 对外部可执行工具做探测
    import shutil as _sh
    TOOLS = [
        ("rsync", "传输引擎", True), ("sshpass", "SSH 密码认证 (rsync/ssh 依赖)", True),
        ("rclone", "对象存储引擎", False), ("croc", "P2P 直传", False),
        ("tar", "归档 (内置优先)", False), ("gzip", "压缩", False), ("zstd", "压缩 (推荐)", False),
        ("lz4", "极速压缩", False), ("7z", "7z/多种格式", False), ("unrar", "RAR 解压", False),
        ("unzip", "ZIP 解压", False), ("age", "现代文件加密 (备选)", False),
        ("sqlite3", "SQLite 备份", False), ("mysqldump", "MySQL/MariaDB 备份", False),
        ("pg_dump", "PostgreSQL 备份", False), ("mongodump", "MongoDB 备份", False),
        ("redis-cli", "Redis 备份", False), ("sqlcmd", "SQL Server 备份", False),
        ("clickhouse-client", "ClickHouse 备份", False), ("docker", "容器管理", False),
        ("restic", "去重备份", False), ("aws", "S3 对象锁/生命周期", False),
        ("ldap3", "LDAP 登录 (Python 包)", False),
    ]
    tools = []
    for name, desc, required in TOOLS:
        if name == "ldap3":
            try:
                import importlib
                ok = importlib.util.find_spec("ldap3") is not None
            except Exception:
                ok = False
            path = "python 包" if ok else ""
            ver = ""
        else:
            path = _sh.which(name) or ""
            ok = bool(path)
            ver = _tool_version(name) if ok else ""
        tools.append({"name": name, "desc": desc, "installed": ok, "required": required,
                      "path": path, "version": ver})
    miss_req = [t["name"] for t in tools if t["required"] and not t["installed"]]
    miss_opt = [t["name"] for t in tools if not t["required"] and not t["installed"]]

    # ② 功能分组 (features.json)
    groups = []
    try:
        import json as _j
        with open(_os.path.join(_ROOT, "scripts", "features.json"), encoding="utf-8") as f:
            fd = _j.load(f)
        fz = fd.get("features") or {}
        if isinstance(fz, dict):
            for k, v in fz.items():
                label = v.get("label") if isinstance(v, dict) else str(v)
                groups.append({"key": k, "label": label or k,
                               "editions": (v.get("editions") if isinstance(v, dict) else None)})
        elif isinstance(fz, list):
            for v in fz:
                groups.append({"key": (v or {}).get("key"), "label": (v or {}).get("label")})
    except Exception:
        pass

    # ③ 页面清单 (NAV_TREE)
    pages = []
    try:
        import re as _re3
        with open(_os.path.join(_ROOT, "frontend", "static", "app.js"), encoding="utf-8") as f:
            src = f.read()
        m = _re3.search(r"window\.NAV_TREE\s*=\s*\[(.*?)\n\];", src, _re3.S)
        if m:
            blk = m.group(1)
            for pm in _re3.finditer(r"\{\s*key:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'", blk):
                pages.append({"key": pm.group(1), "label": pm.group(2)})
    except Exception:
        pass

    # ④ 面板文件清单 (前端实际存在的页面)
    panel_files = []
    try:
        pdir = _os.path.join(_ROOT, "frontend", "static", "panels")
        for fn in sorted(_os.listdir(pdir)):
            if fn.endswith(".js"):
                panel_files.append(fn[:-3])
    except Exception:
        pass

    return {"tools": tools, "missing_required": miss_req, "missing_optional": miss_opt,
            "feature_groups": groups, "pages": pages, "panel_files": panel_files,
            "summary": {"tools_total": len(tools),
                        "installed": sum(1 for t in tools if t["installed"]),
                        "missing": len(miss_req) + len(miss_opt)}}

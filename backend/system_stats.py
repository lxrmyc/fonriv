"""v4.23.0 · 系统状态采集与推送
每 30s 采集 CPU / 内存 / 磁盘，publish `system.stats` 主题。
优先 psutil，回落到 /proc + os.statvfs + os.getloadavg。
"""
from __future__ import annotations
import logging

import os
import shutil
import threading
import time

try:
    import psutil  # type: ignore
    _HAS_PSUTIL = True
except Exception:
    _HAS_PSUTIL = False


_started = False


def _read_proc_meminfo() -> dict:
    try:
        with open("/proc/meminfo") as f:
            info = {}
            for line in f:
                parts = line.split(":", 1)
                if len(parts) != 2: continue
                k = parts[0].strip()
                v = parts[1].strip().split()
                if v: info[k] = int(v[0]) * 1024  # kB → bytes
            total = info.get("MemTotal", 0)
            avail = info.get("MemAvailable", info.get("MemFree", 0))
            used = total - avail
            return {"total": total, "used": used, "available": avail,
                    "percent": round(used * 100.0 / total, 1) if total else 0}
    except Exception:
        return {"total": 0, "used": 0, "available": 0, "percent": 0}


def _cpu_percent_fallback() -> float:
    """基于 loadavg 归一化到 [0, 100]"""
    try:
        la1, _, _ = os.getloadavg()
        cores = os.cpu_count() or 1
        return round(min(la1 / cores * 100.0, 100.0), 1)
    except Exception:
        return 0.0


def collect() -> dict:
    """返回一次采样。安全（永不抛）"""
    result = {
        "ts": time.time(),
        "cpu_percent": 0.0,
        "memory": {"total": 0, "used": 0, "available": 0, "percent": 0},
        "disk": {"total": 0, "used": 0, "free": 0, "percent": 0, "path": "/"},
        "load": [0.0, 0.0, 0.0],
        "uptime_sec": 0,
        "net": {"sent_rate": 0.0, "recv_rate": 0.0,
                "sent_total": 0, "recv_total": 0,
                "sent_mb": 0.0, "recv_mb": 0.0},
        # v6.3.7 · 宿主机身份信息(用户要求: 左栏宿主机信息要有系统/内核/主机名)。
        #   纯本地读取(/etc/os-release + platform), 一次采样带上, 不额外开接口。
        "host": {"hostname": "", "os": "", "kernel": "", "arch": "", "boot_time": 0},
    }
    try:
        import platform as _pf
        h = result["host"]
        h["hostname"] = _pf.node() or ""
        h["kernel"] = "%s %s" % (_pf.system(), _pf.release())
        h["arch"] = _pf.machine() or ""
        try:                                  # 发行版名(有 /etc/os-release 就用它, 否则退回 platform)
            _osname = ""
            with open("/etc/os-release", "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if line.startswith("PRETTY_NAME="):
                        _osname = line.split("=", 1)[1].strip().strip('"')
                        break
            h["os"] = _osname or (_pf.system() + " " + _pf.version())[:60]
        except Exception:
            h["os"] = (_pf.system() + " " + _pf.version())[:60]
    except Exception:
        pass
    try:
        if _HAS_PSUTIL:
            try:
                result["cpu_percent"] = float(psutil.cpu_percent(interval=None))
            except Exception:
                result["cpu_percent"] = _cpu_percent_fallback()
            try:
                # v5.33.0 · 网络 I/O 速率 (需要两次采样差值)
                try:
                    nio = psutil.net_io_counters()
                    now = time.time()
                    if hasattr(collect, '_last_net'):
                        dt = now - collect._last_ts
                        if dt > 0.5:
                            sb = nio.bytes_sent - collect._last_sent
                            rb = nio.bytes_recv - collect._last_recv
                            if sb >= 0 and rb >= 0:
                                result["net"]["sent_rate"] = round(sb / dt / 1024, 1)   # KB/s
                                result["net"]["recv_rate"] = round(rb / dt / 1024, 1)
                    collect._last_net = nio
                    collect._last_ts = now
                    collect._last_sent = nio.bytes_sent
                    collect._last_recv = nio.bytes_recv
                    result["net"]["sent_total"] = nio.bytes_sent
                    result["net"]["recv_total"] = nio.bytes_recv
                    result["net"]["sent_mb"] = round(nio.bytes_sent / 1048576, 1)
                    result["net"]["recv_mb"] = round(nio.bytes_recv / 1048576, 1)
                except Exception:
                    pass
                m = psutil.virtual_memory()
                result["memory"] = {
                    "total": int(m.total), "used": int(m.used),
                    "available": int(m.available), "percent": float(m.percent),
                }
            except Exception:
                result["memory"] = _read_proc_meminfo()
        else:
            result["cpu_percent"] = _cpu_percent_fallback()
            result["memory"] = _read_proc_meminfo()

        try:
            du = shutil.disk_usage("/")
            result["disk"] = {
                "total": int(du.total), "used": int(du.used), "free": int(du.free),
                "percent": round(du.used * 100.0 / du.total, 1) if du.total else 0,
                "path": "/",
            }
        except Exception as _e: logging.debug("suppressed", exc_info=True)
        try:
            result["load"] = list(os.getloadavg())
        except Exception as _e: logging.debug("suppressed", exc_info=True)
        try:
            with open("/proc/uptime") as f:
                result["uptime_sec"] = int(float(f.read().split()[0]))
        except Exception as _e: logging.debug("suppressed", exc_info=True)
    except Exception as e:
        print(f"[system_stats] collect fail: {e}")
    return result


def _loop(interval: int = 30):
    from backend import events as _events
    # 首次调用 psutil.cpu_percent 需要 interval=1 建立基线
    if _HAS_PSUTIL:
        try: psutil.cpu_percent(interval=None)
        except Exception as _e: logging.debug("suppressed", exc_info=True)
    while True:
        try:
            stats = collect()
            _events.publish("system.stats", stats)
        except Exception as e:
            print(f"[system_stats] publish fail: {e}")
        time.sleep(interval)


def start(interval: int = 30) -> None:
    global _started
    if _started:
        return
    _started = True
    t = threading.Thread(target=_loop, args=(interval,), daemon=True,
                         name="system-stats")
    t.start()
    print(f"[system_stats] started · interval={interval}s · psutil={_HAS_PSUTIL}")

"""Fonriv · SSH 服务器硬件与资源扫描 (v5.98.26)

用户要求: SSH 服务器表里要能看到 **CPU / 内存 / 硬盘 / 显卡** 的型号与**占用情况**。

设计:
  · 一次 SSH 会话跑一段**带分隔符的组合命令**取全(减少往返): lscpu /proc/stat×2 /proc/meminfo
    /proc/loadavg /proc/uptime / df / lsblk / nvidia-smi(或 lspci) / docker 计数
  · CPU 占用率用 /proc/stat 两次采样(间隔 1s)算真实值 —— 不猜、不用负载均值冒充
  · 显卡: 有 nvidia-smi 才给利用率与显存; 否则用 lspci 报**型号**并**明说没有占用率数据**
  · 结果按主机缓存(TTL 60s), 避免每次刷新都去连一遍; refresh=true 强制重扫
  · 单主机失败**只影响该主机**(如实回 err), 不影响其它主机
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import Any, Dict, List, Optional

from fastapi import WebSocket

from backend.log import log_operation

CACHE_TTL = 60
_CACHE: Dict[str, Dict[str, Any]] = {}

# v5.98.26 · 实测踩坑: 远端 SSH 会话可能带中文 locale → `lscpu` 输出成「架构：/CPU 运行模式：」,
#   按英文标签解析就取不到型号(实测某台机器 CPU 型号显示成 "?"), 且 head 截断也会切掉型号行。
#   强制 LC_ALL=C/LANG=C 让输出稳定为英文; 同时附 /proc/cpuinfo 作兜底(内核字段永远是英文)。
CMD = r"""
export LC_ALL=C LANG=C
echo '###HOST'; hostname 2>/dev/null; uname -sr 2>/dev/null
echo '###LSCPU'; (lscpu 2>/dev/null || true) | head -40
echo '###CPUINFO'; grep -m3 -E 'model name|cpu model|Hardware|Processor' /proc/cpuinfo 2>/dev/null
echo '###CPU1'; grep '^cpu ' /proc/stat 2>/dev/null
sleep 1
echo '###CPU2'; grep '^cpu ' /proc/stat 2>/dev/null
echo '###MEM'; grep -E 'MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree' /proc/meminfo 2>/dev/null
echo '###LOAD'; cat /proc/loadavg 2>/dev/null
echo '###UPTIME'; cat /proc/uptime 2>/dev/null
echo '###DF'; df -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x fuse.sshfs 2>/dev/null
echo '###LSBLK'; lsblk -d -b -o NAME,SIZE,MODEL,ROTA,TYPE 2>/dev/null | head -20
echo '###GPU'; if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader 2>/dev/null; else echo 'NO_NVIDIA_SMI'; (lspci 2>/dev/null | grep -iE 'vga|3d|display' | head -4); fi
echo '###DOCKER'; if command -v docker >/dev/null 2>&1; then echo -n 'run='; docker ps -q 2>/dev/null | wc -l; echo -n 'all='; docker ps -aq 2>/dev/null | wc -l; echo -n 'img='; docker images -q 2>/dev/null | wc -l; else echo 'NO_DOCKER'; fi
echo '###END'
"""


def _sections(txt: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    cur = None
    for line in (txt or "").splitlines():
        if line.startswith("###"):
            cur = line[3:].strip()
            out[cur] = ""
            continue
        if cur:
            out[cur] += line + "\n"
    return out


def _cpu_from_stat(line: str) -> Optional[Dict[str, int]]:
    p = (line or "").split()
    if len(p) < 5 or p[0] != "cpu":
        return None
    try:
        v = [int(x) for x in p[1:]]
    except Exception:
        return None
    idle = v[3] + (v[4] if len(v) > 4 else 0)      # idle + iowait
    total = sum(v)
    return {"total": total, "idle": idle}


def _kb(s: str) -> Optional[int]:
    m = re.search(r"(\d+)", s or "")
    return int(m.group(1)) * 1024 if m else None


def _b(s: str) -> Optional[int]:
    m = re.search(r"(\d+)", s or "")
    return int(m.group(1)) if m else None


def _parse(txt: str) -> Dict[str, Any]:
    sec = _sections(txt)
    out: Dict[str, Any] = {}

    # ── CPU ──
    lscpu = sec.get("LSCPU", "") or ""
    model = ""
    # 英文标签 / 中文标签 / 通用兜底
    for pat in (r"^Model name:\s*(.+)$", r"^型号名称：\s*(.+)$", r"^Model\s*:\s*(.+)$"):
        m = re.search(pat, lscpu, re.M)
        if m:
            model = m.group(1).strip()
            break
    if not model:
        ci = sec.get("CPUINFO", "") or ""
        m = re.search(r"^\s*(?:model name|cpu model|Hardware|Processor)\s*:\s*(.+)$", ci, re.M)
        if m:
            model = m.group(1).strip()
    cores = None
    m = re.search(r"^CPU\(s\):\s*(\d+)", lscpu, re.M)
    if m:
        cores = int(m.group(1))
    mhz = ""
    m = re.search(r"^CPU MHz:\s*([\d.]+)", lscpu, re.M)
    if m:
        mhz = m.group(1)
    arch = ""
    for pat in (r"^Architecture:\s*(\S+)", r"^架构：\s*(\S+)"):
        m = re.search(pat, lscpu, re.M)
        if m:
            arch = m.group(1)
            break
    a, b = _cpu_from_stat(sec.get("CPU1", "")), _cpu_from_stat(sec.get("CPU2", ""))
    usage = None
    if a and b and b["total"] > a["total"]:
        dt = b["total"] - a["total"]
        di = b["idle"] - a["idle"]
        usage = round(max(0.0, min(100.0, (dt - di) * 100.0 / dt)), 1)
    load = ""
    la = (sec.get("LOAD", "") or "").split()
    if la:
        load = " / ".join(la[:3])
    up = ""
    ut = (sec.get("UPTIME", "") or "").split()
    if ut:
        try:
            s = float(ut[0])
            d, s = divmod(int(s), 86400)
            h, s = divmod(s, 3600)
            mm, _ = divmod(s, 60)
            up = ("%d天 " % d if d else "") + "%d小时%d分" % (h, mm)
        except Exception:
            up = ""
    out["cpu"] = {"model": model, "cores": cores, "mhz": mhz, "arch": arch,
                  "usage_pct": usage, "load": load, "uptime": up}

    # ── 内存 ──
    mem = sec.get("MEM", "") or ""
    mt, mav, mf = _kb(_g(mem, "MemTotal")), _kb(_g(mem, "MemAvailable")), _kb(_g(mem, "MemFree"))
    st, sf = _kb(_g(mem, "SwapTotal")), _kb(_g(mem, "SwapFree"))
    used = (mt - mav) if (mt and mav is not None) else None
    out["mem"] = {"total": mt, "available": mav, "free": mf, "used": used,
                  "pct": round(used * 100.0 / mt, 1) if (used and mt) else None,
                  "swap_total": st, "swap_used": (st - sf) if (st and sf is not None) else None}

    # ── 磁盘(df) ──
    disks: List[Dict[str, Any]] = []
    for line in (sec.get("DF", "") or "").splitlines()[1:]:
        p = line.split()
        if len(p) < 6 or not p[1].isdigit():
            continue
        tot, u = int(p[1]), int(p[2])
        mp = " ".join(p[5:])
        if mp.startswith("/snap") or mp.startswith("/var/lib/docker/overlay2"):
            continue
        disks.append({"device": p[0], "mount": mp, "total": tot, "used": u,
                      "free": int(p[3]) if p[3].isdigit() else None,
                      "pct": round(u * 100.0 / tot, 1) if tot else None})
    disks.sort(key=lambda x: -(x.get("total") or 0))
    out["disks"] = disks[:8]
    blk = []
    for line in (sec.get("LSBLK", "") or "").splitlines()[1:]:
        p = line.split(None, 4)
        if len(p) >= 4 and p[1].isdigit():
            blk.append({"name": p[0], "size": int(p[1]), "model": (p[2] if p[2] != "-" else ""),
                        "rota": (p[3] == "1")})
    out["blockdevices"] = blk[:8]

    # ── 显卡 ──
    gpu_txt = (sec.get("GPU", "") or "").strip()
    gpus = []
    if gpu_txt.startswith("NO_NVIDIA_SMI"):
        for ln in gpu_txt.splitlines()[1:]:
            ln = ln.strip()
            if ln:
                # 只留型号(去掉 PCI 地址前缀)
                gpus.append({"model": re.sub(r"^[0-9a-fA-F:.]+ ", "", ln)[:120],
                             "util": None, "mem_used": None, "mem_total": None, "temp": None})
        note = ("本机无 nvidia-smi → 只报型号, **没有占用率数据**"
                if gpus else "未检测到显示设备")
        out["gpu_note"] = note
    else:
        for ln in gpu_txt.splitlines():
            p = [x.strip() for x in ln.split(",")]
            if not p or not p[0]:
                continue
            gpus.append({"model": p[0],
                         "util": p[1] if len(p) > 1 else None,
                         "mem_used": p[2] if len(p) > 2 else None,
                         "mem_total": p[3] if len(p) > 3 else None,
                         "temp": p[4] if len(p) > 4 else None})
        out["gpu_note"] = ""
    out["gpus"] = gpus

    # ── 容器 ──
    dk = (sec.get("DOCKER", "") or "").strip()
    if dk.startswith("NO_DOCKER"):
        out["containers"] = {"docker": False}
    else:
        run = re.search(r"run=(\d+)", dk)
        allc = re.search(r"all=(\d+)", dk)
        img = re.search(r"img=(\d+)", dk)
        out["containers"] = {"docker": True,
                             "running": int(run.group(1)) if run else None,
                             "total": int(allc.group(1)) if allc else None,
                             "images": int(img.group(1)) if img else None}

    out["host"] = (sec.get("HOST", "") or "").strip().splitlines()[:2]
    return out


def _g(block: str, key: str) -> str:
    m = re.search(r"^%s:\s*(.*)$" % re.escape(key), block or "", re.M)
    return m.group(1) if m else ""


async def _scan_one(prof: dict) -> dict:
    from backend.handlers.server_profile import resolve_resource
    from backend.ssh_lib import SSHTarget
    guid = prof.get("guid")
    base = {"guid": guid, "name": prof.get("name") or prof.get("hostname") or "",
            "host": prof.get("hostname") or "", "ok": False}
    try:
        r = resolve_resource(guid, "ssh")
        p = r["params"]
    except Exception as e:
        return {**base, "err": "档案凭据不可用: %s: %s" % (type(e).__name__, str(e)[:140])}
    try:
        tgt = SSHTarget.from_ws_data({
            "host": p.get("host") or "", "port": p.get("port") or 22,
            "user": p.get("user") or "root", "auth_type": p.get("auth_type") or "pass",
            "password": p.get("password") or "", "key": p.get("key") or "",
            "passphrase": p.get("passphrase") or "", "os_type": p.get("os_type") or "auto"})
        async with tgt.runner() as run:
            code, out, err = await run.exec(CMD, timeout=45, merge_stderr=True)
        if code != 0 and not out:
            return {**base, "err": "采集失败(rc=%s): %s" % (code, (err or "")[:160])}
        data = _parse(out or "")
        if not (data.get("cpu") or {}).get("model") and not (data.get("mem") or {}).get("total"):
            return {**base, "err": ("该主机未返回 Linux 指标(可能不是 Linux, 或缺少 lscpu//proc) —— "
                                    "本功能目前只采集 Linux 主机"),
                    "raw_head": (out or "")[:160]}
        return {**base, "ok": True, **data, "ts": time.strftime("%Y-%m-%d %H:%M:%S")}
    except Exception as e:
        return {**base, "err": "%s: %s" % (type(e).__name__, str(e)[:160])}


async def handle_server_hw_scan(ws: WebSocket, data: dict):
    """扫描服务器的 CPU/内存/磁盘/显卡(含占用率) + 容器计数。

    params: guids=[...] 或 all=true; refresh=true 忽略缓存。
    结果按主机缓存 60 秒(避免每次刷新都连一遍); 单机失败只影响该机。
    """
    req = data.get("req_id") or ""
    refresh = bool(data.get("refresh"))
    try:
        from backend import db as _db
        rows = _db.get_conn().execute(
            "SELECT guid,name,hostname,ssh_port,ssh_user,kind,protocols FROM server_profiles "
            "ORDER BY sort_order ASC, name ASC LIMIT 200").fetchall()
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": req,
                            "msg": "读取服务器档案失败: %s: %s" % (type(e).__name__, e)})
        return
    profs = [dict(x) for x in rows]
    want = data.get("guids")
    if isinstance(want, list) and want:
        profs = [p for p in profs if p.get("guid") in want]
    # v5.98.26 · 实测: server_profiles.protocols 是**按协议设置的 JSON 字典**(不是能力列表),
    #   拿它判断"有没有 SSH"会漏掉一大半主机。改为: 只要配了 ssh_port/ssh_user 就扫;
    #   非 Linux 主机(Win/mac)由采集结果如实回报"未返回 Linux 指标", 不假装成功。
    profs = [p for p in profs if p.get("hostname") and (p.get("ssh_port") or p.get("ssh_user"))]
    if not profs:
        await ws.send_json({"type": "result", "status": "error", "req_id": req,
                            "msg": "没有可扫描的 SSH 服务器档案(请先在连接中心添加)"})
        return
    now = time.time()
    todo = []
    out: List[dict] = []
    for p in profs:
        g = p.get("guid")
        c = _CACHE.get(g)
        if (not refresh) and c and (now - c.get("_at", 0) < CACHE_TTL):
            out.append(c["data"])
        else:
            todo.append(p)
    if todo:
        sem = asyncio.Semaphore(6)

        async def _g1(p):
            async with sem:
                return await _scan_one(p)

        res = await asyncio.gather(*[_g1(p) for p in todo])
        for p, r in zip(todo, res):
            _CACHE[p.get("guid")] = {"_at": time.time(), "data": r}
            out.append(r)
    okN = sum(1 for x in out if x.get("ok"))
    log_operation("服务器扫描", "硬件与资源", "共 %d 台, 成功 %d 台" % (len(out), okN))
    await ws.send_json({"type": "result", "status": "ok", "req_id": req,
                        "scanned": len(out), "ok_count": okN, "cache_ttl": CACHE_TTL,
                        "items": out})

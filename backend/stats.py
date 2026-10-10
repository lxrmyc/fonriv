"""Fonriv - 备份/传输统计与智能分析 (v4.67.0 · E1+E2)

E1 备份异常检测 (3σ 统计模型, 无需 LLM):
    每次备份/传输完成记录 (文件数, 字节数, 耗时, 速率);
    与最近 N 次同类任务基线比较, 偏差 > 3σ 判定异常并告警
    (例: "本次备份文件数减少 8000 (-40%), 请检查是否异常删除")

E2 智能时间推荐:
    按小时聚合历史传输速率, 推荐速率最高的 2 小时窗口

数据: run_stats 表 (kind/target/files/bytes/duration/speed/hour/ts)
"""
from __future__ import annotations

import math
import re
from datetime import datetime

from backend import db

BASELINE_N = 30          # 基线样本数
SIGMA_WARN = 3.0         # 3σ 告警阈值
SIGMA_INFO = 2.0         # 2σ 提示


def ensure_table(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS run_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT 1,
            kind TEXT NOT NULL,
            target TEXT DEFAULT '',
            files INTEGER DEFAULT 0,
            bytes INTEGER DEFAULT 0,
            duration_sec REAL DEFAULT 0,
            speed_bps REAL DEFAULT 0,
            hour INTEGER DEFAULT 0,
            status TEXT DEFAULT 'ok',
            note TEXT DEFAULT '',
            ts TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_run_stats_kind ON run_stats(kind, target, id)")
    conn.commit()


def parse_rsync_summary(text: str) -> dict:
    """从 rsync 输出解析统计: 文件数/字节/速率。

    兼容:
      'sent 1,234,567 bytes  received 89 bytes  2,580,000.00 bytes/sec'
      'Total transferred file size: 1,234,567 bytes'
      'Number of regular files transferred: 42'
    """
    out = {"files": 0, "bytes": 0, "speed_bps": 0.0}
    if not text:
        return out
    m = re.search(r"Number of regular files transferred:\s*([\d,]+)", text)
    if m:
        out["files"] = int(m.group(1).replace(",", ""))
    m = re.search(r"Total transferred file size:\s*([\d,]+)", text)
    if m:
        out["bytes"] = int(m.group(1).replace(",", ""))
    if not out["bytes"]:
        m = re.search(r"sent\s+([\d,]+)\s+bytes", text)
        if m:
            out["bytes"] = int(m.group(1).replace(",", ""))
    m = re.search(r"([\d,\.]+)\s+bytes/sec", text)
    if m:
        try:
            out["speed_bps"] = float(m.group(1).replace(",", ""))
        except ValueError:
            pass
    m = re.search(r"Number of files transferred:\s*([\d,]+)", text)
    if m and not out["files"]:
        out["files"] = int(m.group(1).replace(",", ""))
    return out


def record_run(kind: str, target: str = "", files: int = 0, bytes_: int = 0,
               duration_sec: float = 0, speed_bps: float = 0.0,
               status: str = "ok", note: str = "", user_id: int = 1) -> int:
    """记录一次运行统计; 返回新增行 id"""
    conn = db.get_conn()
    ensure_table(conn)
    try:
        hour = datetime.now().hour
    except Exception:
        hour = 0
    if not speed_bps and bytes_ and duration_sec > 0:
        speed_bps = bytes_ / duration_sec
    cur = conn.execute(
        """INSERT INTO run_stats
           (user_id, kind, target, files, bytes, duration_sec, speed_bps, hour, status, note)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (user_id, kind[:40], (target or "")[:400], int(files or 0), int(bytes_ or 0),
         float(duration_sec or 0), float(speed_bps or 0), hour, status[:20], (note or "")[:300]))
    conn.commit()
    # v4.91.0 · F4: 流量同时计入配额计数 (rsync/rclone/restic/平台/容器 备份全覆盖)
    if int(bytes_ or 0) > 0:
        try:
            from backend import quota as _q
            _q.record(user_id, int(bytes_))
        except Exception:
            pass
    return cur.lastrowid


def baseline(kind: str, target: str = "", n: int = BASELINE_N) -> dict:
    """返回最近 n 次同类运行的基线: {count, mean_files, std_files, mean_bytes, std_bytes, mean_speed}"""
    conn = db.get_conn()
    ensure_table(conn)
    if target:
        rows = conn.execute(
            """SELECT files, bytes, speed_bps FROM run_stats
               WHERE kind=? AND target=? AND status='ok' ORDER BY id DESC LIMIT ?""",
            (kind, target, n)).fetchall()
    else:
        rows = conn.execute(
            """SELECT files, bytes, speed_bps FROM run_stats
               WHERE kind=? AND status='ok' ORDER BY id DESC LIMIT ?""",
            (kind, n)).fetchall()
    if not rows:
        return {"count": 0}
    fs = [r[0] for r in rows]
    bs = [r[1] for r in rows]
    ss = [r[2] for r in rows]

    def _ms(vals):
        m = sum(vals) / len(vals)
        if len(vals) < 2:
            return m, 0.0
        var = sum((v - m) ** 2 for v in vals) / (len(vals) - 1)
        return m, math.sqrt(var)
    mf, sf = _ms(fs)
    mb, sb = _ms(bs)
    ms, _ = _ms(ss)
    return {"count": len(rows), "mean_files": mf, "std_files": sf,
            "mean_bytes": mb, "std_bytes": sb, "mean_speed": ms}


def check_anomaly(kind: str, files: int, bytes_: int, target: str = "") -> dict:
    """E1 · 3σ 异常检测。返回 {anomaly, level, msg, sigma_files, sigma_bytes}"""
    b = baseline(kind, target)
    if b.get("count", 0) < 5:
        return {"anomaly": False, "level": "none",
                "msg": f"样本不足 ({b.get('count', 0)}/5), 暂不判定", "baseline": b}
    res = {"anomaly": False, "level": "ok", "msg": "", "baseline": b,
           "sigma_files": 0.0, "sigma_bytes": 0.0}
    # 基线以 0 为主 (如重复同步无变更) 时不判定, 避免噪音告警
    if b["std_files"] > 0 and b["mean_files"] >= 1:
        res["sigma_files"] = abs(files - b["mean_files"]) / b["std_files"]
    if b["std_bytes"] > 0 and b["mean_bytes"] > 0:
        res["sigma_bytes"] = abs(bytes_ - b["mean_bytes"]) / b["std_bytes"]
    worst = max(res["sigma_files"], res["sigma_bytes"])
    if worst >= SIGMA_WARN:
        res["anomaly"] = True
        res["level"] = "warn"
    elif worst >= SIGMA_INFO:
        res["anomaly"] = True
        res["level"] = "info"

    if res["anomaly"]:
        parts = []
        if res["sigma_files"] >= SIGMA_INFO:
            d = files - b["mean_files"]
            pct = (d / b["mean_files"] * 100) if b["mean_files"] else 0
            parts.append(f"文件数 {'+' if d >= 0 else ''}{int(d)} ({pct:+.0f}%, 基线均值 {int(b['mean_files'])})")
        if res["sigma_bytes"] >= SIGMA_INFO:
            d2 = bytes_ - b["mean_bytes"]
            pct2 = (d2 / b["mean_bytes"] * 100) if b["mean_bytes"] else 0
            parts.append(f"体积 {'+' if d2 >= 0 else ''}{d2 // 1048576}MB ({pct2:+.0f}%)")
        res["msg"] = (f"本次{'备份' if 'backup' in kind else '任务'}偏离基线 {worst:.1f}σ: " +
                      "; ".join(parts) + (" · 请检查是否有异常删除/激增" if worst >= SIGMA_WARN else ""))
    else:
        res["msg"] = f"正常 (最大偏差 {worst:.1f}σ < {SIGMA_INFO}σ)"
    return res


def speed_by_hour(kind: str = "") -> list:
    """E2 · 按小时聚合平均速率 (仅统计有速率的运行)"""
    conn = db.get_conn()
    ensure_table(conn)
    if kind:
        rows = conn.execute(
            """SELECT hour, AVG(speed_bps), COUNT(*) FROM run_stats
               WHERE speed_bps > 0 AND kind=? GROUP BY hour ORDER BY hour""", (kind,)).fetchall()
    else:
        rows = conn.execute(
            """SELECT hour, AVG(speed_bps), COUNT(*) FROM run_stats
               WHERE speed_bps > 0 GROUP BY hour ORDER BY hour""").fetchall()
    return [{"hour": r[0], "avg_speed": r[1] or 0, "samples": r[2]} for r in rows]


def recommend_window(min_samples: int = 2, window: int = 2) -> dict:
    """E2 · 推荐最优执行时间窗口 (按历史平均速率, 取连续 window 小时最高)"""
    hs = speed_by_hour()
    usable = [h for h in hs if h["samples"] >= min_samples]
    if len(usable) < window:
        return {"ok": False, "msg": f"样本不足 (需 {window} 个小时段各 ≥{min_samples} 次采样, 当前 {len(usable)})",
                "hours": hs}
    # 环形滑窗 (第二天凌晨与当天深夜可连)
    best = None
    n = len(usable)
    for i in range(n):
        group = [usable[(i + k) % n] for k in range(window)]
        if len({g["hour"] for g in group}) < window:
            continue
        avg = sum(g["avg_speed"] for g in group) / window
        total = sum(g["samples"] for g in group)
        if best is None or avg > best["avg_speed"]:
            best = {"avg_speed": avg, "total_samples": total,
                    "hours": [g["hour"] for g in group]}
    if not best:
        return {"ok": False, "msg": "无足够连续时段样本", "hours": hs}
    overall = sum(h["avg_speed"] * h["samples"] for h in usable) / max(1, sum(h["samples"] for h in usable))
    hstr = "-".join(f"{h:02d}:00" for h in sorted(best["hours"]))
    gain = ((best["avg_speed"] / overall - 1) * 100) if overall else 0
    return {"ok": True, "window": hstr, "hours": best["hours"],
            "avg_speed": best["avg_speed"], "overall_avg": overall,
            "gain_pct": gain, "samples": best["total_samples"],
            "msg": f"推荐时段 {hstr} (历史平均 {best['avg_speed']/1048576:.1f} MB/s, "
                   f"较全局均值{'高' if gain >= 0 else '低'} {abs(gain):.0f}%)",
            "hourly": hs}


def recent_anomalies(limit: int = 20) -> list:
    """列出最近判定为异常的运行 (重算历史记录, 供看板展示)"""
    conn = db.get_conn()
    ensure_table(conn)
    rows = conn.execute(
        "SELECT * FROM run_stats WHERE status='ok' ORDER BY id DESC LIMIT 200").fetchall()
    out = []
    # 按时间正序做滑动基线判定
    hist = [dict(r) for r in rows][::-1]
    for i, r in enumerate(hist):
        prior = hist[max(0, i - BASELINE_N):i]
        if len(prior) < 5:
            continue
        fs = [p["files"] for p in prior]
        bs = [p["bytes"] for p in prior]
        mf = sum(fs) / len(fs)
        mb = sum(bs) / len(bs)
        sf = math.sqrt(sum((v - mf) ** 2 for v in fs) / (len(fs) - 1)) if len(fs) > 1 else 0
        sb = math.sqrt(sum((v - mb) ** 2 for v in bs) / (len(bs) - 1)) if len(bs) > 1 else 0
        sf_x = sf if (sf and mf >= 1) else 0
        sb_x = sb if (sb and mb > 0) else 0
        sg = max((abs(r["files"] - mf) / sf_x) if sf_x else 0, (abs(r["bytes"] - mb) / sb_x) if sb_x else 0)
        if sg >= SIGMA_WARN:
            out.append({"id": r["id"], "kind": r["kind"], "target": r["target"],
                        "files": r["files"], "bytes": r["bytes"], "ts": r["ts"],
                        "sigma": round(sg, 1), "mean_files": int(mf), "mean_bytes": int(mb),
                        "msg": f"文件数 {r['files']} vs 基线均值 {int(mf)} ({sg:.1f}σ)"})
    return out[-limit:][::-1]

"""F4 流量配额 / 成本管控 (v4.91.0)

数据模型:
  quota_usage(day TEXT, user_id INTEGER, bytes INTEGER, PRIMARY KEY(day, user_id))
  —— 日粒度精确计数, 所有 record_run() 统计的传输流量中央汇入
配置存 settings_kv: quota_cfg = JSON {enabled, daily_gb, monthly_gb, cost_per_gb, currency}

WS 动作:
  quota_config  GET/SET 配置 (enabled/daily_gb/monthly_gb/cost_per_gb/currency)
  quota_usage   查询: 今日/本月用量+估算成本+剩余额度 + 按用户/按日分布

闸门:
  gate(user_id) → (ok, msg)   handle_rsync 发起前调用; 超限拒绝
  gate_ws(ws)                  自动从 active_sessions 取 user_id
  record(user_id, bytes)       stats.record_run 挂钩 (rsync/rclone/restic/平台/容器 备份全覆盖)
"""
from __future__ import annotations

import json
import time
from datetime import datetime

from backend import db

_GB = 1024 * 1024 * 1024

_DEFAULT_CFG = {
    "enabled": False,
    "daily_gb": 0,      # 0 = 不限
    "monthly_gb": 0,    # 0 = 不限
    "cost_per_gb": 0.0, # 成本估算单价 (元/GB), 0 = 不估算
    "currency": "¥",
}


def _ensure_table(conn) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS quota_usage (
        day TEXT NOT NULL,
        user_id INTEGER NOT NULL DEFAULT 1,
        bytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, user_id))""")


def get_cfg() -> dict:
    raw = db.setting_get("quota_cfg", "")
    cfg = dict(_DEFAULT_CFG)
    if raw:
        try:
            cfg.update(json.loads(raw))
        except Exception:
            pass
    return cfg


def set_cfg(cfg: dict) -> None:
    clean = {k: cfg.get(k, _DEFAULT_CFG.get(k)) for k in _DEFAULT_CFG}
    db.setting_set("quota_cfg", json.dumps(clean, ensure_ascii=False))


def record(user_id: int, bytes_: int) -> None:
    """累计某用户当日传输流量 (record_run 中央挂钩调用)"""
    b = int(bytes_ or 0)
    if b <= 0:
        return
    conn = db.get_conn()
    _ensure_table(conn)
    day = datetime.now().strftime("%Y-%m-%d")
    conn.execute(
        """INSERT INTO quota_usage (day, user_id, bytes) VALUES (?,?,?)
           ON CONFLICT(day, user_id) DO UPDATE SET bytes = bytes + excluded.bytes""",
        (day, int(user_id or 1), b))
    conn.commit()


def _sum_range(conn, day_from: str, day_to: str, user_id=None) -> int:
    q = "SELECT COALESCE(SUM(bytes),0) FROM quota_usage WHERE day >= ? AND day <= ?"
    args = [day_from, day_to]
    if user_id is not None:
        q += " AND user_id = ?"
        args.append(int(user_id))
    return int(conn.execute(q, args).fetchone()[0] or 0)


def usage(user_id=None, days: int = 30) -> dict:
    """汇总用量/成本/剩余 + 分布"""
    conn = db.get_conn()
    _ensure_table(conn)
    cfg = get_cfg()
    today = datetime.now().strftime("%Y-%m-%d")
    month_start = today[:8] + "01"
    today_b = _sum_range(conn, today, today, user_id)
    month_b = _sum_range(conn, month_start, today, user_id)

    daily_limit = float(cfg.get("daily_gb") or 0) * _GB
    monthly_limit = float(cfg.get("monthly_gb") or 0) * _GB
    cost_per_gb = float(cfg.get("cost_per_gb") or 0)
    cur = cfg.get("currency") or ""

    def _remain(used: int, limit: float) -> str:
        if not cfg.get("enabled"):
            return "未启用"
        if limit <= 0:
            return "不限"
        r = max(0, int(limit - used))
        return f"{r / _GB:.2f} GB"

    by_user, by_day = [], []
    try:
        since = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
        for r in conn.execute(
                """SELECT user_id, SUM(bytes) b, COUNT(*) n FROM quota_usage
                   WHERE day >= ? GROUP BY user_id ORDER BY b DESC LIMIT 20""", (since,)):
            by_user.append({"user_id": r[0], "bytes": int(r[1] or 0), "runs": int(r[2] or 0)})
        for r in conn.execute(
                """SELECT day, SUM(bytes) FROM quota_usage WHERE day >= ?
                   GROUP BY day ORDER BY day DESC LIMIT 60""", (since,)):
            by_day.append({"day": r[0], "bytes": int(r[1] or 0)})
    except Exception:
        pass

    return {
        "enabled": bool(cfg.get("enabled")),
        "today_bytes": today_b,
        "month_bytes": month_b,
        "daily_limit_bytes": int(daily_limit),
        "monthly_limit_bytes": int(monthly_limit),
        "remain_today": _remain(today_b, daily_limit),
        "remain_month": _remain(month_b, monthly_limit),
        "today_cost": round(today_b / _GB * cost_per_gb, 2),
        "month_cost": round(month_b / _GB * cost_per_gb, 2),
        "cost_per_gb": cost_per_gb,
        "currency": cur,
        "by_user": by_user,
        "by_day": by_day,
    }


def gate(user_id: int) -> tuple[bool, str]:
    """传输前闸门: 启用且日/月超限 → (False, 原因)"""
    cfg = get_cfg()
    if not cfg.get("enabled"):
        return True, ""
    conn = db.get_conn()
    _ensure_table(conn)
    today = datetime.now().strftime("%Y-%m-%d")
    month_start = today[:8] + "01"
    daily_limit = float(cfg.get("daily_gb") or 0) * _GB
    monthly_limit = float(cfg.get("monthly_gb") or 0) * _GB
    if daily_limit > 0:
        used = _sum_range(conn, today, today, user_id)
        if used >= daily_limit:
            return False, (f"🔴 已达当日流量配额 ({used / _GB:.2f}/{daily_limit / _GB:.2f} GB), "
                           f"传输被拒绝 · 可在 系统设置→流量配额 调整或次日自动恢复")
    if monthly_limit > 0:
        used_m = _sum_range(conn, month_start, today, user_id)
        if used_m >= monthly_limit:
            return False, (f"🔴 已达当月流量配额 ({used_m / _GB:.2f}/{monthly_limit / _GB:.2f} GB), "
                           f"传输被拒绝 · 可在 系统设置→流量配额 调整")
    return True, ""


def gate_ws(ws) -> tuple[bool, str]:
    """带会话的闸门: 自动取当前登录用户"""
    uid = 1
    try:
        from backend.auth import active_sessions
        sess = active_sessions.get(ws) or {}
        uid = int(sess.get("user_id") or 1)
    except Exception:
        pass
    return gate(uid)


def human(n: int) -> str:
    n = float(n or 0)
    if n >= _GB:
        return f"{n / _GB:.2f} GB"
    if n >= 1024 * 1024:
        return f"{n / 1048576:.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{int(n)} B"


# ── WS handlers ──

async def handle_quota_config(ws, data: dict):
    """GET/SET 流量配额配置"""
    _req = data.get("req_id") or ""
    try:
        if data.get("cfg") is not None:
            c = data["cfg"]
            if not isinstance(c, dict):
                await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "cfg 须为对象"})
                return
            set_cfg(c)
            from backend.log import log_operation
            log_operation("流量配额", f"配置更新: enabled={c.get('enabled')} daily={c.get('daily_gb')}GB monthly={c.get('monthly_gb')}GB")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "cfg": get_cfg(), "msg": "✓ 配置已保存" if data.get("cfg") is not None else "配置读取成功"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"配置失败: {e}"})


async def handle_quota_usage(ws, data: dict):
    """查询流量用量/成本/剩余"""
    _req = data.get("req_id") or ""
    try:
        u = usage(days=int(data.get("days") or 30))
        u["today_human"] = human(u["today_bytes"])
        u["month_human"] = human(u["month_bytes"])
        for r in u["by_user"]:
            r["bytes_human"] = human(r["bytes"])
        for r in u["by_day"]:
            r["bytes_human"] = human(r["bytes"])
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **u})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"查询失败: {e}"})

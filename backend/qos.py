"""Fonriv - QoS 带宽时间表 (v4.59.0)

settings:
  qos_enabled  = "1"/"0"
  qos_schedule = JSON [{start:"09:00", end:"18:00", limit:"2m"}, ...]

resolve_bwlimit(user_bwlimit) -> (生效限速, 说明):
  - 启用且当前时刻命中某条规则 → 规则限速覆盖手动值 (规则 limit 空或 "0" = 该时段不限速)
  - 支持跨午夜 (start > end, 如 22:00-06:00)
  - 未启用/无匹配 → 用户手动 bwlimit 原样生效

limit 格式与 rsync --bwlimit 一致: 100k / 2m / 512k 等 (rsync 3.1+ 也接受 10MB/s)。
"""
from __future__ import annotations

import json

from backend import db


def get_config() -> dict:
    enabled = (db.setting_get("qos_enabled", "0") or "0") == "1"
    raw = db.setting_get("qos_schedule", "") or "[]"
    try:
        rules = json.loads(raw)
    except Exception:
        rules = []
    if not isinstance(rules, list):
        rules = []
    clean = []
    for r in rules:
        if not isinstance(r, dict):
            continue
        start = str(r.get("start") or "").strip()
        end = str(r.get("end") or "").strip()
        limit = str(r.get("limit") or "").strip()
        if start and end:
            clean.append({"start": start, "end": end, "limit": limit})
    return {"enabled": enabled, "rules": clean}


def set_config(enabled: bool, rules: list) -> dict:
    clean = []
    for r in rules or []:
        if not isinstance(r, dict):
            continue
        start = str(r.get("start") or "").strip()
        end = str(r.get("end") or "").strip()
        limit = str(r.get("limit") or "").strip()
        if start and end:
            clean.append({"start": start, "end": end, "limit": limit})
    db.setting_set("qos_enabled", "1" if enabled else "0")
    db.setting_set("qos_schedule", json.dumps(clean, ensure_ascii=False))
    return get_config()


def _in_window(now_min: int, start_min: int, end_min: int) -> bool:
    """now/start/end 均为当日分钟数; start>end 视为跨午夜窗口"""
    if start_min == end_min:
        return True  # 0 点窗口视为全天
    if start_min < end_min:
        return start_min <= now_min < end_min
    return now_min >= start_min or now_min < end_min  # 跨午夜


def _to_minutes(hhmm: str) -> int | None:
    try:
        parts = hhmm.split(":")
        h, m = int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h * 60 + m
    except Exception:
        pass
    return None


def resolve_bwlimit(user_bwlimit: str) -> tuple[str, str]:
    """返回 (生效 bwlimit, 命中说明)。命中规则时限速覆盖手动值; 空规则 limit=不限速"""
    cfg = get_config()
    if not cfg["enabled"] or not cfg["rules"]:
        return (user_bwlimit or "0"), ""
    import datetime as _dt
    now = _dt.datetime.now()
    now_min = now.hour * 60 + now.minute
    for r in cfg["rules"]:
        s = _to_minutes(r["start"])
        e = _to_minutes(r["end"])
        if s is None or e is None:
            continue
        if _in_window(now_min, s, e):
            limit = r["limit"]
            if not limit or limit == "0":
                return "0", f"QoS 时段 {r['start']}-{r['end']} → 不限速"
            return limit, f"QoS 时段 {r['start']}-{r['end']} → 限速 {limit}"
    return (user_bwlimit or "0"), ""

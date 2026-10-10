"""Fonriv - Transfer Fabric P1 · 统一日志写入器 (L1 索引 + L2 JSONL 明细)

原则:
  - run_id 贯穿: 每个任务一个 run_id, L1 索引行与 L2 明细行都带它
  - 双层: L1 = task_runs 表(全局查询); L2 = runs/<run_id>.jsonl(逐行明细, 懒加载)
  - 页面 ring buffer / 事件总线成为同一写入器的消费者 (两套日志 = 同一数据的两个视图)
  - 轮转: 日志区 50MB 或每日轮转, 明细保留 30 天
"""
from __future__ import annotations

import json
import os
import os as _os
import re
import sqlite3
import threading
import time
from datetime import datetime

from backend import db

_RUNS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "data", "runs")
_LOCK = threading.Lock()
_MAX_FILE = 50 * 1024 * 1024          # 单明细文件 50MB 轮转
_KEEP_DAYS = 30                       # 明细保留天数


def _ensure_dirs() -> None:
    os.makedirs(_RUNS_DIR, exist_ok=True)


_DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "data")


def _ensure_table(conn) -> None:
    conn.execute("""CREATE TABLE IF NOT EXISTS task_runs (
        run_id TEXT PRIMARY KEY,
        kind TEXT DEFAULT '',
        label TEXT DEFAULT '',
        src TEXT DEFAULT '',
        dst TEXT DEFAULT '',
        engine TEXT DEFAULT '',
        status TEXT DEFAULT 'running',
        started_ts REAL,
        finished_ts REAL,
        stats TEXT DEFAULT '{}',
        log_path TEXT DEFAULT ''
    )""")
    try:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_task_runs_ts ON task_runs(started_ts)")
    except Exception:
        pass
    # v5.19.5 · 跨任务关联: parent_run_id (flow/编排 → 子任务) + flow_id
    for _col in ("parent_run_id TEXT DEFAULT ''", "flow_id INTEGER DEFAULT 0"):
        try:
            conn.execute(f"ALTER TABLE task_runs ADD COLUMN {_col}")
        except Exception:
            pass  # 已存在
    try:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_task_runs_parent ON task_runs(parent_run_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_task_runs_flow ON task_runs(flow_id)")
    except Exception:
        pass


def start_run(run_id: str, kind: str, label: str = "", src: str = "", dst: str = "",
              engine: str = "", parent_run_id: str = "", flow_id: int = 0) -> str:
    """L1: 登记任务索引行 + 创建 L2 明细文件"""
    conn = db.get_conn()
    _ensure_table(conn)
    conn.execute(
        """INSERT OR REPLACE INTO task_runs
           (run_id, kind, label, src, dst, engine, status, started_ts, log_path,
            parent_run_id, flow_id)
           VALUES (?,?,?,?,?,?, 'running', ?, ?, ?, ?)""",
        (run_id, kind[:40], label[:200], src[:400], dst[:400], engine[:40],
         time.time(), _jsonl_path(run_id),
         (parent_run_id or "")[:64], int(flow_id or 0)))
    conn.commit()
    _ensure_dirs()
    append_detail(run_id, "INFO", "RUN_START", label=label, src=src, dst=dst)
    return run_id


def update_run(run_id: str, *, status: str = None, stats: dict = None,
               finished: bool = False) -> None:
    """L1: 更新任务索引行"""
    conn = db.get_conn()
    _ensure_table(conn)
    sets, args = [], []
    if status:
        sets.append("status=?"); args.append(status[:20])
    if stats is not None:
        sets.append("stats=?"); args.append(json.dumps(stats, ensure_ascii=False)[:4000])
    if finished:
        sets.append("finished_ts=?"); args.append(time.time())
    if not sets:
        return
    args.append(run_id)
    try:
        conn.execute(f"UPDATE task_runs SET {', '.join(sets)} WHERE run_id=?", args)
        conn.commit()
    except Exception:
        pass


def _jsonl_path(run_id: str, rotate: int = 0) -> str:
    return os.path.join(_RUNS_DIR, f"{run_id}.jsonl" if not rotate else f"{run_id}.{rotate}.jsonl")


# v5.20.0 · 纵深防御: 敏感字段名与值形态脱敏
#   审计结论: 现有 11 个 append_detail 调用点都不传凭据, runlog 目前没有泄漏。
#   但 append_detail 是 `**fields` 通吃后原样 json.dumps 落盘, 将来谁加一个
#   password=/token= 就会静默写出明文。这里把"下一次的失误"堵掉, 成本接近零。
_SENSITIVE_KEY = re.compile(
    r'(pass|passwd|password|secret|token|credential|passphrase|auth_value|'
    r'private_key|access_key|apikey|api_key|pwd)', re.I)
# 值形态: rclone 连接串 pass=、URL user:pass@、Authorization 头、PVE Token
_SENSITIVE_VAL = re.compile(
    r'((?:pass|password|secret|token|pwd|auth_value)=)[^,;\s&]+'
    r'|(://[^:/@\s]+:)[^@\s]+(@)'
    r'|(Bearer\s+)[A-Za-z0-9._\-]{8,}'
    r'|(PVEAPIToken=)[^\s]+'
    r'|(Basic\s+)[A-Za-z0-9+/=]{8,}', re.I)


def _sub_secret(m) -> str:
    """按命中的分支重建, 保留分隔符 (@ : = 等), 只替换秘密本身。"""
    if m.group(1):                 # pass=… / token=… 等
        return m.group(1) + "***"
    if m.group(2):                 # scheme://user:pass@host
        return m.group(2) + "***" + (m.group(3) or "")
    if m.group(4):                 # Bearer …
        return m.group(4) + "***"
    if m.group(5):                 # PVEAPIToken=…
        return m.group(5) + "***"
    if m.group(6):                 # Basic …
        return m.group(6) + "***"
    return "***"


def redact(v):
    """把一个值脱敏为可安全落盘的形态 (字符串做模式替换, 容器递归)。"""
    if isinstance(v, str):
        s = _SENSITIVE_VAL.sub(_sub_secret, v)
        if len(s) > 512:
            s = s[:512] + f"…(截断 {len(v) - 512} 字符)"
        return s
    if isinstance(v, dict):
        return {k: ("***" if _SENSITIVE_KEY.search(str(k)) else redact(x)) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [redact(x) for x in v]
    return v


def _redact_fields(fields: dict) -> dict:
    """按字段名判定敏感 → 直接打码; 其余按值形态脱敏。"""
    out = {}
    for k, v in fields.items():
        if v is None:
            continue
        out[k] = "***" if _SENSITIVE_KEY.search(str(k)) else redact(v)
    return out


def append_detail(run_id: str, level: str, event: str, msg: str = "", **fields) -> None:
    """L2: 追加一行 JSONL 明细 (线程安全; 50MB 轮转保留旧段)

    v5.20.0 · 落盘前统一脱敏: 敏感字段名直接打码; 值里内嵌的凭据
    (pass=… / user:pass@host / Bearer … / PVEAPIToken=… / Basic …) 做模式替换。
    """
    rec = {"ts": round(time.time(), 3), "level": level[:8], "run_id": run_id[:64],
           "event": event[:40], "msg": redact(str(msg or ""))[:2000]}
    if fields:
        rec.update(_redact_fields(fields))
    line = json.dumps(rec, ensure_ascii=False, default=str)
    with _LOCK:
        _ensure_dirs()
        path = _jsonl_path(run_id)
        try:
            if os.path.exists(path) and os.path.getsize(path) > _MAX_FILE:
                rot = 1
                while os.path.exists(_jsonl_path(run_id, rot)):
                    rot += 1
                os.replace(path, _jsonl_path(run_id, rot))
        except Exception:
            pass
        try:
            with open(path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass


def read_detail(run_id: str, limit: int = 2000, tail_only: bool = False) -> list:
    """懒加载 L2 明细 (统一日志页点击某行时调用)"""
    path = _jsonl_path(run_id)
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
        if tail_only and len(lines) > limit:
            lines = lines[-limit:]
        out = []
        for ln in lines[-limit:]:
            try:
                out.append(json.loads(ln))
            except Exception:
                continue
        return out
    except Exception:
        return []


def list_runs(status: str = "", kind: str = "", limit: int = 100) -> list:
    """L1 查询: 全局日志页的数据源"""
    conn = db.get_conn()
    _ensure_table(conn)
    q = "SELECT * FROM task_runs WHERE 1=1"
    args = []
    if status:
        q += " AND status=?"; args.append(status)
    if kind:
        q += " AND kind LIKE ?"; args.append(kind + "%")
    q += " ORDER BY started_ts DESC LIMIT ?"
    args.append(min(500, max(1, limit)))
    cols = ["run_id", "kind", "label", "src", "dst", "engine", "status", "started_ts", "finished_ts", "stats"]
    return [dict(zip(cols, r)) for r in conn.execute(q, args).fetchall()]


def cleanup_expired(keep_days: int = _KEEP_DAYS) -> int:
    """清理过期明细文件 (L1 索引保留)"""
    cutoff = time.time() - keep_days * 86400
    n = 0
    try:
        _ensure_dirs()
        for fn in os.listdir(_RUNS_DIR):
            fp = os.path.join(_RUNS_DIR, fn)
            try:
                if os.path.getmtime(fp) < cutoff:
                    os.remove(fp); n += 1
            except OSError:
                continue
    except Exception:
        pass
    return n


# ═════════════════════════════════════════════════════════════
# v5.19.4 · 日志链路回溯
#   把"一次传输"从决策到落账的全过程串成一条可读链路:
#     Planner 决策理由 → Executor 执行明细 → Ledger 对账结果 → 操作日志
# ═════════════════════════════════════════════════════════════

# 链路阶段定义 (按执行时序)
_STAGES = [
    ("plan", "Planner 决策", "引擎/压缩/加密级别的选择依据"),
    ("l2_decision", "L2 加密判定", "是否启用端到端加密及原因"),
    ("e2ee_encrypt", "暂存加密", "中继暂存区内容加密"),
    ("e2ee_decrypt", "暂存解密", "推送前解密校验"),
    ("exec", "Executor 执行", "实际命令与执行结果"),
    ("verify", "Ledger 对账", "产物 size/sha256 比对结果"),
    ("fallback", "降级重试", "首选方法失败后的回退"),
]


def trace(run_id: str, op_limit: int = 40) -> dict:
    """回溯一次任务的完整链路。

    返回 {run, stages:[{key,label,desc,events:[...]}], ops:[操作日志], summary}
    """
    out = {"run_id": run_id, "run": None, "stages": [], "ops": [], "summary": {}}
    # ① L1 索引行
    try:
        conn = db.get_conn()
        _ensure_table(conn)
        row = conn.execute("SELECT * FROM task_runs WHERE run_id=?", (run_id,)).fetchone()
        if row:
            r = dict(row)
            try:
                import json as _j
                r["stats"] = _j.loads(r.get("stats") or "{}")
            except Exception:
                r["stats"] = {}
            out["run"] = r
    except Exception as e:
        out["error"] = f"索引读取失败: {e}"

    # ② L2 明细按阶段分组
    events = []
    try:
        events = read_detail(run_id, limit=5000)
    except Exception:
        events = []
    buckets = {k: [] for k, _l, _d in _STAGES}
    other = []
    for ev in events:
        name = str(ev.get("event") or "")
        placed = False
        for key, label, _desc in _STAGES:
            # 阶段名可出现在 event 或 msg 里
            if name == key or name.startswith(key) or key in name:
                buckets[key].append(ev)
                placed = True
                break
        if not placed:
            other.append(ev)
    stages = []
    for key, label, desc in _STAGES:
        if buckets[key]:
            stages.append({"key": key, "label": label, "desc": desc, "events": buckets[key]})
    if other:
        stages.append({"key": "other", "label": "其他明细", "desc": "未归类的执行记录",
                       "events": other[:200]})

    # ③ 关联操作日志 (按时间窗 + 关键字匹配)
    try:
        op_path = _os.path.join(_DATA, "fonriv_operations.log")
        if _os.path.exists(op_path) and out.get("run"):
            run = out["run"]
            t0 = float(run.get("started_ts") or 0)
            t1 = float(run.get("finished_ts") or (t0 + 3600))
            src = str(run.get("src") or "")[:40]
            dst = str(run.get("dst") or "")[:40]
            lines = []
            try:
                with open(op_path, encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()[-4000:]
            except Exception:
                lines = []
            for ln in lines:
                ln = ln.rstrip("\n")
                # 时间窗 (日志行首格式: 2026-09-14 21:37:57 | [分类] ...)
                try:
                    import datetime as _dt
                    ts = _dt.datetime.strptime(ln[:19], "%Y-%m-%d %H:%M:%S").timestamp()
                    if ts < t0 - 5 or ts > t1 + 30:
                        continue
                except Exception:
                    continue
                if (src and src in ln) or (dst and dst in ln) or (run_id[:8] in ln):
                    out["ops"].append(ln)
                    if len(out["ops"]) >= op_limit:
                        break
    except Exception as e:
        out["ops_error"] = str(e)[:120]

    # ④ 汇总
    run = out.get("run") or {}
    out["summary"] = {
        "kind": run.get("kind") or "",
        "label": run.get("label") or "",
        "src": run.get("src") or "",
        "dst": run.get("dst") or "",
        "engine": run.get("engine") or "",
        "status": run.get("status") or "",
        "started_ts": run.get("started_ts"),
        "finished_ts": run.get("finished_ts"),
        "duration": (round(float(run.get("finished_ts") or 0) - float(run.get("started_ts") or 0), 1)
                     if run.get("finished_ts") and run.get("started_ts") else None),
        "stats": run.get("stats") or {},
        "stage_count": len(stages),
        "event_count": len(events),
        "op_count": len(out["ops"]),
        "has_plan": bool(buckets.get("plan")),
        "has_l2": bool(buckets.get("l2_decision")),
        "has_verify": bool(buckets.get("verify")),
        "has_fallback": bool(buckets.get("fallback")),
    }
    return out


# ═════════════════════════════════════════════════════════════
# v5.19.5 · 跨任务链路关联 (flow / 编排 → 子任务树)
# ═════════════════════════════════════════════════════════════

def tree(flow_id: int = 0, parent_run_id: str = "", limit: int = 100) -> dict:
    """跨任务关联树: 按 flow_id 或 parent_run_id 找出全部子任务。

    返回 {root: {...}, children: [{run 摘要 + 阶段覆盖}], summary}
    """
    conn = db.get_conn()
    _ensure_table(conn)
    rows = []
    try:
        if flow_id:
            rows = [dict(r) for r in conn.execute(
                "SELECT * FROM task_runs WHERE flow_id=? ORDER BY started_ts LIMIT ?",
                (flow_id, limit)).fetchall()]
        elif parent_run_id:
            rows = [dict(r) for r in conn.execute(
                "SELECT * FROM task_runs WHERE parent_run_id=? ORDER BY started_ts LIMIT ?",
                (parent_run_id, limit)).fetchall()]
    except Exception as e:
        return {"children": [], "error": str(e)[:100]}

    children = []
    for r in rows:
        try:
            import json as _j
            r["stats"] = _j.loads(r.get("stats") or "{}")
        except Exception:
            r["stats"] = {}
        # 每个子任务的阶段覆盖度
        try:
            evs = read_detail(r["run_id"], limit=500)
            ev_names = {str(e.get("event") or "") for e in evs}
        except Exception:
            evs, ev_names = [], set()
        children.append({
            "run_id": r["run_id"], "kind": r.get("kind"), "label": r.get("label"),
            "src": r.get("src"), "dst": r.get("dst"), "engine": r.get("engine"),
            "status": r.get("status"),
            "started_ts": r.get("started_ts"), "finished_ts": r.get("finished_ts"),
            "duration": (round(float(r.get("finished_ts") or 0) - float(r.get("started_ts") or 0), 1)
                         if r.get("finished_ts") and r.get("started_ts") else None),
            "stats": r.get("stats"),
            "stages": {
                "plan": any("plan" in n for n in ev_names),
                "l2": any("l2" in n or "e2ee" in n for n in ev_names),
                "verify": any("verify" in n for n in ev_names),
                "fallback": any("fallback" in n for n in ev_names),
            },
            "event_count": len(evs),
        })

    # 汇总
    ok_n = sum(1 for c in children if c.get("status") in ("ok", "success"))
    fail_n = sum(1 for c in children if c.get("status") in ("failed", "error"))
    return {
        "flow_id": flow_id, "parent_run_id": parent_run_id,
        "children": children,
        "summary": {
            "total": len(children),
            "ok": ok_n, "failed": fail_n,
            "other": len(children) - ok_n - fail_n,
            "bytes": sum((c.get("stats") or {}).get("bytes", 0) or
                         sum((s or {}).get("bytes", 0) for s in [c.get("stats")] if s) for c in children)
            if children else 0,
            "span": (round(max((c.get("finished_ts") or 0) for c in children) -
                           min((c.get("started_ts") or 0) for c in children), 1)
                     if children else None),
        },
    }

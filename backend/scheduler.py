"""Fonriv - 定时计划调度器 (v2.9.0)

轻量 asyncio-native 调度器：
  - schedules 表：id / name / cron_expr / action / params_json / enabled / last_run / next_run / created_at
  - 后台 async 任务：每 30s 醒来 → 查询 next_run <= now 的任务 → 派发
  - 派发 = 直接调用对应的 handler（无 WS，用一个假的 SchedulerCtx 收集输出到日志）

不依赖 apscheduler，只用 croniter + asyncio.sleep。
"""
from __future__ import annotations
import logging

import asyncio
import json
import os  # v4.41.0 P3-9 · remote_upload_scheduled 用
import sqlite3
import shlex
import time
from datetime import datetime
from typing import Any, Awaitable, Callable, Optional

try:
    from croniter import croniter
    _CRON_OK = True
except ImportError:
    _CRON_OK = False

from backend import db as _db

_running = False
_task: Optional[asyncio.Task] = None
_TICK_SECONDS = 30  # 每 30s 检查一次

# action 名 → 处理函数（async, (params: dict) → dict/str/None）
_actions: dict[str, Callable[[dict], Awaitable[Any]]] = {}


def register_action(name: str, fn: Callable[[dict], Awaitable[Any]]):
    """注册可被调度的 action。scheduler 触发时会调用 fn(params_dict)。"""
    _actions[name] = fn


def _ensure_table():
    conn = _db.get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            cron_expr TEXT NOT NULL,
            action TEXT NOT NULL,
            params_json TEXT DEFAULT '{}',
            enabled INTEGER DEFAULT 1,
            last_run TEXT DEFAULT NULL,
            last_status TEXT DEFAULT NULL,
            last_msg TEXT DEFAULT NULL,
            next_run TEXT DEFAULT NULL,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    # v4.39.0 · schedules 加 uuid 列(若 init_db 已加则跳过)
    try:
        scols = {r[1] for r in conn.execute("PRAGMA table_info(schedules)").fetchall()}
        if "uuid" not in scols:
            conn.execute("ALTER TABLE schedules ADD COLUMN uuid TEXT DEFAULT ''")
        # v4.47.0 P2 · 多时间段: 表达式数组 (JSON), 与单表达式 cron_expr 共存;
        #   times_json 非空时优先 (多条 cron 的并集), 否则回退 cron_expr
        if "times_json" not in scols:
            conn.execute("ALTER TABLE schedules ADD COLUMN times_json TEXT DEFAULT ''")
    except Exception as e:
        print(f"[scheduler] schedules add uuid col skip: {e}")
    # v4.6.0: 每次派发的运行记录（观测 · 历史）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schedule_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            schedule_id INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT DEFAULT NULL,
            status TEXT DEFAULT 'running',
            msg TEXT DEFAULT NULL,
            trigger TEXT DEFAULT 'cron',
            duration_ms INTEGER DEFAULT NULL,
            FOREIGN KEY(schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
        )
    """)
    # v4.39.0 · schedule_runs 加 uuid 列
    try:
        rcols = {r[1] for r in conn.execute("PRAGMA table_info(schedule_runs)").fetchall()}
        if "uuid" not in rcols:
            conn.execute("ALTER TABLE schedule_runs ADD COLUMN uuid TEXT DEFAULT ''")
    except Exception as e:
        print(f"[scheduler] schedule_runs add uuid col skip: {e}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_schrun_sid ON schedule_runs(schedule_id, id DESC)")
    conn.commit()


def _parse_times(cron_expr: str, times_json=None) -> list:
    """v4.47.0 P2 · 解析多时间段: times_json(JSON 数组) 优先, 回退单表达式。

    返回合法 cron 表达式列表 (空列表 = 无可解析)。
    """
    exprs = []
    if times_json:
        try:
            arr = json.loads(times_json)
            if isinstance(arr, list):
                exprs = [str(x).strip() for x in arr if str(x).strip()]
        except Exception:
            exprs = []
    if not exprs and cron_expr:
        exprs = [cron_expr.strip()]
    if not _CRON_OK:
        return exprs
    return [e for e in exprs if croniter.is_valid(e)]


def _compute_next(cron_expr: str, base: Optional[datetime] = None,
                  times_json: Optional[str] = None) -> Optional[str]:
    """v4.47.0 P2 · 多表达式时取所有表达式最近的一次 (并集语义)。"""
    if not _CRON_OK:
        return None
    try:
        base = base or datetime.now()
        best = None
        for e in _parse_times(cron_expr, times_json):
            nxt = croniter(e, base).get_next(datetime)
            if best is None or nxt < best:
                best = nxt
        return best.strftime("%Y-%m-%d %H:%M:%S") if best else None
    except Exception:
        return None


def schedule_create(name: str, cron_expr: str, action: str, params: Optional[dict] = None,
                    enabled: bool = True, times: Optional[list] = None) -> int:
    """v4.39.0: 自动生成 uuid; v4.47.0 P2: times=多时间段表达式数组(可选)"""
    _ensure_table()
    from backend.db.uuidv7 import uuidv7 as _uuidv7
    if not _CRON_OK:
        raise RuntimeError("croniter not installed; run: pip install croniter")
    # 验证 cron 表达式 (多表达式逐条验)
    _times = [str(t).strip() for t in (times or []) if str(t).strip()]
    for e in (_times or [cron_expr]):
        if not croniter.is_valid(e):
            raise ValueError(f"invalid cron expression: {e}")
    if not _times and not croniter.is_valid(cron_expr):
        raise ValueError(f"invalid cron expression: {cron_expr}")
    _uuid = _uuidv7()
    conn = _db.get_conn()
    cur = conn.execute(
        "INSERT INTO schedules (uuid, name, cron_expr, times_json, action, params_json, enabled, next_run) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (_uuid, name, cron_expr, json.dumps(_times) if _times else "",
         action, json.dumps(params or {}), 1 if enabled else 0,
         _compute_next(cron_expr, times_json=json.dumps(_times) if _times else None))
    )
    conn.commit()
    sid = cur.lastrowid
    # v4.39.0 · 注册引用关系
    _register_schedule_refs(conn, _uuid, params or {})
    return sid


def _register_schedule_refs(conn, sched_uuid: str, params: dict):
    """注册 schedule -> flow/config 的引用关系"""
    from backend.db.entity_refs import register_ref as _reg
    flow_uuid = params.get("flow_uuid")
    flow_id = params.get("flow_id")
    # flow_uuid 优先;若只有 flow_id,查 uuid
    if flow_uuid:
        _reg(conn, 'schedules', sched_uuid, 'params.flow_uuid',
             'backup_flows', flow_uuid, 'required')
    elif flow_id:
        fr = conn.execute("SELECT uuid FROM backup_flows WHERE id=?", (flow_id,)).fetchone()
        if fr and fr[0]:
            _reg(conn, 'schedules', sched_uuid, 'params.flow_uuid',
                 'backup_flows', fr[0], 'required')
    # v5.35.0 · G2: configs 引用注册移除 (零遗留)


def schedule_list() -> list:
    _ensure_table()
    conn = _db.get_conn()
    rows = conn.execute("SELECT * FROM schedules ORDER BY id DESC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["params"] = json.loads(d.pop("params_json") or "{}")
        except Exception:
            d["params"] = {}
        # v4.47.0 P2 · times_json -> times 数组 (前端展示/编辑用)
        try:
            t = json.loads(d.pop("times_json") or "")
            d["times"] = t if isinstance(t, list) and t else []
        except Exception:
            d["times"] = []
        d["enabled"] = bool(d.get("enabled"))
        out.append(d)
    return out


def schedule_update(sid: int, **kwargs) -> bool:
    """v4.39.0: 支持 uuid 定位(传 uuid=... 则按 uuid 查)"""
    _ensure_table()
    uuid_ref = kwargs.pop("uuid", None)
    where_clause = "uuid=?" if uuid_ref else "id=?"
    where_arg = uuid_ref if uuid_ref else sid
    allowed = {"name", "cron_expr", "times_json", "action", "params_json", "enabled"}
    sets, vals = [], []
    for k, v in kwargs.items():
        if k not in allowed:
            continue
        if k == "params_json" and isinstance(v, (dict, list)):
            v = json.dumps(v)
        if k == "times_json" and isinstance(v, list):
            v = json.dumps([str(x).strip() for x in v if str(x).strip()]) if v else ""
        sets.append(f"{k}=?")
        vals.append(v)
    if not sets:
        return False
    # 如果改了 cron_expr/times_json，重算 next_run (多表达式取最近并集)
    if ("cron_expr" in kwargs or "times_json" in kwargs) and _CRON_OK:
        new_expr = kwargs.get("cron_expr")
        new_times = kwargs.get("times_json")
        if isinstance(new_times, str):
            try:
                new_times = json.loads(new_times) if new_times else []
            except Exception:
                new_times = []
        if isinstance(new_times, list) and new_times:
            for e in new_times:
                if not croniter.is_valid(str(e)):
                    raise ValueError(f"invalid cron: {e}")
        elif new_expr and not croniter.is_valid(new_expr):
            raise ValueError(f"invalid cron: {new_expr}")
        sets.append("next_run=?")
        vals.append(_compute_next(new_expr or "* * * * *",
                                  times_json=json.dumps(new_times) if new_times else None))
    sets.append("updated_at=datetime('now','localtime')")
    vals.append(where_arg)
    conn = _db.get_conn()
    conn.execute(f"UPDATE schedules SET {','.join(sets)} WHERE {where_clause}", vals)
    conn.commit()
    # v4.39.0 · 更新引用关系(若改了 params_json)
    if "params_json" in kwargs and (uuid_ref or sid):
        real_uuid = uuid_ref
        if not real_uuid:
            row = conn.execute("SELECT uuid FROM schedules WHERE id=?", (sid,)).fetchone()
            real_uuid = row[0] if row else None
        if real_uuid:
            # 先清旧引用,再注册新引用
            from backend.db.entity_refs import unregister_ref, register_ref
            unregister_ref(conn, 'schedules', real_uuid, 'params.flow_uuid')
            unregister_ref(conn, 'schedules', real_uuid, 'params.config_uuid')
            new_params = kwargs["params_json"]
            if isinstance(new_params, str):
                try:
                    new_params = json.loads(new_params)
                except Exception:
                    new_params = {}
            _register_schedule_refs(conn, real_uuid, new_params)
    return True


def schedule_delete(sid: int, *, uuid: Optional[str] = None) -> bool:
    """v4.39.0: 支持 uuid 定位删除,自动清理引用注册表"""
    _ensure_table()
    conn = _db.get_conn()
    where_clause = "uuid=?" if uuid else "id=?"
    where_arg = uuid if uuid else sid
    # 先查 uuid 用于清理引用注册表
    row = conn.execute(f"SELECT uuid FROM schedules WHERE {where_clause}", (where_arg,)).fetchone()
    if not row:
        return False
    real_uuid = row[0]
    # 删除实体
    row2 = conn.execute(f"SELECT id FROM schedules WHERE uuid=?", (real_uuid,)).fetchone()
    real_id = row2[0] if row2 else sid
    conn.execute("DELETE FROM schedule_runs WHERE schedule_id=?", (real_id,))
    conn.execute("DELETE FROM schedules WHERE id=?", (real_id,))
    # 清理发出的引用
    conn.execute("DELETE FROM entity_refs WHERE source_table='schedules' AND source_uuid=?", (real_uuid,))
    # v4.46.0 P0-2 · 反向清理: 引用此计划的 backup_flows.schedule_id 置空
    #   (缺陷 2: 此前删计划不清 flow 侧指针 → flow 页显示一个永不触发的孤儿计划名)
    try:
        conn.execute(
            "UPDATE backup_flows SET schedule_id=NULL, updated_at=datetime('now','localtime') "
            "WHERE schedule_id=?", (real_id,))
    except Exception as e:
        print(f"[scheduler] flow.schedule_id cleanup fail: {e}")
    conn.commit()
    return True


def schedule_get(sid: int = None, *, uuid: Optional[str] = None) -> Optional[dict]:
    """v4.39.0: 支持 uuid 查询"""
    conn = _db.get_conn()
    if uuid:
        row = conn.execute("SELECT * FROM schedules WHERE uuid=?", (uuid,)).fetchone()
    else:
        row = conn.execute("SELECT * FROM schedules WHERE id=?", (sid,)).fetchone()
    if not row:
        return None
    d = dict(row)
    try:
        d["params"] = json.loads(d.pop("params_json") or "{}")
    except Exception:
        d["params"] = {}
    # v4.47.0 P2 · times_json -> times 数组
    try:
        t = json.loads(d.pop("times_json") or "")
        d["times"] = t if isinstance(t, list) and t else []
    except Exception:
        d["times"] = []
    d["enabled"] = bool(d.get("enabled"))
    return d


async def _dispatch_one(row: dict, trigger: str = "cron"):
    action = row.get("action")
    fn = _actions.get(action)
    sid = row["id"]
    started_dt = datetime.now()
    now_str = started_dt.strftime("%Y-%m-%d %H:%M:%S")
    conn = _db.get_conn()
    # v4.6.0: 开一条 run 记录
    cur = conn.execute(
        "INSERT INTO schedule_runs (schedule_id, started_at, status, trigger) VALUES (?, ?, 'running', ?)",
        (sid, now_str, trigger)
    )
    run_id = cur.lastrowid
    conn.commit()

    def _finish(status: str, msg: str):
        ended_dt = datetime.now()
        ended_str = ended_dt.strftime("%Y-%m-%d %H:%M:%S")
        dur_ms = int((ended_dt - started_dt).total_seconds() * 1000)
        conn.execute(
            "UPDATE schedule_runs SET ended_at=?, status=?, msg=?, duration_ms=? WHERE id=?",
            (ended_str, status, msg[:500] if msg else "", dur_ms, run_id)
        )
        # v4.47.0 P2 · 多表达式 next_run: 兼容 tick 原始行(times_json 列) 与
        #   schedule_get 产物(times 数组) 两种形态
        _tj = row.get("times_json")
        if not _tj and isinstance(row.get("times"), list) and row["times"]:
            _tj = json.dumps(row["times"])
        conn.execute(
            "UPDATE schedules SET last_run=?, last_status=?, last_msg=?, next_run=? WHERE id=?",
            (now_str, status, msg[:200] if msg else "",
             _compute_next(row.get("cron_expr"), times_json=_tj), sid)
        )
        conn.commit()
        # v4.16.1 · publish schedule.run.finished（cron 自动/手动都发）
        try:
            from backend import events
            events.publish("schedule.run.finished",
                           {"id": sid, "status": status, "trigger": trigger,
                            "duration_ms": dur_ms, "run_id": run_id})
        except Exception as _e:
            print(f"[scheduler] publish fail: {_e}")

    if not fn:
        print(f"[scheduler] no action registered: {action}")
        _finish("error", f"unknown action: {action}")
        return {"status": "error", "msg": f"unknown action: {action}", "run_id": run_id}
    try:
        params = row.get("params") or {}
        result = await fn(params)
        msg = str(result)[:500] if result is not None else "ok"
        _finish("ok", msg)
        print(f"[scheduler] ✓ #{sid} {row['name']} → {action} · {msg[:80]}")
        _maybe_auto_retention()
        return {"status": "ok", "msg": msg, "run_id": run_id}
    except Exception as e:
        _finish("error", str(e))
        print(f"[scheduler] ✗ #{sid} {row['name']} · {e}")
        _maybe_auto_retention()
        return {"status": "error", "msg": str(e), "run_id": run_id}


def _maybe_auto_retention():
    """v4.13.0 · schedule 完成后触发全局 auto_apply。捕获所有异常避免影响 scheduler 主流程。"""
    try:
        from backend.handlers.retention import auto_apply_all
        s = auto_apply_all()
        if s.get("users") and (s.get("deleted_ids") or s.get("deleted_files")):
            print(f"[scheduler] retention auto_apply · users={s['users']} · records={s['deleted_ids']} · files={s['deleted_files']}")
    except Exception as e:
        print(f"[scheduler] retention auto_apply hook failed: {e}")


async def _run_now(sid: int):
    """用户请求立即执行某个任务。"""
    row = schedule_get(sid)
    if not row:
        return {"status": "error", "msg": "not found"}
    r = await _dispatch_one(row, trigger="manual")
    # 把真实结果回传（v4.6.0: 之前只返回 dispatched 字符串）
    return {"status": r.get("status", "ok"),
            "msg": r.get("msg", "dispatched")[:200],
            "run_id": r.get("run_id")}


def runs_list(schedule_id: int, limit: int = 50) -> list:
    """v4.6.0: 拉某个 schedule 的最近 N 次运行记录。"""
    _ensure_table()
    conn = _db.get_conn()
    rows = conn.execute(
        "SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY id DESC LIMIT ?",
        (schedule_id, int(limit))
    ).fetchall()
    return [dict(r) for r in rows]


async def _health_probe_all():
    """v5.34.6 · P6 健康巡检: 顺序探测全部 server_profiles, 状态变化才 publish。"""
    import time as _t
    from backend.handlers.server_profile import _probe_profile_core
    from backend import events as _ev
    try:
        conn = _db.get_conn()
        rows = conn.execute("SELECT guid, hostname, ssh_port, ssh_user, ssh_auth_type, "
                            "ssh_auth_value, ssh_passphrase, status, protocols "
                            "FROM server_profiles").fetchall()
    except Exception as e:
        print(f"[health] read profiles fail: {e}")
        return
    for r in rows:
        try:
            d = dict(r)
            prev = d.get("status") or "unknown"
            res = await asyncio.get_event_loop().run_in_executor(None, _probe_profile_core, d)
            new_status = "online" if res.get("ok") else "offline"
            if new_status != prev:
                conn.execute("UPDATE server_profiles SET status=?, last_latency_ms=?, "
                             "last_seen=datetime('now','localtime'), version=version+1 WHERE guid=?",
                             (new_status, res.get("latency_ms", -1), d["guid"]))
                conn.commit()
                _ev.publish("profile.changed", {"guid": d["guid"], "action": "update",
                                                "fields": ["status"], "by": "health_probe"})
            else:
                conn.execute("UPDATE server_profiles SET last_latency_ms=?, "
                             "last_seen=datetime('now','localtime') WHERE guid=?",
                             (res.get("latency_ms", -1), d["guid"]))
                conn.commit()
            await asyncio.sleep(1.0)   # 探测间隔限速, 避免认证风暴
        except Exception as e:
            print(f"[health] probe {r['guid'][:8]} fail: {e}")
    # v6.4.1 · 批4: 巡检结束 → 池成员状态回写(此前 cloudpool members.status 只有
    #   手动 probe 才更新, 池容量/可见性/placement 全基于陈旧状态)
    try:
        from backend.cloudpool import members as _cpm
        _cpm.sync_status_from_profiles(_db.get_conn())
    except Exception as e:
        print(f"[health] cloudpool status sync fail: {e}")


async def _loop():
    """后台循环：每 _TICK_SECONDS 秒检查到期任务。"""
    global _running
    _ensure_table()
    while _running:
        try:
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            conn = _db.get_conn()
            rows = conn.execute(
                "SELECT * FROM schedules WHERE enabled=1 AND next_run IS NOT NULL AND next_run<=?",
                (now_str,)
            ).fetchall()
            for r in rows:
                d = dict(r)
                try:
                    d["params"] = json.loads(d.pop("params_json") or "{}")
                except Exception:
                    d["params"] = {}
                # v4.46.0 P0-3 · 防重入: 派发前先原子预占 next_run (乐观锁)。
                #   缺陷: next_run 此前只在任务完成的 _finish 才更新, 长任务(如 vzdump
                #   跑 30 分钟)执行期间每个 tick(30s) 都会再 SELECT 到同一行再次派发
                #   → 同一任务并发重跑。预占后 _finish 按完成时间重算覆盖, 语义不变。
                try:
                    _tj = d.get("times_json") or ""
                    _nxt = _compute_next(d["cron_expr"], times_json=_tj)
                    _cur = conn.execute(
                        "UPDATE schedules SET next_run=? WHERE id=? AND next_run=?",
                        (_nxt, d["id"], d["next_run"]))
                    conn.commit()
                    if _cur.rowcount != 1:
                        continue  # 已被预占/并发修改, 本 tick 跳过
                except Exception as e:
                    print(f"[scheduler] claim next_run fail #{d['id']}: {e}")
                    continue
                # 派发（不 await，让它并发跑）
                asyncio.create_task(_dispatch_one(d))
        except Exception as e:
            print(f"[scheduler] tick failed: {e}")
        # v4.17.1 · 每次 tick 发一次 system.heartbeat（订阅方用来刷 dashboard 状态卡片）
        try:
            from backend import events
            events.publish("system.heartbeat", {"ts": datetime.now().isoformat(timespec="seconds")})
        except Exception as _e:
            print(f"[scheduler] heartbeat publish fail: {_e}")
        # v5.34.6 · P6 健康巡检: 每 conn_probe_interval 秒顺序探测全部档案 (0=关闭, 默认关)
        #   状态变化才广播 (避免噪音); 探测核心复用 server_profile 的探测实现
        try:
            _interval = int(_db.setting_get("conn_probe_interval", "0") or 0)
            if _interval > 0:
                _now_ts = datetime.now().timestamp()
                _last = getattr(_loop, "_next_probe_ts", 0)
                if _now_ts >= _last:
                    _loop._next_probe_ts = _now_ts + _interval
                    asyncio.create_task(_health_probe_all())
        except Exception as _e:
            print(f"[scheduler] health probe schedule fail: {_e}")
        # v4.20.0 · 每小时清理 30 天前的事件日志（用 tick 计数模拟：120 次 × 30s = 1h）
        try:
            _tick_counter = getattr(_loop, "_tick_counter", 0) + 1
            setattr(_loop, "_tick_counter", _tick_counter)
            if _tick_counter % 120 == 0:
                n = _db.event_log_purge(30, max_rows=200000)   # v5.50.0 · 同时按大小封顶
                if n > 0:
                    print(f"[scheduler] event_log purge · deleted {n} rows (older than 30d)")
        except Exception as _e:
            print(f"[scheduler] event_log purge fail: {_e}")
        # v4.39.0 · 每 2 小时(240 次 tick)检查一次引用图一致性
        try:
            _tick_counter = getattr(_loop, "_tick_counter", 0)
            if _tick_counter % 240 == 0:
                report = _db.graph_integrity_check()
                dangling_count = len(report.get("dangling", []))
                if dangling_count > 0:
                    print(f"[scheduler] graph integrity · {dangling_count} dangling refs detected")
                    from backend import events
                    events.publish("graph.dangling", {
                        "dangling_count": dangling_count,
                        "dangling": report["dangling"][:20],
                        "ts": datetime.now().isoformat(timespec="seconds"),
                    })
        except Exception as _e:
            print(f"[scheduler] graph integrity check fail: {_e}")
        # v5.29.0 · 每日 (2880 tick × 30s) 检查 HTTPS 证书到期 → 自动续期
        try:
            _hc_tc = getattr(_loop, "_https_counter", 0) + 1
            setattr(_loop, "_https_counter", _hc_tc)
            if _hc_tc % 2880 == 0:
                from backend.db import setting_get as _sg
                if _sg("https_enabled", "0") == "1" and _sg("https_auto_renew", "1") == "1":
                    from backend import https_cert as _hc
                    try:
                        _th = int(_sg("https_renew_before_days", "30") or 30)
                    except ValueError:
                        _th = 30
                    _r = _hc.renew_if_due(threshold_days=_th)
                    if _r.get("renewed"):
                        print(f"[scheduler] https cert auto-renewed: {_r}")
                else:
                    setattr(_loop, "_https_counter", 0)  # 未启用 → 重置计数, 启用后即日开始计
        except Exception as _e:
            print(f"[scheduler] https renew check fail: {_e}")
        await asyncio.sleep(_TICK_SECONDS)


def start():
    """由 FastAPI startup 事件调用。"""
    global _running, _task
    if _running:
        return
    if not _CRON_OK:
        print("[scheduler] croniter not installed → scheduler disabled")
        return
    _running = True
    _ensure_table()
    _task = asyncio.create_task(_loop())
    print(f"[scheduler] started (tick every {_TICK_SECONDS}s)")


async def stop():
    global _running, _task
    _running = False
    if _task:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError as _e: logging.debug("suppressed", exc_info=True)
    print("[scheduler] stopped")


# ═════════════════════════════════════════════════════════════
# 默认 action 注册（示例 · 后续可扩展）
# ═════════════════════════════════════════════════════════════

def _sched_license_ok(feat: str) -> bool:
    """v6.16.14 · 定时任务档位校验(用户要求: 非社区版功能清除; 此前 schedule_create 是社区键,
    可绕过档位创建 flow/dbbackup/云上传等高级任务 —— 属功能外溢)。
    未授权 → 记日志并跳过本次执行(不抛错, 避免刷爆任务日志)。"""
    try:
        from backend import license as _L
        if _L.feature_enabled(feat):
            return True
        log.warning("定时任务档位不足, 已跳过: 需要功能键 %s (当前档位不含)", feat)
        return False
    except Exception as e:
        log.warning("定时任务档位校验异常(按允许处理): %s", e)
        return True


async def _action_noop(params: dict):
    """占位测试用：仅打印。"""
    return f"noop · params={params}"


async def _action_pve_backup_scheduled(params: dict):
    """v2.9.1: 真接入 handle_pve_backup。
    params 需要包含 handle_pve_backup 所需的字段（host/user/密码/vm_ids 等）。
    密码类字段可以是明文（scheduler 自己派发，不经 WS 抓包）或 ENC:/EC1:。
    """
    return await _dispatch_via_headless("pve_backup", params)


async def _action_vzdump_scheduled(params: dict):
    """v2.9.1: 真接入 handle_vzdump。"""
    return await _dispatch_via_headless("vzdump", params)


async def _action_platform_backup_scheduled(params: dict):
    """v4.4.0: 定时通用平台备份。

    params 需含 SSHTarget 字段 (host/port/user/auth_type/password 或 key)，
    以及可选 platform / selected_keys / compressor / local_dir / label。
    支持 config_id / config_name 从 DB 取 SSH 凭据补齐。
    执行完毕后：backup 落 backups 表、若远端 auto_upload=1 自动云上传（platform handler 内置）。
    """
    return await _dispatch_via_headless("platform_execute_backup", params)


async def _action_rsync_scheduled(params: dict):
    """v4.15.9: 定时 rsync 传输。

    params: source, target, config_id(可选), extra_flags(可选), password(可选)
    直接调 rsync 命令行；先尝试 config_id 补齐 SSH 凭据。
    """
    from datetime import datetime as _dt
    import shlex as _shlex
    import subprocess as _sp
    from backend import db as _db

    src = (params.get("source") or "").strip()
    dst = (params.get("target") or "").strip()
    if not src or not dst:
        return "[rsync] MISSING source or target"

    env = {"PATH": "/usr/bin:/bin:/usr/local/bin"}
    password = params.get("password") or ""
    # v5.35.0 · G2 零遗留: configs 回退删除; host 未带密码时按档案解析
    if not password and params.get("host"):
        try:
            from backend.db.crypto import decrypt_value as _dv
            from backend.db import _get_fernet as _gf
            _row = _db.get_conn().execute(
                "SELECT ssh_auth_type,ssh_auth_value FROM server_profiles WHERE hostname=?",
                ((params.get("host") or "").strip(),)).fetchone()
            if _row and _row["ssh_auth_type"] == "pass" and _row["ssh_auth_value"]:
                _av = _row["ssh_auth_value"]
                if str(_av).startswith("ENC$"):
                    _av = _dv(_gf(), _av)
                password = _av
        except Exception as e:
            print(f"[scheduler] fonrivfile cred fail: {e}")

    if password:
        env["SSHPASS"] = password

    flags = params.get("extra_flags") or "-avz --progress"
    ssh_opts = "-o StrictHostKeyChecking=accept-new"
    if password:
        cmd = f"sshpass -e rsync -e {_shlex.quote('ssh ' + ssh_opts)} {flags} {_shlex.quote(src)} {_shlex.quote(dst)}"
    else:
        cmd = f"rsync -e {_shlex.quote('ssh ' + ssh_opts)} {flags} {_shlex.quote(src)} {_shlex.quote(dst)}"
    ts = _dt.now().strftime("%H:%M:%S")
    try:
        r = _sp.run(cmd, shell=True, capture_output=True, text=True, env=env, timeout=3600)
        tail = (r.stdout or "").strip().splitlines()[-5:]
        if r.returncode == 0:
            return f"[rsync @ {ts}] ok · {src} → {dst} · {'; '.join(tail)}"
        return f"[rsync @ {ts}] fail rc={r.returncode} · {(r.stderr or '').strip()[:200]}"
    except Exception as e:
        return f"[rsync @ {ts}] exception: {e}"


async def _action_remote_upload_scheduled(params: dict):
    if not _sched_license_ok("cloud"):
        return {"status": "skipped", "msg": "授权档位不含 cloud"}
    """v4.41.0 P3-9 · 定时云上传: 定时把本机文件/目录传到远端存储 (seafile/s3/oss/cos/rclone/local)。

    params: remote_id(int, 必填), local_path(必填), remote_dir(可选, 默认库根),
            mode: "file"(默认) | "dir" (目录 -> 递归逐文件上传)
    返回执行摘要, 写入 last_status。
    """
    from datetime import datetime as _dt
    from backend import db as _db
    # v1.0.0 · 远端存储未包含在本发行版 → 任务明确跳过 (不再抛 ModuleNotFoundError)
    try:
        from backend.remotes import build_from_config
    except ImportError:
        return "[cloud-upload] 云端上传未包含在本发行版中, 已跳过"
    ts = _dt.now().strftime("%H:%M:%S")
    rid = int(params.get("remote_id") or 0)
    local_path = (params.get("local_path") or "").strip()
    remote_dir = (params.get("remote_dir") or "").strip().strip("/")
    mode = (params.get("mode") or "file").strip()
    if rid <= 0 or not local_path or not os.path.exists(local_path):
        return f"[cloud-upload @ {ts}] MISSING remote_id/local_path (or local missing)"
    cfg = _db.remote_get(rid, decrypt=True)
    if not cfg:
        return f"[cloud-upload @ {ts}] remote #{rid} 不存在"
    try:
        storage = build_from_config(cfg)
    except Exception as e:
        return f"[cloud-upload @ {ts}] storage 构造失败: {e}"

    def _prog(sent, total):
        pass  # 调度无 ws, 进度静默

    t0 = time.time()
    if os.path.isdir(local_path) or mode == "dir":
        base = local_path.rstrip("/")
        ok_n = fail_n = 0
        errors = []
        for root, dirs, files in os.walk(base):
            rel_root = os.path.relpath(root, base)
            rel_root = "" if rel_root == "." else rel_root.replace(os.sep, "/")
            for f in sorted(files):
                rel = (rel_root + "/" + f) if rel_root else f
                rkey = (remote_dir + "/" + rel) if remote_dir else rel
                try:
                    res = storage.upload_file(os.path.join(root, f), rkey, _prog)
                    if res.ok:
                        ok_n += 1
                    else:
                        fail_n += 1
                        errors.append(f"{rel}: {res.error}")
                except Exception as e:
                    fail_n += 1
                    errors.append(f"{rel}: {e}")
        return (f"[cloud-upload @ {ts}] ok · {base} → {cfg.get('provider')}:#{rid} · "
                f"{ok_n} 成功 / {fail_n} 失败" + (f" · {errors[0][:120]}" if errors else ""))
    rkey = (remote_dir + "/" + os.path.basename(local_path)) if remote_dir else os.path.basename(local_path)
    try:
        res = storage.upload_file(local_path, rkey, _prog)
        dur = round(time.time() - t0, 1)
        if res.ok:
            return f"[cloud-upload @ {ts}] ok · {os.path.basename(local_path)} → {cfg.get('provider')}:{rkey} ({res.size_bytes}B, {dur}s)"
        return f"[cloud-upload @ {ts}] fail · {res.error}"
    except Exception as e:
        return f"[cloud-upload @ {ts}] exception: {e}"


async def _action_flow_scheduled(params: dict):
    if not _sched_license_ok("flow"):
        return {"status": "skipped", "msg": "授权档位不含 flow"}
    """v4.15.9: 定时跨模块流程。

    params: flow_id (必填) 或 flow_uuid (v4.39.0+)
    调用 backend.flow_engine.run_flow(flow_id, trigger='scheduled')。
    """
    from datetime import datetime as _dt
    from backend import db as _db
    fid = params.get("flow_id")
    flow_uuid = params.get("flow_uuid")
    # v4.39.0: uuid 优先
    if flow_uuid:
        flow = _db.flow_get(uuid=flow_uuid)
        fid = flow["id"] if flow else 0
    else:
        try:
            fid = int(fid or 0)
        except Exception:
            fid = 0
    if fid <= 0:
        return "[flow] MISSING flow_id or flow_uuid"
    ts = _dt.now().strftime("%H:%M:%S")
    try:
        from backend.flow_engine import run_flow
        # run_flow 是同步阻塞 -> 丢线程池
        result = await asyncio.to_thread(run_flow, fid, trigger="scheduled", on_progress=None)
        st = (result or {}).get("status", "?")
        ok = (result or {}).get("files_ok", 0)
        skp = (result or {}).get("files_skipped", 0)
        fail = (result or {}).get("files_failed", 0)
        return f"[flow#{fid} @ {ts}] status={st} · ok={ok} skip={skp} fail={fail}"
    except Exception as e:
        return f"[flow#{fid} @ {ts}] exception: {e}"


async def _dispatch_via_headless(action: str, params: dict):
    """构造一个 headless WS，把定时 params 派发给现有 handler。
    收集 send_json 的输出，把关键 result 消息返回作为 last_msg。

    v2.9.1: 若 params 里没有 host/user/密码，尝试从 params.config_id 或 params.config_name
            查询 DB configs 表补齐。
    """
    from datetime import datetime as _dt
    import uuid as _uuid
    from backend import db as _db

    # v5.34.6 · P6 统一凭据解析: ① server_profiles (真源) ② configs 主字段 ③ configs 前缀列
    #   ①优先: params.host 或 config 行解析出的 host 命中档案 → 解密填充; 未命中计数 (退役监控)
    def _sp_resolve_params(host_in):
        try:
            import json as _json
            from backend.db.crypto import decrypt_value as _dv
            from backend.db import _get_fernet as _gf
            row = _db.get_conn().execute(
                "SELECT ssh_port,ssh_user,ssh_auth_type,ssh_auth_value,ssh_passphrase "
                "FROM server_profiles WHERE hostname=? AND user_id=1", (host_in,)).fetchone()
            if not row:
                return False
            av = row["ssh_auth_value"] or ""
            if av and str(av).startswith("ENC$"):
                av = _dv(_gf(), av)
            pp = row["ssh_passphrase"] or ""
            if pp and str(pp).startswith("ENC$"):
                pp = _dv(_gf(), pp)
            at = row["ssh_auth_type"] or "pass"
            params.setdefault("host", host_in)
            params.setdefault("port", str(row["ssh_port"] or 22))
            params.setdefault("user", row["ssh_user"] or "root")
            params.setdefault("auth_type", at)
            params.setdefault("password", av if at == "pass" else "")
            params.setdefault("key", av if at == "key" else "")
            params["_cred_src"] = "server_profiles"
            return True
        except Exception as _e:
            print(f"[scheduler] sp_resolve_params fail: {_e}")
            return False

    _sp_ok = bool(params.get("host")) and _sp_resolve_params((params.get("host") or "").strip())

    # v5.35.0 · G2 零遗留: configs 展开层移除 (凭据唯一来源 = server_profiles)

    # 若最终仍没 host → 直接返回失败（避免 handler 里深处报错）
    if not params.get("host"):
        return f"[{action}] MISSING host (params 需含 host 或 config_id / config_name)"

    class _HeadlessWS:
        def __init__(self, user_id: int = 1):
            self.sent: list[dict] = []
            self._current_req_id = None
            self.headers = {}
            # v4.7.0: 让 auth._get_user_id 能拿到调度任务归属用户
            self.user = {"id": int(user_id), "username": "sched", "role": "admin"}
        async def send_json(self, msg: dict):
            self.sent.append(msg if isinstance(msg, dict) else {"raw": str(msg)})
        async def send_text(self, txt: str):
            self.sent.append({"type": "text", "msg": txt})

    _owner_uid = int(params.pop("_owner_user_id", 1) or 1)
    ws = _HeadlessWS(user_id=_owner_uid)
    task_id = "sched-" + _uuid.uuid4().hex[:8]

    try:
        if action == "pve_backup":
            from backend.handlers.pve import handle_pve_backup
            await handle_pve_backup(ws, params, task_id)
        elif action == "vzdump":
            from backend.handlers.vzdump import handle_vzdump
            await handle_vzdump(ws, params, task_id)
        elif action == "platform_execute_backup":
            from backend.handlers.platform import handle_platform_execute_backup
            await handle_platform_execute_backup(ws, params)
        else:
            return f"unknown scheduled action: {action}"
    except Exception as e:
        return f"[{action}] exception: {e}"

    final = None
    logs_summary = 0
    for m in ws.sent:
        if not isinstance(m, dict):
            continue
        if m.get("type") in ("result", "backup_done", "vzdump_done"):
            final = m
        if m.get("type") == "log":
            logs_summary += 1

    ts = _dt.now().strftime("%H:%M:%S")
    if final:
        status = final.get("status", "?")
        msg = final.get("msg", "")
        return f"[{action} @ {ts}] status={status} · {msg[:120]} · logs={logs_summary}"
    return f"[{action} @ {ts}] completed · {logs_summary} log msgs"


# v5.45.0 · FonrVFS 目录同步定时 (多云文件管理): 对比 + 增量搬运 (+可选删除多余/试运行)
async def _action_fonr_sync_scheduled(params: dict):
    if not _sched_license_ok("fonrvfs"):
        return {"status": "skipped", "msg": "授权档位不含 fonrvfs"}
    """FonrVFS 目录同步定时任务。

    params:
      src_storage_id / src_path          源 (存储 id 见多云面板, 本机为 local)
      dst_storage_id / dst_path          目标
      compare      name | size | size-mtime (默认 size-mtime)
      delete_extra 目标端多余项是否删除 (默认否, 只增不删)
      dry_run      只对比不搬运 (默认否)
      reverse      反向同步 (等价于交换源/目标)
      max_items    单次最多搬运项数 (默认 500)
    """
    # v1.0.0 · 多云文件管理未包含在本发行版 → 任务明确跳过 (不再抛 ModuleNotFoundError)
    try:
        from backend.fonrvfs.vfs import VFS
        from backend.fonrvfs import diff as _diff
        from backend.fonrvfs import transfer as _tr
    except ImportError:
        return {"status": "skipped", "msg": "多云文件管理未包含在本发行版中"}
    from backend.log import log_operation

    src_sid = (params.get("src_storage_id") or "local").strip() or "local"
    src_path = (params.get("src_path") or "/").strip() or "/"
    dst_sid = (params.get("dst_storage_id") or "local").strip() or "local"
    dst_path = (params.get("dst_path") or "/").strip() or "/"
    if params.get("reverse"):
        src_sid, dst_sid = dst_sid, src_sid
        src_path, dst_path = dst_path, src_path
    compare = (params.get("compare") or "size-mtime").lower()
    dry = bool(params.get("dry_run"))
    del_extra = bool(params.get("delete_extra"))
    head = "[fonr_sync] %s:%s → %s:%s" % (src_sid, src_path, dst_sid, dst_path)
    # v5.97.5 · FIX(本机实测事故 2026-09-27): local:/ → 某目录 的一次误配同步,
    #   把 /bin 等 86 项(26GB)复制进目标目录并把磁盘写满。**仅对本机(local)根目录**拦截:
    #   其它存储(云/SSH/共享)的 "/" 是那块存储自己的根, 是合法用法(v5.45.0 用例即如此),
    #   一刀切会把「同步某个桶/共享根」这种正常场景也拦掉。
    _src_sid_n = (src_sid or "local").strip() or "local"
    _src_root = str(src_path or "/").strip().strip("/") == "" and _src_sid_n == "local"
    if _src_root and not bool(params.get("allow_root")):
        log_operation("fonr_sync", "拒绝执行(源为本机根目录)",
                      "%s · 需要 allow_root=true 才允许遍历整个文件系统" % head)
        return ("%s · 已拒绝: 源是**本机**根目录(/), 会遍历并复制整个文件系统 —— "
                "请改到具体目录, 或显式传 allow_root=true" % head)
    try:
        sa = await VFS.adapter(src_sid)
        da = await VFS.adapter(dst_sid)
        rep = await _diff.compare(sa, src_path, da, dst_path, compare=compare)
    except Exception as e:
        log_operation("fonr_sync", "对比失败", "%s : %s" % (head, e))
        return "%s · 对比失败: %s" % (head, e)
    s = rep.get("summary") or {}
    plan = rep.get("copy_plan") or []
    stat = "only_src=%s only_dst=%s diff=%s same=%s" % (
        s.get("only_src", 0), s.get("only_dst", 0), s.get("diff", 0), s.get("same", 0))
    if dry:
        log_operation("fonr_sync", "试运行", "%s %s 待复制=%d" % (head, stat, len(plan)))
        return "%s · 试运行 %s 待复制=%d" % (head, stat, len(plan))

    copied, failed = 0, []
    for it in plan[:int(params.get("max_items") or 500)]:
        try:
            await _tr.copy_between(sa, it.get("src_path"), da, it.get("dst_path"))
            copied += 1
        except Exception as e:
            failed.append("%s: %s" % (it.get("rel"), e))
    deleted = 0
    if del_extra:
        for e in (rep.get("entries") or []):
            if e.get("status") != "only_dst":
                continue
            rel = e.get("rel") or ""
            try:
                dst_full = (dst_path.rstrip("/") + "/" + rel) if dst_path.strip("/") else "/" + rel
                await da.delete(dst_full, recursive=bool(e.get("is_dir")))
                deleted += 1
            except Exception as ex:
                failed.append("del %s: %s" % (rel, ex))
    tail = "" if not failed else " | 失败: " + "; ".join(failed[:3]) + (" 等 %d 项" % len(failed) if len(failed) > 3 else "")
    msg = "%s · 复制 %d/%d 删除 %d %s%s" % (head, copied, len(plan), deleted, stat, tail)
    log_operation("fonr_sync", "同步完成" if not failed else "同步部分失败",
                  "%s copied=%d deleted=%d failed=%d" % (head, copied, deleted, len(failed)))
    return msg


register_action("noop", _action_noop)
register_action("pve_backup_scheduled", _action_pve_backup_scheduled)
register_action("vzdump_scheduled", _action_vzdump_scheduled)
register_action("platform_backup_scheduled", _action_platform_backup_scheduled)
register_action("rsync_scheduled", _action_rsync_scheduled)
# v4.41.0 P3-9 · 定时云上传 (remote_id + local_path [+ remote_dir, mode=file|dir])
register_action("remote_upload_scheduled", _action_remote_upload_scheduled)
register_action("flow_scheduled", _action_flow_scheduled)
# v4.83.0 · C4 定时自动恢复演练
try:
    from backend.worm_drill import _action_drill_scheduled
except ImportError:  # v6.16.20 批37 · 社区包: worm_drill 剪除 (专业档)
    _action_drill_scheduled = None
if _action_drill_scheduled is not None:
    register_action("drill_scheduled", _action_drill_scheduled)


# v4.15.21 · SQLite 每日自动备份
async def _action_sqlite_backup(params: dict):
    """备份 fonriv.db 到 backups/db/<date>.sqlite。

    params:
      - dest_dir: 目标目录（默认 backups/db）
      - keep_days: 保留天数（默认 14，超过删除）
    使用 SQLite 官方 backup API 保证一致性（不受 WAL 写入影响）。
    """
    import os as _os
    import sqlite3 as _sq3
    from datetime import datetime as _dt, timedelta as _td
    from backend import db as _db

    dest_dir = (params.get("dest_dir") or "backups/db").strip()
    keep_days = int(params.get("keep_days") or 14)

    try:
        _os.makedirs(dest_dir, exist_ok=True)
    except Exception as e:
        return f"[sqlite_backup] mkdir failed: {e}"

    ts = _dt.now().strftime("%Y%m%d_%H%M%S")
    dst_path = _os.path.join(dest_dir, f"fonriv_{ts}.sqlite")
    try:
        src = _db.get_conn()
        dst = _sq3.connect(dst_path)
        with dst:
            src.backup(dst)
        dst.close()
        size = _os.path.getsize(dst_path)
    except Exception as e:
        return f"[sqlite_backup] backup failed: {e}"

    # 清理老快照
    removed = 0
    try:
        cutoff = _dt.now() - _td(days=max(1, keep_days))
        for fn in _os.listdir(dest_dir):
            if not fn.startswith("fonriv_") or not fn.endswith(".sqlite"):
                continue
            fp = _os.path.join(dest_dir, fn)
            try:
                mtime = _dt.fromtimestamp(_os.path.getmtime(fp))
                if mtime < cutoff:
                    _os.remove(fp)
                    removed += 1
            except Exception as e:
                print(f"[sqlite_backup] prune {fp} fail: {e}")
    except Exception as e:
        print(f"[sqlite_backup] prune scan fail: {e}")

    return (f"[sqlite_backup @ {_dt.now().strftime('%H:%M:%S')}] ok · "
            f"{dst_path} · {size} bytes · pruned={removed} (keep {keep_days}d)")


register_action("sqlite_backup", _action_sqlite_backup)


# v4.15.0-alpha1 · 跨模块流程执行
async def _action_flow_run(params: dict):
    if not _sched_license_ok("flow"):
        return {"status": "skipped", "msg": "授权档位不含 flow"}
    """params={'flow_id': int}"""
    try:
        fid = int(params.get("flow_id") or 0)
        if fid <= 0:
            return {"status": "err", "msg": "flow_id required"}
        # 同步阻塞跑；放 to_thread 避免堵 asyncio
        import asyncio as _asyncio
        from backend.flow_engine import run_flow
        r = await _asyncio.to_thread(run_flow, fid, trigger="cron")
        return r
    except Exception as e:
        print("[scheduler] flow_run action error:", e)
        return {"status": "err", "msg": str(e)}


register_action("flow_run", _action_flow_run)
# v5.45.0 · 多云文件管理目录同步 (对比 + 增量搬运, 支持删除多余/试运行)
register_action("fonr_sync", _action_fonr_sync_scheduled)


# v4.54.0 · 数据库热备定时 (MySQL/PG 热备, 复用 handlers.dbbackup 命令构造)
async def _action_dbbackup_scheduled(params: dict):
    if not _sched_license_ok("dbbackup"):
        return {"status": "skipped", "msg": "授权档位不含 dbbackup"}
    """数据库热备定时: params = dbbackup_run 的参数 (db_type/db_host/.../dest_dir/keep_days)"""
    import asyncio as _asyncio
    try:
        from backend.handlers.dbbackup import _run_remote, _dump_cmd, _out_ext
    except ImportError:  # v6.16.20 批37 · 社区包: dbbackup 剪除 (专业档)
        return {"status": "skipped", "msg": "当前发行包未包含数据库热备模块 (专业档功能)"}
    from backend.ssh_lib import SSHTarget
    from datetime import datetime as _dt

    db_type = (params.get("db_type") or "mysql").lower()
    dest_dir = (params.get("dest_dir") or "").strip()
    if not dest_dir:
        return "[dbbackup] MISSING dest_dir"
    data = dict(params)
    target = SSHTarget.from_ws_data({"host": params.get("host") or "", "port": params.get("port") or "22",
                                     "user": params.get("user") or "root",
                                     "auth_type": params.get("auth_type") or "pass",
                                     "password": params.get("password") or ""})
    ts = _dt.now().strftime("%Y%m%d_%H%M%S")
    tag = (params.get("label") or db_type).replace("/", "_").replace(" ", "_")
    out_path = f"{dest_dir.rstrip('/')}/{tag}_{ts}{_out_ext(db_type, data)}"
    rc, _ = await _run_remote(target, f"mkdir -p {shlex.quote(dest_dir)}" if False else
                              f"mkdir -p {out_path.rsplit('/', 1)[0]}", timeout=30)
    import shlex as _shlex
    cmd = _dump_cmd(db_type, target, data, out_path)
    keep = params.get("keep_days")
    if keep:
        ext = _out_ext(db_type, data).replace(".", r"\.")
        cmd += f" ; find {dest_dir} -name '*{ext}' -mtime +{int(keep)} -type f -delete 2>/dev/null"
    rc, out = await _run_remote(target, cmd, timeout=3600)
    rc2, out2 = await _run_remote(target, f"ls -la {out_path} 2>/dev/null", timeout=15)
    ok = rc == 0 and out2.strip()
    return (f"[dbbackup {db_type}] {'ok · ' + out_path if ok else '失败: ' + (out or '')[-160:]}")

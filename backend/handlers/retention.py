"""v4.12.0 · 备份保留策略 handler

WS actions:
- retention_get           读当前用户策略 (无则返默认)
- retention_set           更新/upsert 策略
- retention_preview       预览会删掉哪些 backups (不动数据)
- retention_apply         真删 · 按当前策略清理老备份

策略语义:
- enabled: 关时其他字段不生效 (但保留)
- keep_days: 只保留 started_at >= now - keep_days 的记录 (0 = 不按天数)
- keep_count: 按 scope 分组，每组只保留最新 N 条 (0 = 不按份数)
- scope: all / auto_backup / platform_backup / rsync (对应 backups.type 字段)
- delete_files: 同时删除本地 destination 目录/文件 (小心)

两条规则叠加时：交集删除（同时超期 + 超份数才删）。
"""
import os
import json
import time
import shutil
from typing import List

from backend import db as _db


def _row_to_policy(row) -> dict:
    if not row:
        return {
            "enabled": False, "keep_days": 0, "keep_count": 0,
            "scope": "all", "delete_files": False, "auto_apply": False,
            "updated_at": None,
        }
    # 老库可能没有 auto_apply 列
    try:
        aa = bool(row["auto_apply"])
    except (KeyError, IndexError):
        aa = False
    return {
        "enabled": bool(row["enabled"]),
        "keep_days": int(row["keep_days"] or 0),
        "keep_count": int(row["keep_count"] or 0),
        "scope": row["scope"] or "all",
        "delete_files": bool(row["delete_files"]),
        "auto_apply": aa,
        "updated_at": row["updated_at"],
    }


def _get_policy(conn, user_id: int) -> dict:
    try:
        row = conn.execute(
            "SELECT enabled, keep_days, keep_count, scope, delete_files, auto_apply, updated_at "
            "FROM retention_policies WHERE user_id = ?", (user_id,)
        ).fetchone()
    except Exception as e:
        print(f"[retention] select with auto_apply failed, retry legacy: {e}")
        row = conn.execute(
            "SELECT enabled, keep_days, keep_count, scope, delete_files, updated_at "
            "FROM retention_policies WHERE user_id = ?", (user_id,)
        ).fetchone()
    return _row_to_policy(row)


def _current_user_id(ws) -> int:
    try:
        from backend.auth import active_sessions
        sess = active_sessions.get(ws) or {}
        return int(sess.get("user_id") or 1)
    except Exception as e:
        print(f"[retention] fallback user_id due to: {e}")
        return 1


async def handle_retention_get(ws, data):
    uid = _current_user_id(ws)
    conn = _db.get_conn()
    p = _get_policy(conn, uid)
    await ws.send_json({"type": "result", "status": "ok", "policy": p})


async def handle_retention_set(ws, data):
    uid = _current_user_id(ws)
    enabled = 1 if data.get("enabled") else 0
    keep_days = max(0, int(data.get("keep_days") or 0))
    keep_count = max(0, int(data.get("keep_count") or 0))
    scope = data.get("scope") or "all"
    if scope not in ("all", "auto_backup", "platform_backup", "rsync"):
        scope = "all"
    delete_files = 1 if data.get("delete_files") else 0
    auto_apply = 1 if data.get("auto_apply") else 0

    conn = _db.get_conn()
    conn.execute("""
        INSERT INTO retention_policies (user_id, enabled, keep_days, keep_count, scope, delete_files, auto_apply, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
        ON CONFLICT(user_id) DO UPDATE SET
            enabled=excluded.enabled,
            keep_days=excluded.keep_days,
            keep_count=excluded.keep_count,
            scope=excluded.scope,
            delete_files=excluded.delete_files,
            auto_apply=excluded.auto_apply,
            updated_at=excluded.updated_at
    """, (uid, enabled, keep_days, keep_count, scope, delete_files, auto_apply))
    conn.commit()
    await ws.send_json({
        "type": "result", "status": "ok", "msg": "保留策略已保存",
        "policy": _get_policy(conn, uid),
    })
    # v4.17.2 · publish retention.policy.updated
    try:
        from backend import events
        events.publish("retention.policy.updated",
                       {"user_id": uid, "enabled": bool(enabled),
                        "keep_days": keep_days, "keep_count": keep_count,
                        "scope": scope})
    except Exception as _e:
        print(f"[retention] publish fail: {_e}")


def _select_expired(conn, user_id: int, policy: dict) -> List[dict]:
    """返回将被删除的 backup 行列表 (dict)。不动数据。"""
    if not policy.get("enabled"):
        return []
    keep_days = policy["keep_days"]
    keep_count = policy["keep_count"]
    scope = policy["scope"]

    # 只考虑已完成 (finished_at not null) 的备份，且 status != running
    where = ["user_id = ?", "status != 'running'"]
    args: list = [user_id]
    if scope != "all":
        where.append("type = ?")
        args.append(scope)
    sql = (
        "SELECT id, task_id, type, source, destination, status, size_bytes, started_at, finished_at "
        "FROM backups WHERE " + " AND ".join(where) + " ORDER BY started_at DESC"
    )
    rows = [dict(r) for r in conn.execute(sql, args).fetchall()]

    victims: List[dict] = []
    seen = set()

    # 按天数
    if keep_days > 0:
        cutoff = time.time() - keep_days * 86400
        for r in rows:
            ts = _parse_ts(r["started_at"])
            if ts and ts < cutoff:
                victims.append(r); seen.add(r["id"])

    # 按份数 (按 type 分组)
    if keep_count > 0:
        groups: dict = {}
        for r in rows:
            groups.setdefault(r["type"] or "rsync", []).append(r)
        for _, grp in groups.items():
            # 已经按 started_at DESC 排序，跳过前 keep_count 条
            for r in grp[keep_count:]:
                if r["id"] not in seen:
                    victims.append(r); seen.add(r["id"])

    return victims


def _parse_ts(s: str):
    if not s:
        return None
    try:
        import datetime as _dt
        return _dt.datetime.strptime(s, "%Y-%m-%d %H:%M:%S").timestamp()
    except Exception:
        return None


async def handle_retention_preview(ws, data):
    uid = _current_user_id(ws)
    conn = _db.get_conn()
    p = _get_policy(conn, uid)
    # 允许 preview 时传入临时策略 (不落库)
    override = {}
    for k in ("enabled", "keep_days", "keep_count", "scope", "delete_files"):
        if k in data:
            override[k] = data[k]
    if override:
        p = dict(p)
        p.update({
            "enabled": bool(override.get("enabled", p["enabled"])),
            "keep_days": max(0, int(override.get("keep_days", p["keep_days"]) or 0)),
            "keep_count": max(0, int(override.get("keep_count", p["keep_count"]) or 0)),
            "scope": override.get("scope", p["scope"]),
            "delete_files": bool(override.get("delete_files", p["delete_files"])),
        })
    victims = _select_expired(conn, uid, p)
    total_size = sum((v.get("size_bytes") or 0) for v in victims)
    await ws.send_json({
        "type": "result", "status": "ok",
        "policy": p,
        "victims": victims,
        "total_count": len(victims),
        "total_size_bytes": total_size,
    })


def _apply_for_user(conn, user_id: int, policy: dict, trigger: str = "manual") -> dict:
    """核心清理逻辑 · 供 handle_retention_apply 与 scheduler auto_apply_all 共用。
    v4.13.6: 新增 trigger 参数 + 落 retention_runs 历史。"""
    import time as _time
    t0 = _time.time()
    if not policy.get("enabled"):
        return {"deleted_ids": [], "deleted_files": 0, "delete_errors": [], "bytes_freed": 0}
    victims = _select_expired(conn, user_id, policy)
    bytes_freed = sum((v.get("size_bytes") or 0) for v in victims)
    deleted_files = 0
    delete_errors: list = []
    if policy.get("delete_files"):
        for v in victims:
            path = (v.get("destination") or "").strip()
            if not path or not os.path.exists(path):
                continue
            try:
                if os.path.isdir(path):
                    shutil.rmtree(path, ignore_errors=False)
                else:
                    os.remove(path)
                deleted_files += 1
            except Exception as e:
                delete_errors.append(f"#{v['id']} {path}: {e}")
    ids = [v["id"] for v in victims]
    if ids:
        conn.executemany("DELETE FROM backups WHERE id = ?", [(i,) for i in ids])
        conn.commit()
    # v4.13.6 · 落历史
    try:
        _db.retention_run_record(
            user_id=user_id,
            trigger=trigger,
            scope=str(policy.get("scope") or "all"),
            keep_days=int(policy.get("keep_days") or 0),
            keep_count=int(policy.get("keep_count") or 0),
            deleted_records=len(ids),
            deleted_files=deleted_files,
            bytes_freed=int(bytes_freed),
            duration_ms=int((_time.time() - t0) * 1000),
            errors=delete_errors,
        )
    except Exception as e:
        print(f"[retention] run_record failed: {e}")
    return {"deleted_ids": ids, "deleted_files": deleted_files,
            "delete_errors": delete_errors, "bytes_freed": int(bytes_freed)}


def auto_apply_all() -> dict:
    """v4.13.0 · 由 scheduler 在每次任务完成后调用；
    扫描所有 enabled=1 && auto_apply=1 的策略并按 user_id 清理。
    返回聚合结果，方便打日志（不 raise）。"""
    conn = _db.get_conn()
    summary = {"users": 0, "deleted_ids": 0, "deleted_files": 0, "errors": []}
    try:
        try:
            rows = conn.execute(
                "SELECT user_id FROM retention_policies WHERE enabled=1 AND auto_apply=1"
            ).fetchall()
        except Exception as e:
            # 老库无 auto_apply 列
            print(f"[retention] auto_apply_all skipped (legacy schema): {e}")
            return summary
        for r in rows:
            uid = int(r["user_id"])
            p = _get_policy(conn, uid)
            res = _apply_for_user(conn, uid, p, trigger="auto")
            summary["users"] += 1
            summary["deleted_ids"] += len(res["deleted_ids"])
            summary["deleted_files"] += res["deleted_files"]
            # v4.17.2 · 每个 user 单独 publish 一次（有真删才发）
            if res["deleted_ids"] or res["deleted_files"]:
                try:
                    from backend import events
                    events.publish("retention.applied",
                                   {"user_id": uid, "trigger": "auto",
                                    "deleted_ids": len(res["deleted_ids"]),
                                    "deleted_files": res["deleted_files"]})
                except Exception as _e:
                    print(f"[retention] publish auto fail: {_e}")
            summary["errors"].extend(res["delete_errors"])
            if res["deleted_ids"] or res["deleted_files"]:
                print(f"[retention] auto_apply uid={uid} · records={len(res['deleted_ids'])} · files={res['deleted_files']}")
    except Exception as e:
        summary["errors"].append(f"auto_apply_all: {e}")
        print(f"[retention] auto_apply_all failed: {e}")
    return summary


async def handle_retention_apply(ws, data):
    uid = _current_user_id(ws)
    conn = _db.get_conn()
    p = _get_policy(conn, uid)
    if not p.get("enabled"):
        await ws.send_json({"type": "result", "status": "error", "msg": "保留策略未启用"})
        return
    res = _apply_for_user(conn, uid, p, trigger="manual")
    ids = res["deleted_ids"]
    await ws.send_json({
        "type": "result", "status": "ok",
        "msg": f"已清理 {len(ids)} 条备份记录 · 删除文件 {res['deleted_files']} 个",
        "deleted_ids": ids,
        "deleted_files": res["deleted_files"],
        "delete_errors": res["delete_errors"],
    })
    # v4.17.2 · publish retention.applied（含 deleted 数量 · 供 dashboard 增量刷）
    try:
        from backend import events
        events.publish("retention.applied",
                       {"user_id": uid, "trigger": "manual",
                        "deleted_ids": len(ids),
                        "deleted_files": res["deleted_files"]})
    except Exception as _e:
        print(f"[retention] publish fail: {_e}")


# v4.13.6 · 保留策略执行历史 / 统计
async def handle_retention_runs(ws, data):
    uid = _current_user_id(ws)
    limit = int(data.get("limit") or 200)
    runs = _db.retention_run_list(uid, limit=limit)
    await ws.send_json({
        "type": "result", "status": "ok",
        "runs": runs,
        "total": len(runs),
    })


async def handle_retention_stats(ws, data):
    uid = _current_user_id(ws)
    days = int(data.get("days") or 30)
    days = max(1, min(days, 365))
    stats = _db.retention_run_stats(uid, days=days)
    await ws.send_json({
        "type": "result", "status": "ok",
        "days": days,
        "buckets": stats,
    })

"""v4.15.0-alpha1 · 跨模块流程（backup_flows）DB 层

一个 flow = 「选中一批备份 → 上传到 N 个远端 → 可选挂 schedule cron」

表：
  backup_flows
    id, user_id, name, source_type (platform_backup|vzdump|manual),
    backup_ids (JSON list of backups.id), remote_ids (JSON list),
    template (backup file naming template, optional),
    schedule_id (可空 → 手动执行), enabled, created_at, updated_at

  backup_flow_runs
    id, flow_id, trigger (manual|cron), status (running|ok|partial|failed),
    started_at, finished_at, msg, uploaded_bytes, files_ok, files_fail
"""

import json
from typing import Any, Optional


def _ensure_tables(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS backup_flows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER DEFAULT 1,
            name TEXT NOT NULL,
            source_type TEXT DEFAULT 'manual',
            backup_ids TEXT DEFAULT '[]',
            remote_ids TEXT DEFAULT '[]',
            template TEXT DEFAULT '',
            schedule_id INTEGER DEFAULT NULL,
            enabled INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    # v4.15.0 GA · 补两列：rsync 源信息 + 本地目录/文件路径列表
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(backup_flows)").fetchall()}
        if "rsync_source" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN rsync_source TEXT DEFAULT ''")
        if "local_paths" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN local_paths TEXT DEFAULT '[]'")
        # v4.15.8: 压缩格式（none/tar.gz/zip）
        if "compress" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN compress TEXT DEFAULT 'none'")
        # v4.15.20 · 失败重试策略
        if "max_retries" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN max_retries INTEGER DEFAULT 0")
        if "retry_backoff" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN retry_backoff INTEGER DEFAULT 3")
        # v4.39.0 · UUID 列(若 init_db 已加则跳过)
        if "uuid" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN uuid TEXT DEFAULT ''")
        # v4.39.0 · uuid 引用列(双写过渡: backup_uuids/remote_uuids 与 backup_ids/remote_ids 共存)
        if "backup_uuids" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN backup_uuids TEXT DEFAULT '[]'")
        if "remote_uuids" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN remote_uuids TEXT DEFAULT '[]'")
        # v4.47.0 P3 · 多目标: 云存储之外的共享挂载点(share_ids)与服务器推送(server_ids)
        if "share_ids" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN share_ids TEXT DEFAULT '[]'")
        if "server_ids" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN server_ids TEXT DEFAULT '[]'")
        # v4.54.0 · 防勒索保护: 上传文件写入后 chattr +a (不可变)
        if "immutable" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN immutable INTEGER DEFAULT 0")
        # v4.95.0 · H: 条件步骤(跳过阶段) + 失败策略
        if "skip_stages" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN skip_stages TEXT DEFAULT '[]'")
        if "on_failure" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN on_failure TEXT DEFAULT 'abort'")
        # v6.3.47 · 批2(跨模块备份完整版): 多云文件管理作源 + 本地目录作目标
        #   fonr_sources: [{"storage_id": "local|ssh:<guid>|remote:<uuid>", "path": "/..."}, ...]
        #   local_dsts:   ["/backup/dir1", ...] (本机目录目标, 与 remote/share/server 并列)
        if "fonr_sources" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN fonr_sources TEXT DEFAULT '[]'")
        if "local_dsts" not in cols:
            conn.execute("ALTER TABLE backup_flows ADD COLUMN local_dsts TEXT DEFAULT '[]'")
    except Exception as e:
        print("[flows] alter add cols fail:", e)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS backup_flow_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            flow_id INTEGER NOT NULL,
            trigger TEXT DEFAULT 'manual',
            status TEXT DEFAULT 'running',
            started_at TEXT DEFAULT (datetime('now','localtime')),
            finished_at TEXT DEFAULT NULL,
            msg TEXT DEFAULT '',
            uploaded_bytes INTEGER DEFAULT 0,
            files_ok INTEGER DEFAULT 0,
            files_fail INTEGER DEFAULT 0,
            FOREIGN KEY(flow_id) REFERENCES backup_flows(id) ON DELETE CASCADE
        )
    """)
    # v4.39.0 · backup_flow_runs 加 uuid
    try:
        rcols = {r["name"] for r in conn.execute("PRAGMA table_info(backup_flow_runs)").fetchall()}
        if "uuid" not in rcols:
            conn.execute("ALTER TABLE backup_flow_runs ADD COLUMN uuid TEXT DEFAULT ''")
    except Exception:
        pass
    conn.execute("CREATE INDEX IF NOT EXISTS idx_flow_user ON backup_flows(user_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_flow_runs_fid ON backup_flow_runs(flow_id, id DESC)")
    conn.commit()


def _row_to_dict(r) -> dict:
    d = dict(r)
    if "immutable" in d:
        d["immutable"] = bool(d.get("immutable"))
    for k in ("backup_ids", "remote_ids", "local_paths", "share_ids", "server_ids", "skip_stages",
              "fonr_sources", "local_dsts"):
        try:
            v = d.get(k)
            d[k] = json.loads(v) if v not in (None, "") else []
        except Exception as e:
            print("[flows] parse", k, "fail:", e)
            d[k] = []
    # v4.39.0 · uuid 引用数组(双写过渡,可能不存在)
    for k in ("backup_uuids", "remote_uuids"):
        raw = d.get(k)
        if raw is None:
            d[k] = []
        else:
            try:
                d[k] = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                d[k] = []
    # rsync_source: 可空字符串 或 JSON
    rs = d.get("rsync_source") or ""
    if rs:
        try:
            d["rsync_source"] = json.loads(rs)
        except Exception:
            d["rsync_source"] = rs
    else:
        d["rsync_source"] = None
    return d


def flow_create(conn, user_id: int, name: str, *,
                source_type: str = "manual",
                backup_ids: Optional[list] = None,
                remote_ids: Optional[list] = None,
                template: str = "",
                schedule_id: Optional[int] = None,
                enabled: bool = True,
                rsync_source: Optional[dict] = None,
                local_paths: Optional[list] = None,
                compress: str = "none",
                max_retries: int = 0,
                retry_backoff: int = 3,
                backup_uuids: Optional[list] = None,
                remote_uuids: Optional[list] = None,
                share_ids: Optional[list] = None,
                server_ids: Optional[list] = None,
                immutable: bool = False,
                skip_stages: Optional[list] = None,
                on_failure: str = "abort",
                fonr_sources: Optional[list] = None,
                local_dsts: Optional[list] = None) -> int:
    """v4.39.0: 自动生成 uuid,支持 backup_uuids/remote_uuids 双写
    v4.47.0 P3: share_ids(共享挂载点目标)/server_ids(服务器推送目标)
    v6.3.47 批2: fonr_sources(多云文件管理作源)/local_dsts(本地目录目标)"""
    _ensure_tables(conn)
    from backend.db.uuidv7 import uuidv7 as _uuidv7
    if not name.strip():
        raise ValueError("name required")
    if (not remote_ids and not remote_uuids and not share_ids and not server_ids
            and not local_dsts):
        raise ValueError("至少选择一个目标 (本机目录 / 远端存储 / 网络共享 / 服务器)")
    if compress not in ("none", "tar.gz", "zip"):
        compress = "none"
    _uuid = _uuidv7()
    cur = conn.execute(
        "INSERT INTO backup_flows(uuid, user_id, name, source_type, backup_ids, remote_ids, "
        "template, schedule_id, enabled, rsync_source, local_paths, compress, "
        "max_retries, retry_backoff, backup_uuids, remote_uuids, share_ids, server_ids, immutable, "
        "skip_stages, on_failure, fonr_sources, local_dsts) "
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (_uuid, user_id, name.strip(), source_type,
         json.dumps(list(backup_ids or [])),
         json.dumps(list(remote_ids or [])),
         template or "",
         schedule_id if schedule_id else None,
         1 if enabled else 0,
         json.dumps(rsync_source) if rsync_source else "",
         json.dumps(list(local_paths or [])),
         compress,
         max(0, int(max_retries)),
         max(0, int(retry_backoff)),
         json.dumps(list(backup_uuids or [])),
         json.dumps(list(remote_uuids or [])),
         json.dumps([int(x) for x in (share_ids or [])]),
         # v6.3.47 · 批2: server_ids 改存字符串(guid/hostname 兼容) —— server_profiles
         #   主键是 guid, 旧 int() 强转会让 guid 一律 ValueError(自 G2 serverRows 换 guid 后
         #   flow_mini 的服务器目标其实一直存不进去)
         # v6.3.48 · 批2.1: 条目可为 {'id','dir'}(用户手选目录), 原样保留
         json.dumps([x if isinstance(x, dict) else str(x) for x in (server_ids or [])]),
         1 if immutable else 0,
         json.dumps([str(x) for x in (skip_stages or [])]),
         (on_failure or "abort") if (on_failure or "abort") in ("abort", "continue") else "abort",
         json.dumps(list(fonr_sources or [])),
         json.dumps([str(x) for x in (local_dsts or [])])),
    )
    conn.commit()
    # v4.39.0 · 注册引用关系
    _register_flow_refs(conn, _uuid, backup_uuids or [], remote_uuids or [],
                        backup_ids or [], remote_ids or [])
    return cur.lastrowid


def _register_flow_refs(conn, flow_uuid: str,
                        backup_uuids: list, remote_uuids: list,
                        backup_ids: list, remote_ids: list):
    """注册 backup_flows -> backups 和 -> remote_configs 的引用

    v4.39.0: remote_ids/backup_ids 优先(从 DB 查真实 uuid),
    防止调用方传入不存在的 uuid 导致 dangling。
    """
    from backend.db.entity_refs import register_ref as _reg
    # backup_ids 优先查 DB 获取真实 uuid
    buuids = []
    if backup_ids:
        for bid in backup_ids:
            r = conn.execute("SELECT uuid FROM backups WHERE id=?", (bid,)).fetchone()
            if r and r[0]:
                buuids.append(r[0])
    if not buuids:
        buuids = list(backup_uuids or [])
    for i, buuid in enumerate(buuids):
        if buuid:
            _reg(conn, 'backup_flows', flow_uuid, f'backup_uuids.{i}',
                 'backups', buuid, 'optional')
    # remote_ids 优先查 DB 获取真实 uuid
    ruuids = []
    if remote_ids:
        for e in remote_ids:
            rid = e.get("id") if isinstance(e, dict) else e   # v6.3.48 · {'id','dir'} 条目
            if rid is None:
                continue
            r = conn.execute("SELECT uuid FROM remote_configs WHERE id=?", (rid,)).fetchone()
            if r and r[0]:
                ruuids.append(r[0])
    if not ruuids:
        ruuids = list(remote_uuids or [])
    for i, ruuid in enumerate(ruuids):
        if ruuid:
            _reg(conn, 'backup_flows', flow_uuid, f'remote_uuids.{i}',
                 'remote_configs', ruuid, 'required')


def flow_list(conn, user_id: int = 1) -> list:
    _ensure_tables(conn)
    rows = conn.execute(
        "SELECT * FROM backup_flows WHERE user_id=? ORDER BY id DESC", (user_id,)
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def flow_get(conn, flow_id: int = None, *, uuid: Optional[str] = None) -> Optional[dict]:
    """v4.39.0: 支持 uuid 查询"""
    _ensure_tables(conn)
    if uuid:
        r = conn.execute("SELECT * FROM backup_flows WHERE uuid=?", (uuid,)).fetchone()
    else:
        r = conn.execute("SELECT * FROM backup_flows WHERE id=?", (flow_id,)).fetchone()
    return _row_to_dict(r) if r else None


def flow_update(conn, flow_id: int, **kw):
    """v4.39.0: 支持 uuid 定位,backup_uuids/remote_uuids 双写"""
    _ensure_tables(conn)
    uuid_ref = kw.pop("uuid", None)
    where_clause = "uuid=?" if uuid_ref else "id=?"
    where_arg = uuid_ref if uuid_ref else flow_id
    allowed = {"name", "source_type", "backup_ids", "remote_ids",
               "template", "schedule_id", "enabled",
               "rsync_source", "local_paths", "compress",
               "max_retries", "retry_backoff",
               "backup_uuids", "remote_uuids",
               "share_ids", "server_ids", "immutable",
               "skip_stages", "on_failure",
               "fonr_sources", "local_dsts"}
    sets, vals = [], []
    for k, v in kw.items():
        if k not in allowed:
            continue
        if k in ("backup_ids", "remote_ids", "local_paths", "backup_uuids", "remote_uuids"):
            v = json.dumps(list(v or []))
        elif k == "fonr_sources":
            v = json.dumps([dict(x) for x in (v or []) if isinstance(x, dict)])
        elif k == "local_dsts":
            v = json.dumps([str(x) for x in (v or [])])
        elif k == "skip_stages":
            v = json.dumps([str(x) for x in (v or [])])
        elif k == "share_ids":
            v = json.dumps([int(x) for x in (v or [])])
        elif k == "server_ids":
            # v6.3.47 · 批2: guid/hostname 字符串(与 flow_create 同口径, 见 INSERT 处注释)
            # v6.3.48 · 批2.1: {'id','dir'} 条目原样保留
            v = json.dumps([x if isinstance(x, dict) else str(x) for x in (v or [])])
        elif k == "enabled":
            v = 1 if v else 0
        elif k == "rsync_source":
            v = json.dumps(v) if v else ""
        elif k == "compress":
            if v not in ("none", "tar.gz", "zip"):
                v = "none"
        sets.append(f"{k}=?"); vals.append(v)
    if not sets:
        return 0
    sets.append("updated_at=datetime('now','localtime')")
    vals.append(where_arg)
    cur = conn.execute(
        f"UPDATE backup_flows SET {','.join(sets)} WHERE {where_clause}", vals
    )
    conn.commit()
    # v4.39.0 · 更新引用关系(若改了 backup_uuids/remote_uuids)
    if "backup_uuids" in kw or "remote_uuids" in kw:
        real_uuid = uuid_ref
        if not real_uuid:
            row = conn.execute("SELECT uuid FROM backup_flows WHERE id=?", (flow_id,)).fetchone()
            real_uuid = row[0] if row else None
        if real_uuid:
            from backend.db.entity_refs import unregister_ref
            # 清旧引用
            conn.execute(
                "DELETE FROM entity_refs WHERE source_table='backup_flows' AND source_uuid=?",
                (real_uuid,)
            )
            # 注册新引用
            _register_flow_refs(conn, real_uuid,
                                kw.get("backup_uuids", []),
                                kw.get("remote_uuids", []),
                                kw.get("backup_ids", []),
                                kw.get("remote_ids", []))
    return cur.rowcount


def flow_duplicate(conn, flow_id: int, new_name: Optional[str] = None, *, uuid: Optional[str] = None) -> int:
    """v4.15.21 · 复制一个 flow（不复制 run 历史；schedule_id 置空避免多重触发）。
    v4.39.0: 支持 uuid 定位"""
    _ensure_tables(conn)
    from backend.db.uuidv7 import uuidv7 as _uuidv7
    if uuid:
        src = conn.execute("SELECT * FROM backup_flows WHERE uuid=?", (uuid,)).fetchone()
    else:
        src = conn.execute("SELECT * FROM backup_flows WHERE id=?", (flow_id,)).fetchone()
    if not src:
        raise ValueError(f"flow {flow_id} not found")
    s = dict(src)
    name = (new_name or (s.get("name") or "") + " (副本)").strip() or "副本"
    _uuid = _uuidv7()
    cur = conn.execute(
        "INSERT INTO backup_flows(uuid, user_id, name, source_type, backup_ids, remote_ids, "
        "template, schedule_id, enabled, rsync_source, local_paths, compress, "
        "max_retries, retry_backoff, backup_uuids, remote_uuids, share_ids, server_ids, immutable) "
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (_uuid, s.get("user_id") or 1, name, s.get("source_type") or "manual",
         s.get("backup_ids") or "[]", s.get("remote_ids") or "[]",
         s.get("template") or "",
         None,  # schedule_id 置空
         0,     # 默认禁用，避免复制后立刻触发
         s.get("rsync_source") or "", s.get("local_paths") or "[]",
         s.get("compress") or "none",
         int(s.get("max_retries") or 0), int(s.get("retry_backoff") or 3),
         s.get("backup_uuids") or "[]", s.get("remote_uuids") or "[]",
         s.get("share_ids") or "[]", s.get("server_ids") or "[]",
         s.get("immutable") or 0),
    )
    conn.commit()
    return cur.lastrowid


def flow_delete(conn, flow_id: int, *, uuid: Optional[str] = None):
    """v4.39.0: 支持 uuid 定位删除,自动清理引用注册表"""
    _ensure_tables(conn)
    where_clause = "uuid=?" if uuid else "id=?"
    where_arg = uuid if uuid else flow_id
    # 先查出 id 和 uuid
    row = conn.execute(f"SELECT id, uuid FROM backup_flows WHERE {where_clause}", (where_arg,)).fetchone()
    if not row:
        return
    fid, fuuid = row[0], row[1]
    conn.execute("DELETE FROM backup_flow_runs WHERE flow_id=?", (fid,))
    conn.execute("DELETE FROM backup_flows WHERE id=?", (fid,))
    # 清理发出的引用
    if fuuid:
        conn.execute(
            "DELETE FROM entity_refs WHERE source_table='backup_flows' AND source_uuid=?",
            (fuuid,)
        )
    conn.commit()


def flow_run_create(conn, flow_id: int, trigger: str = "manual") -> int:
    """v4.39.0: 自动生成 uuid"""
    _ensure_tables(conn)
    from backend.db.uuidv7 import uuidv7 as _uuidv7
    _uuid = _uuidv7()
    try:
        cur = conn.execute(
            "INSERT INTO backup_flow_runs(uuid, flow_id, trigger) VALUES (?, ?, ?)",
            (_uuid, flow_id, trigger),
        )
    except Exception:
        cur = conn.execute(
            "INSERT INTO backup_flow_runs(flow_id, trigger) VALUES (?, ?)",
            (flow_id, trigger),
        )
    conn.commit()
    return cur.lastrowid


def flow_run_finish(conn, run_id: int, status: str, *,
                    msg: str = "", uploaded_bytes: int = 0,
                    files_ok: int = 0, files_fail: int = 0):
    conn.execute(
        "UPDATE backup_flow_runs SET status=?, finished_at=datetime('now','localtime'), "
        "msg=?, uploaded_bytes=?, files_ok=?, files_fail=? WHERE id=?",
        (status, msg, uploaded_bytes, files_ok, files_fail, run_id),
    )
    conn.commit()


def flow_run_list(conn, flow_id: int, limit: int = 50) -> list:
    _ensure_tables(conn)
    rows = conn.execute(
        "SELECT * FROM backup_flow_runs WHERE flow_id=? ORDER BY id DESC LIMIT ?",
        (flow_id, int(limit)),
    ).fetchall()
    return [dict(r) for r in rows]


def flow_run_recent(conn, user_id: int = 1, limit: int = 30) -> list:
    """跨 flow 的最近运行（供总览页用）"""
    _ensure_tables(conn)
    rows = conn.execute(
        "SELECT r.*, f.name AS flow_name FROM backup_flow_runs r "
        "JOIN backup_flows f ON f.id = r.flow_id "
        "WHERE f.user_id=? ORDER BY r.id DESC LIMIT ?",
        (user_id, int(limit)),
    ).fetchall()
    return [dict(x) for x in rows]


# v4.15.25 · flow 运行统计（Dashboard 报表）
def flow_run_stats(conn, user_id: int = 1, days: int = 30, flow_id=None) -> dict:
    """
    汇总近 N 天的 flow 运行数据，供 Dashboard 可视化。

    v4.15.32 · 可选 flow_id：只统计单个 flow（用于 Flow 详情页运行报表卡片）
    """
    _ensure_tables(conn)
    d = max(1, int(days))
    window = f"-{d} days"

    # v4.15.32 · flow_id 可选过滤（用于 flow 详情页）
    fid_filter = ""
    fid_params = ()
    if flow_id is not None:
        fid_filter = " AND r.flow_id = ?"
        fid_params = (int(flow_id),)

    # 汇总
    row = conn.execute(f"""
        SELECT
          COUNT(*)                                       AS total_runs,
          COALESCE(SUM(CASE WHEN r.status='ok'   THEN 1 ELSE 0 END), 0) AS ok_runs,
          COALESCE(SUM(CASE WHEN r.status='fail' OR r.status='error' THEN 1 ELSE 0 END), 0) AS fail_runs,
          COALESCE(SUM(r.uploaded_bytes), 0)             AS total_bytes,
          AVG( CASE WHEN r.finished_at IS NOT NULL
                    THEN (julianday(r.finished_at) - julianday(r.started_at)) * 86400.0
                    ELSE NULL END )                     AS avg_sec
        FROM backup_flow_runs r
        JOIN backup_flows f ON f.id = r.flow_id
        WHERE f.user_id = ?
          AND r.started_at >= datetime('now', ?, 'localtime')
          {fid_filter}
    """, (user_id, window) + fid_params).fetchone()
    total_runs = int(row["total_runs"] or 0)
    ok_runs    = int(row["ok_runs"] or 0)
    fail_runs  = int(row["fail_runs"] or 0)
    total_bytes = int(row["total_bytes"] or 0)
    avg_sec    = round(float(row["avg_sec"] or 0.0), 2)

    # 按天
    by_day_rows = conn.execute(f"""
        SELECT date(r.started_at) AS d,
               COALESCE(SUM(CASE WHEN r.status='ok'   THEN 1 ELSE 0 END), 0) AS ok,
               COALESCE(SUM(CASE WHEN r.status='fail' OR r.status='error' THEN 1 ELSE 0 END), 0) AS fail,
               COALESCE(SUM(r.uploaded_bytes), 0) AS bytes
        FROM backup_flow_runs r
        JOIN backup_flows f ON f.id = r.flow_id
        WHERE f.user_id = ?
          AND r.started_at >= datetime('now', ?, 'localtime')
          {fid_filter}
        GROUP BY date(r.started_at)
        ORDER BY d ASC
    """, (user_id, window) + fid_params).fetchall()
    by_day = [{"date": r["d"] or "", "ok": int(r["ok"] or 0),
               "fail": int(r["fail"] or 0), "bytes": int(r["bytes"] or 0)}
              for r in by_day_rows]

    # TOP 慢 flow（按 avg_sec 排序 · 只统计完成的）
    top_slow_rows = conn.execute(f"""
        SELECT r.flow_id,
               f.name AS flow_name,
               COUNT(*) AS runs,
               AVG( (julianday(r.finished_at) - julianday(r.started_at)) * 86400.0 ) AS avg_sec
        FROM backup_flow_runs r
        JOIN backup_flows f ON f.id = r.flow_id
        WHERE f.user_id = ?
          AND r.started_at  >= datetime('now', ?, 'localtime')
          AND r.finished_at IS NOT NULL
          {fid_filter}
        GROUP BY r.flow_id, f.name
        HAVING avg_sec IS NOT NULL
        ORDER BY avg_sec DESC
        LIMIT 5
    """, (user_id, window) + fid_params).fetchall()
    top_slow = [{"flow_id": int(r["flow_id"] or 0),
                 "flow_name": r["flow_name"] or "",
                 "runs": int(r["runs"] or 0),
                 "avg_sec": round(float(r["avg_sec"] or 0.0), 2)}
                for r in top_slow_rows]

    # TOP 字节 flow
    top_bytes_rows = conn.execute(f"""
        SELECT r.flow_id,
               f.name AS flow_name,
               COUNT(*) AS runs,
               COALESCE(SUM(r.uploaded_bytes), 0) AS bytes
        FROM backup_flow_runs r
        JOIN backup_flows f ON f.id = r.flow_id
        WHERE f.user_id = ?
          AND r.started_at >= datetime('now', ?, 'localtime')
          {fid_filter}
        GROUP BY r.flow_id, f.name
        HAVING bytes > 0
        ORDER BY bytes DESC
        LIMIT 5
    """, (user_id, window) + fid_params).fetchall()
    top_bytes = [{"flow_id": int(r["flow_id"] or 0),
                  "flow_name": r["flow_name"] or "",
                  "runs": int(r["runs"] or 0),
                  "bytes": int(r["bytes"] or 0)}
                 for r in top_bytes_rows]

    return {
        "days": d,
        "flow_id": int(flow_id) if flow_id is not None else None,
        "total_runs": total_runs,
        "ok_runs": ok_runs,
        "fail_runs": fail_runs,
        "total_bytes": total_bytes,
        "avg_sec": avg_sec,
        "by_day": by_day,
        "top_slow": top_slow,
        "top_bytes": top_bytes,
    }

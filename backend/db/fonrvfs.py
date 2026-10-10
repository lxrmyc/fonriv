"""FonrVFS 数据层 (v5.40.0 P0): 上传会话 / 后台任务 / 收藏。

设计: 与 db/remotes.py 同风格 —— 纯函数, 由 db/__init__.py 门面注入 conn。
- fonr_upload_session: 分片上传断点续传状态 (upload_id / 已传分片 / 校验和)
- fonr_job: 后台任务落盘 (刷新/重启后仍可看到历史)
- fonr_favorite: 收藏路径 (左侧树"收藏"节)
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional


# ============ 上传会话 ============

def session_create(conn, user_id: int, *, storage_id: str, dst_path: str,
                   local_path: str, size: int, sha256: str = "",
                   upload_id: str = "", part_size: int = 0,
                   job_id: str = "") -> str:
    sid = "us_%d_%s" % (int(time.time() * 1000), abs(hash(dst_path)) % 100000)
    conn.execute("""
        INSERT INTO fonr_upload_session
        (sid, user_id, storage_id, dst_path, local_path, size, sha256,
         upload_id, part_size, job_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now','localtime'))
    """, (sid, user_id, storage_id, dst_path, local_path, int(size or 0), sha256 or "",
          upload_id or "", int(part_size or 0), job_id or ""))
    conn.commit()
    return sid


def session_get(conn, sid: str) -> Optional[dict]:
    row = conn.execute("SELECT * FROM fonr_upload_session WHERE sid=?", (sid,)).fetchone()
    return dict(row) if row else None


def session_update(conn, sid: str, **fields: Any) -> None:
    allowed = ("upload_id", "part_size", "status", "sha256", "job_id", "size", "dst_path")
    sets, vals = [], []
    for k, v in fields.items():
        if k in allowed:
            sets.append("%s=?" % k)
            vals.append(v)
    if not sets:
        return
    sets.append("updated_at=datetime('now','localtime')")
    vals.append(sid)
    conn.execute("UPDATE fonr_upload_session SET %s WHERE sid=?" % ", ".join(sets), vals)
    conn.commit()


def session_list(conn, user_id: int = 1, *, status: str = "", limit: int = 50) -> List[dict]:
    sql = "SELECT * FROM fonr_upload_session WHERE user_id=?"
    args: List[Any] = [user_id]
    if status:
        sql += " AND status=?"
        args.append(status)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(int(limit))
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def session_delete(conn, sid: str) -> None:
    conn.execute("DELETE FROM fonr_upload_session WHERE sid=?", (sid,))
    conn.commit()


# ============ 回收站 (P2) ============

def trash_add(conn, storage_id: str, orig_path: str, trash_path: str, name: str = "",
              is_dir: bool = False, size: int = 0, deleted_by: str = "",
              note: str = "", ttl_days: int = 30) -> int:
    now = time.time()
    expires = now + ttl_days * 86400 if ttl_days else 0
    cur = conn.execute("""
        INSERT INTO fonr_trash (storage_id, orig_path, trash_path, name, is_dir, size,
                                deleted_by, deleted_at, expires_at, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (storage_id, orig_path, trash_path, name or "", 1 if is_dir else 0, int(size or 0),
          deleted_by or "", now, expires, note or ""))
    conn.commit()
    return int(cur.lastrowid or 0)


def trash_list(conn, storage_id: str = "", limit: int = 500) -> List[dict]:
    if storage_id:
        rows = conn.execute("SELECT * FROM fonr_trash WHERE storage_id=? AND restored_at=0 "
                            "ORDER BY deleted_at DESC LIMIT ?", (storage_id, int(limit))).fetchall()
    else:
        rows = conn.execute("SELECT * FROM fonr_trash WHERE restored_at=0 "
                            "ORDER BY deleted_at DESC LIMIT ?", (int(limit),)).fetchall()
    return [dict(r) for r in rows]


def trash_get(conn, tid: int) -> Optional[dict]:
    row = conn.execute("SELECT * FROM fonr_trash WHERE id=?", (int(tid),)).fetchone()
    return dict(row) if row else None


def trash_mark_restored(conn, tid: int) -> None:
    conn.execute("UPDATE fonr_trash SET restored_at=? WHERE id=?", (time.time(), int(tid)))
    conn.commit()


def trash_delete(conn, tid: int) -> None:
    conn.execute("DELETE FROM fonr_trash WHERE id=?", (int(tid),))
    conn.commit()


def trash_expired(conn, limit: int = 200) -> List[dict]:
    rows = conn.execute("SELECT * FROM fonr_trash WHERE restored_at=0 AND expires_at>0 "
                        "AND expires_at < ? ORDER BY deleted_at ASC LIMIT ?",
                        (time.time(), int(limit))).fetchall()
    return [dict(r) for r in rows]


# ============ 治理: ACL / 配额 / 用量 (P3 · v5.47.0) ============

def acl_list(conn, storage_id: str = "") -> List[dict]:
    if storage_id:
        rows = conn.execute("SELECT * FROM fonr_acl WHERE storage_id=? "
                            "ORDER BY subject ASC, path_prefix ASC", (storage_id,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM fonr_acl ORDER BY storage_id ASC, subject ASC").fetchall()
    return [dict(r) for r in rows]


def acl_set(conn, storage_id: str, subject: str, perms: int,
            path_prefix: str = "", note: str = "") -> int:
    cur = conn.execute("""
        INSERT INTO fonr_acl (storage_id, subject, perms, path_prefix, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(storage_id, subject, path_prefix)
        DO UPDATE SET perms=excluded.perms, note=excluded.note
    """, (storage_id, subject, int(perms), path_prefix or "", note or "", time.time()))
    conn.commit()
    if cur.lastrowid:
        return int(cur.lastrowid)
    row = conn.execute("SELECT id FROM fonr_acl WHERE storage_id=? AND subject=? AND path_prefix=?",
                       (storage_id, subject, path_prefix or "")).fetchone()
    return int(row["id"]) if row else 0


def acl_delete(conn, acl_id: int = 0, storage_id: str = "") -> int:
    if acl_id:
        cur = conn.execute("DELETE FROM fonr_acl WHERE id=?", (int(acl_id),))
    else:
        cur = conn.execute("DELETE FROM fonr_acl WHERE storage_id=?", (storage_id,))
    conn.commit()
    return cur.rowcount or 0


def quota_get(conn, storage_id: str) -> dict:
    row = conn.execute("SELECT * FROM fonr_quota WHERE storage_id=?", (storage_id,)).fetchone()
    return dict(row) if row else {}


def quota_set(conn, storage_id: str, max_bytes: int = 0, max_files: int = 0,
              warn_pct: int = 90) -> None:
    conn.execute("""
        INSERT INTO fonr_quota (storage_id, max_bytes, max_files, warn_pct, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(storage_id) DO UPDATE SET max_bytes=excluded.max_bytes,
            max_files=excluded.max_files, warn_pct=excluded.warn_pct,
            updated_at=excluded.updated_at
    """, (storage_id, int(max_bytes or 0), int(max_files or 0), int(warn_pct or 90), time.time()))
    conn.commit()


def usage_get(conn, storage_id: str) -> dict:
    row = conn.execute("SELECT * FROM fonr_usage WHERE storage_id=?", (storage_id,)).fetchone()
    return dict(row) if row else {}


def usage_set(conn, storage_id: str, bytes: int = 0, files: int = 0, dirs: int = 0,
              partial: int = 0) -> None:
    conn.execute("""
        INSERT INTO fonr_usage (storage_id, bytes, files, dirs, scanned_at, partial)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(storage_id) DO UPDATE SET bytes=excluded.bytes, files=excluded.files,
            dirs=excluded.dirs, scanned_at=excluded.scanned_at, partial=excluded.partial
    """, (storage_id, int(bytes or 0), int(files or 0), int(dirs or 0), time.time(),
          int(partial or 0)))
    conn.commit()


def usage_add(conn, storage_id: str, dbytes: int = 0, dfiles: int = 0, ddirs: int = 0) -> None:
    """增量更新 (首次写入时按 0 起算, 之后视为"至少这么多"的增量统计)。"""
    row = conn.execute("SELECT 1 FROM fonr_usage WHERE storage_id=?", (storage_id,)).fetchone()
    if not row:
        usage_set(conn, storage_id, max(0, int(dbytes or 0)), max(0, int(dfiles or 0)),
                  max(0, int(ddirs or 0)))
        return
    conn.execute("""
        UPDATE fonr_usage SET bytes=MAX(0, bytes + ?), files=MAX(0, files + ?),
            dirs=MAX(0, dirs + ?) WHERE storage_id=?
    """, (int(dbytes or 0), int(dfiles or 0), int(ddirs or 0), storage_id))
    conn.commit()


# ============ 操作审计 (P2 剩余) ============

AUDIT_KEEP = 20000


def audit_add(conn, action: str, *, user: str = "", storage_id: str = "", path: str = "",
              detail: str = "", result: str = "ok") -> int:
    cur = conn.execute("""
        INSERT INTO fonr_audit (ts, user, action, storage_id, path, detail, result)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (time.time(), user or "", action, storage_id or "", path or "", detail or "",
          result or "ok"))
    conn.commit()
    return int(cur.lastrowid or 0)


def audit_list(conn, *, user: str = "", action: str = "", storage_id: str = "",
               since: float = 0, limit: int = 200) -> List[dict]:
    sql = "SELECT * FROM fonr_audit WHERE 1=1"
    args: List[Any] = []
    if user:
        sql += " AND user=?"
        args.append(user)
    if action:
        sql += " AND action=?"
        args.append(action)
    if storage_id:
        sql += " AND storage_id=?"
        args.append(storage_id)
    if since:
        sql += " AND ts>=?"
        args.append(float(since))
    sql += " ORDER BY ts DESC LIMIT ?"
    args.append(int(limit))
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def audit_count(conn) -> int:
    row = conn.execute("SELECT COUNT(*) AS n FROM fonr_audit").fetchone()
    return int(row["n"]) if row else 0


def audit_trim(conn, keep: int = AUDIT_KEEP) -> int:
    cur = conn.execute("DELETE FROM fonr_audit WHERE id NOT IN "
                       "(SELECT id FROM fonr_audit ORDER BY ts DESC LIMIT ?)", (int(keep),))
    conn.commit()
    return cur.rowcount or 0


def audit_purge(conn, before_ts: float) -> int:
    cur = conn.execute("DELETE FROM fonr_audit WHERE ts < ?", (float(before_ts),))
    conn.commit()
    return cur.rowcount or 0


# ============ 分享链接 (P2) ============

def share_add(conn, rec: dict) -> None:
    conn.execute("""
        INSERT INTO fonr_share (token, storage_id, path, name, size, is_dir, created_by,
                                created_at, expires_at, max_downloads, downloads, pw_hash,
                                note, revoked, perm, max_viewers)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (rec["token"], rec["storage_id"], rec["path"], rec.get("name", ""),
          int(rec.get("size") or 0), int(rec.get("is_dir") or 0), rec.get("created_by", ""),
          float(rec.get("created_at") or time.time()), float(rec.get("expires_at") or 0),
          int(rec.get("max_downloads") or 0), int(rec.get("downloads") or 0),
          rec.get("pw_hash", ""), rec.get("note", ""), int(rec.get("revoked") or 0),
          rec.get("perm") or "preview_download", int(rec.get("max_viewers") or 0)))
    conn.commit()


def share_list(conn, limit: int = 200) -> List[dict]:
    rows = conn.execute("SELECT * FROM fonr_share ORDER BY created_at DESC LIMIT ?",
                        (int(limit),)).fetchall()
    return [dict(r) for r in rows]


def share_get(conn, token: str) -> Optional[dict]:
    row = conn.execute("SELECT * FROM fonr_share WHERE token=?", (token,)).fetchone()
    return dict(row) if row else None


def share_hit(conn, token: str, ip: str = "", ua: str = "") -> None:
    """v5.99.0 · 记一次访问: 下载计数 + 访客台账(按 token+ip 去重, 供人数上限与审计)。

    用 SELECT→UPDATE/INSERT 而不是 SQLite 的 upsert 语法: 银河麒麟 V10 那批老系统自带的
    SQLite 可能低于 3.24(2018 才有 ON CONFLICT DO UPDATE), 老语法在所有版本都能跑。
    """
    now = time.time()
    conn.execute("UPDATE fonr_share SET downloads=downloads+1 WHERE token=?", (token,))
    if ip:
        row = conn.execute("SELECT hits FROM fonr_share_visitor WHERE token=? AND ip=?",
                           (token, ip)).fetchone()
        if row:
            conn.execute("UPDATE fonr_share_visitor SET last_at=?, hits=hits+1, "
                         "ua=CASE WHEN ? <> '' THEN ? ELSE ua END WHERE token=? AND ip=?",
                         (now, (ua or "")[:200], (ua or "")[:200], token, ip))
        else:
            conn.execute("INSERT INTO fonr_share_visitor (token, ip, first_at, last_at, hits, ua) "
                         "VALUES (?, ?, ?, ?, 1, ?)", (token, ip, now, now, (ua or "")[:200]))
    conn.commit()


def share_visitors(conn, token: str, limit: int = 200) -> List[dict]:
    rows = conn.execute("SELECT ip, first_at, last_at, hits, ua FROM fonr_share_visitor "
                        "WHERE token=? ORDER BY first_at ASC LIMIT ?",
                        (token, int(limit))).fetchall()
    return [dict(r) for r in rows]


def share_visitor_ips(conn, token: str) -> List[str]:
    rows = conn.execute("SELECT ip FROM fonr_share_visitor WHERE token=?", (token,)).fetchall()
    return [r["ip"] for r in rows]


def share_find_recent(conn, storage_id: str, path: str, created_by: str,
                      within_sec: float = 15.0, perm: str = "", max_downloads: int = 0,
                      has_password: bool = False) -> Optional[dict]:
    """v5.99.0 · 幂等去重: 同一份文件**刚刚**建过同参数的分享就复用, 不再插新行。

    用户报「只分享了一次, 分享管理里却出现 3 条一样」—— 重复点击/请求重试都会落到这里。
    """
    since = time.time() - float(within_sec or 0)
    row = conn.execute("""
        SELECT * FROM fonr_share
         WHERE storage_id=? AND path=? AND created_by=? AND revoked=0
           AND created_at >= ? AND COALESCE(perm,'preview_download')=?
           AND COALESCE(max_downloads,0)=?
           AND (CASE WHEN COALESCE(pw_hash,'')='' THEN 0 ELSE 1 END)=?
         ORDER BY created_at DESC LIMIT 1
    """, (storage_id, path, created_by or "", since, perm or "preview_download",
          int(max_downloads or 0), 1 if has_password else 0)).fetchone()
    return dict(row) if row else None


def share_visit(conn, token: str, ip: str = "", ua: str = "") -> None:
    """v5.99.0 · 只记访客台账(不带下载计数)。人数上限就是按这张表里"不同 IP 的个数"判定的,
    所以**打开链接本身就要记**(不是只有下载才记), 否则上限形同虚设。"""
    if not ip:
        return
    now = time.time()
    row = conn.execute("SELECT hits FROM fonr_share_visitor WHERE token=? AND ip=?",
                       (token, ip)).fetchone()
    if row:
        conn.execute("UPDATE fonr_share_visitor SET last_at=?, hits=?, ua=? WHERE token=? AND ip=?",
                     (now, int(row["hits"] or 0) + 1, ua or "", token, ip))
    else:
        conn.execute("INSERT INTO fonr_share_visitor (token, ip, first_at, last_at, hits, ua)"
                     " VALUES (?,?,?,?,?,?)", (token, ip, now, now, 1, ua or ""))
    conn.commit()


def share_revoke(conn, token: str) -> bool:
    cur = conn.execute("UPDATE fonr_share SET revoked=1 WHERE token=?", (token,))
    conn.commit()
    return bool(cur.rowcount)


def share_delete(conn, token: str) -> bool:
    """v5.99.0 · 硬删除一条分享(连同访客台账)。"""
    cur = conn.execute("DELETE FROM fonr_share WHERE token=?", (token,))
    conn.execute("DELETE FROM fonr_share_visitor WHERE token=?", (token,))
    conn.commit()
    return bool(cur.rowcount)


def share_purge_all(conn, include_active: bool = False) -> int:
    """v5.99.0 · 清空分享: 默认只清「已撤销或已过期」, include_active=True 时全清。"""
    now = time.time()
    if include_active:
        cur = conn.execute("DELETE FROM fonr_share")
        conn.execute("DELETE FROM fonr_share_visitor")
    else:
        tokens = [r["token"] for r in conn.execute(
            "SELECT token FROM fonr_share WHERE revoked=1 OR (expires_at>0 AND expires_at < ?)",
            (now,)).fetchall()]
        cur = conn.execute("DELETE FROM fonr_share WHERE revoked=1 OR (expires_at>0 AND expires_at < ?)",
                           (now,))
        for t in tokens:
            conn.execute("DELETE FROM fonr_share_visitor WHERE token=?", (t,))
    conn.commit()
    return cur.rowcount or 0


def share_purge_expired(conn, limit: int = 200) -> int:
    cur = conn.execute("DELETE FROM fonr_share WHERE expires_at>0 AND expires_at < ? AND revoked=0",
                       (time.time(),))
    conn.commit()
    return cur.rowcount or 0


# ============ 设置键 (P2) ============

def setting_get(conn, k: str, default: str = "") -> str:
    row = conn.execute("SELECT v FROM fonr_setting WHERE k=?", (k,)).fetchone()
    return row["v"] if row else default


def setting_set(conn, k: str, v: str) -> None:
    conn.execute("INSERT INTO fonr_setting (k, v, updated_at) VALUES (?, ?, ?) "
                 "ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at",
                 (k, str(v), time.time()))
    conn.commit()


# ============ 最近访问 (P1) ============

RECENT_KEEP = 500


def recent_touch(conn, user_id: int, storage_id: str, path: str, name: str = "",
                 kind: str = "", size: int = 0) -> None:
    ts = time.time()
    conn.execute("""
        INSERT INTO fonr_recent (user_id, storage_id, path, name, kind, size, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, storage_id, path) DO UPDATE SET ts=excluded.ts,
            name=excluded.name, kind=excluded.kind, size=excluded.size
    """, (int(user_id), storage_id, path, name or "", kind or "", int(size or 0), ts))
    # 只保留最近 RECENT_KEEP 条
    conn.execute("""
        DELETE FROM fonr_recent WHERE user_id=? AND id NOT IN (
            SELECT id FROM fonr_recent WHERE user_id=? ORDER BY ts DESC LIMIT ?
        )
    """, (int(user_id), int(user_id), RECENT_KEEP))
    conn.commit()


def recent_list(conn, user_id: int = 1, limit: int = 50) -> List[dict]:
    rows = conn.execute(
        "SELECT * FROM fonr_recent WHERE user_id=? ORDER BY ts DESC LIMIT ?",
        (int(user_id), int(limit))).fetchall()
    return [dict(r) for r in rows]


def recent_delete(conn, user_id: int = 1, storage_id: str = "", path: str = "") -> int:
    cur = conn.execute("DELETE FROM fonr_recent WHERE user_id=? AND storage_id=? AND path=?",
                       (int(user_id), storage_id, path))
    conn.commit()
    return cur.rowcount or 0


def recent_clear(conn, user_id: int = 1, storage_id: str = "") -> int:
    if storage_id:
        cur = conn.execute("DELETE FROM fonr_recent WHERE user_id=? AND storage_id=?",
                           (int(user_id), storage_id))
    else:
        cur = conn.execute("DELETE FROM fonr_recent WHERE user_id=?", (int(user_id),))
    conn.commit()
    return cur.rowcount or 0


# ============ 后台任务 ============

def job_create(conn, job: dict) -> None:
    conn.execute("""
        INSERT OR REPLACE INTO fonr_job
        (id, kind, title, storage_id, path, total, done, status, msg, error,
         speed, created_at, updated_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (job.get("id"), job.get("kind"), job.get("title"), job.get("storage_id"),
          job.get("path"), int(job.get("total") or 0), int(job.get("done") or 0),
          job.get("status") or "running", job.get("msg") or "", job.get("error") or "",
          float(job.get("speed") or 0), float(job.get("created_at") or time.time()),
          float(job.get("updated_at") or time.time()), float(job.get("finished_at") or 0)))
    conn.commit()


def job_update(conn, job: dict) -> None:
    job_create(conn, job)   # INSERT OR REPLACE 语义一致


def job_list(conn, limit: int = 100) -> List[dict]:
    rows = conn.execute(
        "SELECT * FROM fonr_job ORDER BY created_at DESC LIMIT ?", (int(limit),)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["cancel_requested"] = False
        d["meta"] = {}
        out.append(d)
    return out


def job_get(conn, jid: str) -> Optional[dict]:
    row = conn.execute("SELECT * FROM fonr_job WHERE id=?", (jid,)).fetchone()
    return dict(row) if row else None


# v6.8.0 · 批8: 任务删除/清除(用户要求卡死任务可彻底删除 —— 内存清了 DB 也要清,
#   否则刷新/重启后列表里"幽灵"重现)
def job_delete(conn, jid: str) -> int:
    cur = conn.execute("DELETE FROM fonr_job WHERE id=?", (jid,))
    return cur.rowcount


def job_delete_by_status(conn, statuses) -> int:
    st = list(statuses or [])
    if not st:
        return 0
    q = "DELETE FROM fonr_job WHERE status IN (%s)" % ",".join("?" * len(st))
    return conn.execute(q, st).rowcount


# ============ 收藏 ============

def fav_list(conn, user_id: int = 1) -> List[dict]:
    rows = conn.execute(
        "SELECT * FROM fonr_favorite WHERE user_id=? ORDER BY sort_order ASC, id ASC",
        (user_id,)).fetchall()
    return [dict(r) for r in rows]


def fav_save(conn, user_id: int, *, storage_id: str, path: str, label: str = "",
             icon: str = "⭐") -> int:
    cur = conn.execute("""
        INSERT INTO fonr_favorite (user_id, storage_id, path, label, icon, sort_order)
        VALUES (?, ?, ?, ?, ?, 0)
    """, (user_id, storage_id, path, label or path, icon))
    conn.commit()
    return cur.lastrowid


def fav_delete(conn, fid: int) -> None:
    conn.execute("DELETE FROM fonr_favorite WHERE id=?", (int(fid),))
    conn.commit()

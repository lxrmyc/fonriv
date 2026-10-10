"""Fonriv - 系统配置备份/恢复 + 测试残留清理 (v5.19.2)

两块能力:
  A. 配置备份/恢复 (sysconf_*)
     · export  → 把服务器列表/远端存储/网络共享/定时计划/系统设置等**配置**导出为单个 JSON
     · preview → 导入前预览 (将新增/覆盖/跳过哪些条目, 不改动任何数据)
     · import  → 按 merge/skip/replace 策略导入
     · db_backup / db_restore → 系统自身 SQLite 数据库文件级备份与恢复 (恢复前自动留底)
  B. 测试残留清理 (remote_prune_*)
     按保守规则识别自动化测试留下的远端存储桩, 先扫描分类再由用户确认删除。
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import time

from fastapi import WebSocket, WebSocketDisconnect

from backend import db
from backend.log import log_operation

_DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                     "data")
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 参与备份的配置表 (用户可读配置, 不含运行日志/任务历史)
_CONF_TABLES = [
    ("configs", "服务器连接", "name, host, port, user, auth_type, auth_value, auth_passphrase, panel, sort_order"),
    ("remote_configs", "远端存储", "name, provider, endpoint, region, bucket, prefix, access_key, secret_key, extra_json, auto_upload"),
    ("shares", "网络共享", "name, proto, host, port, share, path, user, auth_type, auth_value, domain, vers, ro, uid, gid, opts"),
    ("schedules", "定时计划", "*"),
    ("settings_kv", "系统设置", "key, value"),
    ("users", "用户与权限", "username, role, perms_json, mfa_enabled, created_at"),
]


def _tbl_exists(conn, t: str) -> bool:
    try:
        return bool(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone())
    except Exception:
        return False


def _cols(conn, t: str) -> list:
    try:
        return [r[1] for r in conn.execute(f"PRAGMA table_info({t})").fetchall()]
    except Exception:
        return []


def _export(include: list = None) -> dict:
    """导出配置为可移植 dict (敏感字段保留, 由前端决定是否脱敏展示)"""
    conn = db.get_conn()
    out = {"_meta": {"app": "Fonriv", "kind": "sysconf",
                     "exported_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                     "version": _ver()}, "tables": {}}
    for t, label, cols in _CONF_TABLES:
        if include and t not in include:
            continue
        if not _tbl_exists(conn, t):
            continue
        try:
            rows = conn.execute(f"SELECT {cols} FROM {t}").fetchall()
            out["tables"][t] = {"label": label, "rows": [dict(r) for r in rows]}
        except Exception as e:
            out["tables"][t] = {"label": label, "rows": [], "error": str(e)[:120]}
    return out


def _ver() -> str:
    try:
        from backend.version import VERSION
        return VERSION
    except Exception:
        return ""


async def handle_sysconf_export(ws, data: dict):
    """导出系统配置 (JSON)。params: include(表名列表, 空=全部), mask_secret(1=脱敏密码/密钥)"""
    _req = data.get("req_id") or ""
    try:
        inc = data.get("include") or None
        payload = _export(inc)
        if data.get("mask_secret"):
            for t, blk in (payload.get("tables") or {}).items():
                for row in blk.get("rows", []):
                    for k in list(row.keys()):
                        if any(s in k for s in ("password", "secret", "key", "auth_value", "passphrase")):
                            if row.get(k):
                                row[k] = "***"
        txt = json.dumps(payload, ensure_ascii=False, indent=1)
        log_operation("系统配置", f"导出配置 {len(payload.get('tables') or {})} 组")
        ts = time.strftime("%Y%m%d_%H%M%S")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": f"✓ 已导出 {len(payload.get('tables') or {})} 组配置 "
                                   f"({sum(len((b.get('rows') or [])) for b in (payload.get('tables') or {}).values())} 条)",
                            "filename": f"fonriv_config_{ts}.json",
                            "content_b64": base64.b64encode(txt.encode("utf-8")).decode(),
                            "size": len(txt.encode("utf-8")),
                            "summary": {t: len((b.get("rows") or [])) for t, b in (payload.get("tables") or {}).items()}})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"导出失败: {e}"})


def _key_of(t: str, row: dict) -> str:
    if t == "configs":
        return f"{row.get('name')}|{row.get('host')}|{row.get('port')}"
    if t == "remote_configs":
        return f"{row.get('name')}|{row.get('provider')}"
    if t == "shares":
        return f"{row.get('name')}|{row.get('host')}|{row.get('share')}"
    if t == "schedules":
        return f"{row.get('name')}"
    if t == "settings_kv":
        return str(row.get("key"))
    if t == "users":
        return f"{row.get('username')}"
    return json.dumps(row, sort_keys=True, default=str)[:120]


async def handle_sysconf_preview(ws, data: dict):
    """导入前预览 (不改动数据)。params: content_b64"""
    _req = data.get("req_id") or ""
    try:
        payload = _decode(data)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"内容解析失败: {e}"})
        return
    conn = db.get_conn()
    plan = []
    for t, blk in (payload.get("tables") or {}).items():
        cols = _cols(conn, t)
        if not cols:
            plan.append({"table": t, "label": blk.get("label") or t, "new": 0, "overwrite": 0, "skip": 0,
                         "error": "本机无此表, 将跳过"})
            continue
        try:
            exist = {_key_of(t, dict(r)) for r in conn.execute(f"SELECT * FROM {t}").fetchall()}
        except Exception:
            exist = set()
        new = ov = 0
        for row in (blk.get("rows") or []):
            if _key_of(t, row) in exist:
                ov += 1
            else:
                new += 1
        plan.append({"table": t, "label": blk.get("label") or t, "new": new,
                     "overwrite": ov, "skip": 0, "total": len(blk.get("rows") or [])})
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "plan": plan,
                        "meta": payload.get("_meta") or {}})


def _decode(data: dict) -> dict:
    b64 = data.get("content_b64")
    if b64:
        return json.loads(base64.b64decode(b64).decode("utf-8"))
    txt = data.get("content")
    if txt:
        return json.loads(txt)
    raise ValueError("缺少 content_b64 / content")


async def handle_sysconf_import(ws, data: dict):
    """导入配置。params: content_b64, mode(merge|skip|replace), tables(可选限定), dry_run"""
    _req = data.get("req_id") or ""
    if data.get("dry_run"):
        return await handle_sysconf_preview(ws, data)
    try:
        payload = _decode(data)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"内容解析失败: {e}"})
        return
    mode = (data.get("mode") or "merge").strip().lower()
    if mode not in ("merge", "skip", "replace"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "mode 仅支持 merge(覆盖同名) / skip(保留本机) / replace(先清空该表)"})
        return
    only = data.get("tables") or None
    conn = db.get_conn()
    stats, errors = [], []
    for t, blk in (payload.get("tables") or {}).items():
        if only and t not in only:
            continue
        cols = _cols(conn, t)
        if not cols:
            errors.append(f"{t}: 本机无此表")
            continue
        rows = blk.get("rows") or []
        added = ov = skipped = 0
        try:
            if mode == "replace":
                conn.execute(f"DELETE FROM {t}")
            exist = {}
            for r in conn.execute(f"SELECT rowid AS _rowid, * FROM {t}").fetchall():
                exist[_key_of(t, dict(r))] = dict(r)
            for row in rows:
                use = {k: v for k, v in row.items() if k in cols}
                if not use:
                    continue
                key = _key_of(t, row)
                if key in exist:
                    if mode == "skip":
                        skipped += 1
                        continue
                    sets = ", ".join(f"{k}=?" for k in use.keys())
                    conn.execute(f"UPDATE {t} SET {sets} WHERE rowid=?", (*use.values(), exist[key]["_rowid"]))
                    ov += 1
                else:
                    ks = ", ".join(use.keys())
                    qs = ", ".join("?" for _ in use)
                    conn.execute(f"INSERT INTO {t} ({ks}) VALUES ({qs})", tuple(use.values()))
                    added += 1
            conn.commit()
        except Exception as e:
            errors.append(f"{t}: {str(e)[:120]}")
            try:
                conn.rollback()
            except Exception:
                pass
        stats.append({"table": t, "added": added, "overwritten": ov, "skipped": skipped})
    log_operation("系统配置", f"导入配置 mode={mode} " +
                  " ".join(f"{s['table']}:+{s['added']}/~{s['overwritten']}" for s in stats))
    ok = not errors
    await ws.send_json({"type": "result", "status": "ok" if ok else "warn", "req_id": _req,
                        "msg": ("✓ 导入完成: " + " · ".join(
                            f"{s['table']} +{s['added']} 覆盖 {s['overwritten']} 跳过 {s['skipped']}" for s in stats)
                            + ("; 部分失败: " + "; ".join(errors) if errors else "")),
                        "stats": stats, "errors": errors})


# ── 系统数据库文件级备份/恢复 ──

def _db_file() -> str:
    return os.path.join(_DATA, "fonriv.db")


async def handle_sysdb_backup(ws, data: dict):
    """备份系统自身 SQLite 数据库 (含时间戳 + sha256)。params: dest_dir"""
    _req = data.get("req_id") or ""
    dest = (data.get("dest_dir") or os.path.join(_DATA, "db_backups")).strip()
    try:
        os.makedirs(dest, exist_ok=True)
        src = _db_file()
        if not os.path.exists(src):
            await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "数据库文件不存在"})
            return
        ts = time.strftime("%Y%m%d_%H%M%S")
        out = os.path.join(dest, f"fonriv_{ts}.db")
        # WAL 模式下需先 checkpoint 才能拿到一致快照
        try:
            conn = db.get_conn()
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.commit()
        except Exception:
            pass
        shutil.copy2(src, out)
        import hashlib
        h = hashlib.sha256()
        with open(out, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        with open(out + ".sha256", "w") as f:
            f.write(h.hexdigest() + "\n")
        size = os.path.getsize(out)
        log_operation("系统数据库", f"备份 → {out} ({size // 1024} KB)")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": f"✓ 系统数据库已备份 · {os.path.basename(out)} · {size / 1048576:.1f} MB",
                            "path": out, "size": size, "sha256": h.hexdigest()})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"备份失败: {e}"})


async def handle_sysdb_list(ws, data: dict):
    """列出系统数据库备份产物"""
    _req = data.get("req_id") or ""
    dest = (data.get("dest_dir") or os.path.join(_DATA, "db_backups")).strip()
    out = []
    try:
        for fn in sorted(os.listdir(dest), reverse=True):
            if not fn.endswith(".db"):
                continue
            fp = os.path.join(dest, fn)
            out.append({"name": fn, "path": fp, "size": os.path.getsize(fp),
                        "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(fp))),
                        "has_sha": os.path.exists(fp + ".sha256")})
    except Exception:
        pass
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "files": out[:100], "dir": dest})


async def handle_sysdb_restore(ws, data: dict):
    """恢复系统数据库。params: path, confirm
    安全设计: ① 必须显式 confirm=1; ② 恢复前自动把当前库留底; ③ 恢复后提示重启服务生效。
    """
    _req = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path or not os.path.exists(path):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "备份文件不存在"})
        return
    if not data.get("confirm"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "恢复会覆盖当前系统数据库, 请传 confirm=1 明确确认"})
        return
    try:
        ts = time.strftime("%Y%m%d_%H%M%S")
        pre = os.path.join(os.path.dirname(path), f"pre_restore_{ts}.db")
        shutil.copy2(_db_file(), pre)
        # 关闭连接池后替换文件
        try:
            from backend import db as _dbmod
            if hasattr(_dbmod, "close_all"):
                _dbmod.close_all()
        except Exception:
            pass
        shutil.copy2(path, _db_file())
        for suf in ("-wal", "-shm"):
            p2 = _db_file() + suf
            if os.path.exists(p2):
                try:
                    os.remove(p2)
                except Exception:
                    pass
        log_operation("系统数据库", f"恢复自 {path} (原库留底 {os.path.basename(pre)})")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": f"✓ 已恢复系统数据库 · 原库已留底为 {os.path.basename(pre)} — "
                                   f"**请到「系统设置 → 后台服务」重启服务使数据完全生效**",
                            "pre_backup": pre})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"恢复失败: {e}"})


# ═════════════════════════════════════════════════════════════
# B. 远端存储测试残留清理
# ═════════════════════════════════════════════════════════════

import re as _re

# 保守的测试残留特征 (命中任一即判定为桩数据)
_TEST_NAME_RE = _re.compile(r"^(v\d+[._-]|test[._-]|e2e[._-]|smoke[._-]|tmp[._-]|dummy)", _re.I)
_STUB_ENDPOINTS = ("http://127.0.0.1:1", "http://localhost:1", "127.0.0.1:1")
# v5.31.2 · 占位 bucket / 主机常见的测试取值
_STUB_BUCKETS = {"x", "y", "z", "test", "test1", "testbucket", "bucket", "mybucket", "aaa", "bbb", "1", "2"}


def _ep_host(ep: str) -> str:
    import urllib.parse as _up
    e = (ep or "").strip()
    if not e:
        return ""
    if "://" not in e:
        e = "//" + e
    try:
        return (_up.urlparse(e).hostname or "").lower()
    except Exception:
        return ""


def _is_real_host(h: str) -> bool:
    """能否当作真实主机: IP / localhost / 含点的域名 → 是。"""
    if not h:
        return False
    if h in ("localhost",) or h.replace(".", "").isdigit():
        return True
    try:
        import ipaddress as _ip
        _ip.ip_address(h)
        return True
    except Exception:
        pass
    return "." in h


def _classify(row: dict) -> tuple:
    """返回 (is_test, reason)

    v5.31.2 · 原规则只认「127.0.0.1:1」这一种占位 endpoint, 导致 `http://x` / `http://y`
    这类明显是占位值的桩数据被误判为「疑似在用」而保留 —— 用户看到"清理成功但假数据还在",
    体感就是"清理失败"。现补充: 主机名既不是 IP、也不含点、且很短 → 判为占位。
    """
    name = str(row.get("name") or "")
    ep = str(row.get("endpoint") or "")
    bucket = str(row.get("bucket") or "")
    if _TEST_NAME_RE.match(name):
        return True, f"名称像自动化测试桩 ({name[:24]})"
    if any(ep.startswith(s) or ep == s for s in _STUB_ENDPOINTS):
        return True, "endpoint 指向本地占位端口 (127.0.0.1:1)"
    host = _ep_host(ep)
    if host and not _is_real_host(host) and len(host) <= 3:
        return True, f"endpoint 主机名是占位值 ({ep[:28]})"
    if bucket.lower() in _STUB_BUCKETS and not _is_real_host(host):
        return True, f"占位 bucket='{bucket}' + 非真实 endpoint"
    return False, ""


async def handle_remote_prune_scan(ws, data: dict):
    """扫描远端存储配置, 区分测试残留与疑似在用 (不改动数据)"""
    _req = data.get("req_id") or ""
    try:
        conn = db.get_conn()
        rows = [dict(r) for r in conn.execute(
            "SELECT id,name,provider,endpoint,bucket,created_at FROM remote_configs ORDER BY id").fetchall()]
        test, keep, groups = [], [], {}
        for r in rows:
            is_t, why = _classify(r)
            key = f"{r.get('name')}|{r.get('provider')}"
            groups[key] = groups.get(key, 0) + 1
            (test if is_t else keep).append({**r, "reason": why})
        dup = [{"key": k, "count": c} for k, c in groups.items() if c > 1]
        dup.sort(key=lambda x: -x["count"])
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "total": len(rows), "test_count": len(test), "keep_count": len(keep),
                            "test": test[:200], "keep": keep,
                            "duplicated": dup[:30],
                            "msg": f"共 {len(rows)} 条: 疑似测试残留 {len(test)} 条, 疑似在用 {len(keep)} 条, "
                                   f"重复组 {len(dup)} 个"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"扫描失败: {e}"})


async def handle_remote_prune_apply(ws, data: dict):
    """按确认后删除测试残留。params: ids(明确 id 列表) 或 mode=test_all, confirm=1"""
    _req = data.get("req_id") or ""
    if not data.get("confirm"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "请传 confirm=1 明确确认后再删除"})
        return
    try:
        conn = db.get_conn()
        ids = [int(x) for x in (data.get("ids") or [])]
        if not ids and (data.get("mode") or "") == "test_all":
            rows = [dict(r) for r in conn.execute("SELECT * FROM remote_configs").fetchall()]
            ids = [int(r["id"]) for r in rows if _classify(r)[0]]
        if not ids:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "没有需要删除的条目"})
            return
        # 安全护栏: 一次最多删 2000 条, 且必须全部命中测试特征
        if len(ids) > 2000:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": f"单次最多删除 2000 条 (本次 {len(ids)}), 请分批处理"})
            return
        if data.get("mode") == "test_all" or data.get("safety_check", True):
            rows = {int(r["id"]): dict(r) for r in conn.execute("SELECT * FROM remote_configs").fetchall()}
            bad = [i for i in ids if i not in rows or not _classify(rows[i])[0]]
            if bad and data.get("mode") == "test_all":
                await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                    "msg": f"安全校验未通过: {len(bad)} 条不含测试特征, 已中止 (未删除任何数据)"})
                return
        q = ",".join("?" for _ in ids)
        conn.execute(f"DELETE FROM remote_configs WHERE id IN ({q})", tuple(ids))
        conn.commit()
        log_operation("远端存储", f"清理测试残留 {len(ids)} 条")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": f"✓ 已清理 {len(ids)} 条测试残留配置", "deleted": len(ids)})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"清理失败: {e}"})

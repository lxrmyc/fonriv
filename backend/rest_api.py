"""Fonriv - F5 REST API 开放 (v4.88.0)

第三方系统通过 API Key + REST 端点触发传输/备份/查询任务。

认证: X-API-Key header 或 ?api_key= query param
API Key 管理: db.settings 表 (api_keys JSON)

端点:
  POST /api/v1/transfer       发起传输 (rsync)
  POST /api/v1/dbbackup       发起数据库备份
  GET  /api/v1/status/{task}  查询任务状态
  GET  /api/v1/tasks          最近任务列表
  GET  /api/v1/version        版本信息 (无需认证)
"""
from __future__ import annotations

import json
import os
import uuid

from fastapi import Request, HTTPException, Query
from fastapi.responses import JSONResponse

from backend import db
from backend.version import get_version

# ── API Key 管理 ──

def _get_api_keys() -> dict:
    """{key: {name, created_at, permissions}}"""
    raw = db.setting_get("api_keys", "")
    if raw:
        try: return json.loads(raw)
        except Exception: pass
    return {}


def _create_api_key(name: str) -> dict:
    import time
    key = "rp_" + uuid.uuid4().hex[:32]
    keys = _get_api_keys()
    keys[key] = {"name": name[:60], "created_at": time.strftime("%Y-%m-%d %H:%M:%S")}
    db.setting_set("api_keys", json.dumps(keys, ensure_ascii=False))
    return {"key": key, "name": name}


def _validate_api_key(request: Request) -> bool:
    key = request.headers.get("X-API-Key") or request.query_params.get("api_key") or ""
    if not key:
        return False
    keys = _get_api_keys()
    return key in keys


# ── 端点 ──

def _require_key(request: Request):
    if not _validate_api_key(request):
        raise HTTPException(401, "Invalid or missing API Key (use X-API-Key header)")


async def _get_task_status(task_id: str) -> dict:
    from backend import db as _db
    conn = _db.get_conn()
    row = conn.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
    if not row:
        raise HTTPException(404, f"Task not found: {task_id}")
    d = dict(row)
    return {"task_id": d["task_id"], "name": d["name"], "type": d["type"],
            "status": d["status"], "progress": d.get("progress", 0),
            "command": d.get("command", ""), "log_tail": (d.get("log_output") or "")[-500:]}


def register_rest_api(app):
    """注册 REST API 端点到 FastAPI app。"""

    @app.get("/api/v1/version")
    async def rest_version():
        """版本信息 (无需认证)"""
        return {"product": "Fonriv", "version": get_version(), "api_version": "v1"}

    @app.get("/api/v1/license_text")
    async def rest_license_text():
        """许可证全文 (无需认证: LICENSE 本就是随包公开发布的文本)。

        文本来自安装根的 LICENSE 文件 (AGPL-3.0)。"""
        import os as _os
        root = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
        path = _os.path.join(root, "LICENSE")
        try:
            with open(path, encoding="utf-8") as f:
                return {"status": "ok", "text": f.read()}
        except OSError:
            return {"status": "error", "msg": "许可协议文件缺失"}

    @app.post("/api/v1/keys")
    async def rest_create_key(request: Request, name: str = Query("default")):
        """创建 API Key (需管理员 token 或首次使用)"""
        keys = _get_api_keys()
        if keys:  # 已有 key → 需要认证
            _require_key(request)
        result = _create_api_key(name)
        return JSONResponse(result, status_code=201)

    @app.get("/api/v1/tasks")
    async def rest_tasks(request: Request, limit: int = 20):
        """最近任务列表"""
        _require_key(request)
        conn = db.get_conn()
        rows = conn.execute(
            "SELECT task_id, name, type, status, progress, command FROM tasks "
            "ORDER BY rowid DESC LIMIT ?", (min(limit, 100),)).fetchall()
        return JSONResponse({"tasks": [dict(r) for r in rows]})

    @app.get("/api/v1/status/{task_id}")
    async def rest_status(request: Request, task_id: str):
        """查询任务状态"""
        _require_key(request)
        return await _get_task_status(task_id)

    @app.post("/api/v1/transfer")
    async def rest_transfer(request: Request):
        """发起 rsync 传输"""
        _require_key(request)
        body = await request.json()
        src = body.get("src") or ""
        dst = body.get("dst") or ""
        direction = body.get("direction") or "up"
        if not src or not dst:
            raise HTTPException(400, "src and dst are required")
        host = body.get("host") or ""
        port = str(body.get("port") or "22")
        user = body.get("user") or "root"
        password = body.get("password") or ""
        if direction != "local" and not host:
            raise HTTPException(400, "host is required for remote transfer")

        # 通过 WS dispatch (模拟内部调用)
        from backend.handlers.rsync import handle_rsync
        task_id = f"api_{uuid.uuid4().hex[:12]}"

        data = {"src": src, "dst": dst, "direction": direction,
                "flags": body.get("flags", ["-a"]), "bwlimit": body.get("bwlimit", "0")}
        if host:
            data.update({"host": host, "port": port, "user": user, "auth_type": "pass",
                         "password": password})
        # 异步派发 (不等待完成)
        class _FakeWS:
            async def send_json(self, msg): pass
        ws = _FakeWS()
        asyncio.create_task(handle_rsync(ws, data, task_id))
        return JSONResponse({"task_id": task_id, "status": "dispatched",
                             "check": f"/api/v1/status/{task_id}"}, status_code=202)

    @app.post("/api/v1/dbbackup")
    async def rest_dbbackup(request: Request):
        """发起数据库备份"""
        _require_key(request)
        body = await request.json()
        db_type = body.get("db_type") or "mysql"
        db_host = body.get("db_host") or "127.0.0.1"
        db_name = body.get("db_name") or ""
        dest_dir = body.get("dest_dir") or "/var/backups/fonriv_db"
        password = body.get("db_password") or ""
        task_id = f"api_db_{uuid.uuid4().hex[:12]}"

        try:
            from backend.handlers.dbb import handle_dbb_backup
        except ImportError:  # 本发行版不含 dbb 模块
            return JSONResponse({"status": "error",
                                 "msg": "数据库热备未包含在本发行版中"},
                                status_code=501)
        data = {"db_type": db_type, "db_host": db_host, "db_name": db_name,
                "dest_dir": dest_dir, "compress": body.get("compress", "gzip"),
                "encrypt": body.get("encrypt", 0), "encrypt_pass": body.get("encrypt_pass", ""),
                "task_id": task_id}
        if password: data["db_password"] = password

        class _FakeWS:
            async def send_json(self, msg): pass
        ws = _FakeWS()
        asyncio.create_task(handle_dbb_backup(ws, data))
        return JSONResponse({"task_id": task_id, "status": "dispatched"}, status_code=202)


# ── CloudPool WebDAV 只读出口 (v5.99.9 · M9, 规格 §34.3) ──
# 只读子集: OPTIONS/PROPFIND(depth-1)/GET(Range 基础)。
# 鉴权: 登录会话 token(?token= 或 X-Auth-Token; db.api_session_get 单一真源)。
# 数据路径: Unified 视图(NATIVE 回源/REPLICATED 任一健康副本/MANAGED 拼装/EC 解码),
# 经 cache.file_bytes 统一分派。

def register_dav_api(app):
    """注册只读 WebDAV 端点(在 app.py 的 register_rest_api(app) 之后调用)。"""
    from fastapi import Response
    from fastapi.responses import Response as _Resp

    def _auth(token: str) -> bool:
        if not token:
            return False
        try:
            return db.api_session_get(token) is not None
        except Exception:
            return False

    def _dav_conn():
        # v1.0.0 · 智能存储池(CloudPool)未包含在本发行版 → 501 (不再抛 ModuleNotFoundError)
        try:
            from backend.cloudpool import store
            from backend.cloudpool import cluster
        except ImportError:
            raise HTTPException(501, "智能存储池未包含在本发行版中")
        store.init_store()
        conn = store.get_conn()
        cluster.ensure_cluster(conn)
        return conn

    def _xml_escape(s: str) -> str:
        return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    @app.options("/dav/{rest:path}")
    async def dav_options(rest: str):
        return _Resp(status_code=200, headers={
            "DAV": "1",
            "Allow": "OPTIONS, GET, PROPFIND",
            "Content-Length": "0",
        })

    @app.api_route("/dav/{pool_id}/", methods=["PROPFIND"])
    @app.api_route("/dav/{pool_id}", methods=["PROPFIND"])
    async def dav_propfind_root(pool_id: str, request: Request,
                                token: str = Query("")):
        if not _auth(token or request.headers.get("X-Auth-Token", "")):
            raise HTTPException(401, "需要登录会话 token(?token= 或 X-Auth-Token)")
        conn = _dav_conn()
        # v1.0.0 · 智能存储池未包含在本发行版 → 501 (不再抛 ModuleNotFoundError)
        try:
            from backend.cloudpool import namespace
        except ImportError:
            raise HTTPException(501, "智能存储池未包含在本发行版中")

        view = namespace.unified_view(conn, pool_id, "/")
        parts = ["<?xml version=\"1.0\" encoding=\"utf-8\"?>",
                 "<D:multistatus xmlns:D=\"DAV:\">",
                 _dav_resp("/dav/%s/" % pool_id, is_dir=True)]
        for d in view.get("dirs", []):
            parts.append(_dav_resp("/dav/%s/d/%s/" % (pool_id, _dir_id(conn, pool_id, d["name"])),
                                   is_dir=True, name=d["name"]))
        for f in view.get("files", []):
            if f.get("status") not in ("OK", "CONFLICT"):
                continue
            parts.append(_dav_resp("/dav/%s/f/%s/%s" % (pool_id, f["file_id"], _xml_escape(f["name"])),
                                   is_dir=False, name=f["name"], size=f.get("size_bytes", 0)))
        parts.append("</D:multistatus>")
        return _Resp(content="\n".join(parts), status_code=207,
                     media_type="application/xml; charset=utf-8")

    @app.get("/dav/{pool_id}/f/{file_id}/{name}")
    async def dav_get_file(pool_id: str, file_id: str, name: str, request: Request,
                           token: str = Query("")):
        if not _auth(token or request.headers.get("X-Auth-Token", "")):
            raise HTTPException(401, "需要登录会话 token(?token= 或 X-Auth-Token)")
        conn = _dav_conn()
        # v1.0.0 · 智能存储池未包含在本发行版 → 501 (不再抛 ModuleNotFoundError)
        try:
            from backend.cloudpool import managed
        except ImportError:
            raise HTTPException(501, "智能存储池未包含在本发行版中")

        # v6.4.1 · 批4: **流式范围读** —— 原实现 file_bytes 把整文件读进内存再手工切 Range,
        #   大媒体经 /dav 播放 = 内存炸弹。现按需只读请求范围(read_range_any: chunk 布局真
        #   范围读 / 副本 seek 读 / EC 解码后切片并如实注明)。
        frow = conn.execute("SELECT size_bytes FROM files WHERE id=?", (file_id,)).fetchone()
        if frow is None:
            raise HTTPException(404, "文件不存在")
        total = int(frow["size_bytes"] or 0)
        headers = {"Accept-Ranges": "bytes",
                   "Content-Disposition": 'inline; filename="%s"' % name.replace('"', "")}
        rng = request.headers.get("Range", "")
        if rng.startswith("bytes=") and "-" in rng:
            try:
                a, b = rng[6:].split("-", 1)
                start = int(a) if a else max(0, total - int(b))
                end = int(b) if b else total - 1
                end = min(end, total - 1)
                if start > end or start >= total:
                    return _Resp(status_code=416, headers={"Content-Range": "bytes */%d" % total})
                piece = await managed.read_range_any_async(conn, file_id, start, end - start + 1)
                headers["Content-Range"] = "bytes %d-%d/%d" % (start, end, total)
                return _Resp(content=piece, status_code=206, media_type="application/octet-stream",
                             headers=headers)
            except ValueError:
                pass
            except Exception as e:
                return _Resp(status_code=500, content="范围读取失败: %s" % e,
                             media_type="text/plain; charset=utf-8")
        if total <= 0:
            return _Resp(content=b"", media_type="application/octet-stream", headers=headers)
        data = await managed.read_range_any_async(conn, file_id, 0, total)
        return _Resp(content=data, media_type="application/octet-stream", headers=headers)

    @app.api_route("/dav/{pool_id}/d/{dir_id}/", methods=["PROPFIND"])
    @app.api_route("/dav/{pool_id}/d/{dir_id}", methods=["PROPFIND"])
    async def dav_propfind_dir(pool_id: str, dir_id: str, request: Request,
                               token: str = Query("")):
        """v6.4.1 · 批4: 子目录 PROPFIND —— 根响应里生成的 /d/{dir_id}/ href 自此可达
        (此前无对应路由, WebDAV 客户端进不了任何子目录)。"""
        if not _auth(token or request.headers.get("X-Auth-Token", "")):
            raise HTTPException(401, "需要登录会话 token(?token= 或 X-Auth-Token)")
        conn = _dav_conn()
        row = conn.execute("SELECT id, name, parent_id FROM directories WHERE id=?",
                           (dir_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "目录不存在")
        parts = ["<?xml version=\"1.0\" encoding=\"utf-8\"?>",
                 "<D:multistatus xmlns:D=\"DAV:\">",
                 _dav_resp("/dav/%s/d/%s/" % (pool_id, dir_id), is_dir=True,
                           name=str(row["name"]))]
        for r in conn.execute("SELECT id, name FROM directories WHERE parent_id=? ORDER BY name",
                              (dir_id,)).fetchall():
            parts.append(_dav_resp("/dav/%s/d/%s/" % (pool_id, str(r["id"])), is_dir=True,
                                   name=str(r["name"])))
        for f in conn.execute(
                "SELECT id, name, size_bytes, status FROM files WHERE directory_id=? ORDER BY name",
                (dir_id,)).fetchall():
            if str(f["status"]) not in ("OK", "CONFLICT"):
                continue
            parts.append(_dav_resp("/dav/%s/f/%s/%s" % (pool_id, str(f["id"]), _xml_escape(str(f["name"]))),
                                   is_dir=False, name=str(f["name"]), size=int(f["size_bytes"] or 0)))
        parts.append("</D:multistatus>")
        return _Resp(content="\n".join(parts), status_code=207,
                     media_type="application/xml; charset=utf-8")

    def _dav_resp(href: str, is_dir: bool, name: str = "", size: int = 0) -> str:
        inner = "<D:collection/>" if is_dir else \
            "<D:getcontentlength>%d</D:getcontentlength>" % size
        return ("<D:response><D:href>%s</D:href><D:propstat><D:prop>"
                "<D:displayname>%s</D:displayname>%s</D:prop>"
                "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
                % (_xml_escape(href), _xml_escape(name or "root"), inner))

    def _dir_id(conn, pool_id: str, name: str) -> str:
        row = conn.execute(
            "SELECT d.id FROM directories d JOIN volumes v ON v.id=d.volume_id "
            "WHERE v.pool_id=? AND d.name=? LIMIT 1", (pool_id, name)).fetchone()
        return str(row[0]) if row else "0"

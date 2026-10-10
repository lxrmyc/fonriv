"""Fonriv - FastAPI 应用入口"""
from __future__ import annotations
import logging

import os
import re
import io
import tarfile
import time
import signal
import asyncio
import mimetypes
import urllib.parse
from pathlib import Path
from typing import List, Optional
import uuid

from fastapi import FastAPI, Request, Response, HTTPException, Query, Header, UploadFile, File, Form
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

APP_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = APP_DIR / "frontend"
HTML_FILE = FRONTEND_DIR / "index.html"
STATIC_DIR = FRONTEND_DIR / "static"
START_TIME = time.time()

# ---- 本地文件浏览/下载白名单 ----
ALLOWED_ROOTS = [
    "/mnt/backup",
    "/mnt/data/backup",
    "/backup",
    "/var/lib/vz/dump",
    "/var/lib/vz/template/iso",
    "/var/lib/vz/images",
    "/tmp/fonriv_downloads",
    # v5.90.9 · 浏览器上传暂存目录 (/api/upload 的 dest_dir 默认值, 缺它 → 403 path not allowed)
    "/tmp/fonriv_uploads",
    # v5.59.0 E1 · 网络共享挂载命名空间: SMB/NFS/WebDAV 挂载后等同本机文件,
    #   浏览器直下(/api/fonr/dl)与预览都要求能读这里 (挂载点由本应用创建, 非用户任意路径)
    "/var/lib/fonriv_mounts",
    # v5.59.0 E1 · 本应用数据目录 (FonrVFS 暂存/缩略图/转换产物)
    str(Path(__file__).resolve().parent.parent / "data"),
]

# /api/* 是否要求登录认证
# 默认 ON（安全默认）。设置 FONRIV_REQUIRE_AUTH=0 可关闭（仅限受信内网/本地开发）
REQUIRE_API_AUTH = os.environ.get("FONRIV_REQUIRE_AUTH", "1") not in ("0", "false", "no", "off")


def _resolve_safe(path: str) -> Path:
    """将用户输入路径解析为绝对路径并校验白名单。"""
    if not path:
        raise HTTPException(400, "path required")
    try:
        p = Path(path).expanduser().resolve(strict=False)
    except Exception:
        raise HTTPException(400, "invalid path")
    for root in ALLOWED_ROOTS:
        try:
            root_p = Path(root).resolve(strict=False)
        except Exception:
            continue
        try:
            p.relative_to(root_p)
            return p
        except ValueError:
            continue
    raise HTTPException(403, f"path not allowed (must be under one of: {', '.join(ALLOWED_ROOTS)})")


def _actor_from_token(token: Optional[str]):
    """按 API token 解析 (user_id, role); 无 token / 鉴权关闭时返回 (None, "") 表示"全部"。"""
    if not token:
        return None, ""
    try:
        from backend.auth import active_sessions
        for sess in active_sessions.values():
            if sess.get("token") == token:
                return int(sess.get("user_id") or 1), (sess.get("role") or "")
    except Exception:
        pass
    try:
        from backend import db as _db
        row = _db.api_session_get(token)
        if row:
            return int(row.get("user_id") or 1), (row.get("role") or "")
    except Exception as e:
        print("api session lookup failed:", e)
    return None, ""


def _check_api_auth(token: Optional[str]):
    """检查 API token。REQUIRE_API_AUTH 关闭时直通；否则要求 token 在 active_sessions 或持久化 api_sessions 表中。"""
    if not REQUIRE_API_AUTH:
        return
    if not token:
        raise HTTPException(401, "authentication required (pass ?token= or X-Auth-Token)")
    try:
        from backend.auth import active_sessions
    except Exception:
        raise HTTPException(500, "auth backend unavailable")
    for sess in active_sessions.values():
        if sess.get("token") == token:
            return
    # Fallback: 查持久化会话（server 重启 / WS 断开后仍可用）
    try:
        from backend import db as _db
        if _db.api_session_get(token):
            return
    except Exception as e:
        print("api_session_get fallback failed:", e)
    raise HTTPException(401, "invalid or expired token")


def _auth_dep(
    token: Optional[str] = Query(None),
    x_auth_token: Optional[str] = Header(None),
):
    _check_api_auth(token or x_auth_token)


app = FastAPI(title="Fonriv")

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class _NoCacheMiddleware:
    """v5.98.11 · 缓存头中间件由 BaseHTTPMiddleware 改为**纯 ASGI** 实现。

    为什么改: 采样栈两次落在 starlette 的 `BaseHTTPMiddleware`(`middleware/base.py` 的
    `__call__` / `_send`) 上 —— 它给**每个请求**多建一个任务 + 一个 anyio 内存流把响应体
    搬一遍, 在大响应下(首页 ~330KB、/api/version ~143KB)是天然的延迟/背压放大器。
    而这里只是"按路径贴几个响应头", 用不着那套机制: 纯 ASGI 直接在
    `http.response.start` 上改头即可, 零额外任务、零搬运。

    语义与旧实现保持一致(逐条对照):
      · `/` 或 *.html → no-cache, no-store, must-revalidate + Pragma + Expires: 0
      · /static/* 或 /favicon.ico → no-cache, must-revalidate  (v5.90.10 起: 每次协商复验)
      · 其它 → 不动
    websocket 等非 http scope 直接透传。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "") or ""
        if path == "/" or path.endswith(".html"):
            hdrs = ((b"cache-control", b"no-cache, no-store, must-revalidate"),
                    (b"pragma", b"no-cache"),
                    (b"expires", b"0"))
        elif path.startswith("/static") or path == "/favicon.ico":
            hdrs = ((b"cache-control", b"no-cache, must-revalidate"),)
        else:
            hdrs = ()

        async def _send(message):
            if hdrs and message.get("type") == "http.response.start":
                message = dict(message)
                low = set(k for k, _ in hdrs)          # 同名旧头先去重, 避免出现两个 Cache-Control
                old = message.get("headers") or []
                message["headers"] = [(k, v) for (k, v) in old if k.lower() not in low] + list(hdrs)
            await send(message)

        await self.app(scope, receive, _send)


app.add_middleware(_NoCacheMiddleware)


# ════════════ v5.98.5 · HTTP 请求服务端耗时(用于判定"卡在进程内"还是"投递路径慢") ════════════
# 背景: 用户报「整机卡几十秒、刷新不出列表」。上一步用 SIGUSR1 抓到一次 40.83s 卡顿, 6 份采样栈
#   里**没有任何业务帧**(主线程只有 uvicorn/asyncio 外壳帧) → 怀疑延迟不在我们代码里, 但缺一侧证据:
#   客户端看到的 40s, 服务端到底花了多少?
# 做法: 纯 ASGI 中间件(不用 BaseHTTPMiddleware, 避免再引入一层任务与额外开销), 记录每个 HTTP 请求
#   的**服务端墙上耗时**; 只记可疑区间(≥1s 且 ≤180s)且**排除流式/下载类路径**(那些本来就是长时间在传,
#   记了只会刷屏)。这样同一个卡顿事件: 服务端 0.02s + 客户端 40s ⇒ 投递路径; 两侧都几十秒 ⇒ 卡在进程内。
_HTTP_SLOW_MIN = 1.0        # 低于此不记(正常)
_HTTP_SLOW_MAX = 180.0      # 高于此视为"长连接/大文件传输", 不记(避免噪音)
_HTTP_SKIP_PREFIX = ("/static", "/api/file/stream", "/api/fonr/dl", "/api/fonr/stream",
                     "/api/download", "/api/fonr/share")


class _HttpTimingMiddleware:
    """记录 HTTP 请求的服务端耗时(仅可疑区间), 用于区分"真卡在进程内"与"投递路径慢"。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if path.startswith(_HTTP_SKIP_PREFIX):
            return await self.app(scope, receive, send)
        t0 = time.monotonic()
        state = {"status": 0}

        async def _send(message):
            if message.get("type") == "http.response.start":
                state["status"] = message.get("status", 0)
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            dt = time.monotonic() - t0
            if _HTTP_SLOW_MIN <= dt <= _HTTP_SLOW_MAX:
                try:
                    from backend.log import log_operation as _logop
                    _peer = (scope.get("client") or ("", 0))[0]
                    _logop("性能", "HTTP %s" % path,
                           "服务端耗时 %.1fs 状态=%s peer=%s%s"
                           % (dt, state["status"], _peer,
                              "  ← 若客户端感知远大于此, 说明卡在投递/连接层而非进程内" if dt < 5 else ""))
                except Exception:
                    pass


try:
    app.add_middleware(_HttpTimingMiddleware)
except Exception as _mte:      # 极端情况下不影响启动
    print("[http_timing] 中间件注册失败(忽略):", _mte)


def _frontend_fingerprint() -> str:
    """前端内容指纹: frontend/static/** + index.html 的 (路径,大小,mtime) → sha256 前 10 位。
    用于静态资源 ?v= 的缓存失效(同版本号重新部署也能让浏览器重新拉取)。"""
    import hashlib as _hl, os as _os
    h = _hl.sha256()
    base = STATIC_DIR
    root = base.parent  # frontend/
    try:
        paths = []
        for dp, dn, fn in _os.walk(base):
            for f in fn:
                paths.append(_os.path.join(dp, f))
        paths.append(str(root / "index.html"))
        for p in sorted(paths):
            try:
                st = _os.stat(p)
            except OSError:
                continue
            h.update(("%s|%d|%d;" % (p, st.st_size, int(st.st_mtime))).encode())
    except Exception:
        pass
    return h.hexdigest()[:10]


_FRONTEND_FP = _frontend_fingerprint()


@app.get("/")
async def index():
    if not HTML_FILE.exists():
        return HTMLResponse("Error: frontend/index.html not found.", status_code=404)
    # title/版本徽章动态化 (替换 {{APP_VERSION}} 占位符, 与 backend.version 同源)
    from backend.version import VERSION
    try:
        # v1.0.0 · 静态资源缓存串改为**版本+前端内容指纹** —— 只带版本号时, 同版本号重新部署
        #   浏览器仍用旧 JS(实测: 用户看到旧界面/旧行为), 每次发版必须 Ctrl+F5 才能生效。
        #   指纹按 frontend/static 与 index.html 的 (路径,大小,mtime) 计算, 进程启动时算一次。
        html = (HTML_FILE.read_text(encoding="utf-8")
                # v5.90.10 · 静态资源 ?v= 用裸版本号(先替换, 避免吃掉徽章的 v 前缀规则)
                .replace("?v={{APP_VERSION}}", "?v=" + VERSION + "-" + _FRONTEND_FP)
                .replace("{{APP_VERSION}}", "v" + VERSION))
        # v1.0.0 · 社区包的 index.html 里静态资源是**字面量版本号**(?v=1.0.0, 非占位符),
        #   一并统一成"版本-前端指纹"(幂等: 已带指纹的会被替成同样的值)
        html = re.sub(r'\?v=[0-9A-Za-z.\-]+', "?v=" + VERSION + "-" + _FRONTEND_FP, html)
    except Exception:
        return FileResponse(str(HTML_FILE), media_type="text/html",
                            headers={"Cache-Control": "no-cache"})
    # v4.66.0 · no-cache: 修版本徽章/页面停留旧版 (浏览器缓存 index.html)
    return HTMLResponse(html, media_type="text/html",
                        headers={"Cache-Control": "no-cache, max-age=0"})


@app.get("/terminal.html")
async def terminal_page():
    """v4.38.7: 分离终端独立窗口页面"""
    term_file = STATIC_DIR.parent / "terminal.html"
    if not term_file.exists():
        return HTMLResponse("Error: terminal.html not found.", status_code=404)
    return FileResponse(str(term_file), media_type="text/html")


# v5.20.0 · VM/主机 控制台页面 (noVNC + /ws/vnc 字节桥)
#   与 terminal.html 同模式: 独立窗口页, 参数走 query string。
#   PVE 凭据不下发到这里 —— 浏览器只拿 node/vmid 与会话 token,
#   ticket 由 /ws/vnc 建连时在服务端现取。
@app.get("/novnc.html")
async def novnc_page():
    f = STATIC_DIR.parent / "novnc.html"
    if not f.exists():
        return HTMLResponse("Error: novnc.html not found.", status_code=404)
    return FileResponse(str(f), media_type="text/html")


@app.get("/vnc_play.html")
async def vnc_play_page():
    """v5.23.0 · 远程桌面会话录制回放页。"""
    f = STATIC_DIR.parent / "vnc_play.html"
    if not f.exists():
        return HTMLResponse("Error: vnc_play.html not found.", status_code=404)
    return FileResponse(str(f), media_type="text/html")


@app.get("/guac.html")
async def guac_page():
    """v5.25.0 · RDP/VNC/SSH 控制台页 (guacd 网关, guacamole-common-js 渲染)。"""
    f = STATIC_DIR.parent / "guac.html"
    if not f.exists():
        return HTMLResponse("Error: guac.html not found.", status_code=404)
    return FileResponse(str(f), media_type="text/html")


@app.get("/health")
async def health_check():
    from backend.ssh import active_tasks
    from backend.version import VERSION
    return {
        "status": "ok",
        "version": VERSION,
        "uptime": round(time.time() - START_TIME),
        "active_tasks": len(active_tasks),
        "api_auth": REQUIRE_API_AUTH,
    }


@app.get("/metrics")
async def prometheus_metrics():
    """v4.12.0: Prometheus 抓取端点 · text/plain · exposition format v0.0.4。

    暴露:
      fonriv_up                        1
      fonriv_info{version="..."}       1
      fonriv_uptime_seconds            uptime
      fonriv_active_tasks              当前跑的 SSH 任务数
      fonriv_active_sessions           在线 WS 会话数
      fonriv_backups_total{status,type}  按 status/type 分组的历史 backup 数
      fonriv_backup_bytes_total{type}  历史 backup 字节和
      fonriv_remote_uploads_total{status}
      fonriv_schedules_total{enabled}
      fonriv_schedule_runs_total{status}
    """
    from fastapi.responses import PlainTextResponse
    from backend.version import VERSION
    from backend.ssh import active_tasks
    try:
        from backend.auth import active_sessions
        n_sessions = len(active_sessions)
    except Exception:
        n_sessions = 0

    lines: list[str] = []
    def _m(name, help_text, mtype, samples):
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} {mtype}")
        for labels, val in samples:
            if labels:
                lines.append(f"{name}{{{labels}}} {val}")
            else:
                lines.append(f"{name} {val}")

    _m("fonriv_up", "1 if service is running", "gauge", [("", 1)])
    ver_esc = VERSION.replace('"', '\\"')
    _m("fonriv_info", "Static build info", "gauge", [(f'version="{ver_esc}"', 1)])
    _m("fonriv_uptime_seconds", "Process uptime seconds", "gauge",
       [("", round(time.time() - START_TIME))])
    _m("fonriv_active_tasks", "Currently running SSH/rsync tasks", "gauge",
       [("", len(active_tasks))])
    _m("fonriv_active_sessions", "Live WebSocket sessions", "gauge",
       [("", n_sessions)])

    try:
        from backend import db as _db
        conn = _db.get_conn()
        rows = conn.execute(
            "SELECT status, IFNULL(type,'rsync') AS t, COUNT(*) c, "
            "IFNULL(SUM(size_bytes),0) sz FROM backups GROUP BY status, t"
        ).fetchall()
        samples_count = []
        samples_bytes: dict = {}
        for r in rows:
            samples_count.append((f'status="{r["status"]}",type="{r["t"]}"', r["c"]))
            samples_bytes[r["t"]] = samples_bytes.get(r["t"], 0) + int(r["sz"] or 0)
        _m("fonriv_backups_total", "Backup records by status/type", "gauge", samples_count)
        _m("fonriv_backup_bytes_total", "Total bytes of finished backups by type", "gauge",
           [(f'type="{t}"', v) for t, v in samples_bytes.items()])

        rows = conn.execute(
            "SELECT status, COUNT(*) c FROM remote_uploads GROUP BY status"
        ).fetchall()
        _m("fonriv_remote_uploads_total", "Remote upload records by status", "gauge",
           [(f'status="{r["status"]}"', r["c"]) for r in rows])

        # schedules 可能不存在（老 DB）
        try:
            rows = conn.execute(
                "SELECT enabled, COUNT(*) c FROM schedules GROUP BY enabled"
            ).fetchall()
            _m("fonriv_schedules_total", "Schedules by enabled flag", "gauge",
               [(f'enabled="{bool(r["enabled"])}"', r["c"]) for r in rows])
            rows = conn.execute(
                "SELECT status, COUNT(*) c FROM schedule_runs GROUP BY status"
            ).fetchall()
            _m("fonriv_schedule_runs_total", "Schedule run records by status", "gauge",
               [(f'status="{r["status"]}"', r["c"]) for r in rows])
        except Exception as e:
            print(f"[metrics] schedules query skipped: {e}")
    except Exception as e:
        print(f"[metrics] DB query failed: {e}")

    body = "\n".join(lines) + "\n"
    return PlainTextResponse(body, media_type="text/plain; version=0.0.4; charset=utf-8")


@app.get("/api/version")
async def api_version(limit: int = Query(40, ge=1, le=2000)):
    """返回应用版本 + **最近 N 条**更新日志(默认 40 条)。

    v5.98.4 · 收敛载荷: 此前该接口每次页面加载都回**整份变更历史**(实测 949 KB / 471 条),
    既是带宽浪费, 也是实测捕获到的「HTTP 响应写出被压住」的天然放大器
    (卡顿栈采样落在 uvicorn 的响应 write 上)。现在:
      · 默认只回最近 40 条 + `changelog_total` / `changelog_truncated` 两个字段(前端据此提示);
      · 需要看全量历史走 `/api/changelog`(独立的按页接口), 不进首屏路径。
    """
    from backend.version import get_version, get_changelog
    rows = get_changelog() or []
    return {"version": get_version(), "changelog": rows[:limit],
            "changelog_total": len(rows), "changelog_truncated": len(rows) > limit}


@app.get("/api/changelog")
async def api_changelog(limit: int = Query(200, ge=1, le=5000), offset: int = Query(0, ge=0)):
    """完整更新历史(按页) —— 供「更新日志」弹窗点『加载全部』时使用。"""
    from backend.version import get_changelog
    rows = get_changelog() or []
    return {"changelog": rows[offset:offset + limit], "total": len(rows),
            "offset": offset, "limit": limit, "more": (offset + limit) < len(rows)}


# ════════════════ v5.91.6 · 首次配置向导 (部署后第一次打开网页用) ════════════════
# 背景: 此前 db 层在首次启动时自动建一个固定弱口令账号 —— 且启动日志直接打印口令,
#   而且会随源码材料被公开。现在改为"用户自己设": 打开页面 → 配置超级管理员与主题 → 进系统。
# 安全约束:
#   · 两个端点都**不需要登录**(这正是初始化的意义), 但 init 只在"一个用户都没有"时可调用
#   · 一旦初始化完成, init 立即返回 403 —— 无法被用来重置口令

_WEAK_PW = {"123456", "1234567", "12345678", "123456789", "1234567890", "password",
            "passw0rd", "admin", "admin123", "administrator", "root", "qwerty",
            "abc123", "11111111", "88888888", "00000000", "66666666", "iloveyou"}


def _validate_first_admin(username: str, password: str) -> str:
    """返回错误文案; 空串 = 通过。"""
    import re as _re
    if not username:
        return "请填写超级管理员用户名"
    if not _re.match(r"^[A-Za-z\u4e00-\u9fa5][A-Za-z0-9_.\-\u4e00-\u9fa5]{2,31}$", username):
        return "用户名需 3~32 个字符, 以字母或汉字开头, 可用字母/数字/下划线/点/连字符/汉字"
    if not password:
        return "请填写密码"
    if len(password) < 8:
        return "密码至少 8 位"
    if password.lower() in _WEAK_PW:
        return "该密码过于常见, 请换一个"
    if len(set(password)) <= 2:
        return "密码字符过于单一, 请混合字母、数字或符号"
    if not (_re.search(r"[A-Za-z]", password) and _re.search(r"[0-9]", password)):
        return "密码需同时包含字母和数字"
    return ""


@app.get("/api/setup/status")
async def api_setup_status():
    """是否还需要首次配置(未登录可访问, 前端据此决定显示配置向导还是登录页)。"""
    from backend import db as _db
    from backend.version import get_version
    try:
        need = _db.needs_setup()
    except Exception as e:
        raise HTTPException(500, "读取初始化状态失败: %s" % e)
    return {"needs_setup": bool(need), "version": get_version(),
            "product": "Fonriv 源流云运维传输与备份管理平台"}


@app.post("/api/setup/init")
async def api_setup_init(request: Request):
    """首次配置: 创建超级管理员 + 应用外观偏好, 并直接下发登录 token(免二次登录)。"""
    from backend import db as _db
    from backend.db.hashing import hash_password
    if not _db.needs_setup():
        raise HTTPException(403, "系统已完成初始化, 该接口已关闭")
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    theme = str(body.get("theme") or "light").strip()
    err = _validate_first_admin(username, password)
    if err:
        raise HTTPException(400, err)
    try:
        uid = _db.create_first_admin(username, hash_password(password), theme)
    except ValueError as e:
        raise HTTPException(409, str(e))
    except Exception as e:
        raise HTTPException(500, "创建管理员失败: %s" % e)
    # 系统名称(可选): 写入 app_settings, 界面标题用
    _site = str(body.get("site_name") or "").strip()
    if _site:
        try:
            _db.setting_set("site_name", _site[:48])
        except Exception as e:
            print("[setup] site_name 保存失败(忽略):", e)
    # 界面语言(向导里选的): 写入该管理员偏好 —— 否则进系统后 ui_lang_get 回默认 zh,
    #   会把用户在向导里选的 English 盖回中文(实测踩到)
    _lang = str(body.get("lang") or "").strip().lower()
    if _lang in ("zh", "en"):
        try:
            from backend.i18n import set_user_lang as _set_user_lang
            _set_user_lang(uid, _lang)
        except Exception as e:
            print("[setup] lang 保存失败(忽略):", e)
    else:
        _lang = ""
    token = str(uuid.uuid4())
    try:
        _db.api_session_create(token, uid, username, "admin")
    except Exception as e:
        print("[setup] api_session_create failed:", e)
    print("=" * 58)
    print("Fonriv 初始化完成 · 超级管理员: %s · 主题: %s" % (username, theme))
    print("=" * 58)
    return {"status": "ok", "token": token, "user_id": uid, "username": username,
            "role": "admin", "theme": theme, "lang": _lang, "needs_setup": False}


@app.get("/api/graph")
async def api_graph(token: Optional[str] = Query(None), x_auth_token: Optional[str] = Header(None)):
    """v4.39.0 · 实体引用图拓扑可视化 REST 端点

    返回完整一致性报告(healthy/dangling/orphans) + entity_refs 列表,
    供外部工具或前端拓扑可视化组件消费。
    """
    _check_api_auth(token or x_auth_token)
    import backend.db as _db
    report = _db.graph_integrity_check()
    return {"status": "ok", "report": report}


@app.get("/api/pubkey")
async def api_pubkey():
    """v2.8.1: 返回服务器 X25519 公钥（base64url，无 padding）。
    前端拿到后，用 curve25519+AES-GCM 加密敏感字段（EC1: 前缀）替代旧的 base64（ENC:）。
    返回空 pubkey 表示服务器未装 cryptography → 前端应回退到 ENC: 模式。
    """
    from backend.crypto_channel import server_pubkey_b64
    return {"pubkey": server_pubkey_b64(), "scheme": "x25519-hkdf-sha256-aesgcm-v1", "prefix": "EC1:"}


# v5.38.2 · P2 会话录制文件 (webm 播放 / guac 下载)
@app.get("/api/recordings/{name}")
async def api_recording_file(name: str, token: Optional[str] = Query(None),
                             x_auth_token: Optional[str] = Header(None)):
    """回放/下载录制文件。仅允许 RECORDINGS_DIR 内的文件名 (防路径穿越)。"""
    _check_api_auth(token or x_auth_token)
    import os as _os
    from fastapi.responses import FileResponse
    from backend.guacd_bridge import RECORDINGS_DIR
    safe = _os.path.basename(name)
    p = _os.path.join(RECORDINGS_DIR, safe)
    if not safe or not _os.path.isfile(p):
        return JSONResponse({"status": "error", "msg": "文件不存在"}, status_code=404)
    if safe.endswith(".m4v") or safe.endswith(".mp4"):
        media = "video/mp4"
    elif safe.endswith(".webm"):
        media = "video/webm"
    else:
        media = "application/octet-stream"
    return FileResponse(p, media_type=media, filename=safe)


# v5.35.0 · G2 零遗留: /api/servers 改由 server_profiles 提供 (原 configs 表已退役)
@app.get("/api/servers")
async def api_servers(token: Optional[str] = Query(None), x_auth_token: Optional[str] = Header(None)):
    """返回服务器档案列表（仅必要字段，密码解密后返回）。前端三列传输面板的服务器列表条。"""
    _tok = token or x_auth_token
    _check_api_auth(_tok)
    from backend import db as _db
    from backend.db.crypto import decrypt_value as _dv
    from backend.db import _get_fernet as _gf
    # v5.48.0 修: 此前硬编码 user_id=1 → 别人 (user_id≠1) 建的档案在这个接口里全部消失,
    #   前端三栏的服务器下拉因此"少机器", 选不到机器时回落本机路径 (用户报的现象)。
    #   现在按 token 解析身份: 管理员看全部, 普通用户看自己的, 无鉴权时看全部。
    _uid, _role = _actor_from_token(_tok)
    _all = (_role or "").lower() == "admin" or _uid is None
    out = []
    try:
        _sql = ("SELECT guid,name,hostname,ssh_port,ssh_user,ssh_auth_type,ssh_auth_value,"
                "ssh_passphrase FROM server_profiles "
                + ("" if _all else "WHERE user_id=? ") + "ORDER BY name")
        _args = () if _all else (_uid,)
        rows = _db.get_conn().execute(_sql, _args).fetchall()
        for r in rows:
            d = dict(r)
            av = d.get("ssh_auth_value") or ""
            if av and str(av).startswith("ENC$"):
                try:
                    av = _dv(_gf(), av)
                except Exception:
                    pass
            pp = d.get("ssh_passphrase") or ""
            if pp and str(pp).startswith("ENC$"):
                try:
                    pp = _dv(_gf(), pp)
                except Exception:
                    pass
            at = d.get("ssh_auth_type") or "pass"
            out.append({
                'id': d.get('guid'),
                'uuid': d.get('guid'),
                'name': d.get('name') or d.get('hostname'),
                'label': d.get('name') or d.get('hostname'),
                'host': d.get('hostname'),
                'port': str(d.get('ssh_port') or '22'),
                'user': d.get('ssh_user') or 'root',
                'auth_type': at,
                'password': av if at == 'pass' else '',
                'key': av if at == 'key' else '',
                'passphrase': pp,
            })
    except Exception as e:
        print(f"[api_servers] fail: {e}")
    return out


# v2.9.0: 定时计划调度器 startup/shutdown
@app.on_event("startup")
async def _rp_startup():
    # v5.91.6 · 清理本程序在 /tmp 下的历史临时件
    #   根因: 媒体流式取回的暂存文件(fonrvfs_stream_*)与压缩包成员抽取临时文件(fonr_arc_*)
    #   只在"正常走完 finally"时才删 —— 服务重启/崩溃时全部留下, 累积会把客户机磁盘写满
    #   (本轮排查磁盘实测残留 1.6GB+)。启动时进程不可能持有旧临时件 → 可安全直清;
    #   之后每 6 小时再扫一次, 只清 1 小时前的, 避免误删正在用的。
    try:
        import asyncio as _aio
        from backend import temp_sweep as _tsweep
        _n = len(_tsweep.sweep(force=True))
        if _n:
            print("[app] 启动清理遗留临时件: %d 个" % _n)

        async def _sweep_loop():
            while True:
                await _aio.sleep(6 * 3600)
                try:
                    _tsweep.sweep(age_seconds=3600)
                except Exception as _e:
                    print("[app] 周期清理临时件失败(忽略): %s" % _e)
        try:
            _aio.ensure_future(_sweep_loop())
        except Exception as _e:
            print("[app] 启动临时件周期清理任务失败(忽略): %s" % _e)
    except Exception as _e:
        print("[app] 启动清理临时件失败(忽略): %s" % _e)
    # v5.43.0 · FonrVFS: 把上次进程残留的 running 任务标记为 interrupted
    #   (否则界面上的任务永远转圈; 可续传的分片上传会给出续传入口)
    try:
        from backend.fonrvfs import jobs as _fonr_jobs
        _fonr_jobs.mark_interrupted_on_boot()
    except Exception as _e:
        print("[app] fonrvfs 中断任务标记失败: %s" % _e)
    # v5.20.0 · 授权模块形态自检: .so 会遮蔽 .py (Python 优先加载扩展模块),
    #   开发时改了 backend/license.py 却忘了重编译, 改动会**静默不生效**。启动即告警。
    try:
        import os as _os, glob as _glob
        _lic = __import__("backend.license", fromlist=["license"])
        _loaded = str(getattr(_lic, "__file__", "") or "")
        _sos = _glob.glob(_os.path.join(_os.path.dirname(__file__), "license.*.so"))
        if _loaded.endswith(".so") and _sos:
            _py = _os.path.join(_os.path.dirname(__file__), "license.py")
            if _os.path.exists(_py) and _os.path.getmtime(_py) > _os.path.getmtime(_sos[0]):
                print("[app] ⚠ backend/license.py 比 .so 新, 但当前加载的是 .so — "
                      "你的改动未生效! 请执行: bash scripts/build_license_so.sh")
        print(f"[app] 授权模块: {_os.path.basename(_loaded) or '?'} "
              f"({'编译产物' if _loaded.endswith('.so') else '源码'})")
    except Exception as _le:
        print(f"[app] 授权模块自检失败 (不阻断): {_le}")
    from backend import scheduler as _sched
    _sched.start()
    # v4.16.3 · 把主 asyncio loop 注入事件 broker（工作线程 publish 需要）
    import asyncio
    from backend import events as _events
    _events.set_main_loop(asyncio.get_running_loop())
    # v4.21.0 · 启动告警管道（订阅事件 → webhook）
    try:
        from backend import alerting as _alerting
        _alerting.start()
    except Exception as _e:
        print(f"[app] alerting start fail: {_e}")
    # v4.23.0 · 系统状态推送（每 30s publish system.stats）
    try:
        from backend import system_stats as _ss
        _ss.start(interval=30)
    except Exception as _e:
        print(f"[app] system_stats start fail: {_e}")
    # v4.40.0 · 网络共享持久挂载: 启动时自动重挂 last_status='ok' 的共享
    #   (异步后台执行, 不阻塞 startup -- mount.cifs 可能较慢)
    import asyncio as _aio
    # v5.19.7 · 核心运行状况看门狗: 周期自检 → 告警经事件总线推送 (alerting 路由)
    try:
        from backend.core_fabric import watchdog as _wd
        _wd.start_background()
    except Exception as _we:
        print(f"[app] watchdog start fail: {_we}")

    from backend.handlers.share import share_remount_all as _share_remount

    async def _share_startup_remount():
        try:
            results = await _share_remount()
            if results:
                print(f"[app] share startup remount: {sum(1 for x in results if x.get('ok'))}/{len(results)} ok")
        except Exception as _e:
            print(f"[app] share startup remount fail: {_e}")

    _aio.get_running_loop().create_task(_share_startup_remount())
    # v5.29.0 · HTTPS: 启动 60s 后跑一次证书到期检查 (auto_renew 时自动续期)
    async def _https_startup_check():
        await _aio.sleep(60)
        try:
            from backend.db import setting_get as _sg
            if _sg("https_enabled", "0") == "1" and _sg("https_auto_renew", "1") == "1":
                from backend import https_cert as _hc
                _r = await _aio.get_running_loop().run_in_executor(
                    None, lambda: _hc.renew_if_due(
                        threshold_days=int(_sg("https_renew_before_days", "30") or 30)))
                if _r.get("renewed"):
                    print(f"[https] 启动检查: 证书已自动续期 {_r}")
        except Exception as _e:
            print(f"[https] 启动续期检查失败 (不阻断): {_e}")
    _aio.get_running_loop().create_task(_https_startup_check())
    # v5.30.1 · HTTP→HTTPS 跳转服务 (原 web_port 上的 301 → https_port)
    if os.environ.get("FONRIV_HTTPS_REDIRECT_FROM"):
        async def _https_redirect_srv():
            try:
                from backend import https_redirect as _hr
                _from = int(os.environ["FONRIV_HTTPS_REDIRECT_FROM"])
                _to = int(os.environ.get("FONRIV_HTTPS_PORT", "8443"))
                _srv = await _hr.start(_from, _to)
                async with _srv:
                    await _srv.serve_forever()
            except Exception as _e:
                print(f"[https] 跳转服务启动失败 (不阻断): {_e}")
        _aio.get_running_loop().create_task(_https_redirect_srv())

    # v4.59.0 · 实时同步守护: 启动时拉起所有 enabled 规则的 inotifywait
    try:
        from backend.watcher import manager as _watch_mgr
        _watch_mgr.start_all()
        print("[app] watcher started")
    except Exception as _e:
        print(f"[app] watcher start fail: {_e}")
    # v5.8.0 · Transfer Fabric P1: 明细日志清理(30天) + 授权心跳 daemon
    try:
        from backend.core_fabric.job_registry import register_builtin_jobs as _rbj
        _rbj()
        print("[app] job registry builtin jobs registered")
    except Exception as _e:
        print(f"[app] job registry fail: {_e}")
    try:
        from backend.core_fabric import runlog as _runlog
        _n = _runlog.cleanup_expired()
        print(f"[app] runlog cleanup: {_n} expired files removed")
    except Exception as _e:
        print(f"[app] runlog cleanup fail: {_e}")
    # v6.14.0 · 批14(P0): 事件循环 watchdog —— 后台线程每 5s 往 loop 投心跳,
    #   心跳滞后 >20s = loop 被同步调用卡死(事故实锤: 根目录全池 SQL 在 loop 里跑)。
    #   立即写 ERROR 日志(含滞后秒数), 让"系统突然不能访问"在事后有据可查。
    import threading as _wth, time as _wtime, asyncio as _waio, logging as _wlog
    _wlog.getLogger("fonriv.loop").setLevel(_wlog.INFO)

    def _watchdog():
        loop = asyncio.get_event_loop()
        last = {"t": _wtime.time()}

        def _beat():
            last["t"] = _wtime.time()

        async def _ticker():
            while True:
                loop.call_soon_threadsafe(_beat)
                await asyncio.sleep(5)

        def _watch():
            while True:
                time.sleep(5)
                lag = time.time() - last["t"]
                if lag > 20:
                    _wlog.getLogger("fonriv.loop").error(
                        "事件循环疑似卡死: 心跳滞后 %.0fs —— 存在同步长调用在 loop 里执行"
                        "(最近操作见 fonriv_operations.log)", lag)

        _wth.Thread(target=_watch, daemon=True, name="loop-watchdog").start()
        loop.create_task(_ticker())

    try:
        _watchdog()
        print("[app] loop watchdog started (lag>20s -> ERROR log)")
    except Exception as _we:
        print("[app] loop watchdog fail: %s" % _we)
    # v1.0.0 · 社区版: 无远程授权心跳(不向任何厂商服务器外联)


@app.on_event("shutdown")
async def _rp_shutdown():
    from backend import scheduler as _sched
    await _sched.stop()
    # v4.59.0 · 停止全部 inotify 守护
    try:
        from backend.watcher import manager as _watch_mgr
        _watch_mgr.stop_all()
    except Exception:
        pass


# v4.88.0 · F5 REST API 开放
from backend.rest_api import register_rest_api as _register_rest
_register_rest(app)

# v5.99.9 · M9 · CloudPool 只读 WebDAV 出口(规格 §34.3)
from backend.rest_api import register_dav_api as _register_dav
_register_dav(app)

# ==================== 本地文件浏览 / 下载 API ====================

@app.get("/api/roots")
async def api_roots(token: Optional[str] = Query(None), x_auth_token: Optional[str] = Header(None)):
    _check_api_auth(token or x_auth_token)
    out = []
    for root in ALLOWED_ROOTS:
        p = Path(root)
        exists = p.exists()
        try:
            entries = len(list(p.iterdir())) if exists and p.is_dir() else 0
        except PermissionError:
            entries = 0
        out.append({"path": root, "exists": exists, "entries": entries})
    return {"roots": out, "api_auth": REQUIRE_API_AUTH}


@app.get("/api/browse")
async def api_browse(
    path: str = Query(...),
    token: Optional[str] = Query(None),
    x_auth_token: Optional[str] = Header(None),
):
    _check_api_auth(token or x_auth_token)
    p = _resolve_safe(path)
    if not p.exists():
        raise HTTPException(404, "path not found")
    if not p.is_dir():
        raise HTTPException(400, "not a directory")
    items = []
    try:
        entries = sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
    except PermissionError:
        raise HTTPException(403, "permission denied")
    for entry in entries:
        try:
            st = entry.stat()
            items.append({
                "name": entry.name,
                "path": str(entry),
                "is_dir": entry.is_dir(),
                "size": st.st_size if entry.is_file() else 0,
                "mtime": int(st.st_mtime),
            })
        except (PermissionError, OSError):
            continue
    parent = str(p.parent) if str(p) != "/" else ""
    try:
        _resolve_safe(parent)
    except HTTPException:
        parent = ""
    return {"path": str(p), "parent": parent, "items": items}


@app.get("/api/file-info")
async def api_file_info(
    path: str = Query(...),
    token: Optional[str] = Query(None),
    x_auth_token: Optional[str] = Header(None),
):
    _check_api_auth(token or x_auth_token)
    p = _resolve_safe(path)
    if not p.exists() or not p.is_file():
        raise HTTPException(404, "file not found")
    st = p.stat()
    return {"name": p.name, "path": str(p), "size": st.st_size, "mtime": int(st.st_mtime)}


@app.post("/api/upload")
async def api_upload(
    file: UploadFile = File(...),
    dest_dir: str = Form("/tmp/fonriv_uploads"),
    token: Optional[str] = Query(None),
    x_auth_token: Optional[str] = Header(None),
):
    """v2.6.4: 浏览器 → Fonriv 服务器 文件上传。保存到本地 dest_dir。
    上传成功后，前端可再通过 WS zfs_upload_file 把文件推到远端。"""
    _check_api_auth(token or x_auth_token)
    dest = _resolve_safe(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    safe_name = os.path.basename(file.filename or "upload.bin")
    target = dest / safe_name
    # 避免同名覆盖
    if target.exists():
        stem, suf = os.path.splitext(safe_name)
        from datetime import datetime as _dt
        ts = _dt.now().strftime("%Y%m%d_%H%M%S")
        target = dest / f"{stem}_{ts}{suf}"
    written = 0
    with target.open("wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)  # 1MB 分块
            if not chunk:
                break
            f.write(chunk)
            written += len(chunk)
    return JSONResponse({
        "status": "ok",
        "path": str(target),
        "size": written,
        "filename": target.name,
    })


# ═══ v5.56.0 C1 · 流式槽位闸（阶段C 传输与带宽治理）═════════════════════════
#   三条流式路由(本机 /api/file/stream · SSH /api/file/remote_stream · 云端 /api/fonr/stream)
#   统一经此占名额: 并发超限 → HTTP 429 并给出中文原因(含当前在途路数), 不排队挂死连接。
#   所有在途字节/路数/拒绝次数由 backend/fonrvfs/bwguard.py 统计, 经 fonr_stream_stats
#   与核心运行状况暴露（运维可见"正在流出多少、几路在跑、被拒几次"）。
# v1.0.0 · 本发行版不含云端带宽治理模块(backend/fonrvfs) → 槽位恒为 None(不占名额、不记账),
#   本机/SSH 流式走同一套 _bw_* 接口, 调用方无需分支。
async def _bw_slot(kind: str, label: str, size: int = 0):
    try:
        from backend.fonrvfs import bwguard as _bw
        from backend.fonrvfs.errors import FonrError
    except ImportError:
        return None                      # 模块不随本发行版交付 → 不占名额
    try:
        return await _bw.acquire(kind, label, size)
    except FonrError as e:
        raise HTTPException(429, getattr(e, "msg", None) or str(e))


def _bw_wrap(slot, gen):
    if slot is None:
        return gen
    try:
        from backend.fonrvfs import bwguard as _bw
    except ImportError:
        return gen
    return _bw.wrap(slot, gen)


def _bw_done(slot, size: int) -> None:
    """v5.59.0 E1 · sendfile 路径收尾: 补记字节(逐块计数不适用于内核零拷贝) + 归还并发名额。

    由 Starlette BackgroundTask 在响应发送结束后调用; 客户端中途断开时可能不触发,
    此时由 bwguard 的死连接回收(reap_stale)兜底, 不会永久占名额。
    """
    if slot is None:
        return
    try:
        from backend.fonrvfs import bwguard as _bw
    except ImportError:
        return
    try:
        _bw.credit(slot, int(size or 0))
    finally:
        _bw.release(slot)


@app.get("/api/file/stream")
async def api_file_stream(request: Request, path: str = Query(...), st: str = Query(...)):
    """v4.61.0 · 本机文件流式预览 (音视频 Range 播放/PDF 内嵌)。
    鉴权: WS 侧 file_stream_token 签发的一次性签名(与 WS 读取权限面一致), 不走静态白名单。"""
    from backend.handlers.file_ops import check_stream_token
    import mimetypes as _mt
    from fastapi.responses import StreamingResponse
    try:
        rp = Path(path).expanduser().resolve(strict=False)
    except Exception:
        raise HTTPException(400, "invalid path")
    if not check_stream_token(st, str(rp)):
        raise HTTPException(403, "stream token invalid or expired")
    if not rp.is_file():
        raise HTTPException(404, "file not found")
    fsize = rp.stat().st_size
    mime = _mt.guess_type(rp.name)[0] or "application/octet-stream"

    range_hdr = request.headers.get("range")

    def _iter(rng_start: int, rng_end: int, chunk: int = 256 * 1024):
        with open(rp, "rb") as f:
            f.seek(rng_start)
            remain = rng_end - rng_start + 1
            while remain > 0:
                buf = f.read(min(chunk, remain))
                if not buf:
                    break
                remain -= len(buf)
                yield buf

    if range_hdr and range_hdr.startswith("bytes="):
        try:
            spec = range_hdr[6:].split(",", 1)[0]
            s_s, e_s = spec.split("-", 1)
            start = int(s_s) if s_s else max(0, fsize - int(e_s))
            end = int(e_s) if e_s else fsize - 1
            end = min(end, fsize - 1)
            if start > end or start >= fsize:
                return StreamingResponse(iter([]), status_code=416,
                                         headers={"Content-Range": f"bytes */{fsize}"})
            # v5.56.0 C1: 流式槽位闸 (并发上限 + 在途流量观测)
            _slot = await _bw_slot("local", path, fsize)
            return StreamingResponse(_bw_wrap(_slot, _iter(start, end)), status_code=206,
                                     media_type=mime,
                                     headers={"Content-Range": f"bytes {start}-{end}/{fsize}",
                                              "Accept-Ranges": "bytes",
                                              "Content-Length": str(end - start + 1)})
        except Exception:
            pass
    _slot = await _bw_slot("local", path, fsize)
    return StreamingResponse(_bw_wrap(_slot, _iter(0, fsize - 1)) if fsize else iter([]),
                             media_type=mime, headers={"Accept-Ranges": "bytes",
                                                       "Content-Length": str(fsize)})


@app.get("/api/jobs/schema")
async def api_jobs_schema(token: Optional[str] = Query(None), x_auth_token: Optional[str] = Header(None)):
    """v5.10.0 · @register_job 注册表 → 前端表单/门控/AI 清单数据源"""
    _check_api_auth(token or x_auth_token)
    from backend.core_fabric.job_registry import jobs_schema
    return {"status": "ok", "jobs": jobs_schema()}


@app.post("/api/vnc_rec")
async def api_vnc_rec_upload(request: Request,
                             token: Optional[str] = Query(None),
                             x_auth_token: Optional[str] = Header(None),
                             host: str = Query("vnc")):
    """v5.23.0 · 远程桌面会话录制上传 (webm; vnc_record 闸)。body = 原始字节。"""
    _check_api_auth(token or x_auth_token)
    from backend import license as lic
    if not lic.feature_enabled("vnc_record"):
        return JSONResponse({"status": "error", "msg": "会话录制不在当前档位内"}, status_code=403)
    # v1.0.0 · 本发行版不含会话录制模块 → 501 (不再抛 ModuleNotFoundError)
    try:
        from backend.handlers import vnc_rec
    except ImportError:
        return JSONResponse({"status": "error", "msg": "会话录制未包含在本发行版中"}, status_code=501)
    body = await request.body()
    if not body or len(body) < 64:
        return JSONResponse({"status": "error", "msg": "录制内容为空"}, status_code=400)
    if len(body) > 512 * 1024 * 1024:
        return JSONResponse({"status": "error", "msg": "录制超过 512MB 上限"}, status_code=413)
    fn = await asyncio.to_thread(vnc_rec.save_upload, body, host)
    try:
        from backend.log import log_operation
        log_operation("远程桌面", f"保存会话录制 {fn} ({len(body)//1024} KB)")
    except Exception:
        pass
    return {"status": "ok", "file": fn, "size": len(body)}


@app.get("/api/vnc_rec")
async def api_vnc_rec_download(f: str = Query(""),
                               token: Optional[str] = Query(None),
                               x_auth_token: Optional[str] = Header(None)):
    """v5.23.0 · 会话录制回放流 (鉴权后回 webm)。"""
    _check_api_auth(token or x_auth_token)
    import re as _re
    # v1.0.0 · 本发行版不含会话录制模块 → 501 (不再抛 ModuleNotFoundError)
    try:
        from backend.handlers.vnc_rec import _dir, _feature_ok
    except ImportError:
        return JSONResponse({"status": "error", "msg": "会话录制未包含在本发行版中"}, status_code=501)
    if not _feature_ok():
        return JSONResponse({"status": "error", "msg": "会话录制不在当前档位内"}, status_code=403)
    if not _re.match(r"^rec_\w{8,15}_[A-Za-z0-9_.-]{1,64}\.webm$", f or ""):
        return JSONResponse({"status": "error", "msg": "非法文件名"}, status_code=400)
    fp = os.path.join(_dir(), f)
    if not os.path.exists(fp):
        return JSONResponse({"status": "error", "msg": "录制不存在"}, status_code=404)
    return FileResponse(fp, media_type="video/webm", filename=f)


@app.get("/api/runs")
async def api_runs(status: str = "", kind: str = "", limit: int = 100,
                   token: Optional[str] = Query(None), x_auth_token: Optional[str] = Header(None)):
    """v5.8.0 · 统一日志 L1 索引查询"""
    _check_api_auth(token or x_auth_token)
    from backend.core_fabric import runlog
    return {"status": "ok", "runs": runlog.list_runs(status=status, kind=kind, limit=limit)}


@app.get("/api/runs/{run_id}/detail")
async def api_run_detail(run_id: str, limit: int = 2000, tail: bool = True,
                         token: Optional[str] = Query(None), x_auth_token: Optional[str] = Header(None)):
    """v5.8.0 · 统一日志 L2 明细懒加载"""
    _check_api_auth(token or x_auth_token)
    from backend.core_fabric import runlog
    return {"status": "ok", "run_id": run_id,
            "detail": runlog.read_detail(run_id, limit=limit, tail_only=tail)}


@app.get("/api/file/remote_stream")
async def api_file_remote_stream(request: Request, path: str = Query(...), rst: str = Query(...)):
    """v4.93.0 · A5 远端文件 Range 流播: WS 侧 file_remote_stream_token 签发,
    Range 请求转换为远端 dd iflag=skip_bytes,count_bytes 按需读取。"""
    from backend.handlers.file_ops import check_remote_stream_token
    import asyncio as _asyncio
    import mimetypes as _mt
    import shlex as _shlex
    from fastapi.responses import StreamingResponse
    fields, fpath = check_remote_stream_token(rst, path)
    if not fields:
        raise HTTPException(403, "remote stream token invalid or expired")

    async def _stat_size():
        from backend.ssh_lib import SSHTarget
        t = SSHTarget.from_ws_data(fields)
        async with t.runner() as r:
            rc, out, _e = await r.exec(f"stat -c %s {_shlex.quote(fpath)} 2>/dev/null", timeout=15)
        return int(out.strip()) if rc == 0 and out.strip().isdigit() else 0

    fsize = await _stat_size()
    if not fsize:
        raise HTTPException(404, "file not found on remote")
    mime = _mt.guess_type(fpath.rsplit("/", 1)[-1])[0] or "application/octet-stream"
    range_hdr = request.headers.get("range", "")

    if range_hdr.startswith("bytes="):
        try:
            spec = range_hdr[6:].split(",", 1)[0]
            s_s, e_s = spec.split("-", 1)
            start = int(s_s) if s_s else max(0, fsize - int(e_s))
            end = int(e_s) if e_s else fsize - 1
            end = min(end, fsize - 1)
            if start > end or start >= fsize:
                return StreamingResponse(iter([]), status_code=416,
                                         headers={"Content-Range": f"bytes */{fsize}"})
        except Exception:
            start, end = 0, fsize - 1
    else:
        start, end = 0, fsize - 1

    length = end - start + 1
    dd_cmd = (f"dd if={_shlex.quote(fpath)} bs=64k iflag=skip_bytes,count_bytes "
              f"skip={start} count={length} 2>/dev/null")

    async def _iter():
        from backend.ssh_lib import SSHTarget
        t = SSHTarget.from_ws_data(fields)
        argv, env = t.runner().build_ssh_argv(dd_cmd)
        proc = await _asyncio.create_subprocess_exec(
            *argv, stdout=_asyncio.subprocess.PIPE, stderr=_asyncio.subprocess.DEVNULL, env=env)
        try:
            remain = length
            while remain > 0:
                buf = await proc.stdout.read(min(256 * 1024, remain))
                if not buf:
                    break
                remain -= len(buf)
                yield buf
        finally:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()

    _slot = await _bw_slot("ssh", path, fsize)
    return StreamingResponse(_bw_wrap(_slot, _iter()), status_code=206 if range_hdr else 200,
                             media_type=mime,
                             headers={"Content-Range": f"bytes {start}-{end}/{fsize}",
                                      "Accept-Ranges": "bytes",
                                      "Content-Length": str(length)})



async def _fonr_file_stream(sid: str, path: str, range_hdr: str, filename: Optional[str] = None):
    """FonrVFS 统一 Range 流式响应 (预览路由与分享路由共用)。

    返回 (StreamingResponse, meta) —— meta 含 size/mime/kind。
    """
    import mimetypes as _mt
    from fastapi.responses import StreamingResponse
    # v1.0.0 · 多云文件管理(FonrVFS)未包含在本发行版 → 统一 501, 不再抛 ModuleNotFoundError
    try:
        from backend.fonrvfs import stream as _s
        from backend.fonrvfs.vfs import VFS as _VFS
        from backend.handlers.fonrvfs import _mime as _m
    except ImportError:
        raise HTTPException(501, "多云文件管理未包含在本发行版中")

    stat = await _VFS.stat(sid, path)
    if stat.get("is_dir") or not stat.get("exists"):
        raise HTTPException(404, "not a file")
    fsize = int(stat.get("size") or 0)
    name = filename or path.rsplit("/", 1)[-1]
    kind, mime = _m.classify(path.rsplit("/", 1)[-1], False, fsize, None)
    adapter = await _VFS.adapter(sid)
    start, end = 0, max(0, fsize - 1)
    status_code = 200
    if range_hdr.startswith("bytes="):
        try:
            spec = range_hdr[6:].split(",", 1)[0]
            s_s, e_s = spec.split("-", 1)
            start = int(s_s) if s_s else max(0, fsize - int(e_s))
            end = int(e_s) if e_s else fsize - 1
            end = min(end, fsize - 1)
        except Exception:
            start, end = 0, max(0, fsize - 1)
        if start > end or start >= fsize:
            return StreamingResponse(iter([]), status_code=416,
                                     headers={"Content-Range": "bytes */%d" % fsize}), \
                {"size": fsize, "mime": mime, "kind": kind, "name": name}
        status_code = 206
    hdrs = {"Accept-Ranges": "bytes", "Content-Length": str(max(0, end - start + 1))}
    if status_code == 206:
        hdrs["Content-Range"] = "bytes %d-%d/%d" % (start, end, fsize)
    if filename:
        hdrs["Content-Disposition"] = "attachment; filename*=UTF-8''%s" % urllib.parse.quote(
            filename, safe="")
    elif kind == "image":
        hdrs["Cache-Control"] = "private, max-age=300"
    _slot = await _bw_slot("cloud", path, fsize)
    return StreamingResponse(_bw_wrap(_slot, _s.stream_open(adapter, path, start, end)),
                             status_code=status_code, media_type=mime, headers=hdrs), \
        {"size": fsize, "mime": mime, "kind": kind, "name": name}


async def _share_dir_page(request: Request, token: str, pw: str, rec: dict,
                           preview: int, p_rel: str, dl_rel):
    """v6.14.0 · 批14: **目录分享页** —— 目录链接的唯一实现(本机/SSH/云同一套)。

    - 浏览页(`?p=<相对路径>`): 访客台账照记(人数上限按 IP), **不耗下载次数**;
      权限档: preview 或 download 任一生效即可浏览(纯 download_only 也需先看列表才能下);
    - 文件下载(`?dl=<相对路径>`): 按**下载**权限档判定 + consume(计次数/人数);
    - 防穿越: 相对路径禁止 `..`/绝对跳脱, 全路径必须以分享根为前缀。
    """
    import html as _html
    from fastapi.responses import HTMLResponse
    # v1.0.0 · 多云文件分享未包含在本发行版 → 501 (入口路由已先挡, 此处兜底)
    try:
        from backend.fonrvfs import share as _share
        from backend.fonrvfs.vfs import VFS
    except ImportError:
        raise HTTPException(501, "多云文件分享未包含在本发行版中")

    def _safe_rel(x: str):
        parts = [s for s in str(x or "").split("/") if s not in ("", ".")]
        if any(s == ".." for s in parts):
            return None
        return "/".join(parts)

    root = str(rec.get("path") or "").rstrip("/") or "/"

    def _full(rel: str) -> str:
        return (root + "/" + rel) if root != "/" else ("/" + rel)

    _ip = ""
    try:
        _ip = (request.client.host if request.client else "") or ""
        _fwd = request.headers.get("x-forwarded-for") or ""
        if _fwd:
            _ip = _fwd.split(",")[0].strip() or _ip
    except Exception:
        _ip = ""
    _ua = request.headers.get("user-agent", "")

    # ── 文件下载分支 ──
    if dl_rel is not None and dl_rel != "":
        rel = _safe_rel(dl_rel)
        if rel is None:
            raise HTTPException(403, "非法路径")
        _r = _share.check(token, pw, consume=True, ip=_ip, ua=_ua, need="download")
        if _r is None:
            raise HTTPException(404, "分享链接无效、已过期、已达下载上限或已被撤销")
        if isinstance(_r, Exception):
            raise HTTPException(403, getattr(_r, "message", "") or "权限不足")
        full = _full(rel)
        st = await VFS.stat(rec["storage_id"], full)
        if not st.get("exists") or st.get("is_dir"):
            raise HTTPException(404, "文件不存在")
        resp, _meta = await _fonr_file_stream(rec["storage_id"], full,
                                              request.headers.get("range", ""),
                                              filename=os.path.basename(rel) or None)
        return resp

    # ── 浏览分支(不耗次数) ──
    _err = None
    _okc = False
    for _nd in ("preview", "download"):
        try:
            _r = _share.check(token, pw, consume=False, ip=_ip, ua=_ua, need=_nd)
        except Exception:
            _r = None
        if isinstance(_r, Exception):
            _err = _r
            continue
        if _r:
            _okc = True
            break
    if not _okc:
        raise HTTPException(403, getattr(_err, "message", "") or "权限不足")

    rel = _safe_rel(p_rel) if p_rel not in (None, "", "/") else ""
    if rel is None:
        raise HTTPException(403, "非法路径")
    base = _full(rel) if rel else root
    try:
        items = await VFS.list(rec["storage_id"], base)
    except Exception as e:
        raise HTTPException(500, "目录读取失败: %s" % str(e)[:160])

    def _href_q(**kw):
        from urllib.parse import urlencode
        q = {}
        if pw:
            q["pw"] = pw
        q.update(kw)
        return "?" + urlencode(q)

    dirs = [x for x in items if x.get("is_dir")]
    files = [x for x in items if not x.get("is_dir")]
    dirs.sort(key=lambda x: str(x.get("name", "")).lower())
    files.sort(key=lambda x: str(x.get("name", "")).lower())

    def _fmt_sz(n):
        try:
            n = int(n or 0)
        except Exception:
            n = 0
        for u in ("B", "KB", "MB", "GB", "TB"):
            if n < 1024 or u == "TB":
                return ("%d %s" % (n, u)) if u == "B" else ("%.1f %s" % (n, u))
            n /= 1024.0

    name = _html.escape(str(rec.get("name") or os.path.basename(root.rstrip("/")) or "共享目录"))
    rows = []
    if rel:
        parent = "/".join(rel.split("/")[:-1])
        rows.append('<tr><td colspan="3"><a href="%s">⬆ 上级目录</a></td></tr>'
                    % _href_q(p=("/" + parent) if parent else "/"))
    for x in dirs:
        sub = (rel + "/" + str(x.get("name"))) if rel else str(x.get("name"))
        rows.append('<tr><td>📁 <a href="%s">%s</a></td><td class="m">目录</td><td class="m"></td></tr>'
                    % (_href_q(p=sub), _html.escape(str(x.get("name") or ""))))
    for x in files:
        sub = (rel + "/" + str(x.get("name"))) if rel else str(x.get("name"))
        rows.append('<tr><td>📄 <a href="%s">%s</a></td><td class="m">%s</td><td class="m">%s</td></tr>'
                    % (_href_q(dl=sub), _html.escape(str(x.get("name") or "")),
                       _fmt_sz(x.get("size")), _html.escape(str(x.get("mtime") or ""))))
    n_dirs = " ".join('%s<a href="%s">%s</a>' % (
        "" if i == 0 else " / ",
        _href_q(p=("/" + "/".join(rel.split("/")[: i + 1])) if rel else "/" + seg),
        _html.escape(seg)) for i, seg in enumerate(rel.split("/") if rel else []))
    crumb = '<a href="%s">%s</a>' % (_href_q(p="/"), name) + (" " + n_dirs if n_dirs else "")
    page = """<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s · Fonriv 分享</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;background:#f6f8fa;color:#1f2328}
.hd{padding:14px 18px;background:#fff;border-bottom:1px solid #d8dee4}
.hd h1{font-size:16px;margin:0 0 4px}.crumb{font-size:12px;color:#57606a}
.wrap{max-width:860px;margin:16px auto;padding:0 12px}
table{width:100%%;border-collapse:collapse;background:#fff;border:1px solid #d8dee4;border-radius:8px;overflow:hidden}
td{padding:8px 12px;border-bottom:1px solid #eaeef2;font-size:13px}
td.m{color:#57606a;font-size:12px;white-space:nowrap}
tr:last-child td{border-bottom:0}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
.ft{text-align:center;color:#8b949e;font-size:11px;padding:16px}</style></head><body>
<div class="hd"><h1>📁 %s</h1><div class="crumb">%s &nbsp;·&nbsp; 共 %d 个目录 / %d 个文件</div></div>
<div class="wrap"><table>%s</table></div>
<div class="ft">由 Fonriv 分享 · 目录页浏览不计下载次数, 下载文件才计入</div>
</body></html>""" % (name, name, crumb, len(dirs), len(files), "".join(rows))
    return HTMLResponse(page)


@app.get("/api/fonr/share/{token}")
async def api_fonr_share(token: str, request: Request, pw: str = Query(""),
                         preview: int = Query(0)):
    """v5.44.0 · FonrVFS 分享链接 (外发下载) —— 无需登录, 靠 token+有效期+口令+次数/人数+权限档管控。

    口令错误返回 401 (可重试), 链接无效/过期/超次数/已撤销统一 404 (不泄露区别)。
    v5.99.0 · ① 权限档与人数上限在此**强制**(不在前端"藏按钮"就算完):
      · 仅预览(preview_only) → 只允许 `?preview=1` 的内嵌预览, 直接访问下载被 403;
      · 仅下载(download_only) → 只允许当附件下载, 内嵌预览被 403;
      · 非法/已满(人数上限) → 403 且给出人话原因(对方能看懂"为什么打不开")。
    ② 访问按客户端 IP 记入访客台账 → 同一 IP 反复访问只算 1 人, 超上限的新 IP 被拒。
    """
    # v1.0.0 · 多云文件分享未包含在本发行版 → 501 (不再抛 ModuleNotFoundError)
    try:
        from backend.fonrvfs import share as _share
    except ImportError:
        raise HTTPException(501, "多云文件分享未包含在本发行版中")
    _ip = ""
    try:
        _ip = (request.client.host if request.client else "") or ""
        _fwd = request.headers.get("x-forwarded-for") or ""
        if _fwd:
            _ip = _fwd.split(",")[0].strip() or _ip
    except Exception:
        _ip = ""
    _ua = request.headers.get("user-agent", "")
    _need = "preview" if preview else "download"
    # v6.14.0 · 批14: **目录分享**先判型 —— 目录页浏览不耗"下载次数"(逐文件下载才计),
    #   所以目录链接不能走下面 consume=True 的文件路径。
    _p_rel = request.query_params.get("p", "/")
    _dl_rel = request.query_params.get("dl", None)
    try:
        _rec0 = _share.check(token, pw, consume=False, ip="", ua="", need="")
    except Exception as e:
        raise HTTPException(500, "share check failed: %s" % e)
    if _rec0 is None:
        raise HTTPException(404, "分享链接无效、已过期、已达下载上限或已被撤销")
    if isinstance(_rec0, Exception):
        _c0 = getattr(_rec0, "code", "") or ""
        if _c0 == "auth":
            raise HTTPException(401, "需要口令: 请在链接后追加 ?pw=<口令>")
        raise HTTPException(403, getattr(_rec0, "message", "") or "权限不足")
    if int(_rec0.get("is_dir") or 0):
        return await _share_dir_page(request, token, pw, _rec0, preview, _p_rel, _dl_rel)
    try:
        rec = _share.check(token, pw, consume=True, ip=_ip, ua=_ua, need=_need)
    except Exception as e:
        raise HTTPException(500, "share check failed: %s" % e)
    if rec is None:
        raise HTTPException(404, "分享链接无效、已过期、已达下载上限或已被撤销")
    if isinstance(rec, Exception):                    # FonrError(auth/perm/viewers)
        _code = getattr(rec, "code", "") or ""
        _msg = getattr(rec, "message", "") or str(rec)
        if _code == "auth":
            raise HTTPException(401, "需要口令: 请在链接后追加 ?pw=<口令>")
        raise HTTPException(403, _msg)                # 权限不足 / 人数已满: 明确告知对方
    resp, meta = await _fonr_file_stream(rec["storage_id"], rec["path"],
                                         request.headers.get("range", ""),
                                         filename=(None if preview else (rec.get("name") or None)))
    # 仅预览场景由 _fonr_file_stream 决定 disposition(inline); 这里补一句"仅预览"提示头, 便于前端展示
    try:
        if _need == "preview":
            resp.headers["X-Fonr-Share-Mode"] = "preview"
    except Exception:
        pass
    return resp


@app.get("/api/fonr/stream")
async def api_fonr_stream(request: Request, sid: str = Query(...), path: str = Query(...),
                          st: str = Query(...)):
    """v5.41.0 · FonrVFS 云存储 Range 流播 —— 图片/音视频/PDF 内嵌预览与拖动播放。

    鉴权: WS 侧 fonr_stream_token 签发的一次性 token (绑定 storage_id+path, 权限面同 WS)。
    S3 系 provider 走真正的 Range GET (只取请求区间); 其它 provider 回退整对象暂存切片。
    本机/SSH 不经过这里 (复用 /api/file/stream 与 /api/file/remote_stream)。
    """
    # v1.0.0 · 多云文件管理(FonrVFS)未包含在本发行版 → 501 (不再抛 ModuleNotFoundError)
    try:
        from backend.fonrvfs import stream as _s
    except ImportError:
        raise HTTPException(501, "多云文件管理未包含在本发行版中")

    if not _s.check(st, sid, path):
        raise HTTPException(403, "stream token invalid or expired")
    resp, _meta = await _fonr_file_stream(sid, path, request.headers.get("range", ""))
    return resp


@app.get("/api/fonr/dl")
async def api_fonr_dl(request: Request, sid: str = Query(...), path: str = Query(...),
                      st: str = Query(...), name: str = Query("")):
    """v5.59.0 E1-1/E1-3 · **浏览器直下**（三层零中转优先，阶段E 数据路径强化）。

    ① 本机 / 已挂载的网络共享（SMB/NFS 挂载后等同本机文件）
         → `FileResponse`：**内核 sendfile 零拷贝**，不再经过 Python 读循环；
    ② 云对象存储（provider 声明 `presign`）
         → **302 跳转**到带签名的临时 URL（`response-content-disposition` 参与签名，
            使跨域直连也按"下载"处理）——**后端出网流量 = 0**；
    ③ SSH / 未声明 presign 的存储
         → 回落 `_fonr_file_stream` 的区间流（dd 按需读，**不落盘**），仍受 C1 并发闸保护。

    鉴权: 与 /api/fonr/stream 同一枚一次性 token（绑定 storage_id + path）。
    """
    from fastapi.responses import FileResponse, RedirectResponse
    from starlette.background import BackgroundTask

    # v1.0.0 · 多云文件管理(FonrVFS)未包含在本发行版 → 501 (不再抛 ModuleNotFoundError)
    try:
        from backend.fonrvfs import stream as _s
        from backend.fonrvfs import vfs as _vfs
        from backend.fonrvfs import bwguard as _bw
    except ImportError:
        raise HTTPException(501, "多云文件管理未包含在本发行版中")

    if not _s.check(st, sid, path):
        raise HTTPException(403, "download token invalid or expired")
    _name = (name or path.rsplit("/", 1)[-1] or "download").replace('"', "").replace("\n", " ").strip()
    if not _name:
        _name = "download"
    # v5.90.6 · filename="..." 引号段只允许 ASCII (中文名会 latin-1 编码崩 500), UTF-8 段走 RFC5987
    _ascii = _name.encode("ascii", "ignore").decode() or "download"
    _disp = "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (
        _ascii, urllib.parse.quote(_name))
    try:
        adapter = await _vfs.VFS.adapter(sid)
    except Exception as e:
        raise HTTPException(404, "存储不可用: %s" % str(e)[:120])
    # ① 本机 / 已挂载共享（SMB/NFS 挂载后等同本机文件）→ 内核 sendfile
    _lp = getattr(adapter, "local_path", None)
    if callable(_lp):
        # 鉴权基调与 /api/file/stream 一致: **以一次性 token 为准**(WS 侧已过页面权限 + 归属闸),
        #   不套静态目录白名单(否则用户在 FonrVFS 里浏览到的普通路径一律下不动)。
        #   仅保留最基础的结构校验: 必须是绝对路径且不含 `..`。
        _raw = str(_lp(path) or "")
        if not _raw.startswith("/") or ".." in _raw.split("/"):
            raise HTTPException(400, "路径不合法")
        p = Path(_raw)
        if not p.is_file():
            raise HTTPException(404, "file not found")
        try:
            _size = p.stat().st_size
        except OSError:
            _size = 0
        slot = await _bw_slot("local", str(p), _size)
        resp = FileResponse(
            str(p),
            media_type=(mimetypes.guess_type(p.name)[0] or "application/octet-stream"),
            headers={"Content-Disposition": _disp})
        # sendfile 无法逐块计数 → 由后台任务在响应结束时一次性记账并归还名额
        resp.background = BackgroundTask(_bw_done, slot, _size)
        return resp
    # ② 云端 → 302 预签名直连（后端零带宽）
    _pre = getattr(adapter, "presign", None)
    if callable(_pre) and getattr(getattr(adapter, "caps", None), "presign", False):
        try:
            r = await _pre("GET", path, 900,
                           extra_query={"response-content-disposition": _disp})
            if r and r.get("url"):
                return RedirectResponse(r["url"], status_code=302,
                                        headers={"Cache-Control": "no-store"})
        except Exception as e:
            log.info("fonr/dl: 预签名失败, 回落流式 (%s): %s", sid, e)
    # ③ SSH / 其它 → 区间流(不落盘, 受并发闸)
    resp, _meta = await _fonr_file_stream(sid, path, request.headers.get("range", ""),
                                          filename=_name)
    return resp


@app.get("/api/download")
async def api_download(
    path: str = Query(...),
    token: Optional[str] = Query(None),
    x_auth_token: Optional[str] = Header(None),
):
    _check_api_auth(token or x_auth_token)
    p = _resolve_safe(path)
    if not p.exists() or not p.is_file():
        raise HTTPException(404, "file not found")
    mime, _ = mimetypes.guess_type(p.name)
    return FileResponse(
        str(p),
        media_type=mime or "application/octet-stream",
        filename=p.name,
    )


@app.get("/api/download-batch")
async def api_download_batch(
    paths: str = Query(..., description="换行或 | 分隔的多个绝对路径"),
    name: str = Query("fonriv_bundle", description="下载文件名（不含后缀）"),
    token: Optional[str] = Query(None),
    x_auth_token: Optional[str] = Header(None),
):
    """将多个文件/目录打包为 tar 流式返回。所有路径必须在白名单内。"""
    _check_api_auth(token or x_auth_token)
    raw = [s.strip() for s in paths.replace("|", "\n").splitlines() if s.strip()]
    if not raw:
        raise HTTPException(400, "no paths given")
    resolved: List[Path] = []
    for r in raw:
        p = _resolve_safe(r)
        if not p.exists():
            raise HTTPException(404, f"not found: {r}")
        resolved.append(p)

    def gen():
        # 使用 pipe: TarFile 写入 BytesIO 缓冲片段，边生成边 yield
        buf = io.BytesIO()
        tar = tarfile.open(fileobj=buf, mode="w|")
        try:
            for p in resolved:
                # arcname 用文件/目录自身名字，避免泄露完整绝对路径
                tar.add(str(p), arcname=p.name, recursive=True)
                data = buf.getvalue()
                if data:
                    yield data
                buf.seek(0)
                buf.truncate(0)
        finally:
            tar.close()
            data = buf.getvalue()
            if data:
                yield data

    safe_name = "".join(c if c.isalnum() or c in "-_." else "_" for c in name) or "bundle"
    headers = {"Content-Disposition": f'attachment; filename="{safe_name}.tar"'}
    return StreamingResponse(gen(), media_type="application/x-tar", headers=headers)


# 优雅关闭
_original_sigterm = None


async def _graceful_shutdown():
    from backend.ssh import active_tasks
    if active_tasks:
        task_ids = list(active_tasks.keys())
        for tid in task_ids:
            from backend.ssh import kill_process
            await kill_process(tid)


def register_signal_handlers():
    def handler(sig, frame):
        asyncio.ensure_future(_graceful_shutdown())
        os.kill(os.getpid(), signal.SIGINT)
    try:
        signal.signal(signal.SIGTERM, handler)
    except (OSError, ValueError) as _e: logging.debug("suppressed", exc_info=True)
def setup_websocket():
    from backend.ws import websocket_endpoint
    app.websocket("/ws")(websocket_endpoint)
    print("[setup] /ws 已注册", flush=True)

    # v5.20.0 · VM/主机 控制台: 独立 WS 端点, 只做 RFB 字节透传。
    #   为什么独立: /ws 是按 JSON action 分发的, 而 VNC/RFB 是二进制字节流,
    #   塞进 JSON 帧会破坏协议对齐。见 backend/vnc_bridge.py 模块说明。
    from backend.vnc_bridge import bridge as _vnc_bridge, raw_bridge as _vnc_raw

    @app.websocket("/ws/vnc")
    async def _ws_vnc(websocket):
        print("[setup] /ws/vnc 路由注册成功", flush=True)
        print("[ws/vnc] 连接到达", flush=True)
        # 两种模式 (v5.20.2+):
        #   mode=pve (默认): /ws/vnc?node=&vmid=&kind=  → PVE vncwebsocket 通路
        #   mode=raw       : /ws/vnc?mode=raw&vhost=&vport= → 任意标准 VNC 服务器 (TCP↔WS 透传)
        q = dict(websocket.query_params)
        mode = (q.get("mode") or "pve").strip().lower()
        await websocket.accept()
        # v5.20.2 · 会话恢复: /ws/vnc 是独立 WS (不经过 /ws 的 token 自动恢复逻辑),
        #   必须先用 auth_token 恢复会话, 否则 require_auth 恒失败 → noVNC 端表现为
        #   "连接已断开" (实测踩过)
        _tok = (q.get("auth_token") or "").strip()
        if _tok:
            try:
                from backend.auth import restore_session_by_token
                restore_session_by_token(websocket, _tok)
            except Exception:
                pass
        if mode == "raw":
            vhost = (q.get("vhost") or "").strip()
            vport = int(q.get("vport") or 5900)
            if not vhost:
                await websocket.close(code=4400)
                return
            await _vnc_raw(websocket, vhost=vhost, vport=vport,
                           password=q.get("vpassword") or "")
            return
        node = (q.get("node") or "").strip()
        vmid = (q.get("vmid") or "").strip()
        kind = (q.get("kind") or "qemu").strip().lower()
        if not node or not vmid:
            await websocket.close(code=4400)
            return
        if kind not in ("qemu", "lxc"):
            kind = "qemu"
        await _vnc_bridge(websocket, node=node, vmid=vmid, kind=kind)

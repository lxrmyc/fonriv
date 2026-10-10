"""v6.2.0 · 在线更新 (检查更新 / 下载 / 校验 / 应用 / 重启)

设计要点:
  · 升级服务器 = 一个静态 HTTP 目录(任何 PC 都能当): 放 update.json + fonriv-<ver>.tar.gz(.sha256)
  · 本模块只做「检查 + 下载 + 校验 + 落盘」; 真正的替换/重启交给 scripts/apply_update.sh
    —— 服务进程不该自己覆盖自己, 由外部脚本在进程退出后原子替换再拉起(见脚本头注释)。
  · 安全口径(项目红线): 必须校验 sha256, 校验不通过**绝不应用**; 下载只允许 http(s),
    且落盘路径固定在 updates/ 目录内, 不用远端提供的文件名做路径拼接(防目录穿越)。
"""
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error

from backend.version import VERSION

log = logging.getLogger("fonriv.update")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # 项目根(handler 在 backend/handlers/ 下, 需三层)
UPD_DIR = os.path.join(ROOT, "updates")                                  # 下载落盘目录
APPLY_SCRIPT = os.path.join(ROOT, "scripts", "apply_update.sh")
LOG_FILE = os.path.join(ROOT, "data", "update.log")
STATE_FILE = os.path.join(UPD_DIR, "state.json")                         # 最近一次检查/更新结果(重启后仍可查)


def _log(msg: str):
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass
    log.info(msg)


def _state_get() -> dict:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _state_set(d: dict):
    try:
        os.makedirs(UPD_DIR, exist_ok=True)
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log.warning("state 写入失败: %s", e)


def _ver_tuple(v: str):
    """'6.0.4' → (6,0,4); 非数字段忽略(容错 beta 后缀)。"""
    out = []
    for p in str(v or "").strip().lstrip("v").split("."):
        num = ""
        for ch in p:
            if ch.isdigit():
                num += ch
            else:
                break
        out.append(int(num) if num else 0)
    while len(out) < 3:
        out.append(0)
    return tuple(out[:4])


# ─── v1.0.0 · 社区版升级通道 ────────────────────────────────────────────────────
# 社区版升级包发布在 GitHub Releases —— 默认直接查 GitHub(无厂商服务器依赖):
#   GET https://api.github.com/repos/<repo>/releases/latest
#   → 取 fonriv-community-v<ver>-linux-amd64.tar.gz 与同名 .sha256 资产
# 仍以 sha256 做**强制校验**(不通过拒绝应用), HTTPS 保证传输完整性。
# 若 `app_settings.update_server` 配置了自建静态目录(检查更新弹窗里的
#   「⚙ 升级服务器地址」), 则**优先**走该地址(仍读 update.json):
#   update.json → <base>/update.json · 升级包 → <base>/fonriv-<ver>.tar.gz
# DEFAULT_UPDATE_SERVER 非空时作为未配置时的内置默认; 社区版留空 = 走 GitHub。
DEFAULT_UPDATE_SERVER = ""
GITHUB_REPO = "lxrmyc/fonriv"


def _server_base(cfg: dict) -> str:
    """升配地址解析: 显式配置 > 内置默认。返回归一化后的 base(无尾斜杠)。"""
    base = str((cfg or {}).get("update_server") or "").strip() or DEFAULT_UPDATE_SERVER
    base = base.rstrip("/")
    if not (base.startswith("http://") or base.startswith("https://")):
        base = "http://" + base
    return base


def server_source(cfg: dict) -> str:
    """地址来源: setting(用户配置) / default(内置默认) —— 前端据此提示, 不谎报。"""
    return "setting" if str((cfg or {}).get("update_server") or "").strip() else "default"


def _gh_check() -> dict:
    """社区版默认通道: 查 GitHub Releases 最新版(tar.gz + .sha256 资产)。"""
    api = "https://api.github.com/repos/%s/releases/latest" % GITHUB_REPO
    mark = "github:" + GITHUB_REPO
    try:
        req = urllib.request.Request(api, headers={
            "Accept": "application/vnd.github+json", "User-Agent": "Fonriv/%s" % VERSION})
        with urllib.request.urlopen(req, timeout=10) as resp:
            rel = json.loads(resp.read(512 * 1024).decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"status": "error", "server": mark, "server_source": "github",
                    "msg": "GitHub 上还没有已发布的 Release（发布 Releases 后此项即可用）· "
                           "也可点「⚙ 升级服务器地址」改走自建静态目录"}
        return {"status": "error", "server": mark, "server_source": "github",
                "msg": "查询 GitHub Releases 失败: HTTP %s · 也可点「⚙ 升级服务器地址」改走自建静态目录" % e.code}
    except Exception as e:
        return {"status": "error", "server": mark, "server_source": "github",
                "msg": "连接 GitHub Releases 失败: %s · 也可点「⚙ 更新通道地址」改走自建静态目录" % e}
    latest = str(rel.get("tag_name") or "").strip().lstrip("vV")
    assets = rel.get("assets") or []
    pkg = next((a for a in assets if str(a.get("name", "")).endswith(".tar.gz")), None)
    sha = next((a for a in assets if str(a.get("name", "")).endswith(".tar.gz.sha256")), None)
    if not latest or not pkg:
        return {"status": "error", "server": mark, "server_source": "github",
                "msg": "GitHub Release 缺少版本号或 tar.gz 资产(%s)" % api}
    digest = ""
    if sha:
        try:
            with urllib.request.urlopen(urllib.request.Request(
                    sha.get("browser_download_url"), headers={"User-Agent": "Fonriv/%s" % VERSION}),
                    timeout=10) as r:
                digest = (r.read(4096).decode("utf-8", "replace").split() or [""])[0].strip().lower()
        except Exception:
            digest = ""
    result = {
        "current": VERSION,
        "latest": latest,
        "has_update": _ver_tuple(latest) > _ver_tuple(VERSION),
        "notes": rel.get("body") or "",
        "published_at": str(rel.get("published_at") or "")[:10],
        "size": pkg.get("size"),
        "sha256": digest,
        "package_url": pkg.get("browser_download_url"),
        "server": mark,
        "server_source": "github",       # 前端据此标注"GitHub Releases"
    }
    st = _state_get()
    st.update({"last_check": time.strftime("%Y-%m-%d %H:%M:%S"), "last_result": result})
    _state_set(st)
    _log("检查更新(GitHub): 当前 v%s, 最新 v%s, 有更新=%s" % (VERSION, latest, result["has_update"]))
    return {"status": "ok", **result}


def check(cfg: dict) -> dict:
    """拉取升级服务器上的 update.json 并与当前版本比较。
    未配置自建地址且无内置默认 → 走 GitHub Releases(社区版默认)。"""
    cfg = cfg or {}
    if not str(cfg.get("update_server") or "").strip() and not DEFAULT_UPDATE_SERVER:
        return _gh_check()
    base = _server_base(cfg)
    src = server_source(cfg)
    url = base + "/update.json"
    # v6.3.44 · 批 D: 失败信息必须**带上用的是哪个地址 + 怎么改**, 否则用户看到"连不上"却不知道
    #   连的是哪里(默认地址是内置的, 用户没填过 —— 必须说清楚)。
    _hint = base + ("(内置默认地址)" if src == "default" else "(你配置的地址)") + " · 可在弹窗里点「⚙ 升级服务器地址」修改"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Fonriv/%s" % VERSION})
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read(256 * 1024)
        info = json.loads(raw.decode("utf-8", "replace"))
    except urllib.error.URLError as e:
        return {"status": "error", "server": base, "server_source": src,
                "msg": "连接升级服务器失败: %s · %s" % (getattr(e, "reason", e), _hint)}
    except Exception as e:
        return {"status": "error", "server": base, "server_source": src,
                "msg": "解析 update.json 失败(%s): %s · %s" % (url, e, _hint)}

    latest = str(info.get("version") or "").strip()
    if not latest:
        return {"status": "error", "msg": "升级服务器 update.json 缺少 version 字段"}
    cur_t, new_t = _ver_tuple(VERSION), _ver_tuple(latest)
    has_update = new_t > cur_t
    pkg = info.get("package") or ("fonriv-%s.tar.gz" % latest)
    result = {
        "current": VERSION,
        "latest": latest,
        "has_update": has_update,
        "notes": info.get("notes") or "",
        "published_at": info.get("published_at") or "",
        "size": info.get("size"),
        "sha256": (info.get("sha256") or "").strip().lower(),
        "package_url": base + "/" + str(pkg).lstrip("/"),
        "server": base,
        "server_source": src,        # v6.3.44 · 批 D: setting / default(前端如实标注)
    }
    st = _state_get()
    st.update({"last_check": time.strftime("%Y-%m-%d %H:%M:%S"), "last_result": result})
    _state_set(st)
    _log("检查更新: 当前 v%s, 服务器 v%s, 有更新=%s" % (VERSION, latest, has_update))
    return {"status": "ok", **result}


def _download(url: str, dest: str) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": "Fonriv/%s" % VERSION})
    with urllib.request.urlopen(req, timeout=30) as resp, open(dest, "wb") as f:
        n = 0
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
            n += len(chunk)
    return n


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def apply(cfg: dict) -> dict:
    """下载 → sha256 校验 → 交给 apply_update.sh(替换 + 重启)。"""
    cfg = cfg or {}
    _use_gh = (not str(cfg.get("update_server") or "").strip() and not DEFAULT_UPDATE_SERVER)
    if not _use_gh and not _server_base(cfg):
        return {"status": "error", "msg": "升级服务器地址为空(内置默认也缺失, 请检查配置)"}
    chk = check(cfg)
    if chk.get("status") != "ok":
        return chk
    if not chk.get("has_update"):
        return {"status": "ok", "applied": False, "msg": "已是最新版本 v%s" % VERSION, **chk}
    ver = chk["latest"]
    want = (chk.get("sha256") or "").lower()
    if not want:
        return {"status": "error",
                "msg": ("GitHub Release 未提供 .sha256 资产" if _use_gh else "服务器 update.json 未提供 sha256")
                       + ", 拒绝应用(安全口径)"}
    if not os.path.exists(APPLY_SCRIPT):
        return {"status": "error", "msg": "缺少应用脚本 scripts/apply_update.sh"}

    os.makedirs(UPD_DIR, exist_ok=True)
    dest = os.path.join(UPD_DIR, "fonriv-%s.tar.gz" % ver)     # 名字由**版本号**决定, 不用远端字段拼路径
    try:
        n = _download(chk["package_url"], dest)
    except Exception as e:
        return {"status": "error", "msg": "下载失败: %s" % e}
    got = _sha256_file(dest)
    if got != want:
        try:
            os.remove(dest)
        except Exception:
            pass
        _log("校验失败: 期望 %s, 实际 %s (已删除下载文件, 不应用)" % (want, got))
        return {"status": "error", "msg": "sha256 校验不通过(期望 %s… 实际 %s…), 已删除下载文件, 拒绝应用" % (want[:12], got[:12])}
    _log("下载并校验通过: %s (%d bytes, sha256 %s)" % (dest, n, got[:12]))

    st = _state_get()
    st.update({"last_apply": time.strftime("%Y-%m-%d %H:%M:%S"), "applied_version": ver})
    _state_set(st)

    # 交给外部脚本(异步, 后台替换 + 重启; 本服务进程随后会被脚本停止)
    # 关键参数从**当前服务进程**取, 保证重启后与现在完全一致(同解释器/同端口/同监听地址);
    # venv 路径经 env FONRIV_PY 传递(测试实例无 venv 时也能用对解释器)
    port = os.environ.get("FONRIV_EFFECTIVE_PORT") or os.environ.get("FONRIV_PORT") or "8000"
    host = os.environ.get("FONRIV_HOST") or "0.0.0.0"
    env = dict(os.environ)
    env["FONRIV_PY"] = sys.executable
    try:
        subprocess.Popen(["/bin/bash", APPLY_SCRIPT, dest, ver, str(port), str(host)],
                         cwd=ROOT, start_new_session=True, env=env,
                         stdout=open(os.path.join(UPD_DIR, "apply.log"), "a"), stderr=subprocess.STDOUT)
    except Exception as e:
        return {"status": "error", "msg": "启动应用脚本失败: %s" % e}
    return {"status": "ok", "applied": True, "version": ver, "sha256": got,
            "msg": "已下载并校验通过, 正在后台应用 v%s 并重启服务…" % ver}


def status() -> dict:
    st = _state_get()
    return {"status": "ok", "current": VERSION, "updates_dir": UPD_DIR,
            "apply_script": os.path.exists(APPLY_SCRIPT), **st}


def _setting_get(key: str, default: str = "") -> str:
    """项目真实 KV: app_settings(settings handler 同款 API —— config_get 只在 __all__ 里未实现)"""
    try:
        from backend import db as _db
        v = _db.setting_get(key, default)
        return str(v) if v not in (None, "") else default
    except Exception:
        return default


def cfg_from_db(user_id: int = 1) -> dict:
    return {"update_server": _setting_get("update_server", "")}


# ────────────────────────── WS handlers ──────────────────────────
async def _reply(ws, data, payload):
    payload.setdefault("type", "result")
    payload.setdefault("req_id", data.get("req_id") or "")
    await ws.send_json(payload)


async def handle_update_check(ws, data, task_id=None):
    try:
        cfg = cfg_from_db()
        if data.get("update_server"):
            cfg["update_server"] = str(data.get("update_server")).strip()
        r = check(cfg)
    except Exception as e:
        r = {"status": "error", "msg": "检查更新异常: %s: %s" % (type(e).__name__, e)}
    await _reply(ws, data, r)


async def handle_update_apply(ws, data, task_id=None):
    try:
        cfg = cfg_from_db()
        if data.get("update_server"):
            cfg["update_server"] = str(data.get("update_server")).strip()
        r = apply(cfg)
    except Exception as e:
        r = {"status": "error", "msg": "应用更新异常: %s: %s" % (type(e).__name__, e)}
    await _reply(ws, data, r)


async def handle_update_status(ws, data, task_id=None):
    try:
        r = status()
    except Exception as e:
        r = {"status": "error", "msg": str(e)}
    await _reply(ws, data, r)

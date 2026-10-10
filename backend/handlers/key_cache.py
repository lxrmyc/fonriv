"""Fonriv · v5.90.2 密钥缓存中心 (key_cache)

用途: 用户在连接中心/文件传输选认证密钥时, 可以直接「从已存服务器 / 远端存储」取密钥,
      也可粘贴密钥内容 —— 统一落到控制机缓存目录后再交给 ssh 使用。

安全设计 (用户明确要求: 做好泄漏与劫持防护):
  ① 缓存目录 0700 / 文件 0600, 属主即服务进程用户, 他人不可读;
  ② 大小上限 64KB —— 私钥都 < 32KB, 超限直接拒绝 (防借道批量拖任意文件);
  ③ 内容嗅探: 必须含 "PRIVATE KEY" 头才落盘 (防把缓存目录劫持成任意文件仓库);
  ④ 返回 sha256 供界面展示, 用户可与服务端指纹比对, 发现被替换;
  ⑤ 密钥内容永不写日志; 文件名只允许 [A-Za-z0-9._-] (防路径穿越);
  ⑥ 提供 key_cache_list / key_cache_clear, 缓存可见、可清。

actions:
  key_cache_fetch {src_kind:'server'|'cloud', host,port,user,path | remote_id,key}
  key_cache_put   {name?, content}
  key_cache_list  {}
  key_cache_clear {}
"""
from __future__ import annotations

import hashlib
import os
import re
import time
from typing import Optional

from backend.log import log_operation

MAX_KEY_BYTES = 65536          # 64KB 上限
CACHE_DIR_NAME = "key_cache"

_NAME_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def _cache_dir() -> str:
    """缓存目录: <数据目录>/key_cache (0700)。数据目录以 backend.db 的库文件位置为准。"""
    from backend import db
    db_path = getattr(db, "DB_PATH", "") or os.path.join(os.getcwd(), "data", "fonriv.db")
    root = os.path.dirname(os.path.abspath(db_path))
    d = os.path.join(root, CACHE_DIR_NAME)
    os.makedirs(d, mode=0o700, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    return d


def _sniff_key(content: bytes) -> bool:
    """必须是私钥形态 (OPENSSH/RSA/EC/PUTTY 均以 -----BEGIN xxx PRIVATE KEY----- 开头)。"""
    try:
        head = content[:512].decode("utf-8", "replace")
    except Exception:
        return False
    return "BEGIN" in head and "PRIVATE KEY" in head


def _save(content: bytes, name_hint: str) -> dict:
    if not content:
        return {"ok": False, "msg": "内容为空"}
    if len(content) > MAX_KEY_BYTES:
        return {"ok": False, "msg": f"文件过大 ({len(content)} B, 上限 {MAX_KEY_BYTES}) — 私钥不会这么大, 已拒绝"}
    if not _sniff_key(content):
        return {"ok": False, "msg": "内容不含 PRIVATE KEY 头 — 已拒绝缓存 (只允许私钥文件)"}
    base = _NAME_SAFE.sub("_", os.path.basename(name_hint or "key"))[:60] or "key"
    if not base.startswith("key_"):
        base = "key_" + base
    if not base.endswith(".pem"):
        base += ".pem"
    path = os.path.join(_cache_dir(), base)
    with open(path, "wb") as f:
        f.write(content)
    os.chmod(path, 0o600)
    return {"ok": True, "path": path, "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest()}


async def _fetch_from_server(ws, data: dict) -> dict:
    """经 SSH 从「已存服务器」取密钥: 凭据按档案/活跃会话解析(与 sp_resolve 同源)。"""
    from backend.ssh_lib import SSHTarget
    host = (data.get("host") or "").strip()
    path = (data.get("path") or "").strip()
    if not host or not path:
        return {"ok": False, "msg": "缺少 host / path"}
    port = data.get("port") or 22
    user = (data.get("user") or "").strip()

    creds = {"auth_type": "pass", "password": "", "key": "", "passphrase": ""}
    try:
        from backend.handlers.server_profile import resolve_ssh_creds
        r = resolve_ssh_creds(ws, host, port, user)
        if r:
            creds.update({k: v for k, v in r.items() if v})
    except Exception as e:
        print("[key_cache] resolve fail:", e)
    payload = {"host": host, "port": port, "user": user or (creds.get("user") or "root"),
               "auth_type": creds.get("auth_type") or "pass",
               "password": creds.get("password") or "", "key": creds.get("key") or "",
               "passphrase": creds.get("passphrase") or ""}
    import asyncio
    try:
        target = SSHTarget.from_ws_data(payload)
        async with target.runner() as run:
            code, out, _ = await run.exec(
                "head -c %d %s 2>/dev/null" % (MAX_KEY_BYTES + 1, "'" + path.replace("'", "'\\''") + "'"),
                timeout=25)
    except Exception as e:
        return {"ok": False, "msg": f"SSH 读取失败: {type(e).__name__}: {str(e)[:120]}"}
    if code != 0 or not out:
        return {"ok": False, "msg": f"读取失败 (rc={code}): 文件不存在或无权限"}
    raw = out.encode("utf-8", "replace") if isinstance(out, str) else out
    return _save(raw, f"{host}_{os.path.basename(path)}")


async def _fetch_from_cloud(ws, data: dict) -> dict:
    """从「远端存储」(rclone 系) 下载密钥 → 校验 → 入缓存。"""
    # v1.0.0 · 远端存储未包含在本发行版 → 明确报错 (不再抛 ModuleNotFoundError)
    try:
        from backend.handlers.remotes import _resolve_remote, build_from_config
    except ImportError:
        return {"ok": False, "msg": "云端密钥读取未包含在本发行版中"}
    import asyncio
    import tempfile
    rid = data.get("remote_id") or 0
    key = (data.get("key") or data.get("path") or "").strip()
    if not key:
        return {"ok": False, "msg": "缺少远端路径 key"}
    cfg, rid2, _uuid = _resolve_remote({"remote_id": rid})
    if not cfg:
        return {"ok": False, "msg": "远端存储不存在 (检查 remote_id)"}
    fd, tmp = tempfile.mkstemp(prefix="kc_", suffix=".bin")
    os.close(fd)
    try:
        storage = build_from_config(cfg)
        await asyncio.to_thread(storage.download_file, key, tmp)
        sz = os.path.getsize(tmp)
        if sz > MAX_KEY_BYTES:
            return {"ok": False, "msg": f"文件过大 ({sz} B, 上限 {MAX_KEY_BYTES}) — 已拒绝"}
        with open(tmp, "rb") as f:
            content = f.read()
        return _save(content, f"{cfg.get('provider','cloud')}_{os.path.basename(key)}")
    except Exception as e:
        return {"ok": False, "msg": f"远端下载失败: {type(e).__name__}: {str(e)[:120]}"}
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


async def handle_key_cache_fetch(ws, data: dict, task_id: str = ""):
    _req = data.get("req_id") or ""
    kind = (data.get("src_kind") or "").strip().lower()
    if kind == "server":
        r = await _fetch_from_server(ws, data)
    elif kind == "cloud":
        r = await _fetch_from_cloud(ws, data)
    else:
        r = {"ok": False, "msg": "src_kind 仅支持 server / cloud"}
    if r.get("ok"):
        log_operation("密钥缓存", f"取自 {kind} → {os.path.basename(r['path'])} ({r['bytes']}B)")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **r,
                            "msg": f"✓ 已缓存到控制机 (0600) · {r['bytes']} B · sha256 {r['sha256'][:12]}…"})
    else:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": r.get("msg") or "获取失败"})


async def handle_key_cache_put(ws, data: dict, task_id: str = ""):
    _req = data.get("req_id") or ""
    content = data.get("content") or ""
    name = (data.get("name") or "").strip() or "pasted"
    r = _save(content.encode("utf-8", "replace"), "pasted_" + name)
    if r.get("ok"):
        log_operation("密钥缓存", f"粘贴内容 → {os.path.basename(r['path'])}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **r,
                            "msg": f"✓ 已保存 ({r['bytes']} B) · sha256 {r['sha256'][:12]}…"})
    else:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": r.get("msg") or "保存失败"})


async def handle_key_cache_list(ws, data: dict, task_id: str = ""):
    _req = data.get("req_id") or ""
    d = _cache_dir()
    items = []
    try:
        for fn in sorted(os.listdir(d)):
            p = os.path.join(d, fn)
            if not os.path.isfile(p):
                continue
            st = os.stat(p)
            with open(p, "rb") as f:
                sha = hashlib.sha256(f.read()).hexdigest()[:12]
            items.append({"name": fn, "path": p, "bytes": st.st_size,
                          "mtime": int(st.st_mtime), "sha256": sha})
    except OSError:
        pass
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "dir": d, "items": items})


async def handle_key_cache_clear(ws, data: dict, task_id: str = ""):
    _req = data.get("req_id") or ""
    d = _cache_dir()
    n = 0
    try:
        for fn in os.listdir(d):
            p = os.path.join(d, fn)
            if os.path.isfile(p):
                os.unlink(p)
                n += 1
    except OSError:
        pass
    log_operation("密钥缓存", f"清理 {n} 个文件")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "cleared": n, "msg": f"✓ 已清理 {n} 个缓存密钥文件"})

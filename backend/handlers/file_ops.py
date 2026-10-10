"""Fonriv - 文件查看/编辑/管理 handler (v4.58.0)

通过 SSH 隧道实现远端文件的读取/写入/删除/重命名/压缩/解压。
本机文件直接操作。所有命令参数经 shlex.quote 防注入。
"""
from __future__ import annotations

import asyncio
import os
import re
import base64
import shlex
import time
import uuid
from fastapi import WebSocket, WebSocketDisconnect

def _htmlescape(s: str) -> str:
    """HTML 转义用户可控文本, 防反射 XSS (v5.28.5 安全审计修复)"""
    return (s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")
             .replace('"',"&quot;").replace("'","&#x27;"))

from backend.ssh_lib import SSHTarget, ssh_error_msg
from backend.log import log_operation

_MAX_READ = 5 * 1024 * 1024  # 5MB 编辑上限

# v4.61.0 · 流式预览签名 token (一次性表, 60s 有效; 权限面与 WS 读取一致)
_STREAM_TOKENS: dict[str, tuple[str, float]] = {}


def issue_stream_token(path: str, ttl: int = 120) -> str:
    tok = uuid.uuid4().hex
    _STREAM_TOKENS[tok] = (path, time.time() + ttl)
    return tok


def issue_dir_stream_token(base_dir: str, ttl: int = 900) -> str:
    """v5.1.0 · 目录级 token: 该目录及其子路径下所有文件均可用同一 token 流式读取。

    用于相册/缩略图批量取图 (旧实现逐文件签发, 一次几十个 WS 往返, 部分超时 → 图不显示)。
    """
    tok = uuid.uuid4().hex
    _STREAM_TOKENS[tok] = ("DIR:" + base_dir.rstrip("/"), time.time() + ttl)
    now = time.time()
    for k in [k for k, (_, exp) in _STREAM_TOKENS.items() if exp < now]:
        _STREAM_TOKENS.pop(k, None)
    # 顺手清理过期
    now = time.time()
    for k in [k for k, (_, exp) in _STREAM_TOKENS.items() if exp < now]:
        _STREAM_TOKENS.pop(k, None)
    return tok


def check_stream_token(tok: str, path: str) -> bool:
    item = _STREAM_TOKENS.get(tok or "")
    if not item:
        return False
    p, exp = item
    if time.time() > exp:
        _STREAM_TOKENS.pop(tok, None)
        return False
    if p == path:
        return True
    # v5.1.0 · 目录级 token: 允许该目录(含子目录)下的任意文件
    if p.startswith("DIR:"):
        base = p[4:].rstrip("/")
        rp = (path or "").rstrip("/")
        return rp == base or rp.startswith(base + "/")
    return False


def _target(data: dict) -> SSHTarget:
    return SSHTarget.from_ws_data(data)


async def _exec(target, cmd, timeout=30):
    if target and target.host:
        async with target.runner() as run:
            code, out, _ = await run.exec(cmd, timeout=timeout, merge_stderr=True)
            return code, out
    import subprocess as sp
    r = sp.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout


async def handle_file_read(ws, data: dict):
    """读取远端/本地文件内容 (base64 传输, 前端解码)。
    params: host/port/user/auth_type/password(SSH), path, max_size"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少 path"})
        return
    max_size = min(int(data.get("max_size") or _MAX_READ), _MAX_READ)
    try:
        target = _target(data)
        # 先检查文件大小
        cmd_size = f"stat -c %s {shlex.quote(path)} 2>/dev/null || echo 0"
        rc, out = await _exec(target, cmd_size, timeout=10)
        size = int(out.strip() or 0)
        if size > max_size:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"文件过大 ({size // 1024}KB > {max_size // 1024}KB)，不支持在线编辑"})
            return
        # base64 读取 (防二进制乱码)
        cmd_read = f"base64 {shlex.quote(path)} 2>/dev/null"
        rc, b64_out = await _exec(target, cmd_read, timeout=30)
        if rc != 0:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"读取失败: {_htmlescape((b64_out or '').strip()[:150])}"})
            return
        import base64 as b64mod
        content_bytes = b64mod.b64decode(b64_out.strip())
        # 检测是否文本文件 (无 null 字节)
        is_binary = b'\x00' in content_bytes[:4096]
        content = content_bytes.decode("utf-8", "replace") if not is_binary else ""
        if is_binary:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": "二进制文件不支持在线编辑，请使用传输功能"})
            return
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "path": path, "size": size, "content": content,
                            "is_binary": False})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"读取异常: {ssh_error_msg(str(e))}"})


async def handle_file_write(ws, data: dict):
    """写入远端/本地文件。params: path, content, host/...(SSH)"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    content = data.get("content") or ""
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少 path"})
        return
    try:
        target = _target(data)
        b64 = base64.b64encode(content.encode("utf-8")).decode()
        cmd = f"echo {shlex.quote(b64)} | base64 -d > {shlex.quote(path)}.tmp && mv {shlex.quote(path)}.tmp {shlex.quote(path)}"
        rc, out = await _exec(target, cmd, timeout=30)
        if rc != 0:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"写入失败: {_htmlescape((out or '').strip()[:150])}"})
            return
        log_operation("文件编辑", f"写入 {path}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id, "msg": "保存成功"})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"写入异常: {ssh_error_msg(str(e))}"})


async def handle_file_delete(ws, data: dict):
    """删除文件/目录。params: path, recursive(默认 true)
    v5.22.1 · 云端对象: 携带 remote_id (或 remote_uuid) 时 path 为云端 key,
    走 provider.delete_object (此前 delete_object 在各 provider 已实现但无入口)。
    """
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path or path == "/":
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "非法路径"})
        return
    if data.get("remote_id") or data.get("remote_uuid"):
        # v1.0.0 · 远端存储未包含在本发行版 → 明确报错 (不再抛 ModuleNotFoundError)
        try:
            from backend.handlers.remotes import _resolve_remote
            from backend.remotes import build_from_config
        except ImportError:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": "云端对象删除未包含在本发行版中"})
            return
        cfg, rid, _ru = _resolve_remote(data)
        if not cfg:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": "remote 不存在 (检查 remote_id)"})
            return
        try:
            storage = build_from_config(cfg)
            ok, msg = await asyncio.to_thread(storage.delete_object, path)
            if ok:
                log_operation("[远端存储] 删除", f"{cfg.get('name')} · {path}")
                await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                                    "msg": f"✓ 已删除云端对象 {_htmlescape(path)}"})
            else:
                await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                    "msg": f"删除失败: {_htmlescape(msg)}"})
        except Exception as e:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"云端删除异常: {_htmlescape(str(e))}"})
        return
    recursive = "-rf" if data.get("recursive", True) else ""
    try:
        target = _target(data)
        cmd = f"rm {recursive} {shlex.quote(path)} 2>&1"
        rc, out = await _exec(target, cmd, timeout=30)
        if rc == 0:
            log_operation("文件管理", f"删除 {path}")
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id, "msg": "删除成功"})
        else:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"删除失败: {(out or '').strip()[:150]}"})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"删除异常: {ssh_error_msg(str(e))}"})


async def handle_file_rename(ws, data: dict):
    """重命名/移动。params: old_path, new_path"""
    _req_id = data.get("req_id") or ""
    old_path = (data.get("old_path") or "").strip()
    new_path = (data.get("new_path") or "").strip()
    if not old_path or not new_path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少路径"})
        return
    try:
        target = _target(data)
        cmd = f"mv {shlex.quote(old_path)} {shlex.quote(new_path)} 2>&1"
        rc, out = await _exec(target, cmd, timeout=30)
        if rc == 0:
            log_operation("文件管理", f"重命名 {old_path} → {new_path}")
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id, "msg": "重命名成功"})
        else:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"重命名失败: {(out or '').strip()[:150]}"})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"重命名异常: {ssh_error_msg(str(e))}"})


async def handle_file_mkfile(ws, data: dict):
    """v5.17.0 · 新建文件 (空文件或指定内容)。params: path, content(可选), no_clobber(默认true)
    目标区高频需求: 先建占位文件/命名再传; 默认不覆盖已存在文件以免误伤。"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少路径"})
        return
    if ".." in path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "路径不允许含 .."})
        return
    content = data.get("content")
    no_clobber = data.get("no_clobber", True)
    try:
        target = _target(data)
        parent = os.path.dirname(path.rstrip("/")) or "/"
        # test -e 判定 + 父目录自动创建; content 为空 → touch
        guard = "[ -e {p} ] && echo EXISTS || ".format(p=shlex.quote(path)) if no_clobber else ""
        if content:
            import base64 as _b64
            _b = _b64.b64encode(str(content).encode("utf-8")).decode()
            write_cmd = f"echo {shlex.quote(_b)} | base64 -d > {shlex.quote(path)}"
        else:
            write_cmd = f": > {shlex.quote(path)}"
        cmd = (f"mkdir -p {shlex.quote(parent)} 2>&1 && "
               f"{guard}{write_cmd} 2>&1 && stat -c %s {shlex.quote(path)} 2>/dev/null")
        rc, out = await _exec(target, cmd, timeout=20)
        txt = (out or "").strip()
        if "EXISTS" in txt and no_clobber:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"文件已存在: {os.path.basename(path)} (未覆盖)"})
            return
        if rc != 0:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"创建失败: {txt[-200:]}"})
            return
        size = txt.splitlines()[-1] if txt else "0"
        log_operation("文件管理", f"新建文件 {path}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "msg": f"文件已创建 · {int(size) if size.isdigit() else 0} B",
                            "path": path, "size": int(size) if size.isdigit() else 0})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"创建异常: {ssh_error_msg(str(e))}"})


async def handle_file_chmod(ws, data: dict):
    """v5.90.5 · 修改远端文件/目录权限与属主 (chmod/chown)。
    params: path, mode(3-4位八进制, 可空), owner(可空), group(可空)"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    mode = str(data.get("mode") or "").strip()
    owner = str(data.get("owner") or "").strip()
    group = str(data.get("group") or "").strip()
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少路径"})
        return
    import re as _re
    if mode and not _re.fullmatch(r"[0-7]{3,4}", mode):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "权限格式错误 (需 3-4 位八进制): %s" % mode})
        return
    if not mode and not owner and not group:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "未指定任何修改项"})
        return
    try:
        target = _target(data)
        q = shlex.quote(path)
        parts = []
        if mode:
            parts.append(f"chmod {shlex.quote(mode)} {q}")
        og = owner + (":" + group if group else "")
        if og.strip(": "):
            parts.append(f"chown {shlex.quote(og)} {q}")
        cmd = " && ".join(parts) + f" && stat -c %a:%U:%G {q}"
        rc, out = await _exec(target, cmd, timeout=20)
        txt = (out or "").strip().splitlines()[-1] if (out or "").strip() else ""
        if rc != 0 or ":" not in txt:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"修改失败: {(out or '').strip()[:200]}"})
            return
        a, u, g = (txt.split(":") + ["", "", ""])[:3]
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "path": path, "perms": a, "owner": f"{u}:{g}",
                            "msg": f"✓ 已应用 {a} {u}:{g}".strip()})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"修改失败: {e}"})


async def handle_file_mkdir(ws, data: dict):
    """创建目录。params: path (可多级)"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少路径"})
        return
    try:
        target = _target(data)
        cmd = f"mkdir -p {shlex.quote(path)} 2>&1"
        rc, out = await _exec(target, cmd, timeout=15)
        if rc == 0:
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id, "msg": "目录创建成功"})
        else:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"创建失败: {(out or '').strip()[:150]}"})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"创建异常: {ssh_error_msg(str(e))}"})


async def handle_file_compress(ws, data: dict):
    """压缩文件/目录 (v4.69.0 · 多格式 + 密码)。params: path, format(targz|tarbz2|tarxz|tarzst|zip|7z), dest, password, level"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    fmt = (data.get("format") or "targz").strip().lower()
    # 兼容旧参数名 (tar.gz / zip)
    fmt = {"tar.gz": "targz", "tgz": "targz", "tar.bz2": "tarbz2",
           "tar.xz": "tarxz", "tar.zst": "tarzst", "7z": "7z"}.get(fmt, fmt)
    dest_dir = (data.get("dest") or os.path.dirname(path.rstrip("/"))).strip()
    password = data.get("password") or ""
    level = int(data.get("level") or 6)
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少 path"})
        return
    from backend import archive_util as au
    paths = data.get("paths") or []   # v5.28.3 · 多路径批量压缩
    split_size = (data.get("split_size") or "").strip()
    cmd, out_path, err = au.build_compress(path, dest_dir, fmt, password, level,
                                           split_size=split_size,
                                           paths=[p.strip() for p in paths if p.strip()] or None)
    if err:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": err})
        return
    try:
        target = _target(data)
        await _exec(target, f"mkdir -p {shlex.quote(dest_dir)}", timeout=10)
        rc, out = await _exec(target, cmd, timeout=1800)
        if rc == 0:
            _, sz = await _exec(target, f"stat -c %s {shlex.quote(out_path)} 2>/dev/null || echo 0", timeout=10)
            size = (sz or "0").strip()
            log_operation("文件管理", f"压缩 {path} → {out_path} ({fmt})" + (" [加密]" if password else ""))
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                                "msg": f"压缩成功 · {os.path.basename(out_path)} ({size} bytes)"
                                       + (" · 已加密" if password else ""),
                                "path": out_path})
        else:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"压缩失败: {(out or '').strip()[-200:]}"})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"压缩异常: {ssh_error_msg(str(e))}"})



async def handle_file_extract(ws, data: dict):
    """解压文件 (v4.69.0 · 多格式 + 密码)。params: archive_path, dest_dir, password"""
    _req_id = data.get("req_id") or ""
    archive = (data.get("archive_path") or "").strip()
    dest = (data.get("dest_dir") or "").strip()
    password = data.get("password") or ""
    if not archive:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "缺少 archive_path"})
        return
    if not dest:
        name = os.path.basename(archive)
        for suf in (".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tbz", ".tar.xz", ".txz",
                    ".tar.zst", ".tzst", ".tar.lz4", ".tar", ".zip", ".jar", ".7z", ".rar",
                    ".gz", ".bz2", ".xz", ".zst"):
            if name.lower().endswith(suf):
                name = name[: -len(suf)]
                break
        dest = os.path.join(os.path.dirname(archive), (name or "extracted") + "_extracted")
    from backend import archive_util as au
    cmd, err = au.build_extract(archive, dest, password)
    if err:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": err})
        return
    try:
        target = _target(data)
        rc, out = await _exec(target, cmd, timeout=3600)
        if rc == 0:
            log_operation("文件管理", f"解压 {archive} → {dest}" + (" [密码]" if password else ""))
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                                "msg": f"解压成功 → {dest}", "dest": dest})
        else:
            msg = (out or "").strip()[-200:]
            hint = ""
            low = msg.lower()
            if any(k in low for k in ("password", "encrypted", "密码")):
                hint = " · 该归档已加密, 请在解压时填写密码"
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"解压失败: {msg}{hint}"})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"解压异常: {ssh_error_msg(str(e))}"})



async def handle_file_read_raw(ws, data: dict):
    """读取文件原始内容 (base64 返回, 用于图片等二进制预览)。params: path, max_size(默认20MB)"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少 path"})
        return
    max_size = min(int(data.get("max_size") or 20 * 1024 * 1024), 50 * 1024 * 1024)
    try:
        target = _target(data)
        rc, out = await _exec(target, f"stat -c %s {shlex.quote(path)} 2>/dev/null || echo 0", timeout=10)
        # v4.98.0 · 防御: 远端返回非数字 (权限不足/路径不存在/命令缺失) 时旧实现 int() 抛
        #   ValueError → 外层 ssh_error_msg(e) 再崩 → 用户只看到"服务端处理异常"; 现明确报错
        _m = re.search(r"\d+", out or "")
        size = int(_m.group(0)) if _m else -1
        if size < 0:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"无法读取文件信息 (路径不存在或无权限): {path}"})
            return
        if size > max_size:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"文件过大 ({size // 1048576}MB > {max_size // 1048576}MB)，不支持预览"})
            return
        rc, b64_out = await _exec(target, f"base64 -w0 {shlex.quote(path)} 2>/dev/null", timeout=60)
        if rc != 0:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"读取失败: {_htmlescape((b64_out or '').strip()[:150])}"})
            return
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "path": path, "size": size,
                            "content_b64": (b64_out or "").strip()})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"读取异常: {ssh_error_msg(str(e))}"})


async def handle_file_archive_list(ws, data: dict):
    """列出归档内容 (v4.69.0 · 多格式 + 密码, 免解压)。params: archive_path, limit, password"""
    _req_id = data.get("req_id") or ""
    archive = (data.get("archive_path") or "").strip()
    limit = min(int(data.get("limit") or 200), 2000)
    password = data.get("password") or ""
    if not archive:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "缺少 archive_path"})
        return
    from backend import archive_util as au
    cmd, err = au.build_list(archive, limit, password)
    if err:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": err})
        return
    try:
        target = _target(data)
        rc, out = await _exec(target, cmd, timeout=600)
        text = (out or "").strip()
        low = text.lower()
        # 加密归档未给密码时的明确提示
        if any(k in low for k in ("password", "encrypted", "enter password", "密码")):
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": "该归档已加密 · 请填写密码后重试", "need_password": True})
            return
        if rc != 0 and not text:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"读取失败 (rc={rc})"})
            return
        files = [l for l in text.splitlines() if l.strip()]
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "archive": archive, "files": "\n".join(files),
                            "count": len(files),
                            "format": au.detect_format(archive) or "unknown"})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"列表异常: {ssh_error_msg(str(e))}"})



# ── v4.93.0 · A2 大文件分块读取 ──

async def handle_file_read_range(ws, data: dict):
    """分块读取文件 (本机或远端)。params: path, offset(默认0), length(默认512KB, 上限2MB), host可选
    返回 {data(b64), offset, length, total_size, eof}"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    try:
        offset = max(0, int(data.get("offset") or 0))
        length = min(max(1, int(data.get("length") or 524288)), 2 * 1024 * 1024)
    except Exception:
        offset, length = 0, 524288
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少 path"})
        return
    try:
        target = _target(data) if data.get("host") else None
        if target and target.host:
            cmd = (f"stat -c %s {shlex.quote(path)} 2>/dev/null; "
                   f"dd if={shlex.quote(path)} bs={length} iflag=skip_bytes,count_bytes "
                   f"skip={offset} count={length} 2>/dev/null | base64 -w0")
            rc, out = await _exec(target, cmd, timeout=60)
            if rc != 0 and not out.strip():
                await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                    "msg": f"读取失败: {(out or '').strip()[:150]}"})
                return
            lines = out.strip().split("\n", 1)
            total = int(lines[0]) if lines and lines[0].strip().isdigit() else 0
            b64 = lines[1] if len(lines) > 1 else ""
        else:
            if not os.path.isfile(path):
                await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                    "msg": "文件不存在"})
                return
            total = os.path.getsize(path)
            with open(path, "rb") as f:
                f.seek(offset)
                chunk = f.read(length)
            b64 = base64.b64encode(chunk).decode()
        got = len(base64.b64decode(b64)) if b64 else 0
        eof = (offset + got) >= total
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "path": path, "offset": offset, "length": got,
                            "total_size": total, "eof": eof, "data": b64})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"分块读取失败: {e}"})


# ── v4.93.0 · A5 远端音视频 Range 流播 token ──
_REMOTE_STREAM_TOKENS: dict[str, dict] = {}


def issue_remote_stream_token(target_fields: dict, base_path: str, ttl: int = 900) -> str:
    tok = uuid.uuid4().hex
    now = time.time()
    _REMOTE_STREAM_TOKENS[tok] = {"target": dict(target_fields or {}), "base": base_path,
                                  "exp": now + ttl}
    for k in [k for k, v in _REMOTE_STREAM_TOKENS.items() if v["exp"] < now]:
        _REMOTE_STREAM_TOKENS.pop(k, None)
    return tok


def check_remote_stream_token(tok: str, subpath: str):
    """校验 token 并返回 (target_fields, full_path) 或 (None, None)。subpath 须在 base 目录之下。"""
    item = _REMOTE_STREAM_TOKENS.get(tok or "")
    if not item or time.time() > item["exp"]:
        return None, None
    base = item["base"].rstrip("/")
    full = (subpath or "").strip()
    if full != base and not full.startswith(base + "/"):
        return None, None
    return item["target"], full


async def handle_file_remote_stream_token(ws, data: dict):
    """A5: 为远端文件/目录签发 Range 流播 token (15 分钟, /api/file/remote_stream 用)。
    params: host/port/user/auth..., path (文件或目录; 目录则其下文件均可播)"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path or not data.get("host"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "缺少 host 或 path"})
        return
    try:
        target = _target(data)
        async with target.runner() as run:
            code, out, _e = await run.exec(
                f"test -e {shlex.quote(path)} && echo ok", timeout=15)
        if code != 0:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": "远端路径不可访问"})
            return
        base = path if out.strip() == "ok" and not path.endswith("*") else path
        # 目录 → 以目录为 base; 文件 → 以其父目录为 base (同目录批量播放)
        if "." in path.rsplit("/", 1)[-1]:
            base = path.rsplit("/", 1)[0] or "/"
        fields = {k: data.get(k) for k in ("host", "port", "user", "auth_type",
                                           "password", "key_path", "passphrase") if data.get(k)}
        tok = issue_remote_stream_token(fields, base)
        log_operation("文件流播", f"签发远端流播 token: {target.host}:{path}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "token": tok, "ttl": 900, "base": base})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"签发失败: {e}"})


async def handle_file_stream_token(ws, data: dict):
    """为本机文件签发流式预览 token (60s 一次性, 供 /api/file/stream Range 播放)。params: path"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "缺少 path"})
        return
    # v5.1.0 · 目录 → 目录级 token (相册/缩略图批量取图用, 一次签发覆盖整个目录)
    if os.path.isdir(path):
        tok = issue_dir_stream_token(path)
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "token": tok, "ttl": 900, "dir": True, "base": path})
        return
    if not os.path.isfile(path):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "文件不存在或不可读"})
        return
    tok = issue_stream_token(path)
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                        "token": tok, "ttl": 60})


async def handle_file_tail(ws, data: dict):
    """读取文件尾部 N KB (日志实时跟踪用)。params: path, size(默认64KB)"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少 path"})
        return
    size = min(int(data.get("size") or 65536), 512 * 1024)
    try:
        target = _target(data)
        cmd = (f"stat -c %s {shlex.quote(path)} 2>/dev/null; "
               f"tail -c {size} {shlex.quote(path)} 2>/dev/null | base64 -w0")
        rc, out = await _exec(target, cmd, timeout=20)
        if rc != 0 and not out.strip():
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"读取失败: {(out or '').strip()[:150]}"})
            return
        lines = out.strip().splitlines()
        fsize = int(lines[0]) if lines and lines[0].isdigit() else 0
        b64part = "\n".join(lines[1:]) if len(lines) > 1 else ""
        content = base64.b64decode(b64part).decode("utf-8", "replace") if b64part else ""
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "path": path, "size": fsize, "chunk": content})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"读取异常: {ssh_error_msg(str(e))}"})


async def handle_file_archive_extract_one(ws, data: dict):
    """从归档提取单个成员 (v4.69.0 · 多格式 + 密码)。params: archive_path, member, dest_dir, password"""
    _req_id = data.get("req_id") or ""
    archive = (data.get("archive_path") or "").strip()
    member = (data.get("member") or "").strip().lstrip("./")
    dest = (data.get("dest_dir") or "").strip()
    password = data.get("password") or ""
    if not archive or not member:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "缺少 archive_path 或 member"})
        return
    if not dest:
        name = os.path.basename(archive)
        for suf in (".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tbz", ".tar.xz", ".txz",
                    ".tar.zst", ".tzst", ".tar.lz4", ".tar", ".zip", ".7z", ".rar"):
            if name.lower().endswith(suf):
                name = name[: -len(suf)]
                break
        dest = os.path.join(os.path.dirname(archive), (name or "extracted") + "_extracted")
    from backend import archive_util as au
    cmd, err = au.build_extract_one(archive, member, dest, password)
    if err:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": err})
        return
    try:
        target = _target(data)
        rc, out = await _exec(target, cmd, timeout=1800)
        if rc == 0:
            log_operation("文件管理", f"提取 {member} ← {archive}")
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                                "msg": f"已提取 {member} → {dest}", "dest": dest})
        else:
            msg = (out or "").strip()[-200:]
            hint = " · 该归档已加密, 请填写密码" if any(
                k in msg.lower() for k in ("password", "encrypted", "密码")) else ""
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"提取失败: {msg}{hint}"})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"提取异常: {ssh_error_msg(str(e))}"})



async def handle_file_stat(ws, data: dict):
    """获取文件/目录属性。params: path"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少 path"})
        return
    try:
        target = _target(data)
        cmd = (f"stat --format='%s|%F|%Y|%a|%U:%G' {shlex.quote(path)} 2>/dev/null && "
               f"file -b --mime-type {shlex.quote(path)} 2>/dev/null")
        rc, out = await _exec(target, cmd, timeout=15)
        if rc != 0:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"文件不存在: {path}"})
            return
        lines = (out or "").strip().splitlines()
        parts = lines[0].split("|") if lines else []
        mime = lines[1].strip() if len(lines) > 1 else ""
        size = int(parts[0]) if len(parts) > 0 and parts[0].isdigit() else 0
        ftype = parts[1] if len(parts) > 1 else ""
        mtime = parts[2] if len(parts) > 2 else ""
        perms = parts[3] if len(parts) > 3 else ""
        owner = parts[4] if len(parts) > 4 else ""
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "path": path, "size": size, "file_type": ftype,
                            "mtime": mtime, "perms": perms, "owner": owner, "mime": mime})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"异常: {ssh_error_msg(str(e))}"})


async def handle_archive_tools_check(ws, data: dict):
    """归档工具检测 (v4.69.0): 返回可用工具/缺失工具/建议安装包/支持格式"""
    from backend import archive_util as au
    tools = au.detect_tools()
    missing = [n for n, p in tools.items() if not p]
    pkgs = au.install_pkgs_for_missing(tools)
    fmt_status = []
    for f in au.SUPPORTED_LIST:
        fmt_status.append({**f, "available": bool(au.tool_for(f["key"]))})
    await ws.send_json({"type": "result", "status": "ok",
                        "tools": tools, "missing": missing,
                        "install_pkgs": pkgs,
                        "formats": fmt_status,
                        "compress_formats": au.COMPRESS_FORMATS})


async def handle_archive_formats(ws, data: dict):
    """返回支持的归档格式清单 (供前端下拉)"""
    from backend import archive_util as au
    await ws.send_json({"type": "result", "status": "ok",
                        "compress_formats": au.COMPRESS_FORMATS,
                        "list_formats": au.SUPPORTED_LIST})


async def handle_file_copy(ws, data: dict):
    """复制/移动文件·目录 (v4.71.0)。params: src, dst, move(默认false), overwrite"""
    _req_id = data.get("req_id") or ""
    src = (data.get("src") or "").strip()
    dst = (data.get("dst") or "").strip()
    if not src or not dst:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "缺少 src 或 dst"})
        return
    if src == dst:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "源与目标相同"})
        return
    # 防目录递归自复制 (cp a a/b 会无限嵌套)
    if dst.startswith(src.rstrip("/") + "/"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "不能把目录复制到其自身子目录"})
        return
    move = bool(data.get("move"))
    overwrite = data.get("overwrite", True)
    qs, qd = shlex.quote(src), shlex.quote(dst)
    parent = os.path.dirname(dst.rstrip("/")) or "/"
    flags = "-a"
    if move:
        flags = "-a"
    cmd = f"mkdir -p {shlex.quote(parent)} 2>&1 && {'mv' if move else 'cp'} {flags}{'' if overwrite else ' -n'} {qs} {qd} 2>&1"
    try:
        target = _target(data)
        rc, out = await _exec(target, cmd, timeout=1800)
        if rc == 0:
            log_operation("文件管理", f"{'移动' if move else '复制'} {src} → {dst}")
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                                "msg": f"{'移动' if move else '复制'}成功 → {dst}", "dst": dst})
        else:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"失败: {(out or '').strip()[-200:]}"})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"异常: {ssh_error_msg(str(e))}"})


async def handle_dir_size(ws, data: dict):
    """目录占用分析 (v4.71.0): 返回当前目录总计 + Top N 子项。params: path, top(默认15)"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip().rstrip("/") or "/"
    top = min(int(data.get("top") or 15), 100)
    q = shlex.quote(path)
    # du 一级子项 (-d1) 按字节排序; 用 -S 避免重复统计父目录
    # v4.71.0 · 用 -a -d1: GNU du 列出子项含文件; uutils du 需 -a 才列文件 (两者都支持该组合)
    cmd = (f"du -b -a -d1 {q} 2>/dev/null | sort -rn | head -{top + 1}; "
           f"echo '___TOTAL___'; du -sb {q} 2>/dev/null | cut -f1")
    try:
        target = _target(data)
        rc, out = await _exec(target, cmd, timeout=600)
        text = out or ""
        total = 0
        items = []
        if "___TOTAL___" in text:
            head, _, tail = text.partition("___TOTAL___")
            try:
                total = int((tail or "").strip().splitlines()[0])
            except Exception:
                total = 0
        else:
            head = text
        self_path = path
        for line in (head or "").splitlines():
            parts = line.split("\t")
            if len(parts) != 2:
                continue
            try:
                sz = int(parts[0])
            except ValueError:
                continue
            full = parts[1].strip()
            if full == self_path:
                continue          # 跳过自身汇总行
            name = os.path.basename(full.rstrip("/")) or full
            is_dir = True
            items.append({"name": name, "size": sz, "is_dir": is_dir, "path": full})
        items.sort(key=lambda x: -x["size"])
        if not total:
            total = sum(i["size"] for i in items)
        # 区分目录/文件 (远端 find 不可用时用 basename 猜测: 无扩展名多为目录)
        for it in items:
            it["is_dir"] = ("." not in os.path.basename(it["name"]))
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "path": path, "total": total, "items": items[:top]})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"统计异常: {ssh_error_msg(str(e))}"})


async def handle_file_checksum(ws, data: dict):
    """校验文件 (v4.71.0)。params: path, algo(md5|sha1|sha256|sha512)"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    algo = (data.get("algo") or "sha256").strip().lower()
    if algo not in ("md5", "sha1", "sha256", "sha512"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"不支持的算法: {algo}"})
        return
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少 path"})
        return
    tool = {"md5": "md5sum", "sha1": "sha1sum", "sha256": "sha256sum", "sha512": "sha512sum"}[algo]
    q = shlex.quote(path)
    try:
        target = _target(data)
        rc, out = await _exec(target, f"{tool} {q} 2>&1", timeout=1800)
        txt = (out or "").strip()
        if rc != 0 or not txt:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"计算失败: {txt[-200:]}"})
            return
        checksum = txt.split()[0]
        _, sz = await _exec(target, f"stat -c %s {q} 2>/dev/null || echo 0", timeout=10)
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "path": path, "algo": algo, "checksum": checksum,
                            "size": int((sz or "0").strip() or 0)})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"异常: {ssh_error_msg(str(e))}"})


async def handle_file_write_b64(ws, data: dict):
    """写入二进制内容 (v4.71.0 · 拖拽上传)。params: path, content_b64, append(默认false)"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    b64 = data.get("content_b64") or ""
    append = bool(data.get("append"))
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少 path"})
        return
    if not b64:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "内容为空"})
        return
    try:
        # 校验 base64 (非法字符直接拒绝, 防注入)
        import re as _re
        if not _re.fullmatch(r"[A-Za-z0-9+/=\s]+", b64):
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": "内容不是合法 base64"})
            return
        target = _target(data)
        parent = os.path.dirname(path.rstrip("/")) or "/"
        op = ">>" if append else ">"
        tmp = path + ".rpup.tmp"
        cmd = (f"mkdir -p {shlex.quote(parent)} 2>&1 && "
               f"echo {shlex.quote(b64)} | base64 -d {op} {shlex.quote(tmp if not append else path)} 2>&1"
               + (f" && mv {shlex.quote(tmp)} {shlex.quote(path)}" if not append else ""))
        rc, out = await _exec(target, cmd, timeout=600)
        if rc != 0:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                                "msg": f"写入失败: {(out or '').strip()[-200:]}"})
            return
        _, sz = await _exec(target, f"stat -c %s {shlex.quote(path)} 2>/dev/null || echo 0", timeout=10)
        log_operation("文件管理", f"上传 {path} ({(sz or '0').strip()} bytes)")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id,
                            "msg": "上传成功", "size": int((sz or "0").strip() or 0)})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"上传异常: {ssh_error_msg(str(e))}"})


async def handle_file_exif(ws, data: dict):
    """v5.14.0 · 图片 EXIF 摘要 (本机文件, PIL 解析; 远端文件不支持)。
    返回基础信息 (尺寸/格式/大小) + EXIF (拍摄时间/相机/曝光/ISO/焦距/镜头/GPS)"""
    _req_id = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id, "msg": "缺少 path"})
        return
    if data.get("host"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "EXIF 解析目前仅支持本机文件"})
        return
    if not os.path.exists(path):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"文件不存在: {path}"})
        return
    try:
        from PIL import Image
        from PIL.ExifTags import TAGS, GPSTAGS
        img = Image.open(path)
        info = {
            "path": path, "size": os.path.getsize(path),
            "format": img.format or "", "mode": img.mode or "",
            "width": img.width, "height": img.height,
            "mtime": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(path))),
        }
        exif_map = {}
        try:
            raw = img.getexif()
            if raw:
                for tag_id, val in raw.items():
                    name = TAGS.get(tag_id, str(tag_id))
                    exif_map[name] = val
                # EXIF IFD (拍摄时间/曝光等在子 IFD)
                try:
                    ifd = raw.get_ifd(0x8769)
                    for tag_id, val in ifd.items():
                        name = TAGS.get(tag_id, str(tag_id))
                        exif_map.setdefault(name, val)
                except Exception:
                    pass
        except Exception:
            pass

        def _clean(v):
            if isinstance(v, bytes):
                return v.decode("utf-8", "replace").strip("\x00").strip()
            if isinstance(v, tuple):
                return "/".join(str(x) for x in v)
            if isinstance(v, float):
                return round(v, 5)
            return v

        def _ratio(v):
            """'a/b' 或 (a,b) → float"""
            try:
                if isinstance(v, tuple):
                    return float(v[0]) / float(v[1]) if v[1] else 0
                s = str(v)
                if "/" in s:
                    a, b = s.split("/", 1)
                    return float(a) / float(b) if float(b) else 0
                return float(s)
            except Exception:
                return 0

        out = {}
        field_map = {"Make": "相机厂商", "Model": "相机型号", "LensModel": "镜头",
                     "Software": "软件", "ExposureTime": "曝光时间", "FNumber": "光圈",
                     "ISO": "ISO", "ISOSpeedRatings": "ISO", "FocalLength": "焦距",
                     "DateTimeOriginal": "拍摄时间", "DateTime": "修改时间", "Orientation": "方向"}
        for k, label in field_map.items():
            v = exif_map.get(k)
            if v is None or v == "":
                continue
            if k == "ExposureTime":
                r = _ratio(v)
                out[label] = f"1/{round(1 / r)}s" if 0 < r < 1 else f"{r}s"
            elif k == "FNumber":
                out[label] = f"f/{_ratio(v):.1f}"
            elif k == "FocalLength":
                out[label] = f"{_ratio(v):.0f}mm"
            elif k == "Orientation":
                m = {1: "正常", 3: "旋转180°", 6: "顺时针90°", 8: "逆时针90°"}
                out[label] = m.get(_ratio(v) or 1, str(_clean(v)))
            else:
                out[label] = _clean(v)

        # GPS → 十进制度
        try:
            gps_raw = raw.get_ifd(0x8825) if raw else {}
            if gps_raw:
                gps = {GPSTAGS.get(k, str(k)): v for k, v in gps_raw.items()}

                def _dms(v, ref):
                    try:
                        d = _ratio(v[0]) + _ratio(v[1]) / 60 + _ratio(v[2]) / 3600
                        if ref in ("S", "W"):
                            d = -d
                        return round(d, 6)
                    except Exception:
                        return None
                lat = _dms(gps.get("GPSLatitude"), gps.get("GPSLatitudeRef", ""))
                lon = _dms(gps.get("GPSLongitude"), gps.get("GPSLongitudeRef", ""))
                if lat is not None and lon is not None:
                    out["GPS"] = f"{lat}, {lon}"
        except Exception:
            pass
        if out:
            info["exif"] = out
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req_id, **info})
    except ImportError:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": "Pillow 未安装, 无法解析 EXIF"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req_id,
                            "msg": f"EXIF 解析失败: {e} (非图片或已损坏?)"})

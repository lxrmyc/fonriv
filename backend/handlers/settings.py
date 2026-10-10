"""v4.15.24 · 全局设置 (app_settings kv) handler
v4.43.0 · 新增 WEB 端口管理 (web_port_get / web_port_set)
"""
from __future__ import annotations

import os
import re

import backend.db as _db
from backend.log import log_operation


def _pub(topic: str, payload: dict) -> None:
    """v4.21.0 · 发布 audit 事件"""
    try:
        from backend import events as _events
        _events.publish(topic, payload)
    except Exception as _e:
        print(f"[settings] publish {topic} fail: {_e}")


async def _reply(ws, payload):
    # v5.28.5 · 统一信封: 缺 type/req_id 的响应在当前前端 (req_id 严格匹配) 下永远超时
    payload.setdefault("type", "result")
    await ws.send_json(payload)


def _detect_current_port() -> int:
    """探测当前进程实际监听端口。

    server.py 启动时写 FONRIV_EFFECTIVE_PORT 环境变量 (CLI/env/DB 三路解析后的最终值),
    此处直接读取; 无该变量 (非 server.py 入口, 如单元测试) 回退 FONRIV_PORT / 8000。
    """
    for key in ("FONRIV_EFFECTIVE_PORT", "FONRIV_PORT"):
        try:
            v = os.environ.get(key, "")
            if v:
                p = int(v)
                if 1 <= p <= 65535:
                    return p
        except (TypeError, ValueError):
            continue
    return 8000


async def handle_setting_get(ws, data: dict):
    """读一个 setting · 或读一批（keys=[...]）· 或读全部（无参）"""
    _req = data.get("req_id") or ""
    try:
        keys = data.get("keys")
        if isinstance(keys, list) and keys:
            out = {k: _db.setting_get(str(k), "") for k in keys}
        elif data.get("key"):
            out = {data["key"]: _db.setting_get(str(data["key"]), "")}
        else:
            out = _db.setting_all()
        await _reply(ws, {"req_id": _req, "status": "ok", "settings": out})
    except Exception as e:
        print("[settings] get error:", e)
        await _reply(ws, {"req_id": _req, "status": "err", "msg": str(e)})


async def handle_setting_set(ws, data: dict):
    """写一个或多个 setting。
    - 单个：{key, value}
    - 批量：{items: {"k1":"v1","k2":"v2"}}
    """
    _req = data.get("req_id") or ""
    try:
        items = data.get("items")
        if isinstance(items, dict) and items:
            for k, v in items.items():
                _db.setting_set(str(k), "" if v is None else str(v))
            await _reply(ws, {"req_id": _req, "status": "ok", "count": len(items)})
            # v4.21.0 · audit: 批量设置变更（仅 key 列表，不带 value 避免敏感数据泄露）
            _pub("audit.setting.change", {"keys": list(items.keys())[:20], "count": len(items)})
            return
        key = data.get("key")
        if not key:
            await _reply(ws, {"req_id": _req, "status": "err", "msg": "缺少 key"})
            return
        val = data.get("value", "")
        _db.setting_set(str(key), "" if val is None else str(val))
        await _reply(ws, {"req_id": _req, "status": "ok"})
        # v4.21.0 · audit: 单条设置变更（脱敏 value）
        _pub("audit.setting.change", {"key": str(key)})
    except Exception as e:
        print("[settings] set error:", e)
        await _reply(ws, {"req_id": _req, "status": "err", "msg": str(e)})


async def handle_setting_delete(ws, data: dict):
    _req = data.get("req_id") or ""
    try:
        key = data.get("key") or ""
        if not key:
            await _reply(ws, {"req_id": _req, "status": "err", "msg": "缺少 key"})
            return
        _db.setting_delete(str(key))
        await _reply(ws, {"req_id": _req, "status": "ok"})
    except Exception as e:
        print("[settings] delete error:", e)
        await _reply(ws, {"req_id": _req, "status": "err", "msg": str(e)})


# ==================== v4.43.0 · WEB 端口管理 ====================

_DEFAULT_ENV_FILE = "/etc/default/fonriv"
_KEY = "web_port"


async def handle_web_port_get(ws, data: dict):
    """读 WEB 端口设置: db 配置值 + 当前实际监听端口 + env 文件路径"""
    try:
        saved = _db.setting_get(_KEY, "")
        saved_i = None
        if saved:
            try:
                saved_i = int(saved)
            except (TypeError, ValueError):
                saved_i = None
        cur = _detect_current_port()
        await _reply(ws, {"type": "result", "status": "ok", "req_id": data.get("req_id", ""),
                          "saved_port": saved_i,      # None = 未设置（用默认）
                          "current_port": cur,        # 本进程现在实际监听的端口
                          "pending": bool(saved_i is not None and saved_i != cur),  # 已改但未重启
                          "env_file": _DEFAULT_ENV_FILE})
    except Exception as e:
        await _reply(ws, {"type": "result", "status": "error", "req_id": data.get("req_id", ""),
                          "msg": f"读取端口信息失败: {e}"})


async def handle_web_port_set(ws, data: dict):
    """设置 WEB 端口: 写 DB + 同步 /etc/default/fonriv · 需重启生效

    - 端口范围 1-65535；22/80 等常用特权端口提醒但不阻止
    - 需管理员权限
    """
    from backend.auth import _require_admin
    if not await _require_admin(ws):
        return
    try:
        raw = data.get("port")
        try:
            port = int(raw)
        except (TypeError, ValueError):
            await _reply(ws, {"type": "result", "status": "error", "req_id": data.get("req_id", ""),
                              "msg": f"端口必须是数字: {raw!r}"})
            return
        if not (1 <= port <= 65535):
            await _reply(ws, {"type": "result", "status": "error", "req_id": data.get("req_id", ""),
                              "msg": "端口范围 1-65535"})
            return
        cur = _detect_current_port()
        # 写 DB（server.py 启动时优先读）
        _db.setting_set(_KEY, str(port))
        # 同步 /etc/default/fonriv (systemd EnvironmentFile, 不可写时静默降级)
        env_synced = _sync_env_file(port)
        _pub("audit.setting.change", {"key": _KEY, "old": cur, "new": port})
        msg = f"端口已保存: {cur} -> {port} · 重启服务后生效"
        if port in (21, 22, 80, 443, 3306, 5432, 6379):
            msg += f" · 注意: {port} 是常用服务端口, 确认无冲突"
        if not env_synced:
            msg += " · (未能写入 /etc/default/fonriv, 依赖 DB 配置)"
        await _reply(ws, {"type": "result", "status": "ok", "req_id": data.get("req_id", ""),
                          "port": port, "old_port": cur,
                          "env_synced": env_synced, "msg": msg})
    except Exception as e:
        print("[settings] web_port_set error:", e)
        await _reply(ws, {"type": "result", "status": "error", "req_id": data.get("req_id", ""),
                          "msg": f"保存端口失败: {e}"})


def _sync_env_file(port: int) -> bool:
    """同步 WEB 端口到 systemd 环境文件 /etc/default/fonriv（不可写时静默降级，依赖 DB 配置）。

    v5.90.0: 原实现的"主文件 + 旧文件双写"随旧品牌分支一并移除（`_LEGACY_ENV_FILE` 此前根本未定义，
    导致本函数一进入就 NameError、改端口在界面上恒报"保存端口失败"——DB 已写入但环境文件从未同步）。
    """
    ok = False
    for path, var in ((_DEFAULT_ENV_FILE, "FONRIV_PORT"),):
        try:
            if not os.path.isfile(path):
                continue                       # 该环境文件不存在 (未用 systemd/旧部署) → 跳过
            with open(path, encoding="utf-8") as f:
                content = f.read()
            new_line = f"{var}={port}"
            if re.search(rf"^{var}=.*$", content, re.M):
                content = re.sub(rf"^{var}=.*$", new_line, content, flags=re.M)
            else:
                content = content.rstrip("\n") + "\n" + new_line + "\n"
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            ok = True
        except OSError as e:
            print(f"[settings] sync env file fail ({path}): {e}")
    return ok


# ---------------------------------------------------------------------------
# v4.50.0 · 传输引擎 (transfer_engine): auto | rsync | rclone
#   全局设置, 影响「文件传输」页 up/down 方向的底层程序 (双向 sync/cross 仍 rsync)
# ---------------------------------------------------------------------------

_ENGINE_ALLOWED = ("auto", "rsync", "rclone")


async def handle_preview_mode_get(ws, data: dict):
    """v5.1.0 · 读预览模式 (三处独立): transfer(文件传输中栏) / dm(远端磁盘管理中栏) / preview(文件预览右栏)
    值: 'preview' 仅预览 | 'browse' 目录浏览+预览"""
    await _reply(ws, {"type": "result", "status": "ok",
                      "transfer": _db.setting_get("preview_mode_transfer", "browse") or "browse",
                      "dm": _db.setting_get("preview_mode_dm", "browse") or "browse",
                      "preview": _db.setting_get("preview_mode_preview", "browse") or "browse"})


async def handle_preview_mode_set(ws, data: dict):
    """写预览模式。入参: scope(transfer|dm|preview|all), mode(preview|browse)"""
    scope = (data.get("scope") or "all").strip()
    mode = (data.get("mode") or "").strip()
    if mode not in ("preview", "browse"):
        await _reply(ws, {"type": "result", "status": "error", "msg": "mode 必须是 preview|browse"})
        return
    targets = ["transfer", "dm", "preview"] if scope == "all" else [scope]
    for t in targets:
        if t in ("transfer", "dm", "preview"):
            _db.setting_set("preview_mode_" + t, mode)
    _lbl = "仅预览" if mode == "preview" else "目录浏览+预览"
    await _reply(ws, {"type": "result", "status": "ok",
                      "msg": f"✓ {'全部' if scope == 'all' else scope} 预览模式 → {_lbl}"})


async def handle_transfer_engine_get(ws, data: dict):
    """读传输引擎配置: {engine, transfers}"""
    await _reply(ws, {"type": "result", "status": "ok",
                      "engine": _db.setting_get("transfer_engine", "auto") or "auto",
                      "transfers": int(_db.setting_get("rclone_transfers", "4") or 4),
                      "auto_threshold_mb": int(_db.setting_get("transfer_engine_auto_mb", "1024") or 1024),
                      # v5.20.0 · auto 档默认只选 rsync (实测 SSH 端点 rclone 慢 13% / 小文件慢 17.6 倍);
                      #   置 1 可恢复旧的"≥阈值 → rclone"行为。见 docs/性能基线实测报告_v5.20.md
                      "auto_rclone": (_db.setting_get("transfer_engine_auto_rclone", "0") or "0") == "1",
                      "shards_enable": (_db.setting_get("transfer_rsync_shards_enable", "1") or "1") == "1",
                      "shards_min_files": int(_db.setting_get("transfer_rsync_shards_min_files", "500") or 500),
                      # v5.20.0 · 远端 (SSH) 分片收益仅 +2.6% (本机 2.8×), 阈值按此倍数放大
                      "shards_remote_factor": int(_db.setting_get("transfer_rsync_shards_remote_factor", "10") or 10),
                      # v4.94.0 · B3 按协议独立并发
                      "conc_rsync": int(_db.setting_get("conc_rsync", "4") or 4),
                      "conc_sftp": int(_db.setting_get("conc_sftp",
                                       _db.setting_get("rclone_transfers", "4") or "4") or 4),
                      "conc_s3": int(_db.setting_get("conc_s3", "4") or 4)})


async def handle_transfer_engine_set(ws, data: dict):
    """写传输引擎配置。入参: engine(auto|rsync|rclone), transfers(1-16, 可选)"""
    from backend.auth import _require_admin
    if not await _require_admin(ws):
        return
    engine = (data.get("engine") or "").strip().lower()
    if engine not in _ENGINE_ALLOWED:
        await _reply(ws, {"type": "result", "status": "error", "msg": f"engine 必须是 {'/'.join(_ENGINE_ALLOWED)}"})
        return
    _db.setting_set("transfer_engine", engine)
    msg = f"传输引擎 → {engine}"
    # v4.94.0 · B3 按协议独立并发: conc_rsync/rsync分片 · conc_sftp/rclone-SFTP · conc_s3/云端
    for _k, _label in (("conc_rsync", "rsync 分片并发"), ("conc_sftp", "SFTP 并发"), ("conc_s3", "云端(S3) 并发")):
        if _k in data:
            try:
                _n = max(1, min(16, int(data.get(_k) or 4)))
                _db.setting_set(_k, str(_n))
                msg += f" · {_label} {_n}"
            except Exception:
                pass
    if "transfers" in data:
        try:
            n = max(1, min(16, int(data.get("transfers") or 4)))
            _db.setting_set("rclone_transfers", str(n))
            _db.setting_set("conc_sftp", str(n))  # 向后兼容: 全局 rclone 并发即 SFTP 并发
            msg += f" · rclone 并发 {n}"
        except (TypeError, ValueError):
            pass
    if "auto_threshold_mb" in data:
        try:
            mb = max(1, min(102400, int(data.get("auto_threshold_mb") or 1024)))
            _db.setting_set("transfer_engine_auto_mb", str(mb))
            msg += f" · 自动阈值 {mb}MB"
        except (TypeError, ValueError):
            pass
    if "shards_enable" in data:
        _db.setting_set("transfer_rsync_shards_enable", "1" if data.get("shards_enable") else "0")
        msg += " · 并行分片" + ("开" if data.get("shards_enable") else "关")
    if "shards_min_files" in data:
        try:
            nf = max(10, min(1000000, int(data.get("shards_min_files") or 500)))
            _db.setting_set("transfer_rsync_shards_min_files", str(nf))
            msg += f" · 分片阈值 {nf} 文件"
        except (TypeError, ValueError):
            pass
    # v5.20.0 · auto 档是否允许自动选 rclone (默认 0: 实测 SSH 端点 rclone 更慢)
    if "auto_rclone" in data:
        _db.setting_set("transfer_engine_auto_rclone", "1" if data.get("auto_rclone") else "0")
        msg += " · 自动选 rclone " + ("开" if data.get("auto_rclone") else "关")
    # v5.20.0 · 远端通道分片阈值放大倍数 (1 = 不放大)
    if "shards_remote_factor" in data:
        try:
            rf = max(1, min(1000, int(data.get("shards_remote_factor") or 10)))
            _db.setting_set("transfer_rsync_shards_remote_factor", str(rf))
            msg += f" · 远端分片阈值 ×{rf}"
        except (TypeError, ValueError):
            pass
    await _reply(ws, {"type": "result", "status": "ok", "msg": msg, "engine": engine})
    _pub("audit.setting.change", {"keys": ["transfer_engine"]})


# ═══ v5.19.0 · 系统服务管理 (设置页「重启后台服务」) ═══

def _svc_names():
    """候选服务名 (按发行版/部署方式)"""
    return ["fonriv"]


async def handle_service_status(ws, data: dict):
    """查询后台服务运行状态 (systemd)。params: unit(可选)"""
    _req = data.get("req_id") or ""
    import shutil as _sh, subprocess as _sp
    unit = (data.get("unit") or "").strip()
    if not _sh.which("systemctl"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "未检测到 systemd (systemctl 不可用) — 本机可能是容器环境"})
        return
    cands = [unit] if unit else _svc_names()
    picked = None
    for u in cands:
        try:
            r = _sp.run(["systemctl", "is-active", u], capture_output=True, text=True, timeout=8)
            if (r.stdout or "").strip() in ("active", "inactive", "failed", "activating", "deactivating"):
                picked = u
                break
        except Exception:
            continue
    if not picked:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"未找到 Fonriv 服务单元 (尝试过: {', '.join(cands)})"})
        return
    try:
        r = _sp.run(["systemctl", "show", picked, "-p", "ActiveState,SubState,ExecMainPID,ActiveEnterTimestamp,NRestarts"],
                    capture_output=True, text=True, timeout=8)
        kv = {}
        for line in (r.stdout or "").splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                kv[k.strip()] = v.strip()
        # 运行时长
        uptime = ""
        try:
            import datetime as _dt
            ts = kv.get("ActiveEnterTimestamp", "")
            if ts:
                up = _dt.datetime.strptime(ts, "%a %Y-%m-%d %H:%M:%S %Z")
                secs = int((_dt.datetime.now() - up).total_seconds())
                uptime = f"{secs // 86400}天 {(secs % 86400) // 3600}小时" if secs >= 86400 else f"{secs // 3600}小时 {(secs % 3600) // 60}分"
        except Exception:
            pass
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "unit": picked,
                            "active_state": kv.get("ActiveState", ""),
                            "sub_state": kv.get("SubState", ""),
                            "pid": kv.get("ExecMainPID", ""),
                            "since": kv.get("ActiveEnterTimestamp", ""),
                            "restarts": kv.get("NRestarts", ""),
                            "uptime": uptime})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"查询失败: {e}"})


async def handle_service_restart(ws, data: dict):
    """重启后台服务。params: unit(可选), delay(秒, 默认 2)
    实现要点: 先返回响应让前端收到, 再延迟执行重启 (否则连接先断, 前端显示失败)。
    """
    _req = data.get("req_id") or ""
    import shutil as _sh, subprocess as _sp, os as _os
    unit = (data.get("unit") or "fonriv").strip()
    try:
        delay = max(1, min(10, int(data.get("delay") or 2)))
    except Exception:
        delay = 2
    if not _sh.which("systemctl"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "未检测到 systemd — 无法重启服务 (容器/手工启动环境请用 supervisor 或直接重启进程)"})
        return
    # 校验服务存在
    chk = _sp.run(["systemctl", "is-active", unit], capture_output=True, text=True, timeout=8)
    if (chk.stdout or "").strip() not in ("active", "inactive", "failed", "activating", "deactivating"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"服务单元不存在: {unit}"})
        return
    log_operation("系统服务", f"请求重启 {unit} (延迟 {delay}s)")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "unit": unit, "delay": delay,
                        "msg": f"✓ 已下发重启指令 — {delay} 秒后重启 {unit}。服务恢复后请手动刷新页面 (约 5~15 秒)"})
    # v5.31.4 · FIX 重启不生效: 原实现派发 `systemctl restart`, 但部分环境 systemd 的
    #   DBus 不可用 (本机实测 systemctl restart 直接超时) → 子进程静默失败, 而前端已收到
    #   "已下发重启指令" → 表现为「改了代码、界面一直没变化」, 排查成本极高。
    #   改为**应用自 re-exec**: 延迟后用同一解释器+同一 argv 替换进程映像, 同 PID 换新代码,
    #   完全不依赖 systemd (systemd 视角进程一直在, 无需 Restart=)。execv 失败再退回 systemctl。
    def _reexec_later(_delay, _unit):
        import time as _t, sys as _sys, os as _os
        _t.sleep(_delay)
        try:
            _os.execv(_sys.executable, [_sys.executable] + _sys.argv)
        except Exception as _e:
            try:
                _sp.Popen(f"systemctl restart {_unit}", shell=True, start_new_session=True,
                          stdout=_sp.DEVNULL, stderr=_sp.DEVNULL)
            except Exception as _e2:
                log_operation("系统服务", f"重启 {_unit} 失败: execv={_e} systemctl={_e2}")
    try:
        import threading as _th
        _th.Thread(target=_reexec_later, args=(delay, unit), daemon=True).start()
    except Exception as e:
        log_operation("系统服务", f"重启 {unit} 失败: {e}")

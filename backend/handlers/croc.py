"""Fonriv - H 模块 (v4.95.0): croc 点对点传输 + 传输可视化回放

croc 动作:
  croc_check     检测本机 croc (https://github.com/schollz/croc)
  croc_send      发起发送 (path, code 可选, passphrase 可选) · 后台进程, 可停止
  croc_receive   等待接收 (code, out_dir) · 后台进程, 可停止
  croc_stop      停止 send/receive 实例 (name)

回放动作:
  stats_replay   某日传输记录时间轴 (run_stats 按小时聚合 + 明细), 供前端动画回放
"""
from __future__ import annotations

import asyncio
import os
import shutil
import uuid

from fastapi import WebSocket

from backend.log import log_operation

_croc_procs: dict[str, asyncio.subprocess.Process] = {}
_croc_out: dict[str, list[str]] = {}


async def _croc_run_bg(name: str, args: list[str], relay: str = "",
                       passphrase: str = "", secret: str = "") -> tuple[bool, str]:
    """后台启动 croc, 输出环形捕获 (前 200 行), 供状态查询。
    relay 走 CROC_RELAY 环境变量 (v11 的 send 子命令无 --relay 旗标, env 全命令通用)。"""
    if shutil.which("croc") is None:
        return False, "croc 未安装 (apt install croc 或 curl https://getcroc.schollz.com | bash)"
    if name in _croc_procs and _croc_procs[name].returncode is None:
        return False, f"'{name}' 已在运行"
    env = dict(os.environ)
    if relay:
        env["CROC_RELAY"] = relay
    if passphrase:
        env["CROC_PASS"] = passphrase
    if secret:
        # v11 on UNIX: 自定义码短语必须走 CROC_SECRET (send 的 --code 仅自动生成时可用)
        env["CROC_SECRET"] = secret
    proc = await asyncio.create_subprocess_exec(
        "croc", *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        env=env, start_new_session=True)
    _croc_procs[name] = proc
    _croc_out[name] = []

    async def _pump():
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                _croc_out.setdefault(name, []).append(line.decode("utf-8", "replace").rstrip())
                if len(_croc_out[name]) > 200:
                    _croc_out[name] = _croc_out[name][-200:]
        except Exception:
            pass
    asyncio.create_task(_pump())
    await asyncio.sleep(1.2)
    if proc.returncode is not None:
        tail = "\n".join(_croc_out.get(name, []))[-300:]
        _croc_procs.pop(name, None)
        # 小文件传输可能在检查窗口内已完成 (rc=0)
        if proc.returncode == 0:
            return True, "completed"
        return False, f"启动失败: {tail or 'croc 立即退出'}"
    return True, ""


def _mk_name(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:6]}"


async def handle_croc_check(ws, data: dict):
    _req = data.get("req_id") or ""
    path = shutil.which("croc")
    ver = ""
    if path:
        try:
            proc = await asyncio.create_subprocess_exec(
                "croc", "--version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            out, _ = await asyncio.wait_for(proc.communicate(), 10)
            ver = out.decode("utf-8", "replace").strip().splitlines()[-1][:60] if out else ""
        except Exception:
            ver = "?"
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "installed": bool(path), "path": path or "", "version": ver,
                        "msg": f"✓ croc {ver}" if path else "✗ croc 未安装 (安装: curl https://getcroc.schollz.com | bash)"})


async def handle_croc_send(ws, data: dict):
    """发起 P2P 发送。params: path(文件/目录), code(可选 4 词组), passphrase(可选)"""
    _req = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path or not os.path.exists(path):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "路径不存在"})
        return
    args = ["send"]
    relay = (data.get("relay") or "").strip()
    code = (data.get("code") or "").strip()
    args.append(path)
    name = _mk_name("send")
    ok, err = await _croc_run_bg(name, args, relay=relay,
                                 passphrase=str(data.get("passphrase") or ""), secret=code)
    if not ok:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": err})
        return
    # 从输出抓接收码
    out = "\n".join(_croc_out.get(name, []))
    real_code = ""
    for line in out.splitlines():
        if "code is" in line.lower():
            real_code = line.split(":")[-1].strip()
            break
    log_operation("croc", f"发送 {path} · code={real_code or code}")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "name": name,
                        "code": real_code or code,
                        "msg": f"✓ 发送已启动 · 接收码: {real_code or code} · 对方执行 croc 后输入该码"})


async def handle_croc_receive(ws, data: dict):
    """等待接收。params: code, out_dir(默认当前目录), passphrase(可选)"""
    _req = data.get("req_id") or ""
    code = (data.get("code") or "").strip()
    out_dir = (data.get("out_dir") or "").strip() or "."
    if not code:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少接收码"})
        return
    os.makedirs(out_dir, exist_ok=True)
    args = ["--yes", "--out", out_dir, "--overwrite"]
    relay = (data.get("relay") or "").strip()
    name = _mk_name("recv")
    # v11 on UNIX: 接收码同样禁止命令行 (安全警示直接退出), 走 CROC_SECRET
    ok, err = await _croc_run_bg(name, args, relay=relay,
                                 passphrase=str(data.get("passphrase") or ""), secret=code)
    if not ok:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": err})
        return
    log_operation("croc", f"接收 {code} → {out_dir}")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "name": name,
                        "msg": f"✓ 接收已就绪 · 保存到 {os.path.abspath(out_dir)} · 等待对端连接"})


async def handle_croc_stop(ws, data: dict):
    _req = data.get("req_id") or ""
    name = (data.get("name") or "").strip()
    proc = _croc_procs.pop(name, None)
    if not proc:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "实例不存在"})
        return
    try:
        proc.terminate()
    except Exception:
        pass
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "msg": f"✓ {name} 已停止"})


async def handle_croc_status(ws, data: dict):
    _req = data.get("req_id") or ""
    rows = []
    for n, p in list(_croc_procs.items()):
        running = p.returncode is None
        rows.append({"name": n, "running": running,
                     "tail": "\n".join(_croc_out.get(n, [])[-6:])})
        if not running and p.returncode is not None:
            # 已结束: 保留一条最终状态供查询后清理
            _croc_procs.pop(n, None)
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "procs": rows})


# ── 传输可视化回放 ──

async def handle_stats_replay(ws, data: dict):
    """某日传输记录时间轴。params: day(YYYY-MM-DD, 默认今天), days(可选回看天数, 默认1)"""
    from backend import db
    from backend.stats import ensure_table
    _req = data.get("req_id") or ""
    day = (data.get("day") or "").strip()
    days = max(1, min(30, int(data.get("days") or 1)))
    try:
        conn = db.get_conn()
        ensure_table(conn)
        if day:
            rows = conn.execute(
                """SELECT kind, target, files, bytes, duration_sec, speed_bps, hour, status, note, ts
                   FROM run_stats WHERE ts LIKE ? ORDER BY ts ASC LIMIT 500""", (day + "%",)).fetchall()
        else:
            rows = conn.execute(
                """SELECT kind, target, files, bytes, duration_sec, speed_bps, hour, status, note, ts
                   FROM run_stats WHERE ts >= datetime('now', 'localtime', ?)
                   ORDER BY ts ASC LIMIT 500""", (f"-{days} days",)).fetchall()
        events = []
        for r in rows:
            events.append({
                "ts": r[9], "kind": r[0], "target": r[1], "files": r[2] or 0,
                "bytes": r[3] or 0, "speed_bps": r[5] or 0, "hour": r[6] or 0,
                "status": r[7] or "ok", "note": (r[8] or "")[:80],
            })
        total_bytes = sum(e["bytes"] for e in events)
        log_operation("传输回放", f"{day or '近' + str(days) + '天'} · {len(events)} 条记录")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "day": day, "events": events, "count": len(events),
                            "total_bytes": total_bytes,
                            "msg": f"✓ {len(events)} 条传输记录"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"回放查询失败: {e}"})

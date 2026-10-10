"""Fonriv - v4.38.9 · Web 终端 (PTY over WebSocket)

v4.38.9 改动：
- 终端会话与 WS 解耦：WS 断开时 SSH 进程保留，PTY 输出缓冲到内存
- 新增 terminal_attach：前端刷新后用 task_id 重新关联会话
- 30 分钟无重连自动清理（防止资源泄漏）

v4.38.6 修复（保留）：
- 调用 target.auth.__aenter__() 启动 ssh-agent（密钥+短语模式必需）
- 退出时调用 __aexit__() 清理 agent
"""

import logging
import os
import pty
import subprocess
import select
import threading
import asyncio
import time

from fastapi import WebSocket
from backend.ssh_lib import SSHTarget


# 活跃的终端会话 {task_id: {proc, fd, thread, running, auth, ws, buffer, last_active, host, rows, cols}}
_active_terms = {}

# v4.38.9: 断连后保留会话的最大时长（秒），超时自动清理
TERM_KEEPALIVE_TIMEOUT = 30 * 60

# v4.38.9: 缓冲区上限（字节），防止内存爆炸
TERM_BUFFER_LIMIT = 256 * 1024


async def handle_terminal_open(ws: WebSocket, data: dict, task_id: str):
    """打开一个交互式 SSH 终端，通过 WebSocket 双向传输 I/O"""
    # v4.38.9: 顺便清理过期的孤儿会话
    _cleanup_expired_terms()

    try:
        target = SSHTarget.from_ws_data(data)
    except Exception as e:
        await ws.send_json({"type": "term_result", "status": "error",
                            "msg": f"参数错误: {e}"})
        return

    host = target.host
    port = target.port or "22"
    user = target.user or "root"

    if not host:
        await ws.send_json({"type": "term_result", "status": "error",
                            "msg": "缺少主机地址"})
        return

    rows = data.get("rows", 24)
    cols = data.get("cols", 80)

    # v4.38.6: 调用 auth.__aenter__ 启动 ssh-agent（密钥+短语模式必需）
    try:
        await target.auth.__aenter__()
    except Exception as e:
        await ws.send_json({"type": "term_result", "status": "error",
                            "msg": f"认证初始化失败: {e}"})
        return

    # 使用 SSHTarget.ssh_opts() 构建完整 SSH 选项
    ssh_opts = target.ssh_opts()
    ssh_cmd = ["ssh"] + ssh_opts + [f"{user}@{host}"]

    # 使用 auth.prepare_env() 设置 SSHPASS / SSH_AUTH_SOCK 等
    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["LINES"] = str(rows)
    env["COLUMNS"] = str(cols)
    env = target.auth.prepare_env(env)

    # 使用 auth.wrap_cmd() 包装 sshpass（密码模式）
    ssh_cmd = target.auth.wrap_cmd(ssh_cmd)

    try:
        # 创建 PTY 并启动 SSH 进程
        master_fd, slave_fd = pty.openpty()
        proc = subprocess.Popen(
            ssh_cmd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            close_fds=True,
            preexec_fn=os.setsid,
        )
        os.close(slave_fd)

        _active_terms[task_id] = {
            "proc": proc, "fd": master_fd, "running": True,
            "auth": target.auth,
            "ws": ws,  # v4.38.9: 当前关联的 WS
            "buffer": "",  # v4.38.9: 断连期间缓冲
            "last_active": time.time(),
            "host": host, "rows": rows, "cols": cols,
        }

        # 发送 term_started（前端据此更新状态为已连接）
        await ws.send_json({"type": "term_started", "task_id": task_id,
                            "host": host, "rows": rows, "cols": cols})

        loop = asyncio.get_event_loop()

        def read_pty():
            try:
                while _active_terms.get(task_id, {}).get("running"):
                    r, _, _ = select.select([master_fd], [], [], 0.1)
                    if r:
                        try:
                            out = os.read(master_fd, 4096)
                        except OSError:
                            break
                        if not out:
                            break
                        text = out.decode("utf-8", errors="replace")
                        term = _active_terms.get(task_id)
                        if not term:
                            break
                        # v4.38.9: WS 在线直接发，断连缓冲到内存
                        cur_ws = term.get("ws")
                        if cur_ws is not None:
                            try:
                                asyncio.run_coroutine_threadsafe(
                                    cur_ws.send_json({"type": "term_out", "data": text}),
                                    loop,
                                )
                            except Exception:
                                logging.debug("term send fail, buffer instead", exc_info=True)
                                if len(term["buffer"]) < TERM_BUFFER_LIMIT:
                                    term["buffer"] += text
                        else:
                            if len(term["buffer"]) < TERM_BUFFER_LIMIT:
                                term["buffer"] += text
            except Exception:
                logging.debug("term read pty error", exc_info=True)
            finally:
                term = _active_terms.get(task_id)
                if term:
                    term["running"] = False
                # v4.38.9: 只有 SSH 进程真正退出时才发 term_closed
                # WS 断连不触发这里（running 仍为 True，线程继续缓冲）
                try:
                    cur_ws = term.get("ws") if term else None
                    if cur_ws is not None:
                        asyncio.run_coroutine_threadsafe(
                            cur_ws.send_json({"type": "term_closed", "msg": "终端已关闭"}),
                            loop,
                        )
                except Exception:
                    logging.debug("send term_closed fail", exc_info=True)
                # SSH 进程退出 -> 触发清理
                asyncio.run_coroutine_threadsafe(
                    _cleanup_term_async(task_id), loop,
                )

        thread = threading.Thread(target=read_pty, daemon=True)
        _active_terms[task_id]["thread"] = thread
        thread.start()

        # v4.38.6: handler 立即返回，不阻塞 WS 消息循环

    except Exception as e:
        await ws.send_json({"type": "term_result", "status": "error",
                            "msg": f"终端启动失败: {e}"})
        # 清理已启动的 agent
        try:
            await target.auth.__aexit__(None, None, None)
        except Exception:
            logging.debug("auth __aexit__ fail", exc_info=True)
        _cleanup_term(task_id)


async def handle_terminal_attach(ws: WebSocket, data: dict):
    """v4.38.9: 重新关联已存在的终端会话（页面刷新后恢复）

    前端用 localStorage 保存的 task_id 调用此 action。
    - 会话存在且活着：关联新 ws，回放缓冲，后续输出实时转发
    - 会话不存在：返回 error，前端 fallback 到 terminal_open

    注意：task_id 从 data 取（不是 WS 连接的 task_id），因为刷新后 WS 是新连接。
    """
    task_id = data.get("task_id", "")
    if not task_id:
        await ws.send_json({"type": "term_result", "status": "error",
                            "msg": "缺少 task_id"})
        return
    term = _active_terms.get(task_id)
    if not term or not term.get("running"):
        await ws.send_json({"type": "term_result", "status": "error",
                            "msg": "会话不存在或已关闭"})
        return

    # 关联新 ws
    term["ws"] = ws
    term["last_active"] = time.time()

    # 发送 term_started（让前端更新状态 + 设置 termTaskId）
    await ws.send_json({"type": "term_started", "task_id": task_id,
                        "host": term.get("host", ""),
                        "rows": term.get("rows", 24),
                        "cols": term.get("cols", 80),
                        "replayed": True})

    # 回放缓冲
    if term.get("buffer"):
        await ws.send_json({"type": "term_out", "data": term["buffer"]})
        term["buffer"] = ""


async def handle_terminal_input(ws: WebSocket, data: dict):
    """接收前端发送的键盘输入，写入 PTY"""
    task_id = data.get("task_id", "")
    term = _active_terms.get(task_id)
    if not term or not term.get("running"):
        return
    # v4.38.9: 更新最后活动时间
    term["last_active"] = time.time()
    input_data = data.get("data", "")
    if input_data:
        try:
            os.write(term["fd"], input_data.encode("utf-8"))
        except Exception:
            logging.debug("term write error", exc_info=True)


async def handle_terminal_resize(ws: WebSocket, data: dict):
    """调整终端大小"""
    task_id = data.get("task_id", "")
    rows = data.get("rows", 24)
    cols = data.get("cols", 80)
    term = _active_terms.get(task_id)
    if term and term.get("running"):
        term["last_active"] = time.time()
        term["rows"] = rows
        term["cols"] = cols
        try:
            import fcntl
            import termios
            import struct
            winsize = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(term["fd"], termios.TIOCSWINSZ, winsize)
        except Exception:
            logging.debug("term resize error", exc_info=True)


async def handle_terminal_close(ws: WebSocket, data: dict):
    """关闭终端（用户主动点击断开按钮）"""
    task_id = data.get("task_id", "")
    await _cleanup_term_async(task_id)
    await ws.send_json({"type": "term_result", "status": "ok", "msg": "终端已关闭"})


async def on_ws_disconnect(ws: WebSocket):
    """v4.38.9: WS 断开时调用，标记会话 ws=None（不清理 SSH 进程）

    SSH 进程保留，PTY 输出缓冲到内存，等待前端 attach 恢复。
    超时（30 分钟无重连）由 _cleanup_expired_terms 清理。
    """
    for task_id, term in list(_active_terms.items()):
        if term.get("ws") is ws:
            term["ws"] = None
            term["last_active"] = time.time()
            logging.debug(f"[terminal] task_id={task_id} ws disconnected, kept alive")


def _cleanup_expired_terms():
    """v4.38.9: 清理过期的孤儿会话（ws=None 且超过 TERM_KEEPALIVE_TIMEOUT）"""
    now = time.time()
    for task_id, term in list(_active_terms.items()):
        if term.get("ws") is None:
            last = term.get("last_active", now)
            if now - last > TERM_KEEPALIVE_TIMEOUT:
                logging.info(f"[terminal] cleanup expired task_id={task_id}")
                # 同步清理（不能 await，因为可能在非 async 上下文调用）
                _cleanup_term(task_id)


async def _cleanup_term_async(task_id):
    """异步清理：先停进程，再调 auth.__aexit__ 停 agent"""
    term = _active_terms.pop(task_id, None)
    if not term:
        return
    term["running"] = False
    # 1) 停 SSH 进程
    try:
        if term.get("proc") and term["proc"].poll() is None:
            term["proc"].kill()
            term["proc"].wait(timeout=5)
    except Exception:
        logging.debug("term cleanup kill failed", exc_info=True)
    # 2) 关闭 PTY fd
    try:
        if term.get("fd"):
            os.close(term["fd"])
    except Exception:
        logging.debug("term cleanup close fd failed", exc_info=True)
    # 3) v4.38.6: 调用 auth.__aexit__ 清理 ssh-agent
    auth = term.get("auth")
    if auth:
        try:
            await auth.__aexit__(None, None, None)
        except Exception:
            logging.debug("auth __aexit__ fail", exc_info=True)


def _cleanup_term(task_id):
    """同步清理（用于异常路径 / 超时清理，不调 __aexit__）"""
    term = _active_terms.pop(task_id, None)
    if not term:
        return
    term["running"] = False
    try:
        if term.get("proc") and term["proc"].poll() is None:
            term["proc"].kill()
            term["proc"].wait(timeout=5)
    except Exception:
        logging.debug("term cleanup kill failed", exc_info=True)
    try:
        if term.get("fd"):
            os.close(term["fd"])
    except Exception:
        logging.debug("term cleanup close fd failed", exc_info=True)
    # 同步路径无法 await __aexit__，agent 可能泄漏，记录日志
    auth = term.get("auth")
    if auth:
        logging.debug(f"[terminal] task_id={task_id} agent not cleaned (sync path)")

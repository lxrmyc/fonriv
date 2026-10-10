"""Fonriv - SSH 工具与进程管理

⚠️  DEPRECATED — 本模块所有 SSH 相关函数已弃用（Stage 8 完成于 2026-07-07）。

现状：
- 所有 handler 已完全迁移到 backend.ssh_lib（Stage 3~7）
- 本文件保留以下用途：
    1. active_tasks / kill_process 的 re-export（供 ws.py / app.py 使用）
    2. 老 SSH 函数保留供**应急回滚参考** — 不进入任何执行路径
    3. 任何对 build_ssh_opts / run_ssh_cmd / wrap_sshpass 等函数的调用
       会打印 DeprecationWarning，帮助定位残留调用点

新代码请务必使用 backend.ssh_lib：
    from backend.ssh_lib import SSHTarget, SSHRunner
    target = SSHTarget.from_ws_data(data)
    async with target.runner() as run:
        rc, out, err = await run.exec("...")

未来某个稳定期（预计 2026-09 之后），可以直接 rm 掉本文件除 re-export 之外的部分。
"""
import logging

import os
import re
import asyncio
import shlex
import warnings
import functools

from backend.auth import decode_password

# 全局状态：从新包 re-export，保证新旧代码共享同一实例
from backend.ssh_lib.runner import active_tasks, kill_process
from backend.ssh_lib.agent import (
    start_ssh_agent_with_key,
    stop_ssh_agent,
    _ssh_agents,
)
from backend.ssh_lib.utils import (
    parse_ls_output,
    ssh_error_msg,
    sanitize_output,
)


def _deprecated(reason: str = ""):
    """老 SSH API 弃用标记装饰器：调用时打印 DeprecationWarning（每处调用点只打一次）。"""
    def decorator(fn):
        warned = set()

        @functools.wraps(fn)
        def sync_wrapper(*args, **kwargs):
            import inspect
            caller = inspect.stack()[1]
            key = (caller.filename, caller.lineno)
            if key not in warned:
                warned.add(key)
                warnings.warn(
                    f"backend.ssh.{fn.__name__} 已弃用，请改用 backend.ssh_lib.SSHRunner。"
                    f"{' ' + reason if reason else ''} "
                    f"调用点: {caller.filename}:{caller.lineno}",
                    DeprecationWarning, stacklevel=2,
                )
            return fn(*args, **kwargs)

        @functools.wraps(fn)
        async def async_wrapper(*args, **kwargs):
            import inspect
            caller = inspect.stack()[1]
            key = (caller.filename, caller.lineno)
            if key not in warned:
                warned.add(key)
                warnings.warn(
                    f"backend.ssh.{fn.__name__} 已弃用，请改用 backend.ssh_lib.SSHRunner。"
                    f"{' ' + reason if reason else ''} "
                    f"调用点: {caller.filename}:{caller.lineno}",
                    DeprecationWarning, stacklevel=2,
                )
            return await fn(*args, **kwargs)

        # v4.11.0: py 3.16+ 移除 asyncio.iscoroutinefunction，改走 inspect
        import inspect as _insp
        return async_wrapper if _insp.iscoroutinefunction(fn) else sync_wrapper

    return decorator


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SSH_CONNECT_TIMEOUT = 10


# ---------------------------------------------------------------------------
# ⚠️ 以下全部为 DEPRECATED 老 API，仅供应急回滚参考，请勿在新代码中调用
# ---------------------------------------------------------------------------
@_deprecated()
def build_ssh_opts(port="22", key="", password="", passphrase=""):
    """Build SSH options. If passphrase is set (ssh-agent mode), skip -i."""
    opts = ["-p" + str(port),
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=" + str(SSH_CONNECT_TIMEOUT)]
    key = (key or "").strip()
    use_key = bool(key) and not password
    if use_key:
        if not passphrase:
            expanded = os.path.expanduser(key)
            opts.extend(["-i", expanded])
        opts.extend(["-o", "PreferredAuthentications=publickey"])
    else:
        opts.extend(["-o", "NumberOfPasswordPrompts=1",
                     "-o", "PreferredAuthentications=password,keyboard-interactive",
                     "-o", "KbdInteractiveAuthentication=yes",
                     "-o", "PasswordAuthentication=yes"])
    return opts


@_deprecated()
def wrap_sshpass(cmd, password=None, passphrase=None, key=None):
    """Build command for SSH authentication.
    - password: use sshpass -p (password auth)
    - passphrase + key: start ssh-agent, add key via expect, then run cmd with SSH_AUTH_SOCK
    """
    if password:
        return ["sshpass", "-p", password] + cmd
    return cmd


@_deprecated()
async def run_with_ssh_agent(cmd, env, passphrase, key, timeout=30):
    """Run cmd with ssh-agent for key passphrase. Handles agent start/stop."""
    if not passphrase or not key:
        return await run_cmd(cmd, env, timeout)

    agent_pid = None
    try:
        agent_pid, agent_sock = start_ssh_agent_with_key(key, passphrase)
        env = dict(env)
        env['SSH_AUTH_SOCK'] = agent_sock
        return await run_cmd(cmd, env, timeout)
    except RuntimeError as e:
        return -1, f"密钥加载失败: {e}"
    except Exception as e:
        return -1, f"SSH agent error: {e}"
    finally:
        if agent_pid:
            stop_ssh_agent(agent_pid)


class ssh_agent_env:
    """Context manager for streaming SSH/rsync subprocess with passphrase+key.

    Usage:
        env = get_auth_env(password, passphrase)
        with ssh_agent_env(env, passphrase, key) as env2:
            proc = await asyncio.create_subprocess_exec(..., env=env2)
            # 长时间流式 I/O
    传入不带 passphrase 时透传原 env。用于任何 create_subprocess_exec 场景。
    """
    def __init__(self, env, passphrase, key):
        self.env = dict(env)
        self.passphrase = passphrase
        self.key = key
        self.agent_pid = None

    def __enter__(self):
        if self.passphrase and self.key:
            expanded = os.path.expanduser(self.key)
            self.agent_pid, sock = start_ssh_agent_with_key(expanded, self.passphrase)
            self.env['SSH_AUTH_SOCK'] = sock
        return self.env

    def __exit__(self, exc_type, exc, tb):
        if self.agent_pid:
            try: stop_ssh_agent(self.agent_pid)
            except Exception as _e: logging.debug("suppressed", exc_info=True)
        return False


@_deprecated()
async def run_ssh_cmd(host, port, user, cmd_str, password, key, passphrase, timeout=30):
    """Unified SSH command execution with ssh-agent support.
    Returns (code, stdout_str, stderr_str)."""
    expanded_key = os.path.expanduser(key) if key else ""
    ssh_opts = build_ssh_opts(port, expanded_key, password, passphrase)
    cmd = wrap_sshpass(
        ["ssh"] + ssh_opts + [f"{user}@{host}", cmd_str],
        password, passphrase, key,
    )
    env = get_auth_env(password or passphrase, passphrase)
    env["PYTHONIOENCODING"] = "utf-8"
    env["LANG"] = "C.UTF-8"
    env["LC_ALL"] = "C.UTF-8"

    if passphrase and key:
        code, merged = await run_with_ssh_agent(cmd, env, passphrase, key, timeout)
        return code, merged, ""
    else:
        proc = await asyncio.wait_for(
            asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env
            ), timeout=timeout
        )
        out, err = await proc.communicate()
        return proc.returncode, out.decode("utf-8", errors="replace"), err.decode("utf-8", errors="replace")


@_deprecated()
def get_auth_env(password, passphrase=None):
    """Return env dict for SSH authentication. Clear old SSH_ASKPASS and DISPLAY."""
    env = dict(os.environ)
    # Clear variables that cause ssh-askpass fallback or interfere with ssh-agent
    env.pop('SSH_ASKPASS', None)
    env.pop('SSH_ASKPASS_REQUIRE', None)
    env.pop('DISPLAY', None)
    env.pop('SSH_AUTH_SOCK', None)  # Clear GCR/system agent socket
    if password:
        env["SSHPASS"] = password
    return env


# ---------------------------------------------------------------------------
# Process helpers
# ---------------------------------------------------------------------------
@_deprecated()
async def run_cmd(cmd, env=None, timeout=30):
    """Run a subprocess command with proper env for sshpass/expect compatibility."""
    if env is None:
        env = dict(os.environ)
    else:
        env = dict(env)
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode, stdout.decode("utf-8", errors="replace")
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, "命令超时（可能 SSH 等待密码输入）"


@_deprecated()
async def run_cmd_stream(cmd, env=None):
    """Run a subprocess and yield stdout lines one-by-one (async generator).
    Returns (line_text, returncode) after stream ends."""
    if env is None:
        env = dict(os.environ)
    else:
        env = dict(env)
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env
    )
    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            yield line.decode("utf-8", errors="replace").strip()
        await proc.wait()
        yield f"__DONE__|{proc.returncode}"
    except Exception:
        proc.kill()
        await proc.wait()
        yield f"__DONE__|{proc.returncode or -1}"


@_deprecated()
def _auth_from_data(data):
    """Extract and decode password/key/passphrase from WebSocket data."""
    auth_type = data.get("auth_type", "pass")
    raw_val = data.get("password", "")
    key_val = data.get("key", "")
    passphrase_val = data.get("passphrase", "")
    password = ""
    key = ""
    passphrase = ""
    if auth_type == "pass":
        password = decode_password(raw_val)
        key = ""
    else:
        key = decode_password(key_val) if key_val else ""
        if key and key.startswith("ENC:"):
            key = decode_password(key)
        passphrase = decode_password(passphrase_val) if passphrase_val else ""
        if passphrase and passphrase.startswith("ENC:"):
            passphrase = decode_password(passphrase)
    return password, key, passphrase


# ---------------------------------------------------------------------------
# RSync SSH flag builder
# ---------------------------------------------------------------------------
@_deprecated()
def build_rsync_ssh_flag(port, key="", passphrase="", password=""):
    """Build the -e ssh flag for rsync. If passphrase is set, skip -i (agent provides key)."""
    key = (key or "").strip()
    ssh_parts = ["ssh", "-p", str(port), "-o", "StrictHostKeyChecking=accept-new",
                 "-o", "UserKnownHostsFile=/dev/null",
                 "-o", "ConnectTimeout=" + str(SSH_CONNECT_TIMEOUT)]
    use_key = False
    if key and not password:
        expanded = os.path.expanduser(key)
        if passphrase:
            use_key = True
        elif os.path.isfile(expanded):
            use_key = True

    if use_key:
        if not passphrase:
            expanded = os.path.expanduser(key)
            ssh_parts.extend(["-i", shlex.quote(expanded)])
        ssh_parts.extend(["-o", "PreferredAuthentications=publickey"])
    else:
        ssh_parts.extend(["-o", "NumberOfPasswordPrompts=1",
                          "-o", "PreferredAuthentications=password,keyboard-interactive",
                          "-o", "KbdInteractiveAuthentication=yes",
                          "-o", "PasswordAuthentication=yes"])
    return ssh_parts


@_deprecated()
def _build_ssh_flag(port, key="", passphrase="", password=""):
    """Build rsync -e flag string with proper shell escaping for key paths."""
    ssh_parts = build_rsync_ssh_flag(port, key, passphrase, password)
    return ["-e", " ".join(ssh_parts)]


"""SSH 库统一入口。

推荐 API：
    from backend.ssh_lib import SSHTarget, SSHRunner
    from backend.ssh_lib.auth import PasswordAuth, KeyAuth, KeyPassphraseAuth

    target = SSHTarget.from_ws_data(data)
    async with target.runner() as run:
        code, out, err = await run.exec("qm list")
        async for line in run.rsync_stream("up", "/local/", "/remote/"):
            ...

底层工具（跨模块共享）：
    from backend.ssh_lib.utils import parse_ls_output, ssh_error_msg, sanitize_output
    from backend.ssh_lib.runner import active_tasks, kill_process
    from backend.ssh_lib.agent import start_ssh_agent_with_key, stop_ssh_agent
"""

from backend.ssh_lib.auth import (
    SSHAuth,
    PasswordAuth,
    KeyAuth,
    KeyPassphraseAuth,
    build_auth_from_data,
)
from backend.ssh_lib.target import SSHTarget
from backend.ssh_lib.runner import SSHRunner, active_tasks, kill_process
from backend.ssh_lib.utils import parse_ls_output, ssh_error_msg, sanitize_output
from backend.ssh_lib.agent import (
    start_ssh_agent_with_key,
    stop_ssh_agent,
    cleanup_all_agents,
)

__all__ = [
    # 核心类
    "SSHTarget",
    "SSHRunner",
    "SSHAuth",
    "PasswordAuth",
    "KeyAuth",
    "KeyPassphraseAuth",
    "build_auth_from_data",
    # 工具
    "active_tasks",
    "kill_process",
    "parse_ls_output",
    "ssh_error_msg",
    "sanitize_output",
    # Agent 底层
    "start_ssh_agent_with_key",
    "stop_ssh_agent",
    "cleanup_all_agents",
]

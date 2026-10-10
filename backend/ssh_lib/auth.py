"""SSH 认证模块。

三种认证方式统一为多态对象：
- PasswordAuth(password)              # 密码
- KeyAuth(key_path)                   # 密钥（无短语）
- KeyPassphraseAuth(key_path, pass)   # 密钥 + 短语（自动启停 ssh-agent）

未来扩展：
- CertAuth（证书认证）
- HardwareTokenAuth（YubiKey/PIV）

每个 Auth 实例通过 `async with auth:` 使用；进入时设置好 SSH_AUTH_SOCK/SSHPASS
等副作用，退出时清理。
"""

import os
import shlex

from backend.ssh_lib import agent


SSH_CONNECT_TIMEOUT = 10


class SSHAuth:
    """认证方式基类。子类实现四个钩子。"""

    def ssh_opts(self, port: str) -> list:
        """返回 SSH 命令行选项（含 -p、-o StrictHostKeyChecking 等）。"""
        opts = [
            "-p", str(port),
            "-o", "StrictHostKeyChecking=accept-new",
            # ⚠ 注意: /dev/null 意味着**完全不做主机密钥校验** (每次连接都算首次)。
            #   这是历史实现。零信任钉死启用后会被下面的分支覆盖。
            "-o", "UserKnownHostsFile=/dev/null",
            # 抑制 "Warning: Permanently added ..." warning
            "-o", "LogLevel=ERROR",
            "-o", "ConnectTimeout=" + str(SSH_CONNECT_TIMEOUT),
        ]
        # 注: 钉死(零信任)在 SSHTarget.ssh_opts 里做 —— 那里才知道 host/port;
        #     SSHAuth 层拿不到 host, 放这里会静默失效。
        # 子类先出的 BatchMode 生效（ssh 取首值）
        opts.extend(self._auth_opts())
        # 若子类未设 BatchMode → 补默认 yes（禁 askpass 弹窗）
        joined = " ".join(opts)
        if "BatchMode=" not in joined:
            opts.extend(["-o", "BatchMode=yes"])
        return opts

    def _auth_opts(self) -> list:
        """子类补充认证相关的 -i / -o PreferredAuthentications 等选项。"""
        return []

    def rsync_ssh_parts(self, port: str) -> list:
        """rsync -e 使用的 ssh 命令片段（返回 ["ssh","-p",...]，供拼接）。"""
        return ["ssh"] + self.ssh_opts(port)

    def wrap_cmd(self, cmd: list) -> list:
        """密码场景在 cmd 前加 sshpass -e；其他场景原样返回。"""
        return cmd

    def prepare_env(self, env: dict) -> dict:
        """清 SSH_ASKPASS/DISPLAY，写入 SSHPASS / SSH_AUTH_SOCK 等。"""
        env = dict(env)
        env.pop("SSH_ASKPASS", None)
        env.pop("SSH_ASKPASS_REQUIRE", None)
        env.pop("DISPLAY", None)
        # 不清 SSH_AUTH_SOCK — 子类如 KeyPassphraseAuth 需要设它，
        # 反之其他 Auth 主动删除（见 PasswordAuth / KeyAuth）。
        return env

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def describe(self) -> str:
        return type(self).__name__


class PasswordAuth(SSHAuth):
    """密码认证：走 sshpass -e，通过 env['SSHPASS'] 传密码。"""

    def __init__(self, password: str):
        self.password = password or ""

    def _auth_opts(self) -> list:
        return [
            # 密码模式必须允许 sshpass 通过 PTY 注入 · 覆盖基类 BatchMode=yes
            "-o", "BatchMode=no",
            "-o", "NumberOfPasswordPrompts=1",
            "-o", "PreferredAuthentications=password,keyboard-interactive",
            "-o", "KbdInteractiveAuthentication=yes",
            "-o", "PasswordAuthentication=yes",
        ]

    def wrap_cmd(self, cmd: list) -> list:
        if not self.password:
            return cmd
        return ["sshpass", "-e"] + cmd

    def prepare_env(self, env: dict) -> dict:
        env = super().prepare_env(env)
        env.pop("SSH_AUTH_SOCK", None)  # 避免系统 agent 干扰
        if self.password:
            env["SSHPASS"] = self.password
        return env


class KeyAuth(SSHAuth):
    """密钥认证（无 passphrase）：命令行加 -i key_path。"""

    def __init__(self, key_path: str):
        self.key_path = (key_path or "").strip()

    @property
    def expanded_key(self) -> str:
        return os.path.expanduser(self.key_path) if self.key_path else ""

    def _auth_opts(self) -> list:
        opts = []
        if self.expanded_key:
            opts.extend(["-i", self.expanded_key])
        opts.extend(["-o", "PreferredAuthentications=publickey"])
        return opts

    def rsync_ssh_parts(self, port: str) -> list:
        # rsync -e 里 key 路径必须 shell-quote
        parts = ["ssh", "-p", str(port),
                 "-o", "StrictHostKeyChecking=accept-new",
                 "-o", "UserKnownHostsFile=/dev/null",
                 "-o", "LogLevel=ERROR",
                 "-o", "BatchMode=yes",
                 "-o", "ConnectTimeout=" + str(SSH_CONNECT_TIMEOUT)]
        if self.expanded_key:
            parts.extend(["-i", shlex.quote(self.expanded_key)])
        parts.extend(["-o", "PreferredAuthentications=publickey"])
        return parts

    def prepare_env(self, env: dict) -> dict:
        env = super().prepare_env(env)
        env.pop("SSH_AUTH_SOCK", None)
        # v4.15.13 · 无 passphrase 场景禁用 askpass GUI 弹窗（LXC/docker 里没 X 会挂 exec 错）
        env["SSH_ASKPASS"] = "/bin/false"
        env["SSH_ASKPASS_REQUIRE"] = "never"
        env.pop("DISPLAY", None)
        return env


class KeyPassphraseAuth(SSHAuth):
    """密钥+短语：`async with` 时启动 ssh-agent 加载密钥，退出时终止。

    注意：ssh 命令行**不**加 -i（agent 提供密钥），只加
    PreferredAuthentications=publickey 让 ssh 走 agent。
    """

    def __init__(self, key_path: str, passphrase: str):
        self.key_path = (key_path or "").strip()
        self.passphrase = passphrase or ""
        self.agent_pid = None
        self.agent_sock = None

    @property
    def expanded_key(self) -> str:
        return os.path.expanduser(self.key_path) if self.key_path else ""

    def _auth_opts(self) -> list:
        # 不加 -i；由 agent 提供密钥
        return ["-o", "PreferredAuthentications=publickey"]

    def rsync_ssh_parts(self, port: str) -> list:
        return [
            "ssh", "-p", str(port),
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR",
            "-o", "ConnectTimeout=" + str(SSH_CONNECT_TIMEOUT),
            "-o", "PreferredAuthentications=publickey",
        ]

    def prepare_env(self, env: dict) -> dict:
        env = super().prepare_env(env)
        if self.agent_sock:
            env["SSH_AUTH_SOCK"] = self.agent_sock
        else:
            env.pop("SSH_AUTH_SOCK", None)
        return env

    async def __aenter__(self):
        if not self.expanded_key:
            raise RuntimeError("KeyPassphraseAuth 需要 key_path")
        if not self.passphrase:
            # 降级为 KeyAuth 逻辑：无需 agent
            return self
        self.agent_pid, self.agent_sock = agent.start_ssh_agent_with_key(
            self.expanded_key, self.passphrase
        )
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if self.agent_pid:
            try:
                agent.stop_ssh_agent(self.agent_pid)
            finally:
                self.agent_pid = None
                self.agent_sock = None
        return False


def _materialize_key_if_content(key: str) -> str:
    """v4.15.12 · 如果 key 是密钥内容（PEM 文本）而非文件路径，写临时 0600 文件返回路径。
    否则原路返回（可能是路径或空）。"""
    import os as _os
    import tempfile as _tempfile
    key = (key or "").strip()
    if not key:
        return key
    # 已是文件路径
    if _os.path.isfile(_os.path.expanduser(key)):
        return key
    # 判断是否 PEM 密钥内容
    if "BEGIN" in key and "PRIVATE KEY" in key:
        try:
            fd, tmp_path = _tempfile.mkstemp(prefix="ssh_key_", suffix=".pem")
            _os.close(fd)
            with open(tmp_path, "w") as f:
                f.write(key if key.endswith("\n") else key + "\n")
            _os.chmod(tmp_path, 0o600)
            return tmp_path
        except Exception as e:
            print("[ssh_lib.auth] materialize key fail:", e)
            return key
    return key


def build_auth_from_data(data: dict):
    """从 WebSocket 数据构造 SSHAuth 实例。

    data 期望字段（前端保持不变）：
        auth_type: 'pass' | 'key'
        password:  base64 编码后的密码
        key:       base64 编码后的密钥路径 或 密钥内容（PEM）
        passphrase: base64 编码后的短语

    v4.15.12 · 密钥内容自动写临时文件（否则 ssh-agent/ssh-add 拿密钥文本当路径必挂）
    返回 SSHAuth 子类实例。"""
    from backend.auth import decode_password

    auth_type = str(data.get("auth_type") or "pass").strip().lower()
    # v5.90.2 · 只有**显式** key(含 key_pass 等前缀)才走密钥；其余一律按密码处理。
    #   此前写法是 `if auth_type == "pass"` → 任何异常取值(如 'password'/拼写错/空串)
    #   都会静默落到 KeyAuth, 把密码当密钥路径传给 `ssh -i` → 实测现象:
    #   "Warning: Identity file <密码当文件名> not accessible" + Permission denied,
    #   在上层被报成"文件不存在/SSH 连接失败", 极难排查。
    if not auth_type.startswith("key"):
        pwd = decode_password(data.get("password", ""))
        return PasswordAuth(pwd)
    # 密钥 (含或不含 passphrase)
    key = decode_password(data.get("key", "")) if data.get("key") else ""
    # 兼容双层编码
    if key and key.startswith("ENC:"):
        key = decode_password(key)
    # v4.15.12 · 内容 → 临时文件
    key = _materialize_key_if_content(key)
    passphrase = decode_password(data.get("passphrase", "")) if data.get("passphrase") else ""
    if passphrase and passphrase.startswith("ENC:"):
        passphrase = decode_password(passphrase)
    if passphrase:
        return KeyPassphraseAuth(key, passphrase)
    return KeyAuth(key)

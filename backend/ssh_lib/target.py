"""SSH 目标定义：远端服务器 + 认证 + 跳板（多跳）+ 全局选项。

未来 SCP / 多跳完全靠这里扩展：
- SSHTarget.proxy_jump（str, e.g. "user1@host1,user2@host2"）在 ssh_opts 里生成
  -o ProxyJump=... 参数
- Runner 层不需要感知跳板，直接构造出的 ssh_opts 已经带了 ProxyJump
"""

from dataclasses import dataclass, field
from typing import Optional, List

from backend.ssh_lib.auth import SSHAuth, build_auth_from_data


@dataclass
class SSHTarget:
    host: str
    port: str = "22"
    user: str = "root"
    auth: Optional[SSHAuth] = None
    # 多跳跳板：形如 ["user1@host1:22", "user2@host2:22"]
    # 空列表 = 直连
    proxy_jump: List[str] = field(default_factory=list)
    # 是否严格 KnownHosts 检查（默认 False，方便内网使用）
    strict_host: bool = False
    connect_timeout: int = 10
    # v5.20.0 · 远端 OS 声明: auto|linux|windows|macos
    #   auto(默认) = 首次用到时自动探测并缓存; 显式声明可跳过探测 (内网/受限环境友好)
    os_type: str = "auto"

    # 已解析出的 OS 档案 (懒加载, 见 os_profile())
    _os_profile: object = field(default=None, repr=False, compare=False)

    @classmethod
    def from_ws_data(cls, data: dict) -> "SSHTarget":
        """从 WebSocket 消息构造 SSHTarget。

        字段（前端命名保持不变）：
            host, port, user       - 目标服务器
            auth_type, password, key, passphrase - 认证
            proxy_jump             - 可选，逗号分隔的跳板串
            os_type                - 可选, auto|linux|windows|macos (v5.20.0)
        """
        host = (data.get("host") or "").strip()
        port = str(data.get("port") or "22").strip()
        user = (data.get("user") or "root").strip()
        auth = build_auth_from_data(data)
        # 多跳
        proxy_jump = []
        raw_pj = data.get("proxy_jump") or ""
        if isinstance(raw_pj, list):
            proxy_jump = [x for x in raw_pj if x]
        elif isinstance(raw_pj, str) and raw_pj.strip():
            proxy_jump = [x.strip() for x in raw_pj.split(",") if x.strip()]
        strict = bool(data.get("strict_host") or False)
        return cls(
            host=host, port=port, user=user,
            auth=auth, proxy_jump=proxy_jump, strict_host=strict,
            os_type=str(data.get("os_type") or "auto").strip().lower() or "auto",
        )

    async def os_profile(self):
        """v5.20.0 · 取远端 OS 档案 (显式声明优先, 否则探测并缓存)。

        拿到 profile 后用它构造/解析远端命令, 上层不再自己拼 POSIX 命令。
        """
        if self._os_profile is not None:
            return self._os_profile
        from backend import osprofile as _op
        fam = _op.OsFamily.parse(self.os_type)
        if fam == _op.OsFamily.UNKNOWN:
            fam = await _op.detect_async(self)
        self._os_profile = _op.profile_for(fam)
        return self._os_profile

    async def os_family(self):
        """v5.20.0 · 便捷: 只取 OS 家族枚举"""
        return (await self.os_profile()).family

    def _apply_pin(self, opts: list) -> list:
        """v5.20.0 · 阶段5 零信任: 已钉死主机密钥时, 交给 OpenSSH 强校验。

        背景: 默认实现是 `UserKnownHostsFile=/dev/null` + `accept-new`,
        等于**完全不做主机密钥校验**(每次连接都算首次)。这里在已钉死的情况下换成
        单独的 known_hosts 文件 + `StrictHostKeyChecking=yes` —— 校验在握手内完成,
        没有"先看一眼再放行"的 TOCTOU 窗口, 不匹配就直接连不上。
        """
        try:
            from backend.core_fabric import zerotrust as _zt
            if not str(self.host or "").strip():
                return opts
            kh = _zt.known_hosts_for(self.host, self.port)
            if not kh:
                return opts
            out, i = [], 0
            while i < len(opts):
                tok = str(opts[i])
                if tok == "-o" and i + 1 < len(opts):
                    v = str(opts[i + 1])
                    if v.startswith("UserKnownHostsFile="):
                        out.extend(["-o", "UserKnownHostsFile=" + kh]); i += 2; continue
                    if v.startswith("StrictHostKeyChecking="):
                        out.extend(["-o", "StrictHostKeyChecking=yes"]); i += 2; continue
                out.append(opts[i]); i += 1
            return out
        except Exception as _e:
            import logging as _lg
            _lg.debug("零信任钉死接入失败(回退默认): %s", _e)
            return opts

    def ssh_opts(self) -> list:
        """完整的 SSH 命令行选项（含跳板 + 认证）。"""
        opts = self._apply_pin(self.auth.ssh_opts(self.port))
        # ConnectTimeout 由 auth.ssh_opts 提供默认值；strict_host 覆盖
        if self.strict_host:
            # v5.8.0 · strict_host=True 语义 = 严格校验(拒绝未知主机):
            #   删除 accept-new + /dev/null, 交由系统 known_hosts 严格处理
            #   (默认 accept-new = 首连自动信任并记录, 之后变更则拒绝 — 防中间人)
            filtered = []
            skip_next = False
            for i, tok in enumerate(opts):
                if skip_next:
                    skip_next = False
                    continue
                if tok == "-o" and i + 1 < len(opts):
                    v = opts[i + 1]
                    if v.startswith("StrictHostKeyChecking=") or v.startswith("UserKnownHostsFile="):
                        skip_next = True
                        continue
                filtered.append(tok)
            opts = filtered
        # 多跳
        if self.proxy_jump:
            opts.extend(["-o", "ProxyJump=" + ",".join(self.proxy_jump)])
        # v5.32.0 · 连接中心复用: 该 endpoint 有活跃 ControlMaster 会话 → 走复用通道
        try:
            from backend import conn_registry as _cr
            opts += _cr.master_opts(self.host, self.port, self.user)
        except Exception:
            pass
        return opts

    def rsync_ssh_parts(self) -> list:
        """rsync -e 使用的 ssh 命令片段（含跳板 + 认证）。"""
        parts = self._apply_pin(self.auth.rsync_ssh_parts(self.port))
        if self.strict_host:
            # v5.8.0 · 同上: strict_host=True → 删除 accept-new, 用系统严格校验
            filtered = []
            skip_next = False
            for i, tok in enumerate(parts):
                if skip_next:
                    skip_next = False
                    continue
                if tok == "-o" and i + 1 < len(parts):
                    v = parts[i + 1]
                    if v.startswith("StrictHostKeyChecking=") or v.startswith("UserKnownHostsFile="):
                        skip_next = True
                        continue
                filtered.append(tok)
            parts = filtered
        if self.proxy_jump:
            parts.extend(["-o", "ProxyJump=" + ",".join(self.proxy_jump)])
        # v5.32.0 · 连接中心复用: 该 endpoint 有活跃 ControlMaster 会话 → 走复用通道
        try:
            from backend import conn_registry as _cr
            parts += _cr.master_opts(self.host, self.port, self.user)
        except Exception:
            pass
        return parts

    def endpoint(self) -> str:
        """user@host 字符串。"""
        return f"{self.user}@{self.host}"

    def runner(self) -> "SSHRunner":
        # 延迟 import 避免循环
        from backend.ssh_lib.runner import SSHRunner
        return SSHRunner(self)

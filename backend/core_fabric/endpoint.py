"""Fonriv - Transfer Fabric · P0 Endpoint 抽象层 (v5.8.0)

统一端点模型: 10 类端点收敛为单一 Endpoint 描述符 + 注册表。
原则: **新老并存** — 现有传输逻辑暂不迁移, 新代码(列举/鉴权/健康探活)从这里走。

用法:
    from core.endpoint import Endpoint, EndpointKind, register_endpoint, resolve

    @register_endpoint(EndpointKind.SSH)
    class SSHProvider(BaseEndpointProvider): ...

    ep = Endpoint(kind=EndpointKind.LOCAL, path='/tmp')
    provider = resolve(ep)
    entries = await provider.list_dir('/tmp/mx_src')
"""
from __future__ import annotations

import asyncio
import os
import shlex
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class EndpointKind(Enum):
    """全项目唯一的端点类型枚举 (P0 覆盖 3 类, 后续期次扩展)"""
    LOCAL = "local"        # 本机文件系统
    SSH = "ssh"            # 远端 SSH 服务器 (configs 表)
    CLOUD = "cloud"        # 云端存储 (remote_configs: seafile/s3/webdav/oss/cos/pan123/local)
    # ── 以下类型 P1+ 逐步纳入 ──
    MOUNT = "mount"        # df 挂载点 (本机或远端磁盘)
    SHARE = "share"        # 网络共享挂载 (smb/nfs/afp/webdav)
    PVE = "pve"            # Proxmox 节点
    K8S = "k8s"            # K8s 集群
    RESTIC = "restic"      # restic 仓库
    CROC = "croc"          # P2P 摆渡


@dataclass
class Caps:
    """端点能力矩阵 — Planner 路由决策的输入"""
    read: bool = True
    write: bool = True
    list: bool = True
    stat: bool = True
    random_read: bool = False        # 是否支持随机读 (对象存储=假)
    rename_atomic: bool = False      # 原子改名 (NFS 某些实现=假)
    preserve_meta: bool = False      # 权限/时间戳/属主保留
    delta: bool = False              # 块级差量 (rsync 通路)
    snapshot: bool = False           # 快照能力 (zfs/lvm)
    object_lock: bool = False        # 不可变/只追加
    append_only: bool = False


@dataclass
class Endpoint:
    """统一端点描述符 — 任何模块都用这个 (替代各处内联 dict)"""
    kind: EndpointKind
    path: str = "/"                                    # 本机路径 / 远端路径 / 云端 key
    host: Optional[str] = None                         # SSH 主机
    port: Optional[int] = None
    user: Optional[str] = None
    # 凭据引用 (P0 阶段: 明文字段直传; P1+ 收敛为 credential_id → 集中解密)
    auth_type: Optional[str] = None                    # pass | key
    password: Optional[str] = None
    key: Optional[str] = None
    passphrase: Optional[str] = None
    # 云端/共享
    remote_id: Optional[int] = None                    # remote_configs.id
    remote_uuid: Optional[str] = None
    label: str = ""

    def to_ssh_data(self) -> dict:
        """转为 SSHTarget.from_ws_data 兼容字段 (复用既有规范通路)"""
        return {"host": self.host or "", "port": str(self.port or 22), "user": self.user or "root",
                "auth_type": self.auth_type or "pass", "password": self.password or "",
                "key": self.key or "", "passphrase": self.passphrase or ""}

    def is_local(self) -> bool:
        """是否应走本机通路 (本地类型, 或 SSH 主机为本机回环)"""
        if self.kind == EndpointKind.LOCAL:
            return True
        h = (self.host or "").strip().lower()
        return h in ("", "127.0.0.1", "localhost", "::1", "0.0.0.0")

    def display(self) -> str:
        if self.kind == EndpointKind.CLOUD:
            return f"☁ {self.label or ('remote#' + str(self.remote_id))}:{self.path}"
        if self.kind == EndpointKind.SSH and self.host:
            return f"{self.user}@{self.host}:{self.path}"
        return self.path


# ═════════════════════════════════════════════════════════════
# Provider 注册表
# ═════════════════════════════════════════════════════════════

class BaseEndpointProvider:
    """端点 Provider 统一接口 — 每种 EndpointKind 实现一次"""

    kind: EndpointKind = None  # 子类覆盖
    caps: Caps = Caps()

    def __init__(self, ep: Endpoint):
        self.ep = ep

    async def list_dir(self, path: str) -> dict:
        """返回 {status, path, entries:[{name,path,type,is_dir,size,mtime}]} (契约同 list_dir)"""
        raise NotImplementedError

    async def stat(self, path: str) -> dict:
        raise NotImplementedError

    def health(self) -> dict:
        """健康探活: {ok, detail} — P3 接入 Dashboard"""
        return {"ok": False, "detail": "not implemented"}


# ---- 注册表 ----

_PROVIDERS: dict = {}


def register_endpoint(kind: EndpointKind):
    """装饰器: 新端点实现只需 @register_endpoint(EndpointKind.X) — 核心零改动"""
    def deco(cls):
        _PROVIDERS[kind] = cls
        cls.kind = kind
        return cls
    return deco


def resolve(ep: Endpoint) -> BaseEndpointProvider:
    cls = _PROVIDERS.get(ep.kind)
    if not cls:
        raise ValueError(f"未注册的端点类型: {ep.kind}")
    return cls(ep)


def registered_kinds() -> list:
    return list(_PROVIDERS.keys())


# ═════════════════════════════════════════════════════════════
# 内置实现 (P0: 本机 / SSH / 云端 — 复用既有规范通路, 不重写)
# ═════════════════════════════════════════════════════════════

@register_endpoint(EndpointKind.LOCAL)
class LocalProvider(BaseEndpointProvider):
    """本机文件系统 — 复用 handle_list_dir 的逻辑 (同契约)"""
    caps = Caps(preserve_meta=True, rename_atomic=True, random_read=True)

    async def list_dir(self, path: str) -> dict:
        from backend.handlers.rsync import handle_list_dir

        class _WS:
            def __init__(self): self.sent = []
            async def send_json(self, d): self.sent.append(d)
        ws = _WS()
        await handle_list_dir(ws, {"path": path})
        r = ws.sent[-1] if ws.sent else {"status": "error", "msg": "no reply"}
        if r.get("status") == "ok":
            r["endpoint"] = self.ep.display()
        return r


@register_endpoint(EndpointKind.SSH)
class SSHProvider(BaseEndpointProvider):
    """远端 SSH — 复用 SSHTarget + handle_list_remote_dir (同契约)"""
    caps = Caps(preserve_meta=True, rename_atomic=True, random_read=True, delta=True)

    async def list_dir(self, path: str) -> dict:
        from backend.handlers.rsync import handle_list_remote_dir

        class _WS:
            def __init__(self): self.sent = []
            async def send_json(self, d): self.sent.append(d)
        ws = _WS()
        await handle_list_remote_dir(ws, dict(self.ep.to_ssh_data(), path=path))
        r = ws.sent[-1] if ws.sent else {"status": "error", "msg": "no reply"}
        if r.get("status") == "ok":
            r["endpoint"] = self.ep.display()
        return r

    def health(self) -> dict:
        return {"ok": bool(self.ep.host), "detail": self.ep.host or "no host"}


@register_endpoint(EndpointKind.CLOUD)
class CloudProvider(BaseEndpointProvider):
    """云端存储 — 复用 _resolve_remote + storage.list_dir (同契约)"""
    caps = Caps(rename_atomic=False, random_read=False, object_lock=True)

    async def list_dir(self, path: str) -> dict:
        import asyncio
        from backend import db
        # v1.0.0 · 远端存储未包含在本发行版 → 明确报错 (不再抛 ModuleNotFoundError)
        try:
            from backend.remotes.base import build_from_config
            from backend.handlers.remotes import _resolve_remote
        except ImportError:
            return {"status": "error", "msg": "云端存储未包含在本发行版中"}

        class _WS:
            def __init__(self): self.sent = []
            async def send_json(self, d): self.sent.append(d)
        ws = _WS()
        await _cloud_list(ws, self.ep, path)
        r = ws.sent[-1] if ws.sent else {"status": "error", "msg": "no reply"}
        if r.get("status") == "ok":
            r["endpoint"] = self.ep.display()
        return r

    def health(self) -> dict:
        return {"ok": self.ep.remote_id is not None or bool(self.ep.remote_uuid),
                "detail": f"remote={self.ep.remote_id or self.ep.remote_uuid}"}


async def _cloud_list(ws, ep: Endpoint, path: str):
    """云端列举 (与 handle_remote_ls 同逻辑, 抽出供 Endpoint 复用)"""
    # v1.0.0 · 远端存储未包含在本发行版 → 明确报错 (不再抛 ModuleNotFoundError)
    try:
        from backend.handlers.remotes import _resolve_remote
        from backend.remotes.base import build_from_config
    except ImportError:
        await ws.send_json({"type": "remote_ls_result", "status": "error",
                            "req_id": "", "msg": "云端存储未包含在本发行版中"})
        return
    cfg, rid, ruuid = _resolve_remote({"remote_id": ep.remote_id, "remote_uuid": ep.remote_uuid})
    if not cfg:
        await ws.send_json({"type": "remote_ls_result", "status": "error",
                            "req_id": "", "msg": "remote 不存在"})
        return
    try:
        storage = build_from_config(cfg)
        entries = await asyncio.to_thread(storage.list_dir, path or "")
        entries.sort(key=lambda x: (not x.get("is_dir"), x.get("name", "")))
        await ws.send_json({"type": "remote_ls_result", "status": "ok", "path": path,
                            "entries": entries, "provider": cfg.get("provider")})
    except Exception as e:
        await ws.send_json({"type": "remote_ls_result", "status": "error",
                            "msg": f"云端列举失败: {str(e)[:150]}"})


# ── 便捷构造: 从现有前端描述符 dict 构建 Endpoint (新老桥接) ──

def endpoint_from_ws(desc: dict, conn: dict = None) -> Endpoint:
    """把现有各页面的"来源描述符 + conn"桥接为 Endpoint (渐进收敛用)"""
    conn = conn or {}
    kind = (desc or {}).get("kind") or "local"
    if kind == "cloud":
        return Endpoint(kind=EndpointKind.CLOUD, remote_id=desc.get("cloudId"),
                        remote_uuid=desc.get("remote_uuid"), path=desc.get("path") or "/")
    if kind in ("ssh", "df") and (conn.get("host") or desc.get("host")):
        return Endpoint(kind=EndpointKind.SSH, host=conn.get("host") or desc.get("host"),
                        port=int(conn.get("port") or 22), user=conn.get("user") or "root",
                        auth_type=conn.get("auth_type") or "pass", password=conn.get("password") or "",
                        key=conn.get("key") or "", passphrase=conn.get("passphrase") or "",
                        path=desc.get("path") or "/")
    return Endpoint(kind=EndpointKind.LOCAL, path=desc.get("path") or "/")

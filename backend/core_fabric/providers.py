"""Fonriv - Transfer Fabric P1 · 统一传输 Provider 层 (纯函数 build)

原则:
  - build_* 为**纯函数**: 输入 TransferSpec → 输出 argv/steps, 无 IO, 可单测可 diff
  - 每个引擎一个 Provider; 全项目唯一的命令拼装点 (收敛原 20+ 处)
  - P1 范围: rsync (up/down/local) + rclone (up/down)。cross/sync/分片 P1 后期搬迁
"""
from __future__ import annotations

import os
import shlex
from dataclasses import dataclass, field
from typing import Optional

from backend.core_fabric.endpoint import Endpoint, EndpointKind


# ═════════════════════════════════════════════════════════════
# 传输规格 (Planner P2 接管前的过渡形态: 显式列出全部参数)
# ═════════════════════════════════════════════════════════════

@dataclass
class TransferSpec:
    """一次传输的完整参数 (来自前端 + Planner; Executor 只消费它)"""
    src: str                                # 源路径 (本机路径 或 远端绝对路径)
    dst: str                                # 目标路径 (同上)
    direction: str = "up"                   # up | down | local
    engine: str = "rsync"                   # rsync | rclone
    # ssh 端点 (up/down 时必须; local 时忽略)
    host: Optional[str] = None
    port: int = 22
    user: str = "root"
    auth_type: str = "pass"
    password: Optional[str] = None
    key: Optional[str] = None
    passphrase: Optional[str] = None
    # 引擎参数
    # v5.20.0 · `-z` 移出默认: 实测不可压缩数据下慢 8.1 倍 (128.1→15.8 MB/s);
    #   压缩与否统一由 planner.decide_compress() 决定。见 docs/性能基线实测报告_v5.20.md
    flags: list = field(default_factory=lambda: ["-a", "-v", "--progress", "--partial"])
    bwlimit: str = "0"                      # "0"=不限; "2m"/"500k"…
    exclude: str = ""                       # 逗号分隔
    # rclone 专属
    rclone_transfers: int = 4
    # v5.19.4 · L2 端到端加密与路由提示 (由 Planner 决策, Executor 消费)
    force_l2: bool = False          # 显式要求 L2
    via_relay: bool = False         # 经中转机 (数据落盘 → 强制 L2)
    src_remote: bool = False        # 源是远端 (用于判断 cross/中继路径)
    dst_remote: bool = False        # 目标是远端
    # 云端
    cloud_remote: Optional[str] = None      # rclone remote 名 (云端目标时)
    # v5.20.0 · WebDAV 服务端类型 (nextcloud|owncloud|other): 决定是否有 mtime/哈希
    vendor: str = ""


def normalize_src_dst(src: str, dst: str) -> tuple:
    """折叠 /../ 与重复斜杠 (与前端 _normPath 同语义; 后端兜底)"""
    def _n(p: str) -> str:
        s = str(p or "").replace("//", "/")
        while True:
            n2 = s.replace("/./", "/").replace("//", "/")
            if n2 == s:
                break
            s = n2
        out = []
        for seg in s.split("/"):
            if seg == "..":
                if out:
                    out.pop()
            elif seg and seg != ".":
                out.append(seg)
        return "/" + "/".join(out) if s.startswith("/") else "/".join(out) or "/"
    return _n(src), _n(dst)


# ═════════════════════════════════════════════════════════════
# SSH Provider (纯函数)
# ═════════════════════════════════════════════════════════════

def rsync_ssh_opts(port: int) -> list:
    """rsync -e 的 ssh 片段 (accept-new 安全基线; 与 ssh_lib 同语义)"""
    return ["-e", f"ssh -p {int(port)} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"]


def build_rsync(spec: TransferSpec) -> dict:
    """构建 rsync argv (up/down/local; 纯函数)。

    返回 {kind: "argv"|"ssh_argv", argv: [...], ok, msg}
      - kind=argv      → 本机直接执行
      - kind=ssh_argv  → 经 ssh_lib 执行 ( argv 为远端命令串 )
    """
    src, dst = normalize_src_dst(spec.src, spec.dst)
    flags = [f for f in spec.flags if f not in ("--bwlimit", "--exclude")]
    if spec.bwlimit and spec.bwlimit != "0":
        flags.append("--bwlimit=" + str(spec.bwlimit))
    if "--exclude" in (spec.flags or []) and spec.exclude:
        for pat in spec.exclude.split(","):
            if pat.strip():
                flags.extend(["--exclude", pat.strip()])

    if spec.direction == "local":
        return {"kind": "argv", "argv": ["rsync"] + flags + [src, dst], "ok": True, "src": src, "dst": dst}

    # up/down: 远端一端
    if not spec.host:
        return {"kind": "none", "argv": [], "ok": False, "msg": "缺少远端主机"}
    ssh_parts = rsync_ssh_opts(spec.port)
    if spec.direction == "up":
        argv = ["rsync"] + flags + ssh_parts + [src, f"{spec.user}@{spec.host}:{dst}"]
        return {"kind": "argv", "argv": argv, "ok": True, "src": src, "dst": dst}
    if spec.direction == "down":
        argv = ["rsync"] + flags + ssh_parts + [f"{spec.user}@{spec.host}:{src}", dst]
        return {"kind": "argv", "argv": argv, "ok": True, "src": src, "dst": dst}
    return {"kind": "none", "argv": [], "ok": False,
            "msg": f"fonrivvider 暂不支持方向: {spec.direction} (cross/sync P1 后期搬迁)"}


# ═════════════════════════════════════════════════════════════
# rclone Provider (纯函数)
# ═════════════════════════════════════════════════════════════

def rclone_remote_base(spec: TransferSpec) -> str:
    """:sftp 内联连接串 (密码 obscure 由调用方预先完成, 此处接收已 obscure 值)"""
    bits = [f"host={spec.host}", f"user={spec.user or 'root'}", f"port={spec.port or 22}"]
    if spec.password:
        bits.append("pass=" + spec.password)          # 已 obscure
    elif spec.key:
        bits.append("key_file=" + os.path.expanduser(spec.key.strip()))
    return ":sftp," + ",".join(bits)


def rclone_remote_webdav(spec: TransferSpec, vendor: str = "") -> str:
    """v5.20.0 · :webdav 内联连接串 (私有云/网盘批量传输)

    用内联连接串而不是写 rclone.conf 的好处:
      · 不必让用户手工 `rclone config` 配 remote (现状 remotes/rclone.py 只能包装已存在的 remote)
      · 凭据不落盘 (pass 需先 rclone obscure)
      · 一次覆盖 Nextcloud / ownCloud / Cloudreve / Kodbox / ZFile / 群晖 / NAS 的 WebDAV

    vendor 决定服务端能力 (rclone 官方文档):
      nextcloud / owncloud → 支持 mtime (X-OC-Mtime) + SHA1/MD5 哈希, 分块上传默认 10Mi
      other                → **无 mtime、无哈希** (纯 WebDAV), 增量只能靠大小 + 本地清单账本
    """
    # vendor 取值优先级: 显式参数 > spec.vendor > other
    #   (注意 vendor 形参不能默认 "other", 否则会把 spec.vendor 永远盖掉)
    v = (vendor or getattr(spec, "vendor", "") or "other").strip().lower()
    if v not in ("nextcloud", "owncloud", "other"):
        v = "other"
    bits = [f"url={spec.host}", f"vendor={v}"]
    if spec.user:
        bits.append("user=" + spec.user)
    if spec.password:
        bits.append("pass=" + spec.password)          # 已 obscure
    return ":webdav," + ",".join(bits)


def build_rclone(spec: TransferSpec, obscured_password: Optional[str] = None) -> dict:
    """构建 rclone argv (up/down; 纯函数)。obscured_password: 调用方 rclone obscure 后的值"""
    spec.password = obscured_password or spec.password
    src, dst = normalize_src_dst(spec.src, spec.dst)
    transfers = max(1, min(16, int(spec.rclone_transfers or 4)))
    base_flags = ["--transfers", str(transfers), "--checkers", str(transfers * 2),
                  "--stats-one-line", "--stats", "1s", "-P", "-v"]
    if spec.bwlimit and spec.bwlimit != "0":
        base_flags.append("--bwlimit=" + str(spec.bwlimit))
    if spec.exclude:
        for pat in spec.exclude.split(","):
            if pat.strip():
                base_flags += ["--exclude", pat.strip()]

    rb = rclone_remote_base(spec)

    if spec.direction == "up":
        # 路径语义对齐 rsync: 目录尾斜杠=内容; 不带斜杠=目录本身
        if os.path.isfile(src):
            remote = rb + ":" + dst.rstrip("/")
            argv = ["rclone", "copyto", src, remote]
        elif src.endswith("/"):
            remote = rb + ":" + dst.rstrip("/")
            argv = ["rclone", "copy", src, remote]
        else:
            b = os.path.basename(src.rstrip("/"))
            argv = ["rclone", "copy", src, rb + ":" + (dst.rstrip("/") + "/" + b)]
        return {"kind": "argv", "argv": argv + base_flags, "ok": True, "src": src, "dst": dst}

    if spec.direction == "down":
        if src.endswith("/"):
            argv = ["rclone", "copy", rb + ":" + src, dst]
        else:
            argv = ["rclone", "copyto", rb + ":" + src, dst]
        return {"kind": "argv", "argv": argv + base_flags, "ok": True, "src": src, "dst": dst}

    return {"kind": "none", "argv": [], "ok": False,
            "msg": f"rclone provider 暂不支持方向: {spec.direction}"}


PROVIDERS = {
    "rsync": build_rsync,
    "rclone": build_rclone,
}


def build(spec: TransferSpec) -> dict:
    """统一入口: 按引擎分发 (Executor 唯一调用点)"""
    fn = PROVIDERS.get(spec.engine)
    if not fn:
        return {"kind": "none", "argv": [], "ok": False, "msg": f"未知引擎: {spec.engine}"}
    return fn(spec)

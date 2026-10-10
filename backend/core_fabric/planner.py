"""Fonriv - Transfer Fabric P3 · Planner (唯一决策入口) + Ledger (校验账本)

P3 核心:
  - Planner.plan(spec) → TransferPlan: 引擎/参数/加密级别**一次算完** (engine_selector 接线)
  - Ledger: 任务清单 (路径→size/sha256) + 传输后对账 diff
  - 断点续跑以账本为准: skip 已 verified 的条目
"""
from __future__ import annotations

import hashlib
import logging
import os
import time
from dataclasses import dataclass, field

from backend.core_fabric.endpoint import Endpoint, EndpointKind, Caps
from backend.core_fabric.providers import TransferSpec


# ═════════════════════════════════════════════════════════════
# TransferPlan (Planner 输出 = Executor 输入)
# ═════════════════════════════════════════════════════════════

@dataclass
class TransferPlan:
    spec: TransferSpec
    engine: str                     # rsync | rclone
    direction: str                  # up | down | local
    compress: bool = True           # engine_selector.decide 的 compress 落地
    shards: int = 0                 # 0 = 不分片
    concurrency: int = 4
    bwlimit: str = "0"
    encrypt_level: str = "L1"       # L1 通道 | L2 端到端
    verify: str = "size"            # none | size | sha256
    reasons: list = field(default_factory=list)   # 决策理由 (可解释)

    def to_spec(self) -> TransferSpec:
        s = self.spec
        s.engine = self.engine
        return s


# ═════════════════════════════════════════════════════════════
# Planner (engine_selector 的正确归宿)
# ═════════════════════════════════════════════════════════════

class Planner:
    """唯一决策入口 — 前端建议 = 实际行为"""

    def __init__(self, src: Endpoint, dst: Endpoint):
        self.src = src
        self.dst = dst

    def plan(self, spec: TransferSpec) -> TransferPlan:
        reasons = []
        # ① 引擎选择: 复用 engine_selector 的决策 (真实接线, 不再分叉)
        engine, sel_reasons = self._select_engine(spec)
        reasons += sel_reasons
        spec.engine = engine

        # ② 压缩: engine_selector 的 compress 落地 (此前从未被消费)
        compress, c_reason = self._decide_compress(spec)
        reasons.append(c_reason)
        if not compress and "-z" in spec.flags:
            spec.flags = [f for f in spec.flags if f != "-z"]

        # ③ 加密级别
        enc, e_reason = self._decide_encrypt(spec)
        reasons.append(e_reason)

        return TransferPlan(spec=spec, engine=engine, direction=spec.direction,
                            compress=compress, encrypt_level=enc, reasons=reasons)

    def _endpoint_kind_name(self) -> str:
        """把端点枚举映射成 engine_selector.decide() 的 dst_kind 取值"""
        from backend.core_fabric.endpoint import EndpointKind
        kinds = {getattr(self.src, "kind", None), getattr(self.dst, "kind", None)}
        if EndpointKind.CLOUD in kinds:
            return "cloud"
        if EndpointKind.SSH in kinds:
            return "ssh"
        if kinds == {EndpointKind.LOCAL} or kinds == {None}:
            return "local"
        return ""

    def _select_engine(self, spec: TransferSpec) -> tuple:
        """引擎决策 (v5.20.0 · auto 档统一走 engine_selector.decide, 不再硬编码 rsync)

        三处决策曾各算各的 (planner / engine_selector / handlers/rsync.py), 口径不一致。
        现统一到 decide(), 并传入端点类型 —— 实测 SSH 与云端的引擎优劣相反:
          SSH/本地端点 → rsync (大文件快 13%, 小文件快 17.6 倍)
          云/对象存储   → rclone (服务端复制 + 分块并发上传)
        """
        reasons = []
        from backend.core_fabric.endpoint import EndpointKind
        # 云端端点 → rclone (无需画像, 结论明确)
        if getattr(self.dst, "kind", None) == EndpointKind.CLOUD or \
           getattr(self.src, "kind", None) == EndpointKind.CLOUD:
            reasons.append("云端端点 → rclone (对象存储服务端复制/并发优势)")
            return "rclone", reasons
        # 系统设置优先级最高
        try:
            from backend import db
            pref = (db.setting_get("transfer_engine", "auto") or "auto").strip().lower()
            if pref in ("rsync", "rclone"):
                reasons.append(f"管理设置: {pref}")
                return pref, reasons
        except Exception:
            pass
        # auto: 用 engine_selector 的加权决策 (唯一实现)
        try:
            from backend.engine_selector import decide as _decide, profile_source as _profile
            root = str(spec.src or "").rstrip("/")
            if root and os.path.isdir(root):
                prof = _profile(root)
                kind = self._endpoint_kind_name()
                d = _decide(prof, "auto", spec.direction, kind)
                reasons.append(
                    f"engine_selector: {d.engine} 胜出 "
                    f"(rsync {d.scores.get('rsync')} / rclone {d.scores.get('rclone')}, 端点 {kind or '未知'})")
                for _r in d.reasons[:3]:
                    reasons.append(_r)
                return d.engine, reasons
        except Exception as _e:
            logging.debug("planner engine_selector 调用失败: %s", _e)
        reasons.append("auto → rsync (默认)")
        return "rsync", reasons

    def _decide_compress(self, spec: TransferSpec) -> tuple:
        """压缩决策 (v5.20.0 起委托给模块级实现, 与 up/down 路径同源)"""
        return decide_compress(spec.src, spec.direction, getattr(spec, "host", "") or "")


    def _decide_encrypt(self, spec: TransferSpec) -> tuple:
        """加密级别决策 (v5.19.4 · L2 真正接线)

        判定顺序 (先命中先返回):
          ① 显式请求 force_l2           → L2 (用户/上层明确要求端到端)
          ② relay 中转 / 非 SSH 的跨机   → L2 (数据在中转机落盘, 通道加密不覆盖静态数据)
          ③ 公网地址且非 SSH 信任通道    → L2
          ④ SSH 直连                    → L1 (SSH 已提供通道加密 + 主机校验)
          ⑤ 本机 / 云端 HTTPS           → L1
        """
        # ① 显式要求
        if getattr(spec, "force_l2", False):
            return "L2", "显式要求端到端加密 (force_l2)"
        # ② relay 中转: 数据会落在中转机磁盘, 必须内容级加密
        if getattr(spec, "via_relay", False) or self._is_relay_path(spec):
            return "L2", "Relay 中转路径 — 数据经中转机落盘, 强制 L2 端到端"
        # ③ 公网 + 非 SSH
        host = str(getattr(spec, "host", "") or "")
        if host and spec.engine == "rsync":
            if self._is_public_host(host):
                return "L1", f"SSH 通道加密 (公网 {host[:24]} · accept-new 主机校验)"
            return "L1", "SSH 通道加密 (accept-new 主机校验)"
        if host and spec.engine == "rclone" and self._is_public_host(host):
            return "L2", f"公网非 SSH 通路 ({host[:24]}) — 建议 L2 端到端"
        # ④ 本机 / 云端
        if not host:
            return "L1", "本机通路 (无跨机传输)"
        return "L1", "云端 HTTPS 通道"

    @staticmethod
    def _is_public_host(host: str) -> bool:
        """判断是否公网地址 (委托模块级 is_public_host, 单一实现)"""
        return is_public_host(host)

    def _is_relay_path(self, spec: TransferSpec) -> bool:
        """是否走中继: 源与目标都是远端 (cross) 或上层标记"""
        try:
            if getattr(spec, "src_remote", False) and getattr(spec, "dst_remote", False):
                return True
        except Exception:
            pass
        return False

    def needs_l2(self, plan: "TransferPlan") -> bool:
        """plan 是否需要 L2 端到端加密 (供 Executor 消费)"""
        return str(getattr(plan, "encrypt_level", "L1")).upper() == "L2"


def needs_l2(plan: "TransferPlan") -> bool:
    """v5.19.4 · 模块级判定: plan 是否需要 L2 端到端加密

    供 Executor 直接调用 (Planner 类同名方法保留兼容)。
    """
    return str(getattr(plan, "encrypt_level", "L1")).upper() == "L2"


def is_public_host(host: str) -> bool:
    """判断是否公网地址 (非 RFC1918 私网 / 非回环 / 非链路本地)。"""
    import ipaddress as _ip
    h = str(host or "").strip()
    if not h:
        return False
    try:
        ip = _ip.ip_address(h.split(":")[0])
    except Exception:
        # 域名: 保守视为公网 (除非明显的本机名)
        low = h.lower()
        return not (low in ("localhost",) or low.endswith(".local") or low.endswith(".lan"))
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved)


def _probe_compressible(root: str, max_files: int = 3, sample: int = 65536):
    """内容嗅探: 用 zlib 实测压缩率, 返回 True/False/None(无法判定)。

    为什么需要: engine_selector 的 `incompressible_ratio` **只看文件扩展名**
    (INCOMPRESSIBLE_EXTS), 对 `.dat`/`.bin`/无扩展名 的随机内容完全漏判 ——
    而实测中 `-z` 慢 8.1 倍的那次, 源正是 `big.dat` 里的 /dev/urandom 数据。
    只采样前几个文件的头部 64KB, 开销可忽略。
    """
    import zlib
    try:
        names = sorted(os.listdir(root))[:max(max_files, 1) * 4]
    except OSError:
        return None
    tested = 0
    for n in names:
        if tested >= max_files:
            break
        fp = os.path.join(root, n)
        if not os.path.isfile(fp):
            continue
        try:
            with open(fp, "rb") as f:
                data = f.read(sample)
        except OSError:
            continue
        if len(data) < 4096:
            continue
        tested += 1
        try:
            if len(zlib.compress(data, 1)) >= len(data) * 0.95:
                return False   # 压不动 → 判定不可压缩
        except Exception:
            continue
    return True if tested else None


def decide_compress(src_path: str, direction: str = "up", host: str = "") -> tuple:
    """v5.20.0 · 压缩决策 (唯一实现, Planner 与 up/down 路径共用)

    实测依据 (docs/性能基线实测报告_v5.20.md §阶段3, 1GB 单文件本机→9.22):
      · 不可压缩数据 + `-z`: 128.1 MB/s → **15.8 MB/s (慢 8.1 倍)**
      · 内网链路 12~17 Gbps, 传输瓶颈是 SSH 加解密 CPU (2 核 VM 打满) 而非带宽
      · 因此内网压缩纯属浪费 CPU; 只有"网络才是瓶颈"(公网) 且"内容可压缩"时才划算

    规则: 默认关闭 → 源可压缩 (扩展名启发式 **且** 内容嗅探都不反对) 且 目标是公网 → 开启。
    返回 (bool, 理由字符串)。
    """
    default = (False, "默认关闭压缩 (实测不可压缩数据下 -z 慢 8.1 倍; 内网瓶颈是 CPU 而非带宽)")
    try:
        from backend.engine_selector import profile_source
        root = (src_path or "").rstrip("/")
        if direction not in ("up", "local") or not root or not os.path.isdir(root):
            return default
        profile = profile_source(root)
        ratio = float(getattr(profile, "incompressible_ratio", 0.0) or 0.0)
        if ratio > 0.7:
            return False, f"不可压缩占比 {ratio:.0%} > 70% (按扩展名) → 关闭压缩"
        if not (host and is_public_host(host)):
            return False, f"内网/CPU 受限链路 → 关闭压缩 (不可压缩占比 {ratio:.0%})"
        if ratio > 0.3:
            return False, f"不可压缩占比 {ratio:.0%} > 30% → 公网也不划算, 关闭压缩"
        sniff = _probe_compressible(root)
        if sniff is False:
            return False, "内容嗅探: 样本 zlib 压不动 (随机/已压缩内容) → 关闭压缩"
        return True, f"可压缩源 (扩展名占比 {ratio:.0%}" + \
                     ("，内容嗅探通过)" if sniff else ")") + " + 公网链路 → 开启压缩"
    except Exception as _e:
        logging.debug("decide_compress fallback: %s", _e)
        return default


# ═════════════════════════════════════════════════════════════
# Ledger (校验账本): 任务清单 + 传输后对账
# ═════════════════════════════════════════════════════════════

def _sha256_file(path: str, limit: int = 0) -> str:
    h = hashlib.sha256()
    n = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 256)
            if not chunk:
                break
            if limit and n + len(chunk) > limit:
                chunk = chunk[:limit - n]
            h.update(chunk)
            n += len(chunk)
            if limit and n >= limit:
                break
    return h.hexdigest()


def build_manifest(root: str, sha256_limit_per_file: int = 0) -> dict:
    """生成源/目标清单: {rel_path: {size, sha256, mtime}} (dir 不算)"""
    out = {}
    root = root.rstrip("/")
    if os.path.isfile(root):
        st = os.stat(root)
        out[os.path.basename(root)] = {
            "size": st.st_size,
            "sha256": _sha256_file(root, sha256_limit_per_file),
            "mtime": int(st.st_mtime),
        }
        return out
    for w_root, _dirs, files in os.walk(root):
        for fn in files:
            fp = os.path.join(w_root, fn)
            rel = os.path.relpath(fp, root)
            try:
                st = os.stat(fp)
            except OSError:
                continue
            out[rel.replace(os.sep, "/")] = {
                "size": st.st_size,
                "sha256": _sha256_file(fp, sha256_limit_per_file) if st.st_size <= 8 * 1024 * 1024 else "",
                "mtime": int(st.st_mtime),
            }
    return out


def verify_transfer(src_dir: str, dst_dir: str, manifest: dict = None) -> dict:
    """对账: 比对源与目标清单。返回 {ok, missing[], size_mismatch[], hash_mismatch[], extra[]}"""
    src_m = manifest or build_manifest(src_dir)
    dst_m = build_manifest(dst_dir)
    missing, size_mis, hash_mis = [], [], []
    for rel, meta in src_m.items():
        dp = os.path.join(dst_dir, rel)
        if not os.path.exists(dp):
            missing.append(rel)
            continue
        dsz = os.path.getsize(dp)
        if dsz != meta["size"]:
            size_mis.append(rel)
            continue
        if meta["sha256"] and dsz <= 8 * 1024 * 1024:
            dh = _sha256_file(dp)
            if dh != meta["sha256"]:
                hash_mis.append(rel)
    src_set, dst_set = set(src_m.keys()), set(dst_m.keys())
    return {
        "ok": not (missing or size_mis or hash_mis),
        "total": len(src_m),
        "verified": len(src_m) - len(missing) - len(size_mis) - len(hash_mis),
        "missing": missing[:50],
        "size_mismatch": size_mis[:50],
        "hash_mismatch": hash_mis[:50],
        "extra_in_dst": sorted(dst_set - src_set)[:50],
    }

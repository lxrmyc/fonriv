"""Fonriv - 自适应传输引擎决策矩阵 (v4.82.0 · 专利1 深化)

多维度源特征探测 → 加权评分决策 → 引擎/分片/并发选择 → 历史反馈学习。

决策维度 (8 维):
  ① 文件总数          小文件多 → rsync (元数据开销低)
  ② 总字节数          大总量 → rclone (多线程并行)
  ③ 平均文件大小      >10MB 大文件 → rclone; <100KB → rsync
  ④ 文件大小分布熵    均匀分布大文件 → rclone; 双峰(少量大+海量小) → 分片 rsync
  ⑤ 文件类型分布      已压缩类型(mp4/zip/gz)占比高 → 关闭 -z 压缩
  ⑥ 存储类型          ZFS → zfs send 建议; LVM-thin → vzdump 建议; 网络挂载 → 跳过本地扫描
  ⑦ 历史性能          run_stats 中同类 profile 的历史引擎耗时 (反馈学习)
  ⑧ 网络通道          SSH (22) vs 高端口 vs 本地

输出: EngineDecision {
  engine: 'rsync'|'rclone', shards: N, concurrency: N,
  compress: bool, reasons: [...], scores: {rsync: x, rclone: y},
  profile: {...}, learned_from: N 条历史
}
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

from backend import db

# ── 常量 ──
RSYNC = "rsync"
RCLONE = "rclone"

# 压缩收益低的文件类型 (已压缩/随机性高)
INCOMPRESSIBLE_EXTS = {
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm",
    ".zip", ".tar.gz", ".tgz", ".7z", ".rar", ".gz", ".bz2", ".xz", ".zst",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico",
    ".iso", ".img", ".qcow2", ".vmdk", ".vdi",
    ".mp3", ".flac", ".aac", ".ogg", ".wav",
    ".pdf", ".docx", ".xlsx", ".pptx",  # Office 已 ZIP 压缩
    ".so", ".o", ".a", ".pyc", ".class", ".jar", ".war",
    ".sqlite", ".db", ".rdb",  # 数据库文件
    ".enc", ".gpg", ".asc",
}

# 大文件类型 (单文件通常 >10MB, rclone 并行收益高)
LARGE_FILE_EXTS = {
    ".mp4", ".mkv", ".avi", ".iso", ".img", ".qcow2", ".vmdk",
    ".tar.gz", ".tgz", ".zip", ".7z", ".rar",
    ".sql", ".dump", ".vma", ".vma.zst",
}

# 采样限制 (性能保护)
_PROFILE_MAX_FILES = 50000       # 超过则采样前 N 个
_PROFILE_TIMEOUT_FILES = 5000    # 采样统计的文件数上限


@dataclass
class SourceProfile:
    """源特征快照"""
    total_files: int = 0
    total_bytes: int = 0
    avg_file_size: int = 0
    max_file_size: int = 0
    min_file_size: int = 999999999
    large_files: int = 0          # >10MB
    small_files: int = 0          # <100KB
    incompressible_bytes: int = 0  # 已压缩类型的字节数
    incompressible_ratio: float = 0.0
    size_entropy: float = 0.0      # 文件大小分布的 Shannon 熵
    ext_distribution: dict = field(default_factory=dict)  # top 10 扩展名 → count
    storage_type: str = "dir"     # dir|zfs|lvm|nfs|cifs|ceph
    is_network_mount: bool = False
    sampled: bool = True           # True = 完整扫描, False = 采样截断

    def to_dict(self):
        return {
            "total_files": self.total_files, "total_bytes": self.total_bytes,
            "avg_file_size": self.avg_file_size, "max_file_size": self.max_file_size,
            "large_files": self.large_files, "small_files": self.small_files,
            "incompressible_ratio": round(self.incompressible_ratio, 3),
            "size_entropy": round(self.size_entropy, 3),
            "storage_type": self.storage_type, "is_network_mount": self.is_network_mount,
            "top_exts": dict(list(self.ext_distribution.items())[:5]),
            "sampled": self.sampled,
        }


@dataclass
class EngineDecision:
    """决策结果"""
    engine: str = RSYNC
    shards: int = 1
    concurrency: int = 4
    compress: bool = True
    reasons: list = field(default_factory=list)
    scores: dict = field(default_factory=lambda: {RSYNC: 0.0, RCLONE: 0.0})
    profile: dict = field(default_factory=dict)
    learned_from: int = 0
    learned_adjustment: float = 0.0

    def to_dict(self):
        return {
            "engine": self.engine, "shards": self.shards,
            "concurrency": self.concurrency, "compress": self.compress,
            "reasons": self.reasons, "scores": self.scores,
            "profile": self.profile, "learned_from": self.learned_from,
        }


# ── 源特征探测 ──

def detect_storage_type(path: str) -> tuple[str, bool]:
    """检测源路径的存储类型。返回 (storage_type, is_network_mount)"""
    try:
        # 1. 检查挂载表
        with open("/proc/mounts") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 3:
                    mount_point, fs_type = parts[1], parts[2]
                    if path.startswith(mount_point):
                        if fs_type == "zfs" or "zfs" in fs_type:
                            return "zfs", False
                        if "nfs" in fs_type:
                            return "nfs", True
                        if "cifs" in fs_type or "smb" in fs_type:
                            return "cifs", True
                        if "ceph" in fs_type:
                            return "ceph", False
                        if path.startswith("/dev/mapper/") or "lvm" in path.lower():
                            return "lvm", False
        # 2. LVM 检测
        if os.path.exists(path) and path.startswith("/dev/mapper/"):
            return "lvm", False
        return "dir", False
    except Exception:
        return "dir", False


def profile_source(path: str) -> SourceProfile:
    """扫描源目录, 构建特征快照。"""
    p = SourceProfile()
    p.storage_type, p.is_network_mount = detect_storage_type(path)

    # 网络挂载不扫描 (性能原因)
    if p.is_network_mount:
        p.sampled = False
        return p

    ext_counter: dict[str, int] = {}
    size_buckets = [0] * 10  # 按大小分 10 个桶 (计算分布熵)
    scanned = 0

    for root, _dirs, files in os.walk(path):
        for fn in files:
            scanned += 1
            if scanned > _PROFILE_MAX_FILES:
                p.sampled = False
                break
            fp = os.path.join(root, fn)
            try:
                sz = os.path.getsize(fp)
            except OSError:
                continue
            p.total_files += 1
            p.total_bytes += sz
            p.max_file_size = max(p.max_file_size, sz)
            p.min_file_size = min(p.min_file_size, sz)

            if sz > 10 * 1024 * 1024:
                p.large_files += 1
            if sz < 100 * 1024:
                p.small_files += 1

            ext = os.path.splitext(fn)[1].lower()
            ext_counter[ext] = ext_counter.get(ext, 0) + 1
            if ext in INCOMPRESSIBLE_EXTS:
                p.incompressible_bytes += sz

            # 大小分布桶 (指数分布)
            import math
            bucket = min(9, int(math.log2(max(1, sz)) // 3)) if sz > 0 else 0
            size_buckets[bucket] += 1

            # 采样截断后停止统计
            if scanned >= _PROFILE_TIMEOUT_FILES and p.total_files >= 1000:
                p.sampled = False
                break
        if not p.sampled and scanned > _PROFILE_MAX_FILES:
            break

    if p.total_files > 0:
        p.avg_file_size = p.total_bytes // p.total_files
        p.incompressible_ratio = p.incompressible_bytes / p.total_bytes if p.total_bytes else 0

        # 大小分布的 Shannon 熵 (比特)
        total = sum(size_buckets)
        if total > 0:
            ent = 0.0
            for cnt in size_buckets:
                if cnt > 0:
                    prob = cnt / total
                    ent -= prob * (prob and __import__("math").log2(prob))
            p.size_entropy = ent

    # Top 10 扩展名
    p.ext_distribution = dict(sorted(ext_counter.items(), key=lambda x: -x[1])[:10])
    return p


def profile_remote(target, path: str) -> SourceProfile:
    """远端源特征探测 (SSH, 粗粒度)。"""
    import shlex
    import asyncio
    p = SourceProfile(sampled=False)

    async def _do():
        async with target.runner() as run:
            # du + find 一次拿到统计 (远端执行, 减少往返)
            q = shlex.quote(path.rstrip("/"))
            cmd = (
                f"echo \"FILES=$(find {q} -maxdepth 3 -type f 2>/dev/null | head -{_PROFILE_TIMEOUT_FILES} | wc -l)\";"
                f"echo \"BYTES=$(du -sb {q} 2>/dev/null | cut -f1)\";"
                f"echo \"LARGE=$(find {q} -maxdepth 3 -type f -size +10M 2>/dev/null | head -100 | wc -l)\";"
                f"echo \"MOUNT=$(stat -f -c %T {q} 2>/dev/null || echo unknown)\""
            )
            code, out, _ = await run.exec(cmd, timeout=60, merge_stderr=True)
            return out or ""
    try:
        loop = asyncio.get_event_loop()
        out = loop.run_until_complete(_do()) if not loop.is_running() else ""
    except Exception:
        return p

    for line in out.splitlines():
        if line.startswith("FILES="):
            p.total_files = int(line.split("=", 1)[1].strip() or 0)
        elif line.startswith("BYTES="):
            p.total_bytes = int(line.split("=", 1)[1].strip() or 0)
        elif line.startswith("LARGE="):
            p.large_files = int(line.split("=", 1)[1].strip() or 0)
        elif line.startswith("MOUNT="):
            mt = line.split("=", 1)[1].strip().lower()
            if "nfs" in mt: p.storage_type, p.is_network_mount = "nfs", True
            elif "cifs" in mt or "smb" in mt: p.storage_type, p.is_network_mount = "cifs", True
            elif "zfs" in mt: p.storage_type = "zfs"
    if p.total_files > 0:
        p.avg_file_size = p.total_bytes // p.total_files
    return p


# ── 历史学习 ──

def learn_from_history(profile: SourceProfile) -> tuple[float, int]:
    """查询 run_stats 中类似 profile 的历史引擎表现。

    返回 (rclone_adjustment, sample_count):
      adjustment > 0 → 历史上 rclone 在此规模下更快 → 加分
      adjustment < 0 → 历史上 rsync 更快 → 减分
    """
    try:
        conn = db.get_conn()
        # 按文件数规模分桶 (0-100, 100-1k, 1k-10k, 10k-100k, 100k+)
        n = profile.total_files
        if n < 100: bucket = "0-100"
        elif n < 1000: bucket = "100-1k"
        elif n < 10000: bucket = "1k-10k"
        elif n < 100000: bucket = "10k-100k"
        else: bucket = "100k+"

        rows = conn.execute(
            """SELECT kind, AVG(speed_bps), COUNT(*) FROM run_stats
               WHERE speed_bps > 0 AND kind LIKE 'transfer_%'
               GROUP BY kind""").fetchall()
        if not rows:
            return 0.0, 0

        # 简单启发: 如果有历史数据且总量 >100MB 的记录中 rclone 速度更高 → 加分
        rclone_speeds = [r[1] for r in rows if "rclone" in (r[0] or "")]
        rsync_speeds = [r[1] for r in rows if "rsync" in (r[0] or "") and "rclone" not in (r[0] or "")]
        total_samples = sum(r[2] for r in rows)
        if not rclone_speeds or not rsync_speeds:
            return 0.0, total_samples

        avg_rc = sum(rclone_speeds) / len(rclone_speeds)
        avg_rs = sum(rsync_speeds) / len(rsync_speeds)
        if avg_rs > 0:
            ratio = avg_rc / avg_rs
            # ratio >1.2 → rclone 快 20%+ → +0.3 分; <0.8 → -0.3 分
            if ratio > 1.2: return 0.3, total_samples
            elif ratio < 0.8: return -0.3, total_samples
        return 0.0, total_samples
    except Exception:
        return 0.0, 0


# ── 决策矩阵 ──

def decide(profile: SourceProfile, engine_pref: str = "auto",
           direction: str = "up", dst_kind: str = "") -> EngineDecision:
    """核心决策: 多维加权评分 → 引擎 + 分片 + 并发 + 压缩。

    评分制 (总分高者胜):
      rsync 得分场景: 文件多且小(元数据开销低)、本地路径、SSH/SFTP 端点
      rclone 得分场景: 云/对象存储端点 (服务端复制、分块并发上传)

    dst_kind (v5.20.0 新增): ""|"local"|"ssh"|"cloud"
      —— 实测 (docs/性能基线实测报告_v5.20.md, 1GB 单文件 本机→9.22, 1 万×4KB 小文件):
           · SSH 端点大文件: rsync 128.1 MB/s vs rclone(sftp) 111.8 MB/s → rsync 快 13%
           · SSH 端点小文件: rsync 3787 files/s vs rclone 215 files/s → rsync 快 17.6 倍
         rclone 的体积加分原本基于"大文件并行更快"的**未经验证假设**, 实测在 SSH/本地
         端点上不成立 (rclone 的并行优势只在云/对象存储后端体现)。故对非云端点下调其加分。
    """
    d = EngineDecision()
    d.profile = profile.to_dict()
    rs, rc = 0.0, 0.0  # rsync score, rclone score
    reasons = []

    # ── 维度⓪: 端点类型 (最强的单一因素, 先定基调) ──
    # 端点类型: 仅"云/对象存储"与"非云"两类待遇不同, 其余 (ssh/local/sftp/smb/nfs/未指定)
    # 一律按非云处理 —— 本模块的调用方 (handlers/rsync.py) 用 rclone 时只走 :sftp
    _rk = (dst_kind or "").strip().lower()
    _cloud = _rk == "cloud"

    # ── 维度①: 文件总数 ──
    if profile.total_files >= 5000:
        rs += 2.0
        reasons.append(f"文件数 {profile.total_files} ≥ 5000 → rsync 元数据优势 (+2.0)")
    elif profile.total_files >= 500:
        rs += 1.0
        reasons.append(f"文件数 {profile.total_files} ≥ 500 → rsync 略优 (+1.0)")
    elif profile.total_files > 0 and profile.total_files < 50:
        if _cloud:
            rc += 0.5
            reasons.append(f"文件数 {profile.total_files} < 50 + 云端点 → rclone 并行 (+0.5)")
        else:
            reasons.append(f"文件数 {profile.total_files} < 50 → 不计分 (实测 SSH 端点 rsync 仍快 13%)")

    # ── 维度②: 总字节数 (先记入 rc_size, 由下方按端点类型决定是否计入) ──
    GB = 1024 * 1024 * 1024
    rc_size = 0.0
    if profile.total_bytes >= 10 * GB:
        rc_size += 3.0
        reasons.append(f"体积加分候选: 总量 {profile.total_bytes / GB:.1f}GB ≥ 10GB (+3.0 → rclone 并行)")
    elif profile.total_bytes >= 1 * GB:
        rc_size += 2.0
        reasons.append(f"体积加分候选: 总量 {profile.total_bytes / GB:.1f}GB ≥ 1GB (+2.0 → rclone)")
    elif profile.total_bytes >= 100 * 1024 * 1024:
        rc_size += 1.0
        reasons.append(f"体积加分候选: 总量 {profile.total_bytes // (1024*1024)}MB ≥ 100MB (+1.0 → rclone)")

    # ── 维度③: 平均文件大小 ──
    if profile.avg_file_size > 50 * 1024 * 1024:
        rc_size += 2.0
        reasons.append(f"体积加分候选: 均文件 {profile.avg_file_size // (1024*1024)}MB > 50MB (+2.0 → 大文件 rclone)")
    elif profile.avg_file_size > 10 * 1024 * 1024:
        rc_size += 1.0
        reasons.append(f"体积加分候选: 均文件 {profile.avg_file_size // (1024*1024)}MB > 10MB (+1.0 → rclone)")
    elif 0 < profile.avg_file_size < 100 * 1024:
        rs += 1.5
        reasons.append(f"均文件 {profile.avg_file_size // 1024}KB < 100KB → 小文件 rsync (+1.5)")

    # ── 维度②③ 结算: 体积加分只对云/对象存储端点成立 ──
    #   实测 (docs/性能基线实测报告_v5.20.md): SSH 端点上 rclone(sftp) 全面慢于 rsync ——
    #     1GB 单文件 128.1 vs 111.8 MB/s (慢 13%); 1 万×4KB 3787 vs 215 files/s (慢 17.6 倍)。
    #   rclone 的"体积大 → 并行更快"只在云/对象存储后端体现 (服务端复制、分块并发上传),
    #   对 SSH/本地端点是无依据的假设, 故**不计入**而非打折 (打折后 20GB 单文件仍会误选 rclone)。
    if _cloud:
        rc += rc_size
        if rc_size:
            reasons.append(f"云端点 → 体积加分 {rc_size:.1f} 计入 rclone (服务端复制/分块并发占优)")
        if rs > 0:
            rs -= rs * 0.5
            reasons.append("云端点 → rsync 加分减半")
    else:
        # 非云 (ssh/local/sftp/smb/nfs/未指定): 给 rsync 单流优势分
        rs += 1.5
        reasons.append(f"端点 {_rk or '非云'} → 体积加分 {rc_size:.1f} 不计入 rclone "
                       f"(实测 SSH 端点 rsync 快 13% / 小文件快 17.6 倍); rsync 单流优势 (+1.5)")

    # ── 维度④: 大小分布熵 (双峰 → 分片策略) ──
    if profile.size_entropy < 1.5 and profile.total_files > 1000:
        # 低熵 = 大小集中 → 如果集中在小文件区间, 分片收益高
        if profile.small_files > profile.total_files * 0.7:
            rs += 1.0
            reasons.append(f"分布熵 {profile.size_entropy:.2f} 低 + 70% 小文件 → rsync 分片 (+1.0)")

    # ── 维度⑤: 压缩收益 ──
    if profile.incompressible_ratio > 0.7:
        d.compress = False
        reasons.append(f"不可压缩内容占比 {profile.incompressible_ratio:.0%} > 70% → 关闭 -z 压缩")
    elif profile.incompressible_ratio > 0.4:
        reasons.append(f"不可压缩内容占比 {profile.incompressible_ratio:.0%} → 压缩收益有限")

    # ── 维度⑥: 存储类型建议 ──
    if profile.storage_type == "zfs":
        reasons.append("⚠ 源为 ZFS 数据集 → 建议优先使用 zfs send/receive (如可用)")
    elif profile.storage_type == "lvm":
        reasons.append("⚠ 源为 LVM 逻辑卷 → 建议优先使用 LVM 快照 + vzdump")

    # ── 维度⑦: 历史学习 ──
    adj, samples = learn_from_history(profile)
    d.learned_from = samples
    if adj != 0:
        rc += adj
        d.learned_adjustment = adj
        reasons.append(f"历史学习: {samples} 条记录 → rclone 调整 ({adj:+.1f})")

    # ── 维度⑧: 方向约束 ──
    if direction not in ("up", "down"):
        reasons.append(f"方向 {direction} 不支持 rclone → 强制 rsync")
        rs += 10  # 非上传/下载方向只能 rsync

    # ── 手动偏好 ──
    if engine_pref == RSYNC:
        rs += 100
        reasons.append("手动指定: rsync")
    elif engine_pref == RCLONE:
        rc += 100
        reasons.append("手动指定: rclone")

    # ── 最终决策 ──
    d.scores = {RSYNC: round(rs, 2), RCLONE: round(rc, 2)}
    d.engine = RCLONE if rc > rs else RSYNC

    # ── 分片决策 (仅 rsync 引擎) ──
    if d.engine == RSYNC:
        shard_threshold = int(db.setting_get("transfer_rsync_shards_min_files", "500") or 500)
        # v5.20.0 · 远端 (SSH) 分片收益远低于本机, 阈值需放大:
        #   实测本机对拷分片 2.8× (3667→10277 files/s), 但跨机 SSH 只有 +2.6% (3787→3886 files/s),
        #   因为多条 SSH 连接抢目标机 CPU 核 (2 核 VM 已打满)。详见 docs/性能基线实测报告_v5.20.md
        if not (_rk in ("local", "")):
            _rf = int(db.setting_get("transfer_rsync_shards_remote_factor", "10") or 10)
            if _rf > 1:
                shard_threshold *= _rf
                reasons.append(f"远端通道 → 分片阈值放大 {_rf} 倍 (实测 SSH 分片仅 +2.6%)")
        if profile.total_files >= shard_threshold * 4:
            d.shards = 8
            reasons.append(f"文件数 ≥ {shard_threshold * 4} → 8 片并发")
        elif profile.total_files >= shard_threshold * 2:
            d.shards = 4
            reasons.append(f"文件数 ≥ {shard_threshold * 2} → 4 片并发")
        elif profile.total_files >= shard_threshold:
            d.shards = 2
            reasons.append(f"文件数 ≥ {shard_threshold} → 2 片并发")

    # ── 并发决策 (rclone) ──
    if d.engine == RCLONE:
        if profile.total_bytes >= 10 * GB:
            d.concurrency = 8
            reasons.append("总量 ≥ 10GB → rclone 8 并发")
        elif profile.total_bytes >= GB:
            d.concurrency = 4
            reasons.append("总量 ≥ 1GB → rclone 4 并发")
        else:
            d.concurrency = 2

    d.reasons = reasons
    return d


# ── WS handler ──

async def handle_engine_analyze(ws, data: dict):
    """分析源路径, 返回决策矩阵 (供前端展示/测试)。
    params: path, engine_pref(auto|rsync|rclone), direction"""
    from fastapi import WebSocketDisconnect
    from backend.ssh_lib import SSHTarget, ssh_error_msg
    _req = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path or not path.startswith("/"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少绝对路径 path"})
        return
    try:
        if data.get("host"):
            target = SSHTarget.from_ws_data(data)
            import asyncio
            async def _probe():
                async with target.runner() as run:
                    import shlex
                    q = shlex.quote(path)
                    code, out, _ = await run.exec(f"du -sb {q} 2>/dev/null", timeout=30, merge_stderr=True)
                    return out or ""
            try:
                loop = asyncio.get_event_loop()
                out = loop.run_until_complete(_probe()) if not loop.is_running() else ""
            except Exception:
                out = ""
            # 远端: 简化 profile
            p = SourceProfile(sampled=False)
            if out.strip():
                parts = out.strip().split()
                if parts and parts[0].isdigit():
                    p.total_bytes = int(parts[0])
                    p.total_files = 1  # 未知, 保守
        else:
            if not os.path.exists(path):
                await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"路径不存在: {path}"})
                return
            p = profile_source(path)

        pref = (data.get("engine_pref") or "auto").strip().lower()
        direction = data.get("direction") or "up"
        # v5.20.0 · 端点类型参与决策 (实测 SSH 与云端的引擎优劣相反)
        _dk = (data.get("dst_kind") or "").strip().lower()
        if not _dk:
            _dk = "cloud" if data.get("cloud") else ("ssh" if data.get("host") else "local")
        decision = decide(p, pref, direction, _dk)
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "decision": decision.to_dict()})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"分析异常: {ssh_error_msg(str(e))}"})

"""Fonriv - 平台适配层（v4.0.0-alpha1）

跨平台一键备份/恢复的抽象层。每个 BackupPlatform 子类描述一个目标系统
（PVE / Linux 通用 / OMV / DSM / TrueNAS / Unraid ...）的备份清单、
工作负载探测与打包/恢复方式。

alpha1 里只落地：
  - 注册表 + get_platform / all_platforms
  - detector.probe() 单次 SSH 探针
  - BackupPlatform.detect() 打分
  - linux_generic / pve / omv / synology 骨架 + collect_config_manifest
handler/前端迁移留给 alpha1.5+。
"""
from __future__ import annotations

from backend.platforms.base import BackupPlatform, BackupItem
from backend.platforms.linux_generic import LinuxGenericPlatform
from backend.platforms.pve import PVEPlatform
from backend.platforms.omv import OMVPlatform
from backend.platforms.synology import SynologyPlatform
from backend.platforms.truenas import TrueNASPlatform  # v5.20.0 · 阶段5

# 注册顺序 = detect 打分默认顺序（打分本身独立，仅用于迭代稳定）
_REGISTRY = [
    PVEPlatform,      # 特化度最高，最先匹配
    OMVPlatform,
    SynologyPlatform,
    TrueNASPlatform,   # v5.20.0 · 有完整 REST 控制面, 与 ZFS 备份闭环
    LinuxGenericPlatform,  # 兜底
]


def all_platforms():
    """返回所有已注册平台类的列表（顺序 = 匹配优先级）。"""
    return list(_REGISTRY)


def get_platform(name: str):
    """按 NAME 取平台类；未知则返回 LinuxGenericPlatform（兜底）。"""
    if not name:
        return LinuxGenericPlatform
    for cls in _REGISTRY:
        if cls.NAME == name:
            return cls
    return LinuxGenericPlatform


def pick_best(probe_result: dict):
    """按探针结果给所有平台打分，选最高分。

    返回 (platform_cls, confidence:int, scores:dict[name,int])
    并列时按 _REGISTRY 顺序取第一个（PVE > OMV > DSM > generic）。
    """
    scores = {}
    best_cls = LinuxGenericPlatform
    best_score = -1
    for cls in _REGISTRY:
        try:
            s = int(cls.detect(probe_result) or 0)
        except Exception as e:
            # 探针评分失败绝不影响其他平台，记 0 并显式吞掉本次错误
            s = 0
            scores[cls.NAME + "__error"] = f"{type(e).__name__}: {e}"[:120]
        scores[cls.NAME] = s
        if s > best_score:
            best_score = s
            best_cls = cls
    return best_cls, max(best_score, 0), scores


__all__ = [
    "BackupPlatform", "BackupItem",
    "LinuxGenericPlatform", "PVEPlatform", "OMVPlatform", "SynologyPlatform",
    "all_platforms", "get_platform", "pick_best",
]

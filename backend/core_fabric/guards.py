"""Fonriv · 运行时完整性与反调试 (v5.20.0 / v5.20.0)

设计原则 (与项目历史教训一致):
  1. **不退出进程**。参考过的通用方案是"检测到篡改就 sys.exit(1)", 这在客户现场
     是灾难 —— 一次误报(权限、只读挂载、备份还原后 mtime 变化)会让服务起不来,
     运维只能删掉校验才能恢复。本模块一律**降级 + 上报**, 不做自杀。
  2. **哈希表编译进二进制**, 不放在外部 json/txt —— 否则改一下清单文件就绕过了。
     本模块只做校验; 哈希表本体在 backend/license.py 的 `_GUARD_HASHES` ——
     那个模块编译成 license.abi3.so 发行, 所以客户改不动这张表。
     注入由 scripts/_inject_guards_hashes.py 在 cythonize 之前完成。
  3. 反调试只挡"顺手挂 gdb 改内存"的脚本小子, 不当成强防线, 因此同样只降级。

降级语义: `check_integrity()` 返回 (ok, details); 调用方 (license 门控) 在
ok=False 时降级能力集, 而不是拒绝服务; 校验结果只上报, 不阻断,
正经客户即使误报也仍能正常使用基础能力。
"""
from __future__ import annotations

import hashlib
import logging
import os
import sys
import time

log = logging.getLogger(__name__)

# ── 哈希表来源 ──
# 关键模块的 sha256 表存放在 backend/license.py 的 _GUARD_HASHES —— 那个模块会编译成
# license.abi3.so 发行, 表因此固化在二进制里, 客户改不动。
# **不要**把表搬回本文件: guards.py 是明文 .py 发行, 放这里等于没有防护。
# (本文件此前被注入器误写过一次, 现已改为运行时从 license 模块读取。)
_HASH_ATTR = "_GUARD_HASHES"

# 参与校验的关键模块 (实际清单以 _GUARD_HASHES 的键为准; 由注入器写入)
# 注意: 不含 backend/license.py —— 哈希表就存在它里面, 写入哈希会改变其自身内容,
#   自指校验必然永远失败。它只以 .so 发行, 完整性由 RSA 签名 + 指纹机制保障。
_CRITICAL = ("backend/core_fabric/planner.py",
             "backend/core_fabric/providers.py",
             "backend/engine_selector.py",
             "backend/osprofile.py")

_REPORT_CACHE = {"ts": 0.0, "ok": True, "details": {}}
_REPORT_TTL = 3600  # 1 小时最多全量校验一次


def _embedded_hashes() -> dict:
    """从编译产物 license.abi3.so 里取哈希表 (取不到 → 空 → 视为开发态)。"""
    try:
        from backend import license as _lic
        h = getattr(_lic, _HASH_ATTR, None)
        return dict(h) if isinstance(h, dict) else {}
    except Exception as e:
        log.debug("读取 %s 失败: %s", _HASH_ATTR, e)
        return {}


def _root() -> str:
    """项目根 (backend/core_fabric/guards.py → 上溯 3 层)。

    注意: _GUARD_HASHES 的键是**项目根相对**路径 (如 "backend/license.py"),
    因此这里必须回到项目根, 不能停在 backend/ —— 否则会拼成 backend/backend/license.py
    而把文件误判为"缺失"。
    """
    here = os.path.abspath(__file__)                    # …/backend/core_fabric/guards.py
    return os.path.dirname(os.path.dirname(os.path.dirname(here)))


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError as e:
        log.debug("hash 失败 %s: %s", path, e)
        return ""


def check_integrity(force: bool = False) -> tuple:
    """校验关键模块哈希。

    返回 (ok, details)。**任何情况下都不抛异常、不退出进程。**
    details: {checked: n, mismatched: [...], missing: [...], skipped: 原因}
    """
    now = time.time()
    if not force and now - _REPORT_CACHE["ts"] < _REPORT_TTL:
        return _REPORT_CACHE["ok"], _REPORT_CACHE["details"]

    details = {"checked": 0, "mismatched": [], "missing": [], "skipped": ""}
    embedded = _embedded_hashes()
    if not embedded:
        details["skipped"] = "未注入编译期哈希 (开发态) — 跳过校验"
        _REPORT_CACHE.update({"ts": now, "ok": True, "details": details})
        return True, details

    root = _root()
    for rel, want in embedded.items():
        fp = os.path.join(root, rel)
        if not os.path.exists(fp):
            # 发行包里 license.py 会被剔除, 只剩 .so —— 这是**预期**情况, 不算缺失
            if rel.endswith("license.py"):
                alt = os.path.join(root, "backend", "license.abi3.so")
                if os.path.exists(alt):
                    continue
            details["missing"].append(rel)
            continue
        got = _sha256_file(fp)
        if not got:
            details["skipped"] = details.get("skipped") or "部分文件不可读"
            continue
        details["checked"] += 1
        if got != want:
            details["mismatched"].append(rel)

    ok = not details["mismatched"] and not details["missing"]
    if not ok:
        # v1.0.0 · 社区版: 只记录并在「核心概览」如实展示, 不影响任何功能
        #   (开源版按 AGPL-3.0 允许修改代码; 此处仅为自查提示)
        log.warning("完整性校验未通过: 变更=%s 缺失=%s",
                    details["mismatched"], details["missing"])
    _REPORT_CACHE.update({"ts": now, "ok": ok, "details": details})
    return ok, details


# ═════════════════════════════════════════════════════════════
# 反调试 (只做降级, 不自杀)
# ═════════════════════════════════════════════════════════════

def debugger_attached() -> bool:
    """检测调试器。Linux 读 /proc/self/status 的 TracerPid; 其它平台返回 False。"""
    try:
        if not sys.platform.startswith("linux"):
            return False
        with open("/proc/self/status", "r") as f:
            for line in f:
                if line.startswith("TracerPid:"):
                    return int((line.split(":", 1)[1] or "0").strip() or 0) > 0
    except Exception:
        pass
    return False


def env_suspicious() -> list:
    """常见"逆向/注入"环境信号 (仅作提示, 不单独构成判定依据)。"""
    hits = []
    for k in ("LD_PRELOAD", "PYTHONINSPECT", "PYTHONSTARTUP", "CYTHON_TRACE"):
        if os.environ.get(k):
            hits.append(k)
    if os.environ.get("RP_DEBUG") or os.environ.get("RP_SKIP_INTEGRITY"):
        hits.append("RP_* 调试开关")
    return hits


def security_report() -> dict:
    """供 vitals/自检页展示的一份汇总 (无副作用)。"""
    ok, det = check_integrity()
    dbg = debugger_attached()
    envh = env_suspicious()
    return {
        "integrity_ok": ok,
        "integrity": det,
        "debugger": dbg,
        "env_flags": envh,
        # 是否建议降级到社区版功能集
        "suggest_downgrade": (not ok) or dbg,
        "policy": "检测到异常只降级功能集并上报, 不退出进程 (避免客户现场误报导致服务不可用)",
    }

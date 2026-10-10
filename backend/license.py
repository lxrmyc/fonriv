"""Fonriv 社区版 (开源) · 授权模块 —— 纯 Python 明文实现

开源社区版以 AGPL-3.0 发布, 无需授权激活。本模块提供与既有调用点
(ws.py / app.py / handlers / core_fabric) 兼容的接口 (功能开关 / 限额 / 状态摘要):

  · feature_enabled(key)  社区版内置功能 -> True; 非社区键 -> False
  · limits()              不限量 (0 = 不限): 无档案数 / 用户数上限
  · get_status_summary()  授权面板 / 前端显隐的数据源
  · verify_license(...)   恒拒绝 —— 开源版不接受/不需要授权文件

功能键 -> 档位 的映射读取 scripts/features.json (运行期真源);
features.json 缺失时按"全部功能开放"处理 (fail-open)。
"""

from __future__ import annotations

import hashlib
import json
import os

# ── 常量 (handlers/license.py 兼容) ──────────────────────────────────────────
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEATURES_JSON = os.path.join(PROJECT_ROOT, "scripts", "features.json")

EDITION_LABEL = "社区版 (开源 · AGPL-3.0)"

# 档位序: 开源社区版恒为 community; 非社区键 (pro/enterprise) 不放行
_RANK = {"community": 0, "pro": 1, "enterprise": 2}


# ── 功能键 → 档位表 (真源 scripts/features.json) ─────────────────────────────
def _load_feature_editions() -> dict:
    try:
        with open(FEATURES_JSON, encoding="utf-8") as f:
            fd = json.load(f)
        fz = fd.get("features") or {}
        out = {}
        if isinstance(fz, dict):
            for k, v in fz.items():
                out[k] = (v or {}).get("edition") or "community"
        else:
            for x in fz:
                out[x.get("key")] = x.get("edition") or "community"
        return out
    except Exception:
        return {}


FEATURE_EDITIONS = _load_feature_editions()


def _edition_meets(cur: str, req) -> bool:
    """当前档位是否满足需求档位; 需求为空/社区档视为放行"""
    if not req or req == "community":
        return True
    return _RANK.get(cur, 0) >= _RANK.get(req, 99)


def _status_allows(_status, feat: str) -> bool:
    """开源版恒为社区档: 只要功能键本身是社区/无档键即放行"""
    return feature_enabled(feat)


def feature_enabled(feat: str) -> bool:
    """功能开关: 社区键 True; pro/enterprise 键 False (与商业社区包行为一致)"""
    try:
        return _edition_meets("community", FEATURE_EDITIONS.get(feat, "community"))
    except Exception:
        return True


def limits() -> dict:
    """开源版不限量 (0 = 不限): 无档案数/用户数上限, 与 AGPL-3.0 开源定位一致。"""
    return {"max_profiles": 0, "max_users": 0}



def get_status_summary() -> dict:
    """授权状态摘要 —— 授权面板 / license_get 的数据源"""
    return {
        "status": "valid",
        "edition": "community",
        "edition_label": EDITION_LABEL,
        "message": "社区版为开源软件 (AGPL-3.0), 永久免费, 无需授权激活; 档案数与用户数不限",
        "features_allow": None,          # None -> 前端按社区档位表过滤导航
        "feature_editions": FEATURE_EDITIONS,
        "edition_info": {"community": {"label": EDITION_LABEL, "price": "免费"}},
        "limits": limits(),
    }


def reset_verify_cache() -> None:
    """兼容接口: 开源版无验证缓存, 空操作"""


def verify_license(path: str | None = None, content: str | None = None, **_kw) -> dict:
    """恒拒绝: 开源版不接受授权文件 (无需任何激活)"""
    return {"status": "invalid",
            "edition": "community",
            "message": "社区版为开源软件 (AGPL-3.0), 无需授权文件"}

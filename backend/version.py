"""Fonriv - 应用版本号。

更新日志数据在 backend/changelog.py（v4.37.3 起拆分，本文件 re-export 保持兼容）。
CHANGELOG.md 由 scripts/gen_changelog.py 自动生成。
"""

VERSION = "1.0.0"

# 更新日志：按版本从新到旧倒序排列
# 每条 (version, date, category, summary, details:list[str])
# 向后兼容 re-export：所有消费方（app.py / server.py / tests / gen_changelog.py）
# 仍通过 `from backend.version import VERSION, CHANGELOG` 访问，无需改动。
from backend.changelog import CHANGELOG  # noqa: F401


def get_version() -> str:
    return VERSION


def get_changelog() -> list:
    """返回可序列化的更新日志。"""
    return [
        {"version": v, "date": d, "category": c, "summary": s, "details": det}
        for (v, d, c, s, det) in CHANGELOG
    ]

"""平台抽象基类 + 备份项数据结构。"""

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class BackupItem:
    """一条建议备份的配置/数据项。"""
    key: str                 # 内部唯一标识（如 "network_config", "ssh_config"）
    display: str             # 中文显示名
    path: str                # 远端路径（可能是文件/目录/glob）
    kind: str = "path"       # path | file | dir | dump | command_output
    required: bool = False   # 是否强制勾选
    description: str = ""    # 说明文字
    default_selected: bool = True

    def to_dict(self) -> dict:
        return {
            "key": self.key, "display": self.display, "path": self.path,
            "kind": self.kind, "required": self.required,
            "description": self.description, "default_selected": self.default_selected,
        }


@dataclass
class Workload:
    """一个平台上的工作负载对象（VM / Container / Share / Package ...）"""
    kind: str                # vm | ct | docker | systemd | share | package | user
    id: str                  # 唯一 id（vmid / container_id / share_name ...）
    name: str = ""
    status: str = ""
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"kind": self.kind, "id": self.id, "name": self.name,
                "status": self.status, "extra": self.extra}


class BackupPlatform:
    """所有平台适配器的抽象基类。

    子类必须重写 NAME / DISPLAY / detect() / collect_config_manifest()。
    其他方法在 alpha 阶段保持 NotImplementedError，逐步实现。
    """

    NAME: str = "generic"
    DISPLAY: str = "通用 Linux"
    ICON: str = "🐧"           # 前端徽章图标
    NOTES: str = ""            # 前端连接提示（如 DSM 需开 SSH）

    # ---------- 检测 ----------
    @classmethod
    def detect(cls, probe: dict) -> int:
        """基于 detector.probe() 的结果打匹配置信度分（0-100）。

        probe 字段见 detector.py 的 parse_probe()。
        """
        return 0

    # ---------- 元信息（alpha1 只需实现到这一层）----------
    def collect_config_manifest(self) -> List[BackupItem]:
        """返回该平台建议备份的配置项清单（静态元数据，不 SSH）。"""
        return []

    def workloads_hint(self) -> List[str]:
        """前端渲染 hint：告诉 UI 该平台大概会有哪些 workload 类别。"""
        return []

    # ---------- 以下 alpha1.5+ 再实现 ----------
    async def detect_workloads(self, runner) -> List[Workload]:
        raise NotImplementedError

    async def plan_backup(self, runner, selected_keys=None) -> dict:
        """(alpha3) 只读预演：告诉前端每个 item 存在/大小/文件数、工具可用性。"""
        raise NotImplementedError

    async def execute_backup(self, runner, plan, local_dst,
                             compressor="gzip", progress_cb=None, task_id=None) -> dict:
        """(alpha4) 真备份：远端 tar 走 stdout · 本地落盘 · sha256。"""
        raise NotImplementedError

    async def prepare_backup(self, runner, selected_items):
        raise NotImplementedError

    async def restore_config(self, runner, archive_path, item):
        raise NotImplementedError

    async def post_restore(self, runner):
        raise NotImplementedError

    # ---------- 序列化 ----------
    @classmethod
    def describe(cls) -> dict:
        """给前端展示用的静态元信息。"""
        inst = cls()
        return {
            "name": cls.NAME,
            "display": cls.DISPLAY,
            "icon": cls.ICON,
            "notes": cls.NOTES,
            "manifest": [it.to_dict() for it in inst.collect_config_manifest()],
            "workloads_hint": inst.workloads_hint(),
        }

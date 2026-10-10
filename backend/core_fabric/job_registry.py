"""Fonriv - Transfer Fabric P2 · JobSpec 注册表 + Schema 驱动

根治"新增一个 WS action 要同步改 7 个文件":
  - @register_job(action, schema, page, feature): 一次注册, 派生一切
    → WS 路由 / ACTION_DESC / 门控清单 / 前端表单 schema / AI 工具清单 全部自动
  - schema 描述参数: {"字段名": {"type": "endpoint|string|int|bool|select|path",
                                  "required": bool, "options": [...], "label": str, "default": any}}
  - 老的 7 处手工注册继续工作 (新老并存); 新 action 推荐只走注册表

落地范围:
  - registry 本体 + schema 校验 + WS 自动路由桥 + REST /api/jobs/schema (前端表单数据源)
  - 内置迁移 2 个示范 action (quota_config / preview_mode_get) 走注册表
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Callable, Optional

_LOCK = threading.Lock()

# action → JobDef
_JOBS: dict = {}


@dataclass
class JobDef:
    action: str
    handler: Callable
    schema: dict
    page: str                    # 前端面板 key (ACTION_PAGE_MAP 等价)
    feature: str                 # license feature key (ACTION_FEATURE_MAP 等价)
    desc: str                    # ACTION_DESC_MAP 等价
    danger: bool = False         # True = 需要前端二次确认


def _check_schema_value(schema_entry: dict, value) -> tuple:
    """校验单个字段。返回 (ok, 规范化值或错误消息)"""
    t = schema_entry.get("type", "string")
    if value is None or value == "":
        if schema_entry.get("required"):
            return False, f"缺少必填字段: {schema_entry.get('label') or '字段'}"
        return True, schema_entry.get("default")
    if t == "int":
        try:
            v = int(value)
            if "min" in schema_entry:
                v = max(schema_entry["min"], v)
            if "max" in schema_entry:
                v = min(schema_entry["max"], v)
            return True, v
        except (TypeError, ValueError):
            return False, f"{schema_entry.get('label') or '字段'} 须为整数"
    if t == "bool":
        return True, bool(value)
    if t == "select":
        opts = schema_entry.get("options") or []
        if opts and str(value) not in [str(o) for o in opts]:
            return False, f"{schema_entry.get('label') or '字段'} 须为: {'/'.join(map(str, opts))}"
        return True, value
    if t == "endpoint":
        if not isinstance(value, dict) or not (value.get("kind")):
            return False, "endpoint 须为 {kind, ...} 对象"
        return True, value
    # string / path / pattern_list → 原样
    return True, value


def register_job(action: str, schema: dict = None, page: str = "settings",
                 feature: str = None, desc: str = "", danger: bool = False):
    """装饰器: 注册一个 Job (action → handler + schema + 门控元数据)"""
    def deco(fn: Callable):
        with _LOCK:
            _JOBS[action] = JobDef(action=action, handler=fn, schema=schema or {},
                                   page=page, feature=feature or "core",
                                   desc=desc or action, danger=danger)
        return fn
    return deco


def get_job(action: str) -> Optional[JobDef]:
    return _JOBS.get(action)


def all_jobs() -> dict:
    return dict(_JOBS)


def validate_params(action: str, params: dict) -> tuple:
    """按 schema 校验参数。返回 (ok, 规范化 params 或 错误消息)"""
    jd = _JOBS.get(action)
    if not jd:
        return False, f"未注册的 action: {action}"
    out = {}
    for k, entry in (jd.schema or {}).items():
        ok, v = _check_schema_value(entry, (params or {}).get(k))
        if not ok:
            return False, v
        if v is not None:
            out[k] = v
    # 透传未声明字段 (向后兼容), 但标脏便于排查
    for k, v in (params or {}).items():
        if k not in out and k not in (jd.schema or {}):
            out[k] = v
    return True, out


def jobs_schema() -> dict:
    """前端表单数据源: action → {schema, page, desc, danger}"""
    return {a: {"schema": j.schema, "page": j.page, "desc": j.desc,
                "danger": j.danger, "feature": j.feature}
            for a, j in _JOBS.items()}


# ═════════════════════════════════════════════════════════════
# P2 · 内置注册示范 (新代码走注册表; 老代码不迁移)
# ═════════════════════════════════════════════════════════════

def register_builtin_jobs():
    """把 P2 示范 action 注册进注册表 (handler 转发到既有实现)"""
    from backend.handlers import settings as _settings
    from backend import quota as _quota

    def _quota_config(ws, data):
        return _quota.handle_quota_config(ws, data)

    def _preview_mode_get(ws, data):
        return _settings.handle_preview_mode_get(ws, data)

    def _preview_mode_set(ws, data):
        return _settings.handle_preview_mode_set(ws, data)

    register_job(
        "quota_config",
        schema={"cfg": {"type": "string", "label": "配置对象(可空=读)", "required": False}},
        page="settings", feature="core", desc="流量配额配置读写",
    )(_quota_config)

    register_job(
        "preview_mode_get",
        schema={}, page="settings", feature="core", desc="读取预览方式",
    )(_preview_mode_get)

    register_job(
        "preview_mode_set",
        schema={
            "scope": {"type": "select", "options": ["transfer", "dm", "preview", "all"],
                      "required": True, "label": "作用域"},
            "mode":  {"type": "select", "options": ["preview", "browse"],
                      "required": True, "label": "预览方式"},
        },
        page="settings", feature="core", desc="保存预览方式",
    )(_preview_mode_set)

    # v5.13.0 · P2.5 扩展: 高频 action 注册 (示例; 后续逐步将高频 action 全部迁入)
    from backend.handlers.stats import handle_stats_overview, handle_stats_recommend
    from backend.handlers.dup_scan import handle_dup_scan, handle_dup_delete
    from backend.quota import handle_quota_usage as _q_use
    from backend.handlers.pve_cluster import (
        handle_pve_api_cluster as _cluster,
        handle_pve_api_migrate as _migrate,
        handle_pve_api_vm_op as _vm_op,
    )
    from backend.handlers.rsync import handle_list_dir as _ls_dir
    from backend.handlers.file_ops import handle_file_delete as _f_del, handle_file_stat as _f_stat

    register_job("stats_overview", schema={}, page="dashboard",
                 feature="core", desc="统计概览与异常检测")(handle_stats_overview)
    register_job("stats_recommend", schema={}, page="dashboard",
                 feature="core", desc="推荐最优传输时间窗口")(handle_stats_recommend)
    register_job("quota_usage", schema={"days": {"type": "int", "min": 1, "max": 365,
                 "label": "查询天数", "default": 30}}, page="settings",
                 feature="core", desc="流量配额用量")(_q_use)
    register_job("dup_scan", schema={"paths": {"type": "path", "required": True, "label": "扫描路径"}},
                 page="settings", feature="core", desc="重复文件扫描")(handle_dup_scan)
    register_job("dup_delete", schema={"paths": {"type": "path", "required": True, "label": "删除路径"}},
                 page="settings", feature="core", desc="删除重复文件", danger=True)(handle_dup_delete)
    register_job("pve_api_cluster", schema={"host": {"type": "string", "required": True, "label": "PVE 主机"}},
                 page="proxmox", feature="pve", desc="PVE 集群视图")(_cluster)
    register_job("pve_api_migrate", schema={
        "host": {"type": "string", "required": True, "label": "源节点"},
        "target": {"type": "string", "required": True, "label": "目标节点"},
        "vmid": {"type": "int", "required": True, "label": "VMID"},
    }, page="proxmox", feature="pve", desc="跨节点迁移", danger=True)(_migrate)
    register_job("file_list_dir", schema={"path": {"type": "path", "required": True, "label": "目录路径"}},
                 page="transfer", feature="core", desc="列出目录内容")(_ls_dir)
    register_job("file_delete", schema={"path": {"type": "path", "required": True, "label": "文件路径"}},
                 page="transfer", feature="core", desc="删除文件", danger=True)(_f_del)
    register_job("file_stat", schema={"path": {"type": "path", "required": True, "label": "文件路径"}},
                 page="transfer", feature="core", desc="文件详情")(_f_stat)

    # v5.22.0 · G6 E2EE 双端协商 (统一入口, 经任务注册表面板可用)
    from backend.handlers.rsync import handle_e2ee as _e2ee
    register_job("e2ee", schema={
        "sub": {"type": "select", "options": ["status", "pubkey", "peers", "exchange", "pin", "unpin"],
                "default": "status", "label": "子操作"},
        "host": {"type": "string", "label": "对端主机 (exchange/pin/unpin)"},
        "pub_b64": {"type": "string", "label": "对端公钥 (pin)"},
        "confirm": {"type": "bool", "label": "确认 (pin/unpin 必填)"},
    }, page="settings", feature="core", desc="E2EE 双端协商: 身份/对端公钥钉死")(_e2ee)

"""Fonriv - 实例身份 (instance_id)

首次启动随机生成并落盘(0600), 用于界面展示与日志关联的实例标识:
同一份数据目录搬迁到别的机器会**连同实例号一起带走**, 便于识别"同一套部署"。
不采集硬件信息, 不对外发送。
"""
from __future__ import annotations

import os
import uuid

_ID_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "data", "instance_id")


def get_instance_id() -> str:
    """读取实例 UUID; 不存在则生成并落盘 (0600)"""
    try:
        with open(_ID_PATH, encoding="utf-8") as f:
            v = f.read().strip()
            if v:
                return v
    except OSError:
        pass
    v = uuid.uuid4().hex
    try:
        os.makedirs(os.path.dirname(_ID_PATH), exist_ok=True)
        with open(_ID_PATH, "w", encoding="utf-8") as f:
            f.write(v)
        try:
            os.chmod(_ID_PATH, 0o600)
        except OSError:
            pass
    except OSError:
        pass
    return v


def reset_instance_id() -> str:
    """重置实例身份 (仅测试/手动使用; 正常运行不应调用)"""
    try:
        os.remove(_ID_PATH)
    except OSError:
        pass
    return get_instance_id()

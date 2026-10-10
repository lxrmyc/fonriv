"""Fonriv 社区版 (开源) · 功能闸模块 —— 纯 Python 明文实现

本模块只提供 ws.py 启动期要求的 GATE_MAP 接口 (action -> license 功能键 的绑定表)。
表为空即"所有动作不挂功能闸", 配合 license.feature_enabled 构成完整的闸行为。
"""

# action -> license 功能键。空表 = 开源社区版所有已内置动作均不门控。
GATE_MAP = {}

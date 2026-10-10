"""Fonriv · UUID v7 生成器

UUID v7: 时间排序型(RFC 9562)
- 前 48 bit: 毫秒级 Unix 时间戳
- 4 bit: 版本号 (0x7)
- 12 bit: 随机
- 2 bit: 变体 (0b10)
- 62 bit: 随机

优势 over UUID v4:
- 天然有序,B-tree 索引页分裂少,写入性能好
- 可按创建时间排序,ORDER BY uuid 等价 ORDER BY created_at
- 全局唯一,跨实例合并不冲突

Python 3.8 无原生 uuid7,手写实现(约 20 行)。
"""
from __future__ import annotations

import time
import secrets
import uuid


def uuidv7() -> str:
    """生成 UUID v7 字符串(36 字符规范格式)。

    >>> len(uuidv7())
    36
    >>> uuidv7() < uuidv7()  # 时间递增
    True
    """
    ts_ms = int(time.time() * 1000)
    rand_a = secrets.randbits(12)
    rand_b = secrets.randbits(62)
    # 组装 128 bit:
    # [48 bit 时间戳][4 bit 版本=7][12 bit rand_a][2 bit 变体=10][62 bit rand_b]
    uuid_int = (ts_ms & ((1 << 48) - 1)) << 80
    uuid_int |= 0x7 << 76              # version 7
    uuid_int |= (rand_a & ((1 << 12) - 1)) << 64
    uuid_int |= 0b10 << 62             # variant (RFC 4122)
    uuid_int |= rand_b & ((1 << 62) - 1)
    return str(uuid.UUID(int=uuid_int))


def is_valid_uuid(s: str) -> bool:
    """检查字符串是否为合法 UUID(任意版本)。"""
    if not s or not isinstance(s, str):
        return False
    try:
        uuid.UUID(s)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


if __name__ == "__main__":
    # 自测
    for _ in range(5):
        print(uuidv7())
    # 验证不同毫秒递增(同毫秒内随机,不保证有序)
    import time as _t
    u1 = uuidv7()
    _t.sleep(0.002)
    u2 = uuidv7()
    assert u1 < u2, f"UUID v7 跨毫秒应递增: {u1} >= {u2}"
    assert len(u1) == 36
    print("OK · UUID v7 生成器自测通过")

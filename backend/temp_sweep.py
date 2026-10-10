"""启动/周期清理本程序在 /tmp 下的临时件。

背景(2026-09-26 实测): 服务被重启/崩溃时, 正在流式取回的媒体暂存文件
(`/tmp/fonrvfs_stream_*`) 与压缩包成员抽取临时文件(`/tmp/fonr_arc_*`) 会永久留下 ——
本轮排查磁盘时清出 1.6GB + 若干残留。累积下去会把客户机的盘写满。

策略:
- 启动时扫一次: 刚启动的进程不可能持有任何旧临时件 → 我们的固定前缀可直接清;
- 周期扫(默认 6 小时): 只清 mtime 超过 age 秒(默认 1 小时)的, 避免误删正在用的。
"""
from __future__ import annotations

import logging
import os
import time
from typing import List

log = logging.getLogger("temp_sweep")

TMP_DIRS = ("/tmp",)
PREFIXES = ("fonrvfs_stream_", "fonr_arc_", "fonr_stage_", "fonr_work_",
            "fonr_conv_", "fonr_x1_", "fonrvfs_thumb_")
SUFFIXES = ("_inner.txt",)


def sweep(age_seconds: int = 3600, *, force: bool = False) -> List[str]:
    """清理临时件, 返回被删路径列表。

    force=True(启动时用) → 不判年龄, 见到我们的前缀就删;
    force=False(周期用) → 只删 mtime 早于 age_seconds 的。
    """
    removed = []
    now = time.time()
    for d in TMP_DIRS:
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for name in names:
            hit = any(name.startswith(p) for p in PREFIXES) or any(name.endswith(s) for s in SUFFIXES)
            if not hit:
                continue
            path = os.path.join(d, name)
            try:
                st = os.stat(path)
                if not force and (now - st.st_mtime) < age_seconds:
                    continue
                if os.path.isdir(path):
                    import shutil
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    os.remove(path)
                removed.append(path)
            except OSError as e:
                log.debug("temp_sweep: 跳过 %s (%s)", path, e)
    if removed:
        log.info("temp_sweep: 清理 %d 个临时件 (force=%s)", len(removed), force)
    return removed

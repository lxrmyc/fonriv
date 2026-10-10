"""Fonriv - 日志系统"""

import os
import logging
import logging.handlers

from backend.app import APP_DIR

# Phase D: 日志到项目顶层 data/
DATA_DIR = os.path.abspath(os.path.join(str(APP_DIR), "data"))
os.makedirs(DATA_DIR, exist_ok=True)
LOG_FILE = os.path.join(DATA_DIR, "fonriv_operations.log")

op_logger = logging.getLogger("fonriv_ops")
op_logger.setLevel(logging.INFO)
# v4.50.0 · 容错打开: 日志文件属主与运行用户不一致 (如 root 服务 rotate 后被非 root
#   进程 import) 时不崩 import, 降级为仅 stderr, 保证 pytest/CLI 等旁路进程可用
try:
    _rh = logging.handlers.RotatingFileHandler(
        LOG_FILE, maxBytes=5*1024*1024, backupCount=3, encoding="utf-8"
    )
    _rh.setFormatter(logging.Formatter("%(asctime)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
    op_logger.addHandler(_rh)
except PermissionError as _e:
    print(f"[log] ⚠ 操作日志 {LOG_FILE} 不可写 ({_e}) · 本次进程降级为 stderr 输出")
    _sh = logging.StreamHandler()
    _sh.setFormatter(logging.Formatter("%(asctime)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
    op_logger.addHandler(_sh)


def log_operation(category: str, desc: str, detail: str = ""):
    msg = f"[{category}] {desc}"
    if detail:
        msg += f" | {detail}"
    op_logger.info(msg)


def get_operations_log(limit: int = 200) -> list:
    records = []
    if os.path.exists(LOG_FILE):
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    parts = line.split(" | ", 1)
                    timestamp = parts[0] if parts else ""
                    content = parts[1] if len(parts) > 1 else parts[0]
                    records.append({"time": timestamp, "content": content})
    return records[-limit:]


def clear_operations_log():
    with open(LOG_FILE, "w") as f:
        f.write("")

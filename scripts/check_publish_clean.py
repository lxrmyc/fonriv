#!/usr/bin/env python3
"""Fonriv 社区版 (开源) · 发布面敏感自检门

对源码树 / 发行 staging 目录做发布前硬闸扫描: 命中任何一类即 exit 1。
开源仓库同样可能因日常开发引入私钥、数据目录、日志或个人路径等不宜公开的内容,
发布 (git push / 打 tar / 构建 deb) 前跑一遍本脚本作为最后防线。

两类检查:
  ① 文件名: 私钥/凭据件、运行数据、日志、已知开发残留 —— 一律不得入包;
  ② 文件内容: PEM 私钥块等机密痕迹。

用法:
    python3 scripts/check_publish_clean.py <目录>      # 扫描, 命中即 exit 1
    python3 scripts/check_publish_clean.py <目录> -v   # 同时列出已扫描文件数

维护: 新增敏感模式时, 同步 packaging/build_deb.sh 的产物复检正则, 避免口径漂移。
"""
from __future__ import annotations

import os
import re
import sys

# ── ① 文件名黑名单 (匹配即失败) ───────────────────────────────────────────────
BAD_NAMES = re.compile(
    r"(^|/)("
    r"nohup\.out|\.zcodeignore|"
    r"upgrade_targets\.json|machine_creds[^/]*|"
    r"license_private[^/]*|license_registry[^/]*|license_gui\.passcode|license_activation[^/]*|"
    r"license\.key|\.fernet\.key|.*_secret[^/]*|"
    r"e2ee_identity[^/]*|relay_staging[^/]*|"
    r"license_server\.py|license_keygen\.py|"
    r"license\.abi3\.so|edition_gate\.abi3\.so"
    r")$"
)
BAD_DIRS = re.compile(r"(^|/)(\.claude|node_modules|\.git)($|/)")
BAD_SUFFIX = re.compile(r"(\.log(\.\d+)?|\.pem|\.key|\.crt)$")

# 必须保持为空的运行期目录 (首启自建; 有文件即视为数据/私钥随包)
MUST_BE_EMPTY_DIRS = ("data", "backend/data")

# ── ② 文件内容黑名单 ─────────────────────────────────────────────────────────
# 注意: 文档/示例中的占位地址一律使用 RFC 私网通用段(192.168.1.x)或 example.com。
CONTENT_RULES = [
    ("PEM 私钥块", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{64,}")),
]

# 仓库自身的版本管理文件不算命中
ALLOW = {".gitignore"}

_SCAN_EXT = {".py", ".js", ".html", ".css", ".json", ".md", ".sh", ".txt", ".conf",
             ".service", ".in", ".yml", ".yaml", ".ini", ".cfg"}


def _rel(root: str, p: str) -> str:
    return os.path.relpath(p, root).replace(os.sep, "/")


def scan(root: str, verbose: bool = False) -> int:
    hits: list = []
    n_files = 0
    n_dirs = 0
    for dirpath, dirnames, filenames in os.walk(root):
        # .git 等版本库内部目录不进入
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
        n_dirs += 1
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = _rel(root, full)
            if rel in ALLOW:
                continue
            if BAD_SUFFIX.search(name) or BAD_NAMES.search(rel) or BAD_DIRS.search(rel):
                hits.append(("文件名", rel, ""))
                continue
            # 内容扫描: 只扫文本扩展名
            ext = os.path.splitext(name)[1].lower()
            if ext not in _SCAN_EXT:
                continue
            n_files += 1
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    for ln, line in enumerate(f, 1):
                        for label, rx in CONTENT_RULES:
                            if rx.search(line):
                                hits.append((label, rel, f"L{ln}: {line.strip()[:110]}"))
            except OSError as e:
                hits.append(("读取失败", rel, str(e)))
        # 空目录检查: 运行期目录必须是空目录(首启自建), 不得有任何文件
        if _rel(root, dirpath) in MUST_BE_EMPTY_DIRS and filenames:
            for name in filenames:
                hits.append(("%s/ 非空" % _rel(root, dirpath),
                             _rel(root, os.path.join(dirpath, name)), "数据/日志/私钥不得随包"))

    # ── ③ 必备件自检 (漏了同样发不出去) ──
    must = [
        "backend/license.py", "backend/edition_gate.py", "backend/version.py",
        "frontend/index.html", "server.py", "LICENSE", "README.md",
        "scripts/install.sh", "scripts/apply_update.sh", "scripts/features.json",
    ]
    for m in must:
        if not os.path.exists(os.path.join(root, m)):
            hits.append(("缺少必备件", m, ""))

    if hits:
        print(f"✗ 敏感自检未通过: {len(hits)} 处命中 (目录: {root})")
        for label, rel, extra in hits[:40]:
            print(f"    [{label}] {rel}" + (f"  {extra}" if extra else ""))
        if len(hits) > 40:
            print(f"    ... 其余 {len(hits) - 40} 处省略")
        return 1
    if verbose:
        print(f"✓ 敏感自检通过: 扫描 {n_files} 个文本文件 / {n_dirs} 个目录, 零命中")
    return 0


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    if not args or not os.path.isdir(args[0]):
        print("用法: python3 scripts/check_publish_clean.py <目录> [-v]", file=sys.stderr)
        return 2
    return scan(args[0], verbose=verbose)


if __name__ == "__main__":
    raise SystemExit(main())

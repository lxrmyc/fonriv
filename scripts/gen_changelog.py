#!/usr/bin/env python3
"""
scripts/gen_changelog.py · v2.8.0

从 backend/version.py 的 CHANGELOG 结构生成 Markdown 格式的 CHANGELOG.md。
避免"backend/version.py 内嵌 detail 列表 + 手工同步 CHANGELOG.md"的双份维护。

用法：
    python scripts/gen_changelog.py            # → 写入 CHANGELOG.md
    python scripts/gen_changelog.py --stdout   # → 打印到 stdout
    python scripts/gen_changelog.py --last 5   # → 只取最近 5 版

发版时可加入 scripts/release.sh 自动调用。
"""
import argparse
import importlib.util
import pathlib
import sys


def load_changelog():
    root = pathlib.Path(__file__).resolve().parent.parent
    # v4.37.3: version.py 现在 `from backend.changelog import CHANGELOG`，
    # 需要项目根在 sys.path 才能解析绝对导入。
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    vpath = root / "backend" / "version.py"
    spec = importlib.util.spec_from_file_location("version", vpath)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.VERSION, mod.CHANGELOG


def format_markdown(version, changelog, limit=None):
    lines = [
        "# Fonriv · CHANGELOG",
        "",
        f"当前版本: **v{version}**  · 由 `scripts/gen_changelog.py` 自动从 `backend/changelog.py` 生成。",
        "",
        "---",
        "",
    ]
    entries = changelog[:limit] if limit else changelog
    for entry in entries:
        # 兼容 (version, date, category, summary) 或 (version, date, category, summary, details)
        if len(entry) == 5:
            ver, date, category, summary, details = entry
        elif len(entry) == 4:
            ver, date, category, summary = entry
            details = []
        else:
            continue
        lines.append(f"## v{ver} · {date} · {category}")
        lines.append("")
        lines.append(f"**{summary}**")
        lines.append("")
        if details:
            current_header = None
            for d in details:
                # 识别 "==== 标题 ====" 作为二级标题
                if d.startswith("====") and d.endswith("===="):
                    current_header = d.strip("= ").strip()
                    lines.append(f"### {current_header}")
                    lines.append("")
                else:
                    lines.append(f"- {d}")
            lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate CHANGELOG.md from backend/version.py")
    parser.add_argument("--stdout", action="store_true", help="Print to stdout instead of writing file")
    parser.add_argument("--last", type=int, default=None, help="Only include the last N versions")
    parser.add_argument("--out", default="CHANGELOG.md", help="Output path (default: CHANGELOG.md)")
    args = parser.parse_args()

    version, changelog = load_changelog()
    md = format_markdown(version, changelog, limit=args.last)

    if args.stdout:
        sys.stdout.write(md)
    else:
        out = pathlib.Path(__file__).resolve().parent.parent / args.out
        out.write_text(md, encoding="utf-8")
        print(f"✓ 已生成 {out} ({len(changelog)} 版本, {len(md)} 字符)")


if __name__ == "__main__":
    main()

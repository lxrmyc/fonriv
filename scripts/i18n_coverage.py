#!/usr/bin/env python3
"""i18n 覆盖率自查 (v4.74.0)

扫描前端界面文案 (index.html 可见文本/属性 + 面板 JS 中的 UI 字符串字面量),
对照 frontend/static/i18n_en.js 的 key 集合, 报告未翻译项与覆盖率。

用法:
  python3 scripts/i18n_coverage.py              # 汇总
  python3 scripts/i18n_coverage.py --list       # 列出未翻译文案
  python3 scripts/i18n_coverage.py --list --limit 100
"""
from __future__ import annotations
import argparse, glob, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IDX = os.path.join(ROOT, "frontend", "index.html")
EN = os.path.join(ROOT, "frontend", "static", "i18n_en.js")
PANEL_GLOBS = [
    "frontend/static/panels/*.js", "frontend/static/*.js",
    "frontend/static/components/*.js",
]
CJK = re.compile(r"[\u4e00-\u9fff]")


def load_en_keys() -> set:
    src = open(EN, encoding="utf-8").read()
    body = src[src.index("window.I18N_EN"):]
    keys = set()
    for m in re.finditer(r'"((?:[^"\\]|\\.)*)"\s*:', body):
        keys.add(m.group(1).replace('\\"', '"'))
    return keys


def html_strings() -> set:
    s = open(IDX, encoding="utf-8").read()
    s = re.sub(r"<script[\s\S]*?</script>", "", s)
    s = re.sub(r"<style[\s\S]*?</style>", "", s)
    out = set()
    for t in re.findall(r">([^<>]+)<", s):
        c = t.strip()
        if c and CJK.search(c) and len(c) <= 90:
            out.add(c)
    for m in re.finditer(r'\b(placeholder|title|alt)="([^"]*)"', s):
        v = m.group(2).strip()
        if v and CJK.search(v) and len(v) <= 90:
            out.add(v)
    return out


def js_strings() -> set:
    out = set()
    for pat in PANEL_GLOBS:
        for f in glob.glob(os.path.join(ROOT, pat)):
            if os.path.basename(f).startswith("i18n"):
                continue
            src = open(f, encoding="utf-8", errors="replace").read()
            for m in re.finditer(r"(?:'((?:[^'\\\n]|\\.){2,90})'|\"((?:[^\"\\\n]|\\.){2,90})\")", src):
                v = (m.group(1) or m.group(2) or "").strip()
                if not v or not CJK.search(v):
                    continue
                if re.search(r"[<>{}\\]|function|return|var |=>", v):
                    continue
                out.add(v)
    return out


def priority_strings() -> set:
    """界面框架文案: 区块标题 / 按钮 / label / 表头 / option"""
    s = open(IDX, encoding="utf-8").read()
    s = re.sub(r"<script[\s\S]*?</script>", "", s)
    s = re.sub(r"<style[\s\S]*?</style>", "", s)
    out = set()
    pats = [
        r'class="section-title"[^>]*>([^<]+)<',
        r"<button[^>]*>([^<]{1,50})</button>",
        r"<label[^>]*>([^<]{1,60})",
        r"<th[^>]*>([^<]{1,40})</th>",
        r"<option[^>]*>([^<]{1,50})</option>",
    ]
    for pat in pats:
        for m in re.finditer(pat, s):
            t = m.group(1).strip()
            if t and CJK.search(t):
                out.add(t)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="列出未翻译文案")
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--all", action="store_true",
                    help="--list 时列出全部未翻译文案(默认只列框架文案)")
    a = ap.parse_args()

    en = load_en_keys()
    h = html_strings()
    j = js_strings()
    prio = priority_strings()          # 界面框架: 区块标题/按钮/标签/表头/选项
    allk = h | j
    miss = sorted(x for x in allk if x not in en)
    pmiss = sorted(x for x in prio if x not in en)
    cov = (len(allk) - len(miss)) / len(allk) * 100 if allk else 100.0
    pcov = (len(prio) - len(pmiss)) / len(prio) * 100 if prio else 100.0

    print(f"【界面框架文案】(区块标题/按钮/字段标签/表头/选项)")
    print(f"  总数 {len(prio)} · 已翻译 {len(prio) - len(pmiss)} · 覆盖率 {pcov:.1f}%")
    print()
    print(f"【全部界面文案】(含日志/提示等业务文案)")
    print(f"  总数 {len(allk)}  (index.html {len(h)} · JS {len(j)})")
    print(f"  已翻译 {len(allk) - len(miss)} · 覆盖率 {cov:.1f}%")
    print()
    print(f"未翻译合计 {len(miss)} (其中框架文案 {len(pmiss)}) · 未翻译时自动回退中文显示, 不影响功能")
    show = miss if (a.all or not pmiss) else pmiss
    if a.list:
        print("\n未翻译文案 (前 %d 条, 按长度排序便于优先处理):" % a.limit)
        for x in sorted(show, key=len)[:a.limit]:
            print("  " + x)
    else:
        print("\n加 --list 查看未翻译清单; 翻译时直接往 frontend/static/i18n_en.js 追加:")
        print('  "中文原文": "English",')
    return 0


if __name__ == "__main__":
    sys.exit(main())

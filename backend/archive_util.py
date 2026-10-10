"""Fonriv - 归档格式统一调度 (v4.69.0)

支持浏览/解压/单文件提取/压缩的格式:
  tar · tar.gz/tgz · tar.bz2/tbz2 · tar.xz/txz · tar.zst/tzst · tar.lz4
  zip · 7z · rar · gz/bz2/xz/zst (单文件压缩流)

密码支持:
  zip  → zip -P / unzip -P
  7z   → 7z a/x -p
  rar  → unrar x -p
  tar* → 本身不支持密码 (提示用户改用 zip/7z)

工具缺失时: 返回明确的安装提示 (前端可一键安装)。
"""
from __future__ import annotations

import os
import shlex
import shutil

# 扩展名 → 格式键 (最长后缀优先匹配)
EXT_MAP = [
    (".tar.gz", "targz"), (".tgz", "targz"),
    (".tar.bz2", "tarbz2"), (".tbz2", "tarbz2"), (".tbz", "tarbz2"),
    (".tar.xz", "tarxz"), (".txz", "tarxz"),
    (".tar.zst", "tarzst"), (".tzst", "tarzst"),
    (".tar.lz4", "tarlz4"),
    (".tar", "tar"),
    (".zip", "zip"), (".jar", "zip"), (".war", "zip"), (".apk", "zip"),
    (".7z", "7z"),
    (".rar", "rar"),
    (".gz", "gzip"), (".bz2", "bzip2"), (".xz", "xz"), (".zst", "zstd"),
]

# 格式 → 需要的可执行文件 (按优先级)
NEEDS = {
    "tar": ["tar"], "targz": ["tar"], "tarbz2": ["tar"], "tarxz": ["tar"],
    "tarzst": ["tar"], "tarlz4": ["tar"],
    "zip": ["unzip"], "7z": ["7z", "7za", "7zr"], "rar": ["unrar", "unar", "7z"],
    "gzip": ["gzip"], "bzip2": ["bzip2"], "xz": ["xz"], "zstd": ["zstd"],
}

# 格式 → 压缩时需要的可执行文件
COMPRESS_NEEDS = {
    "targz": ["tar"], "tarbz2": ["tar"], "tarxz": ["tar"], "tarzst": ["tar"],
    "zip": ["zip"], "7z": ["7z", "7za"],
}

# 建压缩包时可选格式 (前端下拉)
COMPRESS_FORMATS = [
    {"key": "targz", "label": "tar.gz (通用)", "ext": ".tar.gz", "password": False},
    {"key": "tarbz2", "label": "tar.bz2 (兼容老系统)", "ext": ".tar.bz2", "password": False},
    {"key": "tarxz", "label": "tar.xz (压缩率最高)", "ext": ".tar.xz", "password": False},
    {"key": "tarzst", "label": "tar.zst (现代·快)", "ext": ".tar.zst", "password": False},
    {"key": "zip", "label": "zip (Windows 友好·支持密码)", "ext": ".zip", "password": True},
    {"key": "7z", "label": "7z (压缩率最高·支持密码)", "ext": ".7z", "password": True},
]

# 浏览/解压支持的全部格式 (前端展示用)
SUPPORTED_LIST = [
    {"key": "zip", "label": "zip/jar war apk", "password": True},
    {"key": "7z", "label": "7z", "password": True},
    {"key": "rar", "label": "rar", "password": True},
    {"key": "targz", "label": "tar.gz/tgz", "password": False},
    {"key": "tarbz2", "label": "tar.bz2/tbz2", "password": False},
    {"key": "tarxz", "label": "tar.xz/txz", "password": False},
    {"key": "tarzst", "label": "tar.zst/tzst", "password": False},
    {"key": "tarlz4", "label": "tar.lz4", "password": False},
    {"key": "tar", "label": "tar", "password": False},
    {"key": "gzip", "label": "gz", "password": False},
    {"key": "bzip2", "label": "bz2", "password": False},
    {"key": "xz", "label": "xz", "password": False},
    {"key": "zstd", "label": "zst", "password": False},
]


def detect_format(path: str) -> str | None:
    low = (path or "").lower()
    for ext, key in EXT_MAP:
        if low.endswith(ext):
            return key
    return None


def tool_for(fmt: str) -> str | None:
    """返回可用于该格式的可执行文件路径 (缺则 None)"""
    for name in NEEDS.get(fmt, []):
        p = shutil.which(name)
        if p:
            return p
    return None


def tool_for_compress(fmt: str) -> str | None:
    for name in COMPRESS_NEEDS.get(fmt, []):
        p = shutil.which(name)
        if p:
            return p
    return None


def missing_tools_message(fmt: str) -> str:
    """格式不可用时的安装提示"""
    need = NEEDS.get(fmt, [])
    pkg = {
        "7z": "p7zip-full", "7za": "p7zip-full", "7zr": "p7zip-full",
        "unrar": "unrar-free", "unar": "unar",
        "zstd": "zstd", "xz": "xz-utils", "bzip2": "bzip2",
        "zip": "zip", "unzip": "unzip", "tar": "tar",
    }
    pkgs = sorted({pkg[n] for n in need if n in pkg})
    return (f"缺少处理 {fmt} 的工具 ({'/'.join(need)})"
            + (f" · 可一键安装: {' '.join(pkgs)}" if pkgs else ""))


def detect_tools() -> dict:
    """当前环境归档工具清单 (供检测/一键安装 UI)"""
    names = ["tar", "gzip", "bzip2", "xz", "zstd", "zip", "unzip", "7z", "7za", "unrar", "unar", "pigz", "lz4"]
    return {n: (shutil.which(n) or "") for n in names}


def install_pkgs_for_missing(tools: dict | None = None) -> list:
    """根据缺失工具给出需要安装的包名列表"""
    t = tools or detect_tools()
    pkgs = []
    if not (t.get("7z") or t.get("7za") or t.get("7zr")):
        pkgs.append("p7zip-full")
    if not t.get("rar"):  # unrar 缺失 (注意: 上面的 key 是 unrar)
        pass
    if not (t.get("unrar") or t.get("unar")):
        pkgs.append("unrar-free")
    for name, pkg in (("zstd", "zstd"), ("xz", "xz-utils"), ("bzip2", "bzip2"),
                      ("zip", "zip"), ("unzip", "unzip"), ("lz4", "lz4")):
        if not t.get(name):
            pkgs.append(pkg)
    return sorted(set(pkgs))


# ── 命令构造 ──

def _pq(s: str) -> str:
    return shlex.quote(s)


def build_list(path: str, limit: int = 200, password: str = "") -> tuple[str | None, str]:
    """列出归档内容。返回 (cmd, err)"""
    fmt = detect_format(path)
    if not fmt:
        return None, "不支持的归档格式 (支持 tar/tar.gz/tar.bz2/tar.xz/tar.zst/zip/7z/rar/gz/bz2/xz/zst)"
    tool = tool_for(fmt)
    if not tool:
        return None, missing_tools_message(fmt)
    q = _pq(path)
    pw = _pq(password) if password else ""
    if fmt in ("tar", "targz", "tarbz2", "tarxz", "tarzst", "tarlz4"):
        flag = {"tar": "", "targz": "z", "tarbz2": "j", "tarxz": "J",
                "tarzst": "--zstd", "tarlz4": "--lz4"}[fmt]
        if fmt == "tar":
            return f"tar tf {q} 2>&1 | head -{limit}", ""
        if fmt in ("tarzst", "tarlz4"):
            return f"tar {flag} -tf {q} 2>&1 | head -{limit}", ""
        return f"tar t{flag}f {q} 2>&1 | head -{limit}", ""
    if fmt == "zip":
        # zip 的中央目录未加密 → 无密码也能列名
        p = f" -P {pw}" if pw else ""
        return f"unzip -l{p} {q} 2>&1 | head -{limit}", ""
    if fmt == "7z":
        p = f" -p{pw}" if pw else ""
        return f"7z l{p} -y {q} 2>&1 | head -{limit}", ""
    if fmt == "rar":
        base = os.path.basename(tool)
        if base == "unar":
            return f"unar -l {q} 2>&1 | head -{limit}", ""
        if base == "unrar":
            p = f" -p{pw}" if pw else ""
            return f"unrar lb{p} {q} 2>&1 | head -{limit}", ""
        p = f" -p{pw}" if pw else ""
        return f"7z l{p} -y {q} 2>&1 | head -{limit}", ""
    # 单文件压缩流
    cmd = {"gzip": "gzip", "bzip2": "bzip2", "xz": "xz", "zstd": "zstd"}[fmt]
    return f"echo '(单文件压缩流: {os.path.basename(path)})'; {cmd} -l {q} 2>&1 | head -20", ""


def build_extract(path: str, dest: str, password: str = "") -> tuple[str | None, str]:
    """原地解压到 dest。返回 (cmd, err)"""
    fmt = detect_format(path)
    if not fmt:
        return None, "不支持的归档格式"
    tool = tool_for(fmt)
    if not tool:
        return None, missing_tools_message(fmt)
    q, d = _pq(path), _pq(dest)
    pw = _pq(password) if password else ""
    mk = f"mkdir -p {d} 2>&1"
    if fmt in ("tar", "targz", "tarbz2", "tarxz", "tarzst", "tarlz4"):
        flag = {"tar": "", "targz": "z", "tarbz2": "j", "tarxz": "J",
                "tarzst": "--zstd", "tarlz4": "--lz4"}[fmt]
        if fmt == "tar":
            return f"{mk} && tar xf {q} -C {d} 2>&1", ""
        if fmt in ("tarzst", "tarlz4"):
            return f"{mk} && tar {flag} -xf {q} -C {d} 2>&1", ""
        return f"{mk} && tar x{flag}f {q} -C {d} 2>&1", ""
    if fmt == "zip":
        p = f" -P {pw}" if pw else ""
        return f"{mk} && unzip -o{p} {q} -d {d} 2>&1", ""
    if fmt == "7z":
        p = f" -p{pw}" if pw else ""
        return f"{mk} && 7z x{p} -y -o{d} {q} 2>&1", ""
    if fmt == "rar":
        base = os.path.basename(tool)
        if base == "unar":
            return f"{mk} && unar -o {d} -f {q} 2>&1", ""
        if base == "unrar":
            p = f" -p{pw}" if pw else ""
            return f"{mk} && unrar x{p} -o+ {q} {d}/ 2>&1", ""
        p = f" -p{pw}" if pw else ""
        return f"{mk} && 7z x{p} -y -o{d} {q} 2>&1", ""
    # 单文件压缩流 → 解成去后缀文件
    out = dest.rstrip("/") + "/" + os.path.basename(path)
    for suf in (".gz", ".bz2", ".xz", ".zst"):
        if out.lower().endswith(suf):
            out = out[: -len(suf)]
            break
    cmd = {"gzip": "gzip", "bzip2": "bzip2", "xz": "xz", "zstd": "zstd"}[fmt]
    dflag = {"gzip": "-d -c", "bzip2": "-d -c", "xz": "-d -c", "zstd": "-d -c"}[fmt]
    return f"{mk} && {cmd} {dflag} {q} > {_pq(out)} 2>&1 && echo '已解出: {out}'", ""


def build_extract_one(path: str, member: str, dest: str, password: str = "") -> tuple[str | None, str]:
    """从归档提取单个成员。返回 (cmd, err)"""
    fmt = detect_format(path)
    if not fmt:
        return None, "不支持的归档格式"
    tool = tool_for(fmt)
    if not tool:
        return None, missing_tools_message(fmt)
    q, m, d = _pq(path), _pq(member), _pq(dest)
    pw = _pq(password) if password else ""
    mk = f"mkdir -p {d} 2>&1"
    if fmt in ("tar", "targz", "tarbz2", "tarxz", "tarzst", "tarlz4"):
        flag = {"tar": "", "targz": "z", "tarbz2": "j", "tarxz": "J",
                "tarzst": "--zstd", "tarlz4": "--lz4"}[fmt]
        if fmt == "tar":
            return f"{mk} && tar xf {q} -C {d} {m} 2>&1", ""
        if fmt in ("tarzst", "tarlz4"):
            return f"{mk} && tar {flag} -xf {q} -C {d} {m} 2>&1", ""
        return f"{mk} && tar x{flag}f {q} -C {d} {m} 2>&1", ""
    if fmt == "zip":
        p = f" -P {pw}" if pw else ""
        return f"{mk} && unzip -o{p} {q} {m} -d {d} 2>&1", ""
    if fmt == "7z":
        p = f" -p{pw}" if pw else ""
        return f"{mk} && 7z x{p} -y -o{d} {q} {m} 2>&1", ""
    if fmt == "rar":
        base = os.path.basename(tool)
        if base == "unar":
            return f"{mk} && unar -o {d} -f {q} {m} 2>&1", ""
        if base == "unrar":
            p = f" -p{pw}" if pw else ""
            return f"{mk} && unrar x{p} -o+ {q} {m} {d}/ 2>&1", ""
        p = f" -p{pw}" if pw else ""
        return f"{mk} && 7z x{p} -y -o{d} {q} {m} 2>&1", ""
    return None, "单文件压缩流不支持按成员提取"


def build_compress(path: str, dest_dir: str, fmt: str = "targz",
                   password: str = "", level: int = 6,
                   split_size: str = "", paths: list = None,
                   out_name: str = "") -> tuple[str | None, str, str]:
    """压缩文件/目录。返回 (cmd, 输出路径, err)
    v5.28.3 · 新增 split_size (7z 分卷, 如 '100m'/'1g') 和 paths (多路径批量压缩)
    v5.91.4 · out_name: 直接按指定文件名产出(含分片时也生效 —— 分片产物多段, 事后改名会漏段)"""
    fmt = (fmt or "targz").strip().lower()
    if fmt not in COMPRESS_NEEDS:
        return None, "", f"不支持的压缩格式: {fmt} (可选 {'/'.join(COMPRESS_NEEDS.keys())})"
    tool = tool_for_compress(fmt)
    if not tool:
        return None, "", missing_tools_message(fmt)
    src = path.rstrip("/")
    parent = os.path.dirname(src) or "/"
    base = os.path.basename(src)
    ext = {"targz": ".tar.gz", "tarbz2": ".tar.bz2", "tarxz": ".tar.xz",
           "tarzst": ".tar.zst", "zip": ".zip", "7z": ".7z"}[fmt]
    if out_name:
        _nm = str(out_name).strip().lstrip("/") or base
        if not _nm.lower().endswith(ext):
            _nm += ext
        out = f"{dest_dir.rstrip('/')}/{_nm}"
    else:
        out = f"{dest_dir.rstrip('/')}/{base}{ext}"
    qp, qs, qo = _pq(parent), _pq(base), _pq(out)
    lv = max(0, min(9, int(level or 6)))
    if fmt == "zip":
        p = f" -P {_pq(password)}" if password else ""
        # v5.91.4 · zip 分卷: -s <大小> → 生成 out.z01/out.z02/…/out.zip (out 即最后一段, 语义不变)
        sp = f" -s {_pq(split_size)}" if split_size else ""
        return (f"cd {qp} && zip -r -{lv}{sp}{p} {qo} {qs} 2>&1", out, "")
    if fmt == "7z":
        # -mhe=on: 同时加密文件头 (隐藏文件名, 无密码连列表都看不到)
        p = f" -p{_pq(password)} -mhe=on" if password else ""
        vol = f" -v{_pq(split_size)}" if split_size else ""
        # 多路径: paths 列表不为空时逐个追加 (替代单一 src)
        srcs = " ".join(_pq(x) for x in (paths or [src]))
        # v5.91.4 · 7z 分卷不生成 out.7z 本体, 首段是 out.7z.001 → 返回首段路径(否则调用方判"产物不存在")
        real_out = (out + ".001") if split_size else out
        return (f"7z a{p}{vol} -mx={lv} -y {qo} {srcs} 2>&1", real_out, "")
    flag = {"targz": "z", "tarbz2": "j", "tarxz": "J", "tarzst": "--zstd"}[fmt]
    if fmt == "tarzst":
        return (f"tar --zstd -cf {qo} -C {qp} {qs} 2>&1", out, "")
    return (f"tar c{flag}f {qo} -C {qp} {qs} 2>&1", out, "")

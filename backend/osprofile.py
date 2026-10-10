"""远端操作系统档案 (v5.20.0 · Windows / macOS 端点支持)

问题背景
--------
本项目长期只面向 Linux, 远端命令到处硬编码 POSIX 假设 (`ls -lA --time-style=`,
`stat -c`, `mkdir -p`, `df -PB1`, `du -sb`, `sha256sum` …)。接到 Windows / macOS 上:

  · Windows —— 连 `ls` 都没有; SSH 默认 shell 可能是 cmd.exe 或 PowerShell,
    路径是 `C:\\dir\\file`, 盘符与 POSIX 挂载点模型完全不同。
  · macOS   —— 是 BSD。**`ls --time-style` 是 GNU 扩展, BSD ls 直接报非法选项**,
    所以现有 `list_remote_dir` 在 macOS 上必然失败 (这是个真 bug, 不是缺功能)。
    另外系统自带 rsync 长期是 2.6.9 / 新版换 openrsync, **协议版本与我们自编的
    3.5.0 握手存疑**, 因此传输不应依赖对端有可用 rsync。

设计
----
本模块把"远端 OS 差异"收敛成一处: 每个 OS 一个 `OSProfile`, 提供
  · 命令构造 (list_dir / mkdir / stat_size / disks)
  · 输出解析 (与构造配对, 便于单测)
  · 路径语义 (分隔符 / 引用 / 拼接 / 上级目录)
  · 引擎适用性 (能否用 rsync)
上层只问 profile, 不再自己拼 POSIX 命令。

安全与健壮性
-----------
· Windows 命令一律走 **PowerShell -EncodedCommand (UTF-16LE base64)**。
  这样彻底绕开"SSH 登录 shell 是 cmd 还是 PowerShell"的转义地狱 ——
  引号、反斜杠、中文路径都不会被中间 shell 破坏。这是 Windows-over-SSH 的稳妥做法。
· 探测命令必须**在任何 shell 下都安全** (只读、不产生副作用、不写文件):
  `uname -s` 在 Windows 上只是"命令未找到", `cmd /c ver` 在 POSIX 上同理。
"""
from __future__ import annotations

import base64
import json
import logging
import posixpath
import re
import shlex
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

log = logging.getLogger(__name__)


class OsFamily(str, Enum):
    LINUX = "linux"
    WINDOWS = "windows"
    MACOS = "macos"
    UNKNOWN = "unknown"

    @classmethod
    def parse(cls, v) -> "OsFamily":
        s = str(v or "").strip().lower()
        alias = {
            "linux": cls.LINUX, "": cls.UNKNOWN, "auto": cls.UNKNOWN,
            "windows": cls.WINDOWS, "win": cls.WINDOWS, "win32": cls.WINDOWS,
            "macos": cls.MACOS, "mac": cls.MACOS, "darwin": cls.MACOS,
            "osx": cls.MACOS, "mac os x": cls.MACOS,
        }
        return alias.get(s, cls.UNKNOWN)


# ═════════════════════════════════════════════════════════════
# 探测 (跨 shell 安全)
# ═════════════════════════════════════════════════════════════

def detect_cmd() -> str:
    """跨平台探测命令: 同时试 POSIX 与 Windows 两条探针, 各自无副作用。

    · POSIX sh/bash/zsh: 打印 Linux / Darwin / <BSD>
    · Windows cmd.exe:   `uname` 未找到 → 该行空, 但 `cmd /c ver` 打印版本
    · Windows PowerShell: 同理 (PowerShell 里 `cmd /c ver` 也能跑)
    """
    return "uname -s 2>/dev/null; echo '---RPOS---'; cmd /c ver 2>/dev/null"


def parse_detect(out: str) -> OsFamily:
    """解析 detect_cmd() 的输出。"""
    s = str(out or "")
    head = s.split("---RPOS---")[0] if "---RPOS---" in s else s
    tail = s.split("---RPOS---")[1] if "---RPOS---" in s else ""
    h = head.strip().lower()
    t = tail.strip().lower()
    if h.startswith("linux"):
        return OsFamily.LINUX
    if h.startswith("darwin") or "mac os" in h:
        return OsFamily.MACOS
    if h and ("bsd" in h):
        return OsFamily.MACOS if "darwin" in h else OsFamily.LINUX
    # Windows: ver 输出 "Microsoft Windows [Version ...]"
    if "windows" in t:
        return OsFamily.WINDOWS
    if t and re.search(r"\d+\.\d+", t):
        return OsFamily.WINDOWS
    return OsFamily.UNKNOWN


# ═════════════════════════════════════════════════════════════
# 档案
# ═════════════════════════════════════════════════════════════

@dataclass
class OSProfile:
    family: OsFamily
    label: str
    path_sep: str = "/"
    posix_paths: bool = True
    has_rsync: bool = True            # 对端是否存在 rsync
    rsync_trustworthy: bool = True    # rsync 版本是否可信 (协议兼容)
    note: str = ""

    # ── 路径语义 ──

    def normalize(self, p: str) -> str:
        p = str(p or "").strip()
        if self.posix_paths:
            if not p:
                return "/"
            if not p.startswith("/"):
                p = "/" + p
            # 折叠重复斜杠与 /./ (保留 /../ 交由上游决定)
            p = re.sub(r"/{2,}", "/", p)
            p = re.sub(r"/\.(?=/|$)", "", p)
            return p or "/"
        # Windows: 统一反斜杠, 补盘符
        q = p.replace("/", "\\")
        q = re.sub(r"\\{2,}", "\\\\", q)
        if q and not re.match(r"^[A-Za-z]:", q):
            q = "C:\\" + q.lstrip("\\")
        return q or "C:\\"

    def join(self, *parts: str) -> str:
        if self.posix_paths:
            return posixpath.join(*[str(x) for x in parts if x not in (None, "")]) or "/"
        segs = [str(x).strip("\\/") for x in parts if x not in (None, "")]
        if not segs:
            return "C:\\"
        head, *rest = segs
        if re.match(r"^[A-Za-z]:$", head):
            return head + "\\" + "\\".join(rest) if rest else head + "\\"
        return "\\".join(segs)

    def parent(self, p: str) -> str:
        if self.posix_paths:
            return posixpath.dirname(str(p).rstrip("/")) or "/"
        q = self.normalize(p).rstrip("\\")
        idx = q.rfind("\\")
        if idx <= 1:
            m = re.match(r"^([A-Za-z]:)", q)
            return (m.group(1) + "\\") if m else "C:\\"
        return q[:idx]

    def basename(self, p: str) -> str:
        if self.posix_paths:
            return posixpath.basename(str(p).rstrip("/")) or "/"
        return self.normalize(p).rstrip("\\").rsplit("\\", 1)[-1]

    def quote(self, p: str) -> str:
        """shell 层引用。Windows 走 EncodedCommand, 无需引用 → 原样返回。"""
        if self.family == OsFamily.WINDOWS:
            return str(p)
        return shlex.quote(str(p))

    # ── 命令构造 + 解析 ──

    def list_dir_cmd(self, path: str) -> str:
        raise NotImplementedError

    def parse_list_dir(self, out: str) -> list:
        raise NotImplementedError

    def mkdir_cmd(self, path: str) -> str:
        raise NotImplementedError

    def stat_size_cmd(self, path: str) -> str:
        raise NotImplementedError

    def parse_size(self, out: str) -> int:
        s = str(out or "").strip()
        m = re.search(r"(\d+)", s.split("\n")[0] if s else "")
        return int(m.group(1)) if m else 0

    def disks_cmd(self) -> str:
        raise NotImplementedError

    def parse_disks(self, out: str) -> list:
        return []

    # ── 引擎适用性 ──

    def engine_hint(self) -> tuple:
        """返回 (推荐引擎, 理由)。Windows 无 rsync; macOS rsync 版本不可信。"""
        if not self.has_rsync:
            return "rclone", "对端无 rsync → 走 rclone sftp 传输"
        if not self.rsync_trustworthy:
            return "rclone", "对端 rsync 版本老旧/协议不兼容 → 走 rclone sftp 传输"
        return "rsync", "对端 rsync 可用"


def _ps(script: str) -> str:
    """把 PowerShell 脚本封装成 -EncodedCommand (UTF-16LE base64), 免疫 shell 转义。"""
    b64 = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return f"powershell -NoProfile -NonInteractive -EncodedCommand {b64}"


def _ps_str(s: str) -> str:
    """PowerShell 单引号字符串字面量 (内部单引号翻倍)。"""
    return "'" + str(s or "").replace("'", "''") + "'"


# ── Linux (保持既有行为, 便于回归) ──

_LIST_LINUX = "ls -lA --time-style='+%Y-%m-%d %H:%M' {q} 2>/dev/null"


@dataclass
class LinuxProfile(OSProfile):
    def list_dir_cmd(self, path: str) -> str:
        return _LIST_LINUX.format(q=shlex.quote(path))

    def parse_list_dir(self, out: str) -> list:
        """解析 GNU `ls -lA --time-style='+%Y-%m-%d %H:%M'` (既有实现, 逻辑保持不变)。"""
        entries = []
        for line in str(out or "").splitlines():
            line = line.rstrip()
            if not line or line.startswith("total"):
                continue
            parts = line.split(None, 7)
            if len(parts) < 8:
                continue
            perm, _links, _own, _grp, size_s, d1, d2, name = parts
            if name in (".", ".."):
                continue
            # 符号链接 "a -> b" 取链接名
            if " -> " in name:
                name = name.split(" -> ", 1)[0]
            is_dir = perm.startswith("d")
            try:
                size = 0 if is_dir else int(size_s)
            except ValueError:
                size = 0
            entries.append({"name": name, "is_dir": is_dir, "size": size,
                            "mtime": f"{d1} {d2}"})
        return entries

    def mkdir_cmd(self, path: str) -> str:
        q = shlex.quote(path)
        return f"[ -e {q} ] && echo RP_EXISTS || (mkdir -p {q} && echo RP_OK)"

    def stat_size_cmd(self, path: str) -> str:
        return f"stat -c %s {shlex.quote(path)} 2>/dev/null || echo 0"

    def disks_cmd(self) -> str:
        return "df -PB1 -x tmpfs -x devtmpfs -x squashfs 2>/dev/null"

    def parse_disks(self, out: str) -> list:
        rows = []
        for line in str(out or "").splitlines():
            p = line.split()
            if len(p) >= 6 and p[0].startswith("/"):
                try:
                    rows.append({"device": p[0], "mount": p[5], "size": int(p[1]),
                                 "used": int(p[2]), "avail": int(p[3])})
                except ValueError:
                    continue
        return rows


# ── macOS (BSD) ──

@dataclass
class MacProfile(OSProfile):
    def list_dir_cmd(self, path: str) -> str:
        # BSD stat: 名称放最后, 解析时用 split(sep, 3) 从左侧切 3 刀,
        # 这样文件名里含 "|" 也不会破坏解析。
        d = shlex.quote(path)
        return (
            f"cd {d} 2>/dev/null && for f in .* *; do "
            f"case \"$f\" in .|..) continue;; esac; "
            f"[ -e \"$f\" ] || continue; "
            f"stat -f '%z|%Sp|%m|%N' \"$f\" 2>/dev/null; "
            f"done"
        )

    def parse_list_dir(self, out: str) -> list:
        entries = []
        for line in str(out or "").splitlines():
            line = line.rstrip("\n")
            if not line or line.count("|") < 3:
                continue
            size_s, perm, mtime_s, name = line.split("|", 3)
            name = name.strip()
            if not name or name in (".", ".."):
                continue
            is_dir = str(perm).startswith("d")
            try:
                size = 0 if is_dir else int(size_s)
            except ValueError:
                size = 0
            mt = ""
            try:
                import time as _t
                mt = _t.strftime("%Y-%m-%d %H:%M", _t.localtime(int(mtime_s)))
            except Exception:
                mt = ""
            entries.append({"name": name, "is_dir": is_dir, "size": size, "mtime": mt})
        return entries

    def mkdir_cmd(self, path: str) -> str:
        q = shlex.quote(path)
        return f"[ -e {q} ] && echo RP_EXISTS || (mkdir -p {q} && echo RP_OK)"

    def stat_size_cmd(self, path: str) -> str:
        return f"stat -f %z {shlex.quote(path)} 2>/dev/null || echo 0"

    def disks_cmd(self) -> str:
        # BSD df: -P 保证单行一设备; -k 以 1024 块计 (BSD df 无 -B1)
        return "df -P -k 2>/dev/null; echo '---RPDISK---'; diskutil list 2>/dev/null | head -60"

    def parse_disks(self, out: str) -> list:
        s = str(out or "")
        head = s.split("---RPDISK---")[0]
        rows = []
        for line in head.splitlines():
            p = line.split()
            if len(p) >= 6 and (p[0].startswith("/") or p[0].startswith("map")):
                try:
                    rows.append({"device": p[0], "mount": p[5],
                                 "size": int(p[1]) * 1024,
                                 "used": int(p[2]) * 1024,
                                 "avail": int(p[3]) * 1024})
                except ValueError:
                    continue
        return rows


# ── Windows (PowerShell over SSH) ──

@dataclass
class WindowsProfile(OSProfile):
    def list_dir_cmd(self, path: str) -> str:
        # 用普通语句而不是嵌套子表达式: 旧版 PowerShell 对 hashtable 字面量里放 if
        # 支持不好, 拆开写最稳。
        script = (
            "$ErrorActionPreference='SilentlyContinue';"
            f"$p={_ps_str(path)};"
            "$it=@(Get-ChildItem -LiteralPath $p -Force | ForEach-Object {"
            "  $isd=[int]($_.PSIsContainer -eq $true);"
            "  $sz=0; if ($isd -eq 0) { $sz=[int64]$_.Length };"
            "  $mt=0; if ($_.LastWriteTimeUtc) { $mt=[int64]([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeSeconds() };"
            "  [pscustomobject]@{ n=$_.Name; d=$isd; s=$sz; m=$mt }"
            "});"
            "$it | ConvertTo-Json -Compress -Depth 3"
        )
        return _ps(script)

    def parse_list_dir(self, out: str) -> list:
        s = str(out or "").strip()
        if not s:
            return []
        # PowerShell 关掉错误后仍可能混入 stderr 文本, 取第一个 JSON 结构
        i, j = s.find("["), s.rfind("]")
        if i == -1 or j == -1:
            i, j = s.find("{"), s.rfind("}")
        if i == -1 or j == -1 or j <= i:
            return []
        try:
            data = json.loads(s[i:j + 1])
        except json.JSONDecodeError:
            return []
        if isinstance(data, dict):
            data = [data]
        entries = []
        for it in data:
            if not isinstance(it, dict):
                continue
            name = str(it.get("n") or "")
            if not name or name in (".", ".."):
                continue
            is_dir = bool(it.get("d"))
            try:
                size = 0 if is_dir else int(it.get("s") or 0)
            except (TypeError, ValueError):
                size = 0
            mt = ""
            try:
                import time as _t
                v = int(it.get("m") or 0)
                if v > 0:
                    mt = _t.strftime("%Y-%m-%d %H:%M", _t.localtime(v))
            except (TypeError, ValueError):
                mt = ""
            entries.append({"name": name, "is_dir": is_dir, "size": size, "mtime": mt})
        return entries

    def mkdir_cmd(self, path: str) -> str:
        script = (
            "$ErrorActionPreference='SilentlyContinue';"
            f"$p={_ps_str(path)};"
            "if (Test-Path -LiteralPath $p) { 'RP_EXISTS' }"
            " else { New-Item -ItemType Directory -Force -Path $p | Out-Null;"
            " if (Test-Path -LiteralPath $p) { 'RP_OK' } else { 'RP_FAIL' } }"
        )
        return _ps(script)

    def stat_size_cmd(self, path: str) -> str:
        script = (
            "$ErrorActionPreference='SilentlyContinue';"
            f"$i=Get-Item -LiteralPath {_ps_str(path)};"
            "if ($i -and -not $i.PSIsContainer) { [int64]$i.Length } else { 0 }"
        )
        return _ps(script)

    def disks_cmd(self) -> str:
        script = (
            "$ErrorActionPreference='SilentlyContinue';"
            "$d=@(Get-PSDrive -PSProvider FileSystem | ForEach-Object {"
            "  [pscustomobject]@{"
            "    dev=$_.Name + ':';"
            "    root=[string]$_.Root;"
            "    used=[int64]($_.Used);"
            "    free=[int64]($_.Free)"
            "  }});"
            "$d | ConvertTo-Json -Compress -Depth 3"
        )
        return _ps(script)

    def parse_disks(self, out: str) -> list:
        s = str(out or "").strip()
        i, j = s.find("["), s.rfind("]")
        if i == -1 or j == -1:
            i, j = s.find("{"), s.rfind("}")
        if i == -1 or j == -1 or j <= i:
            return []
        try:
            data = json.loads(s[i:j + 1])
        except json.JSONDecodeError:
            return []
        if isinstance(data, dict):
            data = [data]
        rows = []
        for it in data:
            if not isinstance(it, dict):
                continue
            try:
                used = int(it.get("used") or 0)
                free = int(it.get("free") or 0)
            except (TypeError, ValueError):
                used = free = 0
            rows.append({"device": str(it.get("dev") or ""),
                         "mount": str(it.get("root") or it.get("dev") or ""),
                         "size": used + free, "used": used, "avail": free})
        return rows

    def quote(self, p: str) -> str:
        return str(p)


_LINUX = LinuxProfile(family=OsFamily.LINUX, label="Linux",
                      has_rsync=True, rsync_trustworthy=True)
_MACOS = MacProfile(family=OsFamily.MACOS, label="macOS",
                    has_rsync=True, rsync_trustworthy=False,
                    note="系统自带 rsync 长期为 2.6.9 / 新版 openrsync, 协议版本存疑")
_WINDOWS = WindowsProfile(family=OsFamily.WINDOWS, label="Windows",
                          path_sep="\\", posix_paths=False,
                          has_rsync=False, rsync_trustworthy=False,
                          note="Windows 原生无 rsync (需 cwRsync/WSL), 且无 POSIX 路径模型")
_UNKNOWN = LinuxProfile(family=OsFamily.UNKNOWN, label="未知 (按 Linux 处理)",
                        has_rsync=True, rsync_trustworthy=True,
                        note="未能识别远端 OS, 按 Linux 兼容口径处理")


def profile_for(family) -> OSProfile:
    f = family if isinstance(family, OsFamily) else OsFamily.parse(family)
    return {OsFamily.LINUX: _LINUX, OsFamily.MACOS: _MACOS,
            OsFamily.WINDOWS: _WINDOWS, OsFamily.UNKNOWN: _UNKNOWN}[f]


# 会话内缓存: (host,port) → 已探测家族, 避免每次列举都探一次
_DETECT_CACHE: dict = {}


def cached_family(host: str, port) -> Optional[OsFamily]:
    return _DETECT_CACHE.get(f"{host}:{port}")


def remember_family(host: str, port, family) -> None:
    f = family if isinstance(family, OsFamily) else OsFamily.parse(family)
    if f != OsFamily.UNKNOWN:
        _DETECT_CACHE[f"{host}:{port}"] = f
        if len(_DETECT_CACHE) > 256:
            for k in list(_DETECT_CACHE)[:64]:
                _DETECT_CACHE.pop(k, None)


async def detect_async(target) -> OsFamily:
    """对 SSHTarget 探测远端 OS (只读探测, 结果缓存)。失败返回 UNKNOWN。"""
    h, p = getattr(target, "host", ""), getattr(target, "port", 22)
    hit = cached_family(h, p)
    if hit is not None:
        return hit
    try:
        async with target.runner() as run:
            code, out, _e = await run.exec(detect_cmd(), timeout=15, merge_stderr=True)
        fam = parse_detect(out or "")
    except Exception as e:
        log.debug("远端 OS 探测失败 %s: %s", h, e)
        return OsFamily.UNKNOWN
    remember_family(h, p, fam)
    return fam


async def resolve_async(target, declared=None) -> OSProfile:
    """确定远端档案: 用户显式声明优先, 否则自动探测。"""
    fam = OsFamily.parse(declared)
    if fam == OsFamily.UNKNOWN:
        fam = await detect_async(target)
    return profile_for(fam)

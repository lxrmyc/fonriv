"""本机依赖注册表 + 检测 + 安装规划 (v5.20.0)

为什么单独成模块
---------------
此前 `handle_install_local_tools` 里内联了一份**只面向 apt 的白名单/别名表**:
  · 跨发行版包名不同 (Debian `unrar-free` / RHEL `unrar`; `p7zip-full` / `p7zip`)
  · 有些依赖 apt 根本没有 (croc 只有 GitHub release; awscli v2 走官方 installer;
    ldap3 是 pip 包; sqlcmd / mongodump / clickhouse-client 需要先加厂商源)
  · 系统设置里没有入口, 用户无从下手
本模块把这些收敛成一张表, 并提供"检测 → 规划 → 安装"的统一通路。

设计
----
每个依赖一条记录:
  id        程序名 (用于 which/--version 检测, 也是前端标识)
  label     中文名  category  分类  level  required|recommended|optional
  verify    检测命令 (退出码 0 即视为已装)
  show      取版本号的命令参数 (用于展示实际版本)
  apt/yum/apk/pip/github   各自的安装来源 (按当前系统取用)
  note      说明 / 失败时的替代建议

安全
----
· 包名一律按注册表取值, **前端传来的 id 必须命中注册表**, 不接受任意字符串,
  从根上避免命令注入 (旧实现靠正则 + 白名单, 这里更严: 只认表内条目)。
· 安装命令用 argv 列表形式, 不经 shell。
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field

# ── 安装来源类型 ──
SRC_APT = "apt"
SRC_YUM = "yum"
SRC_APK = "apk"
SRC_PIP = "pip"          # python -m pip install
SRC_GITHUB = "github"    # 从 GitHub release 取静态二进制 (无需包管理器)
SRC_MANUAL = "manual"    # 需人工加厂商源, 只提示不自动装


@dataclass
class Dep:
    id: str
    label: str
    category: str = "其他"
    level: str = "optional"          # required | recommended | optional
    verify: str = ""                 # 检测命令 (默认 "<id> --version")
    show: str = ""                   # 取版本显示的命令
    apt: str = ""
    yum: str = ""
    apk: str = ""
    pip: str = ""
    github: str = ""                 # 形如 "owner/repo:asset_glob"
    note: str = ""
    needs_repo: str = ""             # 需先加厂商源时的说明 (SRC_MANUAL 用)

    def verify_cmd(self) -> str:
        return self.verify or f"{self.id} --version"


# ═════════════════════════════════════════════════════════════
# 依赖清单
# ═════════════════════════════════════════════════════════════
DEPS: list[Dep] = [
    # ── 传输引擎 (必需) ──
    Dep("rsync", "rsync 传输引擎", "传输", "required",
        verify="rsync --version", show="rsync --version",
        apt="rsync", yum="rsync", apk="rsync",
        note="安全基线要求 ≥ 3.5.0 (修 33 个路径/符号链接类 CVE); 发行版自带可能偏旧, 可用自编译版"),
    Dep("sshpass", "SSH 密码认证", "传输", "required",
        verify="sshpass -V", apt="sshpass", yum="sshpass", apk="sshpass",
        note="rsync/ssh 用密码认证时必需; 密钥认证可不需要"),
    Dep("rclone", "rclone 对象存储引擎", "传输", "required",
        verify="rclone version", apt="rclone", yum="rclone", apk="rclone",
        note="云端 (S3/OSS/COS/WebDAV) 与 Windows/macOS 端点的传输通路"),
    Dep("croc", "croc P2P 直传", "传输", "optional",
        verify="croc --version",
        github="schollz/croc:Linux-64bit.tar.gz",
        note="两台机器均无公网入口时的点对点临时直传; apt 无此包, 由官方发布页获取静态二进制"),

    # ── 归档 / 压缩 ──
    Dep("tar", "tar 归档", "归档", "required", verify="tar --version",
        apt="tar", yum="tar", apk="tar", note="通常系统自带"),
    Dep("gzip", "gzip 压缩", "归档", "required", verify="gzip --version",
        apt="gzip", yum="gzip", apk="gzip"),
    Dep("zstd", "zstd 压缩 (推荐)", "归档", "recommended", verify="zstd --version",
        apt="zstd", yum="zstd", apk="zstd",
        note="同压缩率下比 gzip 快数倍, 备份产物默认优先用 zstd"),
    Dep("lz4", "lz4 极速压缩", "归档", "optional", verify="lz4 --version",
        apt="lz4", yum="lz4", apk="lz4"),
    Dep("7z", "7-Zip 多格式归档", "归档", "recommended", verify="7z",
        apt="p7zip-full", yum="p7zip", apk="p7zip",
        note="Debian 包名 p7zip-full, RHEL/Alpine 为 p7zip"),
    # 注意: 裸 `unrar` 无参数会退出码 1 (实测), 必须用 --help 判定;
    #   unrar-free 同样支持 --help, 二者任一存在即视为已装
    Dep("unrar", "RAR 解压", "归档", "optional",
        verify="unrar --help >/dev/null 2>&1 || unrar-free --help >/dev/null 2>&1",
        apt="unrar-free", yum="unrar", apk="unrar",
        note="Debian 的 unrar-free 对 RAR5 支持有限; 需要完整支持请装 non-free 的 unrar"),
    Dep("unzip", "ZIP 解压", "归档", "recommended", verify="unzip -v",
        apt="unzip", yum="unzip", apk="unzip"),
    Dep("age", "age 现代文件加密", "归档", "optional", verify="age --version",
        apt="age", yum="age", apk="age",
        note="L3 静态加密的可选后端 (X25519 + ChaCha20-Poly1305), 亦可只用内置 e2ee"),

    # ── 数据库备份 ──
    Dep("sqlite3", "SQLite 备份", "数据库", "recommended", verify="sqlite3 --version",
        apt="sqlite3", yum="sqlite", apk="sqlite",
        note="SQLite 备份/恢复必需"),
    Dep("mysqldump", "MySQL/MariaDB 备份", "数据库", "recommended",
        verify="mysqldump --version", show="mysqldump --version",
        apt="default-mysql-client", yum="mysql", apk="mariadb-client",
        note="Debian 包名 default-mysql-client (或 mariadb-client)"),
    Dep("pg_dump", "PostgreSQL 备份", "数据库", "recommended",
        verify="pg_dump --version",
        apt="postgresql-client", yum="postgresql", apk="postgresql-client"),
    Dep("mongodump", "MongoDB 备份", "数据库", "optional",
        verify="mongodump --version",
        needs_repo="需先添加 MongoDB 官方源 (mongodb-org-tools), 发行版自带源通常不含",
        note="因许可证变化, 主流发行版已移除; 需人工加官方源"),
    Dep("redis-cli", "Redis 备份", "数据库", "optional",
        verify="redis-cli --version",
        apt="redis-tools", yum="redis", apk="redis",
        note="Debian 包名 redis-tools"),
    Dep("sqlcmd", "SQL Server 备份", "数据库", "optional",
        verify="sqlcmd -?",
        needs_repo="需添加 Microsoft 官方源 (mssql-tools18)",
        note="微软未进主流发行版源, 需人工添加"),
    Dep("clickhouse-client", "ClickHouse 备份", "数据库", "optional",
        verify="clickhouse-client --version",
        needs_repo="需添加 ClickHouse 官方源或直接装官方静态二进制",
        note="官方提供单文件二进制, 亦可用 clickhouse-client 的 tgz 包"),

    # ── 容器 / 去重备份 ──
    Dep("docker", "Docker 容器管理", "容器", "recommended",
        verify="docker --version", show="docker --version",
        apt="docker.io", yum="docker", apk="docker",
        note="容器/镜像/卷备份与跨模块自动备份依赖它"),
    Dep("restic", "restic 去重备份", "备份", "recommended",
        verify="restic version", apt="restic", yum="restic", apk="restic"),

    # ── 远程控制台 (v6.16.2 批22 · 用户明令加入依赖安装) ──
    Dep("guacd", "guacd 远程桌面网关 (RDP/VNC 控制台必需)", "远程控制台", "recommended",
        verify="dpkg -s guacd",
        apt="guacd",
        note="Apache Guacamole 守护进程(自动带 RDP/VNC 协议插件); 一键安装后如未自启, 执行 systemctl enable --now guacd"),
    Dep("novnc", "noVNC (浏览器 VNC 客户端, 控制台页内置同款)", "远程控制台", "optional",
        verify="dpkg -s novnc", apt="novnc",
        note="仅独立 noVNC 网页时需要; 系统内控制台已内置 noVNC, 通常无需安装"),

    # ── 云 / 目录服务 ──
    Dep("aws", "AWS CLI (S3 对象锁/生命周期)", "云", "optional",
        verify="aws --version",
        apt="awscli", yum="awscli", apk="aws-cli",
        note="仅在使用 S3 Object Lock / 生命周期策略时需要; 普通 S3 传输走内置实现"),
    Dep("ldap3", "LDAP 认证支持 (python-ldap3)", "认证", "optional",
        verify="python3 -c 'import ldap3'",
        pip="ldap3", apt="python3-ldap3",
        note="启用 LDAP/AD 域认证时需要; 走 pip 或发行版 python3-ldap3 包"),
]

_BY_ID = {d.id: d for d in DEPS}


def get(dep_id: str):
    return _BY_ID.get((dep_id or "").strip())


def all_deps() -> list:
    return list(DEPS)


# ═════════════════════════════════════════════════════════════
# 系统探测
# ═════════════════════════════════════════════════════════════

def detect_pkg_mgr() -> str:
    for m, src in (("apt-get", SRC_APT), ("dnf", SRC_YUM), ("yum", SRC_YUM), ("apk", SRC_APK)):
        if shutil.which(m):
            return src
    return ""


def distro_label() -> str:
    """尽量给出可读的发行版名 (仅用于展示)。"""
    try:
        with open("/etc/os-release", encoding="utf-8") as f:
            d = {}
            for line in f:
                if "=" in line:
                    k, v = line.split("=", 1)
                    d[k.strip()] = v.strip().strip('"')
        return d.get("PRETTY_NAME") or d.get("NAME") or "?"
    except OSError:
        return "?"


def has_root_priv() -> tuple:
    """返回 (有权限, 说明)。root 或 sudo 免密均可。"""
    try:
        if os.geteuid() == 0:
            return True, "root"
    except Exception:
        pass
    try:
        r = subprocess.run(["sudo", "-n", "true"], capture_output=True, timeout=4)
        if r.returncode == 0:
            return True, "sudo 免密"
    except Exception:
        pass
    return False, "无 root 且 sudo 需交互密码"


def probe_one(dep: Dep, timeout: int = 5) -> dict:
    """检测单个依赖: 是否已装 + 版本串。"""
    cmd = dep.verify_cmd()
    out, ok = "", False
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        ok = (r.returncode == 0)
        out = (r.stdout or "") + (r.stderr or "")
    except FileNotFoundError:
        ok = False
    except subprocess.TimeoutExpired:
        # 有些工具 --version 会卡住 (如 sqlcmd 交互), 视为已装但不取版本
        ok = bool(shutil.which(dep.id))
        out = ""
    except Exception:
        ok = False
    ver = ""
    if ok and dep.show:
        try:
            r2 = subprocess.run(dep.show, shell=True, capture_output=True, text=True, timeout=timeout)
            ver = ((r2.stdout or "") + (r2.stderr or "")).strip().splitlines()[0][:120] if (r2.stdout or r2.stderr) else ""
        except Exception:
            ver = ""
    elif ok and out:
        ver = out.strip().splitlines()[0][:120]
    return {"id": dep.id, "installed": bool(ok), "version": ver,
            "path": shutil.which(dep.id) or ""}


def scan() -> dict:
    """全量检测本机依赖状态。

    ⚠ **会阻塞**: 逐个 subprocess.run 探测 (23 项 × 单个 5s 超时)。
    在 async 上下文里必须用 scan_async() / run_in_executor, 否则会把事件循环
    堵死, 导致同一连接上的其它 WS 请求超时 (实测过: 装依赖时扫描把 apt 的
    日志通道堵了 30s+ 触发前端超时)。
    """
    mgr = detect_pkg_mgr()
    ok, priv = has_root_priv()
    items = []
    for d in DEPS:
        st = probe_one(d)
        src = ""
        if mgr == SRC_APT:
            src = d.apt
        elif mgr == SRC_YUM:
            src = d.yum
        elif mgr == SRC_APK:
            src = d.apk
        if not src:
            if d.pip:
                src = "pip:" + d.pip
            elif d.github:
                src = "github:" + d.github
            elif d.needs_repo:
                src = "需手工加源"
        items.append({
            "id": d.id, "label": d.label, "category": d.category, "level": d.level,
            "installed": st["installed"], "version": st["version"], "path": st["path"],
            "source": src, "note": d.note, "needs_repo": d.needs_repo,
            "auto_installable": bool(src and not src.startswith("需手工")),
        })
    miss_req = [i["id"] for i in items if i["level"] == "required" and not i["installed"]]
    miss_rec = [i["id"] for i in items if i["level"] == "recommended" and not i["installed"]]
    return {
        "distro": distro_label(), "pkg_mgr": mgr, "has_priv": ok, "priv": priv,
        "items": items,
        "missing_required": miss_req, "missing_recommended": miss_rec,
        "installed_count": sum(1 for i in items if i["installed"]), "total": len(items),
    }


# ═════════════════════════════════════════════════════════════
# 安装
# ═════════════════════════════════════════════════════════════

def plan_install(dep_ids: list, mgr: str) -> tuple:
    """把依赖 id 列表拆成可执行的安装批次。

    返回 (batches, unknown, skipped)
      batches: [{"kind": apt|yum|apk|pip|github, "argv": [...], "label": "..."}]
      unknown: 不在注册表里的 id
      skipped: [(id, 原因)] —— 该来源不适用或需人工加源
    """
    batches: list = []
    unknown: list = []
    skipped: list = []
    pkg_names: list = []
    for i in dep_ids:
        d = get(i)
        if not d:
            unknown.append(i)
            continue
        if mgr == SRC_APT and d.apt:
            pkg_names.append(d.apt)
        elif mgr == SRC_YUM and d.yum:
            pkg_names.append(d.yum)
        elif mgr == SRC_APK and d.apk:
            pkg_names.append(d.apk)
        elif d.pip:
            batches.append({"kind": SRC_PIP, "argv": ["python3", "-m", "pip", "install",
                                                      "--break-system-packages", d.pip],
                            "label": f"pip install {d.pip}"})
        elif d.github:
            batches.append({"kind": SRC_GITHUB, "spec": d.github,
                            "label": f"从 GitHub 获取 {d.id}"})
        elif d.needs_repo:
            skipped.append((d.id, d.needs_repo))
        else:
            skipped.append((d.id, "当前系统无可用安装来源 (或包名未登记)"))
    if pkg_names:
        # 去重保序
        seen, uniq = set(), []
        for p in pkg_names:
            if p not in seen:
                seen.add(p); uniq.append(p)
        if mgr == SRC_APT:
            batches.insert(0, {"kind": SRC_APT,
                               "argv": ["apt-get", "install", "-y"] + uniq,
                               "refresh": ["apt-get", "update"],
                               "label": "apt-get install " + " ".join(uniq)})
        elif mgr == SRC_YUM:
            batches.insert(0, {"kind": SRC_YUM,
                               "argv": ["yum", "install", "-y"] + uniq,
                               "label": "yum install " + " ".join(uniq)})
        elif mgr == SRC_APK:
            batches.insert(0, {"kind": SRC_APK,
                               "argv": ["apk", "add"] + uniq,
                               "label": "apk add " + " ".join(uniq)})
    return batches, unknown, skipped


def with_priv(argv: list, priv: str) -> list:
    """按权限形态给 argv 加 sudo 前缀。"""
    if priv == "root":
        return list(argv)
    return ["sudo", "-n"] + list(argv)


async def scan_async() -> dict:
    """线程池里跑 scan(), 不阻塞事件循环。所有 async 调用点都应使用本函数。"""
    import asyncio
    return await asyncio.get_event_loop().run_in_executor(None, scan)

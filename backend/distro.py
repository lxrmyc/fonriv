"""Fonriv - 异构 Linux 发行版探测与工具适配 (v4.82.0 · 专利3 深化)

系统化发行版识别 → 包管理器映射 → 工具安装命令生成 → 服务管理器适配 → 认证方式自适应。

覆盖 12+ 发行版族:
  Debian 系: Debian / Ubuntu / Deepin / UOS / Raspbian
  RHEL 系: RHEL / CentOS / Rocky / Alma / Fedora / openEuler
  SUSE 系: openSUSE / SLES
  Arch 系: Arch / Manjaro
  Alpine / Gentoo
  国产: 麒麟(Kylin) / 统信(UOS) / openEuler / 凝思(Nessus)

WS 动作:
  distro_detect    本机或远端发行版探测
  distro_tools     按发行版生成数据库工具安装命令
"""
from __future__ import annotations

import shlex

from fastapi import WebSocket, WebSocketDisconnect

from backend.log import log_operation

# ── 发行版注册表 ──
# key: /etc/os-release 的 ID 值
# pkg: 包管理器 (apt/dnf/yum/zypper/pacman/apk/emerge)
# svc: 服务管理器 (systemd/sysvinit/openrc)
# aliases: ID_LIKE 兼容值
DISTRO_REGISTRY = {
    # Debian 系
    "debian":         {"family": "debian", "pkg": "apt",    "svc": "systemd", "label": "Debian"},
    "ubuntu":         {"family": "debian", "pkg": "apt",    "svc": "systemd", "label": "Ubuntu"},
    "deepin":         {"family": "debian", "pkg": "apt",    "svc": "systemd", "label": "Deepin"},
    "uos":            {"family": "debian", "pkg": "apt",    "svc": "systemd", "label": "统信 UOS"},
    "raspbian":       {"family": "debian", "pkg": "apt",    "svc": "systemd", "label": "Raspbian"},
    "kali":           {"family": "debian", "pkg": "apt",    "svc": "systemd", "label": "Kali"},
    "linuxmint":      {"family": "debian", "pkg": "apt",    "svc": "systemd", "label": "Linux Mint"},
    # RHEL 系
    "rhel":           {"family": "rhel",   "pkg": "dnf",    "svc": "systemd", "label": "RHEL"},
    "redhat":         {"family": "rhel",   "pkg": "yum",    "svc": "systemd", "label": "Red Hat"},
    "centos":         {"family": "rhel",   "pkg": "yum",    "svc": "systemd", "label": "CentOS"},
    "rocky":          {"family": "rhel",   "pkg": "dnf",    "svc": "systemd", "label": "Rocky Linux"},
    "almalinux":      {"family": "rhel",   "pkg": "dnf",    "svc": "systemd", "label": "AlmaLinux"},
    "fedora":         {"family": "rhel",   "pkg": "dnf",    "svc": "systemd", "label": "Fedora"},
    "openeuler":      {"family": "rhel",   "pkg": "dnf",    "svc": "systemd", "label": "openEuler"},
    "anolis":         {"family": "rhel",   "pkg": "dnf",    "svc": "systemd", "label": "Anolis"},
    # 国产
    "kylin":          {"family": "debian", "pkg": "apt",    "svc": "systemd", "label": "银河麒麟"},
    "kylin-server":   {"family": "rhel",   "pkg": "yum",    "svc": "systemd", "label": "麒麟服务器版"},
    "nexus":          {"family": "debian", "pkg": "apt",    "svc": "systemd", "label": "凝思"},
    "opengauss":      {"family": "rhel",   "pkg": "dnf",    "svc": "systemd", "label": "openGauss"},
    # SUSE 系
    "opensuse-leap":  {"family": "suse",   "pkg": "zypper", "svc": "systemd", "label": "openSUSE Leap"},
    "opensuse":       {"family": "suse",   "pkg": "zypper", "svc": "systemd", "label": "openSUSE"},
    "sles":           {"family": "suse",   "pkg": "zypper", "svc": "systemd", "label": "SLES"},
    # Arch 系
    "arch":           {"family": "arch",   "pkg": "pacman", "svc": "systemd", "label": "Arch Linux"},
    "manjaro":        {"family": "arch",   "pkg": "pacman", "svc": "systemd", "label": "Manjaro"},
    # 其他
    "alpine":         {"family": "alpine", "pkg": "apk",    "svc": "openrc",  "label": "Alpine"},
    "gentoo":         {"family": "gentoo", "pkg": "emerge", "svc": "openrc",  "label": "Gentoo"},
}

# ID_LIKE → family 映射 (os-release 的 ID_LIKE 字段)
ID_LIKE_MAP = {
    "debian": "debian", "ubuntu": "debian",
    "rhel": "rhel", "fedora": "rhel", "centos": "rhel",
    "suse": "suse", "opensuse": "suse",
    "arch": "arch",
    "alpine": "alpine",
}

# ── 数据库工具 → 包名映射 (按包管理器) ──
DB_TOOL_PACKAGES = {
    # tool: {pkg_mgr: package_name}
    "mysqldump": {
        "apt": "mariadb-client", "dnf": "mariadb", "yum": "mariadb",
        "zypper": "mariadb-client", "pacman": "mariadb-clients", "apk": "mariadb-client",
    },
    "pg_dump": {
        "apt": "postgresql-client", "dnf": "postgresql", "yum": "postgresql",
        "zypper": "postgresql14", "pacman": "postgresql", "apk": "postgresql14-client",
    },
    "mongodump": {
        "apt": "mongodb-database-tools", "dnf": "mongodb-database-tools",
        "yum": "mongodb-database-tools", "zypper": "mongodb-database-tools",
        "pacman": "mongodb-tools", "apk": "mongodb-tools",
    },
    "redis-cli": {
        "apt": "redis-tools", "dnf": "redis", "yum": "redis",
        "zypper": "redis", "pacman": "redis", "apk": "redis",
    },
    "sqlite3": {
        "apt": "sqlite3", "dnf": "sqlite", "yum": "sqlite",
        "zypper": "sqlite3", "pacman": "sqlite", "apk": "sqlite",
    },
    "sqlcmd": {
        "apt": "msodbcsql17", "dnf": "mssql-tools", "yum": "mssql-tools",
    },
    "clickhouse-client": {
        "apt": "clickhouse-client", "dnf": "clickhouse-client",
    },
    "restic": {
        "apt": "restic", "dnf": "restic", "yum": "restic",
        "zypper": "restic", "pacman": "restic", "apk": "restic",
    },
    "rsync": {
        "apt": "rsync", "dnf": "rsync", "yum": "rsync",
        "zypper": "rsync", "pacman": "rsync", "apk": "rsync",
    },
}

# 服务名映射 (数据库服务重启用)
DB_SERVICE_NAMES = {
    "mysql": {"debian": ["mariadb", "mysql"], "rhel": ["mariadb", "mysqld"], "suse": ["mysql"], "arch": ["mariadb"]},
    "postgresql": {"debian": ["postgresql"], "rhel": ["postgresql"], "suse": ["postgresql"], "arch": ["postgresql"]},
    "mongodb": {"debian": ["mongod"], "rhel": ["mongod"], "suse": ["mongod"], "arch": ["mongodb"]},
    "redis": {"debian": ["redis-server"], "rhel": ["redis"], "suse": ["redis"], "arch": ["redis"]},
}


def parse_os_release(content: str) -> dict:
    """解析 /etc/os-release 内容。"""
    out = {}
    for line in content.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            v = v.strip().strip('"').strip("'")
            out[k.strip()] = v
    return out


def identify_distro(os_release: dict) -> dict:
    """从 os-release 字段识别发行版 → 注册表条目。"""
    distro_id = (os_release.get("ID") or "").lower().strip()
    id_like = (os_release.get("ID_LIKE") or "").lower().strip()
    pretty = os_release.get("PRETTY_NAME") or os_release.get("NAME") or ""
    version = os_release.get("VERSION_ID") or os_release.get("VERSION") or ""

    entry = DISTRO_REGISTRY.get(distro_id)
    if not entry:
        # 尝试 ID_LIKE
        for like in id_like.split():
            like = like.strip()
            if like in ID_LIKE_MAP:
                family = ID_LIKE_MAP[like]
                # 找该 family 的默认条目
                for k2, v2 in DISTRO_REGISTRY.items():
                    if v2["family"] == family:
                        entry = {**v2, "label": f"{pretty or like} (via ID_LIKE)"}
                        break
                break
    if not entry:
        # 兜底: 按 PRETTY_NAME 猜
        pl = pretty.lower()
        for key, reg in DISTRO_REGISTRY.items():
            if key in pl:
                entry = {**reg, "label": pretty}
                break
    if not entry:
        entry = {"family": "unknown", "pkg": "apt", "svc": "systemd",
                 "label": pretty or distro_id or "未知"}

    return {
        "id": distro_id, "id_like": id_like,
        "family": entry["family"], "pkg_mgr": entry["pkg"],
        "service_mgr": entry["svc"], "label": entry.get("label", pretty),
        "version": version, "pretty_name": pretty,
    }


def get_tool_install_cmd(tool: str, pkg_mgr: str, use_sudo: bool = False) -> str | None:
    """生成工具安装命令 (按包管理器)。"""
    pkgs = DB_TOOL_PACKAGES.get(tool)
    if not pkgs:
        return None
    pkg = pkgs.get(pkg_mgr)
    if not pkg:
        return None
    prefix = "sudo " if use_sudo else ""
    if pkg_mgr == "apt":
        return f"{prefix}apt-get install -y {pkg}"
    if pkg_mgr in ("dnf", "yum"):
        return f"{prefix}{pkg_mgr} install -y {pkg}"
    if pkg_mgr == "zypper":
        return f"{prefix}zypper install -y {pkg}"
    if pkg_mgr == "pacman":
        return f"{prefix}pacman -S --noconfirm {pkg}"
    if pkg_mgr == "apk":
        return f"{prefix}apk add {pkg}"
    return None


def get_service_cmd(action: str, db_type: str, family: str, use_sudo: bool = False) -> str | None:
    """生成服务管理命令 (start/stop/restart/status)。"""
    services = DB_SERVICE_NAMES.get(db_type, {}).get(family)
    if not services:
        return None
    svc = services[0]
    prefix = "sudo " if use_sudo else ""
    return f"{prefix}systemctl {action} {svc}"


# ── 探测命令 ──

DETECT_CMD = (
    "cat /etc/os-release 2>/dev/null; "
    "echo '---PKG---'; "
    "for pm in apt-get dnf yum zypper pacman apk; do "
    "  command -v $pm >/dev/null 2>&1 && echo \"FOUND:$pm\"; "
    "done; "
    "echo '---TOOLS---'; "
    "for t in mysqldump pg_dump mongodump redis-cli sqlite3 restic rsync; do "
    "  command -v $t >/dev/null 2>&1 && echo \"OK:$t\" || echo \"MISS:$t\"; "
    "done; "
    "echo '---AUTH---'; "
    "id -u 2>/dev/null; "
    "test -S /var/run/mysqld/mysqld.sock && echo 'SOCK:mysql' ; "
    "test -S /var/run/postgresql/.s.PGSQL.5432 && echo 'SOCK:pg' ; true"
)


async def _run(target, cmd: str, timeout: int = 30):
    if target and target.host:
        async with target.runner() as run:
            code, out, _ = await run.exec(cmd, timeout=timeout, merge_stderr=True)
            return code, out
    import subprocess
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


# ── WS handlers ──

async def handle_distro_detect(ws, data: dict):
    """探测本机或远端的发行版 + 包管理器 + 工具可用性 + 认证方式。
    params: host/...(SSH 可选)"""
    from backend.ssh_lib import SSHTarget, ssh_error_msg
    _req = data.get("req_id") or ""
    try:
        target = SSHTarget.from_ws_data(data) if data.get("host") else None
        code, out = await _run(target, DETECT_CMD, timeout=30)
        if code != 0 and not out.strip():
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": f"探测失败 (rc={code})"})
            return

        # 解析分段
        sections = out.split("---PKG---")
        osr_raw = sections[0]
        rest = sections[1] if len(sections) > 1 else ""
        pkg_tools = rest.split("---TOOLS---")
        pkg_raw = pkg_tools[0]
        tools_auth = pkg_tools[1] if len(pkg_tools) > 1 else ""
        ta = tools_auth.split("---AUTH---")
        tools_raw = ta[0]
        auth_raw = ta[1] if len(ta) > 1 else ""

        # 发行版
        osr = parse_os_release(osr_raw)
        distro = identify_distro(osr)

        # 包管理器 (探测结果优先, 注册表兜底)
        found_pkgs = [l.split(":", 1)[1] for l in pkg_raw.splitlines() if l.startswith("FOUND:")]
        if found_pkgs:
            distro["pkg_mgr"] = found_pkgs[0]  # 第一个找到的

        # 工具可用性
        tools = {}
        for l in tools_raw.splitlines():
            if l.startswith("OK:"):
                tools[l.split(":", 1)[1]] = True
            elif l.startswith("MISS:"):
                tools[l.split(":", 1)[1]] = False

        # 认证方式
        auth_lines = [l.strip() for l in auth_raw.splitlines() if l.strip()]
        uid = auth_lines[0] if auth_lines and auth_lines[0].isdigit() else "?"
        auth_modes = []
        if "SOCK:mysql" in auth_raw:
            auth_modes.append("mysql-unix-socket")
        if "SOCK:pg" in auth_raw[0:200] if isinstance(auth_raw, str) else False:
            auth_modes.append("pg-unix-socket")
        if uid == "0":
            auth_modes.append("root")

        # 生成安装建议
        install_suggestions = {}
        for tool, installed in tools.items():
            if not installed:
                cmd = get_tool_install_cmd(tool, distro["pkg_mgr"], use_sudo=(uid != "0"))
                if cmd:
                    install_suggestions[tool] = cmd

        log_operation("发行版探测", f"{distro['label']} · {distro['pkg_mgr']} · {distro['family']}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "distro": distro, "tools": tools,
                            "uid": uid, "auth_modes": auth_modes,
                            "install_suggestions": install_suggestions,
                            "supported_distros": len(DISTRO_REGISTRY)})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"探测异常: {ssh_error_msg(str(e))}"})


async def handle_distro_tools(ws, data: dict):
    """按发行版生成数据库工具安装命令。params: pkg_mgr (可选, 默认 auto-detect 本机)"""
    _req = data.get("req_id") or ""
    pkg_mgr = (data.get("pkg_mgr") or "").strip()
    if not pkg_mgr:
        # 本机探测
        import shutil
        for pm in ("apt-get", "dnf", "yum", "zypper", "pacman", "apk"):
            if shutil.which(pm):
                pkg_mgr = pm.replace("-get", "")
                break
    if not pkg_mgr:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "无法识别本机包管理器"})
        return
    out = {}
    for tool in DB_TOOL_PACKAGES:
        cmd = get_tool_install_cmd(tool, pkg_mgr, use_sudo=False)
        out[tool] = cmd or "(该包管理器无对应包)"
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "pkg_mgr": pkg_mgr, "commands": out})

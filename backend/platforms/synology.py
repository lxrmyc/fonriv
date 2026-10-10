"""群晖 DSM 平台（骨架）。

DSM 特殊性：
  - busybox userland，不完全兼容 GNU coreutils
  - /etc.defaults/VERSION 是 DSM 版本文件
  - 套件在 /var/packages/*/etc/
  - Docker 走 Container Manager
alpha1 只做 detect + manifest 元信息。
"""

from backend.platforms.base import BackupPlatform, BackupItem


class SynologyPlatform(BackupPlatform):
    NAME = "synology"
    DISPLAY = "Synology DSM"
    ICON = "🅢"
    NOTES = "群晖 DSM 6/7 · 需在 控制面板 → 终端机 & SNMP 中开启 SSH · 建议 root 或 admin。"

    @classmethod
    def detect(cls, probe: dict) -> int:
        score = 0
        if probe.get("is_syno"):
            score += 85
        ver = probe.get("syno_version", "") or ""
        if "productversion" in ver.lower() or "buildnumber" in ver.lower():
            score += 10
        return min(score, 100)

    def collect_config_manifest(self):
        return [
            BackupItem("dsm_version",    "DSM 版本",       "/etc.defaults/VERSION",   kind="file", required=True),
            BackupItem("synoinfo",       "DSM 主配置",     "/etc/synoinfo.conf",      kind="file", required=True),
            BackupItem("synoinfo_default","DSM 默认配置",  "/etc.defaults/synoinfo.conf", kind="file", required=False),
            BackupItem("syno_etc",       "DSM /etc/syno*", "/etc/syno*",              kind="dir",  required=False),
            BackupItem("packages_meta",  "套件元数据",     "/var/packages/*/etc/",    kind="dir",  required=False,
                       description="所有已装套件的配置目录（不含数据）"),
            BackupItem("packages_list",  "套件清单",       "/usr/syno/bin/synopkg list", kind="command_output",
                       required=False),
            BackupItem("shares_list",    "共享文件夹清单", "/usr/syno/bin/synoshare --enum ALL",
                       kind="command_output", required=False, description="仅元数据，不含数据"),
            BackupItem("smb_conf",       "Samba 配置",     "/etc/samba/",             kind="dir",  required=False),
            BackupItem("ssh",            "SSH 配置",       "/etc/ssh/",               kind="dir",  required=True),
            BackupItem("hosts",          "hosts 文件",     "/etc/hosts",              kind="file", required=True),
            BackupItem("crontab",        "crontab",        "cat /etc/crontab 2>/dev/null; crontab -l 2>/dev/null",
                       kind="command_output", required=False),
        ]

    def workloads_hint(self):
        return ["package", "share", "docker", "user"]

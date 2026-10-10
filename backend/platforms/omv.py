"""openmediavault 平台。

OMV 的关键差异：
  - 底层是 Debian，通用 Linux 的清单都适用
  - 独有：/etc/openmediavault/config.xml（所有共享/用户/SMB/NFS 都在里面）
  - 部署机制：omv-salt deploy run（恢复后必须重跑）
  - 插件：dpkg -l 'openmediavault-*'
"""

from backend.platforms.base import BackupPlatform, BackupItem
from backend.platforms.linux_generic import LinuxGenericPlatform


class OMVPlatform(LinuxGenericPlatform):
    NAME = "omv"
    DISPLAY = "openmediavault"
    ICON = "📦"
    NOTES = "OMV 5/6/7 · 恢复后需 root 执行 omv-salt deploy run 让新配置生效。"

    @classmethod
    def detect(cls, probe: dict) -> int:
        score = 0
        if probe.get("is_omv"):
            score += 85
        # 释放度：底层是 Debian 会加分
        os_id = probe.get("os_id", "")
        if os_id in ("debian", "raspbian"):
            score += 5
        # OMV 用户很少直接装 zfs，装了不加分也不减分
        return min(score, 100)

    def collect_config_manifest(self):
        return [
            BackupItem("omv_config",  "OMV 主配置", "/etc/openmediavault/config.xml", kind="file", required=True,
                       description="共享/用户/SMB/NFS/RAID 全在这里；恢复后 omv-salt deploy run"),
            BackupItem("omv_salt",    "OMV Salt 目录", "/etc/openmediavault/", kind="dir", required=False,
                       description="完整 OMV 配置目录（含 config.xml.bak）"),
            BackupItem("salt_grains", "Salt grains",  "/etc/salt/",           kind="dir", required=False),
            BackupItem("network",     "网络配置",     "/etc/network/;/etc/netplan/", kind="dir", required=True),
            BackupItem("ssh",         "SSH 配置",     "/etc/ssh/",            kind="dir", required=True),
            BackupItem("fstab",       "挂载表",       "/etc/fstab",           kind="file", required=True),
            BackupItem("hosts",       "hosts 文件",   "/etc/hosts",           kind="file", required=True),
            BackupItem("users",       "用户/密码",    "/etc/passwd;/etc/shadow;/etc/group;/etc/gshadow",
                       kind="file", required=False),
            BackupItem("smb_conf",    "Samba 配置",   "/etc/samba/",          kind="dir", required=False),
            BackupItem("nfs_exports", "NFS exports",  "/etc/exports;/etc/exports.d/", kind="file", required=False),
            BackupItem("root_ssh",    "root SSH",     "/root/.ssh/",          kind="dir", required=False),
            BackupItem("plugins_list","插件清单",     "dpkg -l 'openmediavault-*'",  kind="command_output",
                       required=False, description="只备份清单元数据，不备份插件本体"),
            BackupItem("crontab",     "crontab",      "crontab -l",           kind="command_output", required=False),
        ]

    def workloads_hint(self):
        return ["share", "user", "smb_export", "nfs_export", "plugin", "docker", "systemd"]

    # ------------------------------------------------------------------
    # alpha1.5: 只读探测 workloads
    # 继承 linux_generic 的 Docker+systemd，再叠加 OMV 特有：
    #   · dpkg -l openmediavault-*        → 插件清单
    #   · omv-confdbadm read conf.system.sharedfolder → 共享文件夹元数据
    # 绝不触发 omv-salt / config.xml 写入，符合"不动数据"约束。
    # ------------------------------------------------------------------
    async def detect_workloads(self, runner):
        from backend.platforms.base import Workload

        # 先复用父类拿 Docker + systemd
        workloads = await super().detect_workloads(runner)

        # OMV 插件（dpkg 只读）
        rc, out, _ = await runner.exec(
            "dpkg-query -W -f='${Package}\\t${Version}\\t${Status}\\n' 'openmediavault-*' "
            "2>/dev/null || echo __NO_DPKG__",
            timeout=15,
        )
        if rc == 0 and "__NO_DPKG__" not in out:
            for line in out.strip().splitlines():
                parts = line.split("\t")
                if len(parts) >= 1 and parts[0].startswith("openmediavault"):
                    workloads.append(Workload(
                        kind="plugin", id=parts[0], name=parts[0],
                        status=parts[2] if len(parts) > 2 else "",
                        extra={"version": parts[1] if len(parts) > 1 else ""},
                    ))

        # OMV 共享文件夹（omv-confdbadm 只读）
        rc, out, _ = await runner.exec(
            "command -v omv-confdbadm >/dev/null 2>&1 && "
            "omv-confdbadm read conf.system.sharedfolder 2>/dev/null || echo __NO_OMVCONF__",
            timeout=15,
        )
        if rc == 0 and "__NO_OMVCONF__" not in out and out.strip():
            # omv-confdbadm 输出 JSON 数组
            import json as _json
            try:
                data = _json.loads(out)
                if isinstance(data, list):
                    for sf in data:
                        if isinstance(sf, dict):
                            workloads.append(Workload(
                                kind="share",
                                id=sf.get("uuid") or sf.get("name", ""),
                                name=sf.get("name", ""),
                                status="",
                                extra={
                                    "reldirpath": sf.get("reldirpath", ""),
                                    "mntent": sf.get("mntentref", ""),
                                    "comment": sf.get("comment", ""),
                                },
                            ))
            except Exception as e:
                # 解析失败不影响其他 workloads，记录到日志无门槛：直接吞
                # （UI 只关心已成功识别的 shares；omv-confdbadm 版本差异应有容忍）
                pass

        return workloads

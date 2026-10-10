"""Proxmox VE 平台（v4.0.0-alpha1 骨架 · 保留现有 handler 行为）。

alpha1 只登记 detect() + manifest 元信息，
真正的 workload/backup/restore 依然由 backend/handlers/auto_backup.py 承担。
alpha1.5 起会把 PVE 相关逻辑迁进本文件。
"""

from backend.platforms.base import BackupPlatform, BackupItem


class PVEPlatform(BackupPlatform):
    NAME = "pve"
    DISPLAY = "Proxmox VE"
    ICON = "🅿️"
    NOTES = "Proxmox VE 8.x / 7.x。备份将包含 /etc/pve、VM/LXC 配置与 vzdump 归档索引。"

    @classmethod
    def detect(cls, probe: dict) -> int:
        score = 0
        if probe.get("is_pve"):
            score += 80
        if probe.get("has_qm"):
            score += 5
        if probe.get("has_pct"):
            score += 5
        pv = probe.get("pveversion_cmd", "") or ""
        if pv.startswith("pve-manager"):
            score += 10
        return min(score, 100)

    def collect_config_manifest(self):
        return [
            BackupItem("pve_cluster",    "PVE 集群配置",   "/etc/pve/",              kind="dir",  required=True,
                       description="datacenter.cfg / nodes / qemu-server / lxc"),
            BackupItem("network",        "网络配置",       "/etc/network/interfaces", kind="file", required=True),
            BackupItem("ssh",            "SSH 配置",       "/etc/ssh/",              kind="dir",  required=True),
            BackupItem("fstab",          "挂载表",         "/etc/fstab",             kind="file", required=True),
            BackupItem("hosts",          "hosts 文件",     "/etc/hosts",             kind="file", required=True),
            BackupItem("vzdump_conf",    "vzdump 默认参数", "/etc/vzdump.conf",       kind="file", required=False),
            BackupItem("cron",           "cron 目录",      "/etc/cron.d/;/etc/cron.daily/;/var/spool/cron/",
                       kind="dir", required=False),
            BackupItem("root_ssh",       "root SSH",       "/root/.ssh/",            kind="dir",  required=False),
            BackupItem("firewall",       "PVE 防火墙",     "/etc/pve/firewall/;/etc/pve/nodes/*/host.fw",
                       kind="dir", required=False),
        ]

    def workloads_hint(self):
        return ["vm", "ct", "storage"]

    # ------------------------------------------------------------------
    # alpha1.5: 只读探测 workloads
    # 逻辑与 backend/handlers/auto_backup.py::handle_auto_restore_detect 等价，
    # 但抽出到本类，方便通用 UI 复用。auto_backup.py 保持不动。
    # ------------------------------------------------------------------
    async def detect_workloads(self, runner):
        from backend.platforms.base import Workload

        workloads = []

        # VM 列表 (qm)
        rc, out, _ = await runner.exec("qm list 2>/dev/null || echo NO_QM", timeout=15)
        if rc == 0 and not out.strip().startswith("NO_QM"):
            for line in out.strip().splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 3:
                    workloads.append(Workload(
                        kind="vm", id=parts[0], name=parts[1],
                        status=parts[2],
                        extra={"mem": parts[3] if len(parts) > 3 else ""},
                    ))

        # LXC 列表 (pct)
        rc, out, _ = await runner.exec("pct list 2>/dev/null || echo NO_PCT", timeout=15)
        if rc == 0 and not out.strip().startswith("NO_PCT"):
            for line in out.strip().splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 3:
                    workloads.append(Workload(
                        kind="ct", id=parts[0], name=parts[2] if len(parts) > 2 else "",
                        status=parts[1],
                    ))

        # 存储列表 (pvesm)
        rc, out, _ = await runner.exec("pvesm status 2>/dev/null || echo NO_STORAGE", timeout=15)
        if rc == 0 and not out.strip().startswith("NO_STORAGE"):
            for line in out.strip().splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 3:
                    workloads.append(Workload(
                        kind="storage", id=parts[0], name=parts[0],
                        status=parts[2],
                        extra={"type": parts[1],
                               "total": parts[3] if len(parts) > 3 else "",
                               "used":  parts[4] if len(parts) > 4 else ""},
                    ))

        return workloads

    # ------------------------------------------------------------------
    # alpha6 (v4.0.0 GA 收官): plan_backup / execute_backup
    # PVE 底层是 Debian · manifest 是路径列表 (含 /etc/pve/ 特殊 fuse fs)
    # 复用 LinuxGenericPlatform 的通用扫描/打包逻辑，避免代码重复。
    # 注意：/etc/pve/ 是 pmxcfs FUSE 挂载，tar 读取是稳定的（PVE 官方文档确认）
    # ------------------------------------------------------------------
    async def plan_backup(self, runner, selected_keys=None) -> dict:
        from backend.platforms.linux_generic import LinuxGenericPlatform
        # 借用 LinuxGeneric 的 plan_backup 内核，但用 PVE 的 manifest
        # 通过 monkey-patch collect_config_manifest 让扫描器用 PVE 清单
        helper = LinuxGenericPlatform()
        helper.collect_config_manifest = self.collect_config_manifest  # type: ignore
        return await helper.plan_backup(runner, selected_keys)

    async def execute_backup(self, runner, plan, local_dst,
                             compressor="gzip", progress_cb=None, task_id=None) -> dict:
        from backend.platforms.linux_generic import LinuxGenericPlatform
        # PVE tar 流备份逻辑与通用 Linux 一致
        return await LinuxGenericPlatform().execute_backup(
            runner, plan, local_dst, compressor=compressor,
            progress_cb=progress_cb, task_id=task_id,
        )

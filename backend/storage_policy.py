"""Fonriv - D2 存储类型智能识别 (v4.92.0)

探测路径所在的存储栈, 按"备份通道收益"自动推荐备份方式:
  zfs      → zfs send/receive (快照级增量, 一致性最好)
  ceph/rbd → rbd export (镜像级导出)
  lvm-thin → LVM 薄快照 + 打包 (冻结视图)
  lvm      → LVM 快照 + 打包
  btrfs    → btrfs send/receive
  其他     → rsync 文件级同步 (dir)

动作:
  storage_policy_detect   探测 (path, host 可选: 空=本机, 有=SSH 远端探测)
"""
from __future__ import annotations

import asyncio
import shlex

from fastapi import WebSocket

from backend.log import log_operation

# kind → (通道标签, 推荐理由, 是否支持快照级一致性)
CHANNELS = {
    "zfs": ("zfs send/receive", "ZFS 数据集: 快照级增量 + 原子一致性, 增量传输量最小", True),
    "rbd": ("rbd export / Ceph 导出", "Ceph RBD 块设备: 镜像级导出, 与 PVE 存储池原生集成", True),
    "lvm-thin": ("LVM-thin 快照 + 打包", "LVM 薄卷: thin snapshot 秒级冻结视图, 备份期间写入不受阻", True),
    "lvm": ("LVM 快照 + 打包", "LVM 卷: 传统快照 (预留空间), 提供崩溃一致视图", True),
    "btrfs": ("btrfs send/receive", "Btrfs 子卷: 快照级增量传输", True),
    "dir": ("rsync 文件级同步", "常规文件系统: 文件级增量同步 (画像可联动传输引擎自动选择 rsync/rclone)", False),
}

SUGGEST_CMDS = {
    "zfs": "zfs snapshot {dataset}@rp_backup && zfs send -Ri {dataset}@last {dataset}@rp_backup | 接收端 zfs receive",
    "rbd": "rbd export <pool/image> - > 镜像导出文件 (或 rbd export-diff 增量)",
    "lvm-thin": "lvcreate -s -n rp_snap <vg/lv> && tar cf - <快照挂载点> | 打包落盘",
    "lvm": "lvcreate -s -L 10%FREE -n rp_snap <vg/lv> && tar cf - <快照挂载点> | 打包落盘",
    "btrfs": "btrfs subvolume snapshot <path> <snap> && btrfs send -i <parent> <snap>",
    "dir": "rsync -a <path> <目标>",
}


async def _run_local(cmd: str, timeout: int = 15) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        return proc.returncode or 0, out.decode("utf-8", "replace")
    except Exception as e:
        return 1, str(e)


def _classify(fstype: str, source: str) -> str:
    """纯判定函数 (可单测): fstype+source → kind"""
    fs = (fstype or "").strip().lower()
    src = (source or "").strip().lower()
    if "zfs" in fs or src.startswith("rpool/"):
        return "zfs"
    if "ceph" in fs or "rbd" in src or "ceph" in src:
        return "rbd"
    if fs == "btrfs":
        return "btrfs"
    if src.startswith("/dev/mapper/") or src.startswith("/dev/vg") or "/dev/dm-" in src:
        return "lvm"  # thin 与否由 lvs 深挖判定
    return "dir"


def _zfs_dataset(out: str, path: str) -> str:
    """从 `zfs list -H -o name,mountpoint` 输出取最长 mountpoint 前缀的数据集名"""
    best, best_mp = "", ""
    for line in (out or "").splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            parts = line.split()
            if len(parts) != 2:
                continue
        name, mp = parts[0].strip(), parts[1].strip()
        if mp not in ("-", "") and path.rstrip("/").startswith(mp.rstrip("/")) and len(mp) > len(best_mp):
            best, best_mp = name, mp
    return best


def _lvm_thin_check(lvs_out: str, dm_name: str) -> bool:
    """lvs 输出中该卷是否 thin 段类型。lvs_out 形如 `lvname thin\\n`; dm_name 形如 `vg-lv`"""
    base = (dm_name or "").rsplit("--", 1)[-1].split("-", 1)[-1]
    for line in (lvs_out or "").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == base:
            return parts[1] in ("thin", "thin-pool")
    return False


async def detect(path: str, target=None) -> dict:
    """探测 path 所在存储栈并给出备份通道建议。target 为 SSHTarget 时走远端。"""
    p = path.rstrip("/") or "/"

    async def run(cmd: str, timeout: int = 15) -> tuple[int, str]:
        if target is not None:
            async with target.runner() as r:
                code, out, _e = await r.exec(cmd, timeout=timeout)
                return code or 0, out or ""
        return await _run_local(cmd, timeout)

    fstype, source = "", ""
    code, out = await run(f"findmnt -T {shlex.quote(p)} -n -o FSTYPE,SOURCE")
    if code == 0 and out.strip():
        parts = out.strip().split(None, 1)
        fstype = parts[0] if parts else ""
        source = parts[1] if len(parts) > 1 else ""

    kind = _classify(fstype, source)
    extra = {}

    # 深挖: zfs 数据集名
    zc, zo = await run("zfs list -H -o name,mountpoint 2>/dev/null")
    if zc == 0 and zo.strip():
        ds = _zfs_dataset(zo, p)
        if ds:
            kind = "zfs"
            extra["zfs_dataset"] = ds
    # 深挖: LVM thin
    if kind == "lvm" and source:
        dm = source.replace("/dev/mapper/", "")
        lc, lo = await run("lvs -o lv_name,segtype --noheadings 2>/dev/null")
        if lc == 0:
            thin = _lvm_thin_check(lo, dm)
            kind = "lvm-thin" if thin else "lvm"
            extra["lv"] = dm

    label, reason, snap = CHANNELS[kind]
    suggest = SUGGEST_CMDS[kind].format(dataset=extra.get("zfs_dataset", "<dataset>"))
    return {
        "path": path, "fstype": fstype, "source": source, "kind": kind,
        "channel": label, "reason": reason, "snapshot_capable": snap,
        "suggest_cmd": suggest, **extra,
    }


async def handle_storage_policy_detect(ws, data: dict):
    """D2 存储类型智能识别。params: path, host/port/user/password/key 可选 (走 SSH 远端探测)"""
    _req = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 path"})
        return
    try:
        target = None
        if data.get("host"):
            from backend.ssh_lib import SSHTarget
            target = SSHTarget.from_ws_data(data)
        r = await detect(path, target)
        scope = f"@{target.host}" if target else "@本机"
        log_operation("存储识别", f"{scope} {path} → {r['kind']} · 推荐 {r['channel']}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": f"✓ {scope} {path}: {r['fstype'] or '?'} → 推荐 {r['channel']}", **r})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"识别失败: {e}"})

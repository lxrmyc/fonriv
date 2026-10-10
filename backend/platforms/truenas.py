"""TrueNAS 平台适配 (v5.20.0 · 阶段 5)

为什么值得单独接 (而其他 NAS 只走协议)
-------------------------------------
TrueNAS / OMV / FnOS / ZimaOS 对外都暴露 SMB/NFS/SFTP/WebDAV —— 那批"当存储用"的
NAS 只需协议集成即可覆盖, 我们已有 SMB/NFS/WebDAV 通路。

但 TrueNAS 有**完整的 REST 控制面** (`/api/v2.0`), 能管池/数据集/快照/复制作业。
这与我们已有的 ZFS 备份模块能形成闭环:
    远端 TrueNAS 用 API 打快照 → 本机 ZFS 模块增量接收 → 对账账本
不必在 NAS 上开 SSH 或装任何东西。这是它区别于其他 NAS 的**唯一**价值点,
也是本模块存在的理由; 不要为了"多支持一个 NAS"而重复协议集成。

认证
----
两种都支持 (与 PVE 集合同风格):
  · API Key: `Authorization: Bearer <key>`  —— 推荐 (TrueNAS 13+/SCALE 均支持)
  · 用户名+密码: POST /api/v2.0/auth/login 换 access_token (短时效)

版本差异 (注意)
--------------
  · TrueNAS CORE 13 / SCALE 22+ 用 `/api/v2.0` (本模块)
  · 旧 FreeNAS 11 用 `/api/v1.0`, 且字段名不同 (如 `id` vs `name`) —— 未支持,
    检测到 v1 会明确报错而不是"看起来成功但结果为空"
  · `query-filters` 分页参数 SCALE 用 `limit/offset` 语义与 CORE 略有差异,
    本模块只用最小必要集 (不带 filter), 避免版本差异踩坑
"""
from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.parse
import urllib.request

from backend.platforms.base import BackupPlatform, BackupItem
from backend.platforms.linux_generic import LinuxGenericPlatform


class TrueNASPlatform(LinuxGenericPlatform):
    NAME = "truenas"
    DISPLAY = "TrueNAS"
    ICON = "🟦"
    NOTES = ("TrueNAS CORE 13 / SCALE 22+ · 推荐用 API Key 认证 "
             "(REST /api/v2.0) · 可纳管池/数据集/快照, 与 ZFS 备份闭环")

    @classmethod
    def detect(cls, probe: dict) -> int:
        score = 0
        if probe.get("is_truenas"):
            score += 90
        os_id = probe.get("os_id", "")
        # SCALE 底层是 Debian, CORE 是 FreeBSD
        if os_id in ("debian", "truenas-scale"):
            score += 5
        if "freenas" in str(probe.get("os_pretty", "")).lower():
            score += 5
        return min(score, 100)

    def collect_config_manifest(self):
        return [
            BackupItem("truenas_config", "TrueNAS 系统配置", "/data/freenas-v1.db",
                       kind="file", required=True,
                       description="核心配置库 (池/共享/用户/服务都在里面); "
                                   "也可用 REST /config/save 导出更完整的 tar"),
            BackupItem("network",   "网络配置",   "/etc/network/;/etc/netplan/", kind="dir", required=True),
            BackupItem("ssh",       "SSH 配置",   "/etc/ssh/",      kind="dir", required=True),
            BackupItem("fstab",     "挂载表",     "/etc/fstab",     kind="file", required=False,
                       description="ZFS 池多为自动挂载, OMV/Linux 更依赖此文件"),
            BackupItem("hosts",     "hosts 文件", "/etc/hosts",     kind="file", required=True),
            BackupItem("users",     "用户/密码",  "/etc/passwd;/etc/shadow;/etc/group",
                       kind="file", required=False),
            BackupItem("smb_conf",  "Samba 配置", "/etc/smb4.conf", kind="file", required=False,
                       description="SCALE 为 /etc/smb4.conf; 完整共享配置以 freenas-v1.db 为准"),
            BackupItem("zfs_snaps", "ZFS 快照清单", "zfs list -t snapshot -H -o name,used,creation",
                       kind="command_output", required=False,
                       description="只备份清单元数据; 快照本体由 ZFS 增量通路处理"),
            BackupItem("zfs_pools", "ZFS 池清单", "zpool list -H -o name,size,alloc,health",
                       kind="command_output", required=False),
            BackupItem("crontab",   "crontab",     "crontab -l",    kind="command_output", required=False),
        ]

    def workloads_hint(self):
        return ["pool", "dataset", "snapshot", "share", "user", "smb_export", "nfs_export", "docker", "systemd"]


# ═════════════════════════════════════════════════════════════
# REST 控制面客户端
# ═════════════════════════════════════════════════════════════

class TrueNASClient:
    """TrueNAS REST API (/api/v2.0) 最小可用客户端。

    只用标准库 urllib; TrueNAS 默认自签证书 → 固定不校验证书 (与 PVE 集成同策略),
    因此只应在内网使用。
    """

    def __init__(self, host: str, token: str = "", user: str = "", password: str = "",
                 port: int = 443, use_https: bool = True, timeout: int = 20):
        self.host = (host or "").strip().rstrip("/")
        self.token = (token or "").strip()
        self.user = (user or "").strip()
        self.password = password or ""
        self.port = int(port or 443)
        self.scheme = "https" if use_https else "http"
        self.timeout = timeout
        self._access = ""

    # ── 基础 ──

    def _base(self) -> str:
        return f"{self.scheme}://{self.host}:{self.port}/api/v2.0"

    @staticmethod
    def _ctx():
        c = ssl.create_default_context()
        c.check_hostname = False
        c.verify_mode = ssl.CERT_NONE
        return c

    def _headers(self) -> dict:
        h = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        elif self._access:
            h["Authorization"] = f"Bearer {self._access}"
        return h

    def login(self) -> None:
        """用户名密码 → access_token (短时效)。已在用 API Key 则跳过。"""
        if self.token or self._access:
            return
        if not (self.user and self.password):
            raise RuntimeError("缺少 API Key 或用户名/密码")
        url = self._base() + "/auth/login"
        body = json.dumps({"username": self.user, "password": self.password}).encode()
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self._ctx()) as r:
                d = json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"TrueNAS 登录失败 HTTP {e.code}: {e.reason}") from None
        self._access = d.get("access_token") or ""
        if not self._access:
            raise RuntimeError(f"TrueNAS 登录未返回 access_token: {str(d)[:160]}")

    def _req(self, method: str, path: str, body=None, params: dict = None):
        self.login()
        url = self._base() + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=self._ctx()) as r:
                raw = r.read()
            return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = (e.read() or b"").decode("utf-8", "replace")[:200]
            except Exception:
                pass
            # v1 端点明确报错, 不假装成功
            if e.code == 404:
                raise RuntimeError(
                    "TrueNAS 接口 404 — 可能是旧版 FreeNAS (仅 /api/v1.0)。"
                    "本集成只支持 CORE 13 / SCALE 22+ 的 /api/v2.0") from None
            raise RuntimeError(f"TrueNAS {method} {path} → HTTP {e.code}: {detail or e.reason}") from None

    def get(self, path, **params):
        return self._req("GET", path, params=params or None)

    def post(self, path, body=None):
        return self._req("POST", path, body=body if body is not None else {})

    # ── 只读: 池 / 数据集 / 快照 ──

    def test(self) -> tuple:
        """连通性 + 版本。返回 (ok, msg)。"""
        try:
            info = self.get("/system/info")
            ver = (info or {}).get("version", "?")
            hostname = (info or {}).get("hostname", "?")
            return True, f"TrueNAS {ver} · hostname={hostname}"
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"

    def pools(self) -> list:
        out = []
        for p in (self.get("/pool") or []):
            out.append({
                "name": p.get("name", ""),
                "status": p.get("status", ""),
                "healthy": bool(p.get("healthy")),
                "size": p.get("size") or 0,
                "allocated": p.get("allocated") or 0,
                "free": p.get("free") or 0,
                "topology": (p.get("topology") or {}).get("data", []),
            })
        return out

    def datasets(self, pool: str = "") -> list:
        out = []
        for d in (self.get("/pool/dataset") or []):
            nm = d.get("name") or d.get("id") or ""
            if pool and not nm.startswith(pool + "/") and nm != pool:
                continue
            out.append({
                "name": nm,
                "type": d.get("type", ""),
                "used": (d.get("used") or {}).get("parsed") if isinstance(d.get("used"), dict) else d.get("used"),
                "available": (d.get("available") or {}).get("parsed") if isinstance(d.get("available"), dict) else d.get("available"),
                "compression": (d.get("compression") or {}).get("value") if isinstance(d.get("compression"), dict) else d.get("compression"),
                "mountpoint": d.get("mountpoint", ""),
                "encrypted": d.get("encrypted", False),
            })
        return out

    def snapshots(self, dataset: str = "") -> list:
        q = {}
        if dataset:
            q["dataset"] = dataset
        out = []
        for s in (self.get("/zfs/snapshot", **q) or []):
            out.append({
                "id": s.get("id") or s.get("name") or "",
                "dataset": s.get("dataset", ""),
                "snapshot_name": s.get("snapshot_name", ""),
                "used": (s.get("used") or {}).get("parsed") if isinstance(s.get("used"), dict) else s.get("used"),
                "referenced": (s.get("referenced") or {}).get("parsed") if isinstance(s.get("referenced"), dict) else s.get("referenced"),
                "created": ((s.get("properties") or {}).get("creation") or {}).get("parsed")
                           or (s.get("properties") or {}).get("creation", {}).get("value")
                           if isinstance(s.get("properties"), dict) else "",
            })
        return out

    # ── 写: 打快照 / 删除快照 ──

    def create_snapshot(self, dataset: str, name: str = "", recursive: bool = False) -> dict:
        """给数据集打快照 (ZFS 闭环的第一步: 远端制备还原点)。

        name 省略时由服务端按时间戳生成, 便于对账时识别。
        """
        import time as _t
        ds = (dataset or "").strip().rstrip("/")
        if not ds:
            raise RuntimeError("缺少 dataset")
        snap = (name or ("fonriv_" + _t.strftime("%Y%m%d_%H%M%S"))).strip()
        return self.post("/zfs/snapshot", {"dataset": ds, "name": snap, "recursive": bool(recursive)})

    def delete_snapshot(self, full_id: str) -> dict:
        return self._req("DELETE", "/zfs/snapshot/id/" + urllib.parse.quote(full_id, safe=""))

    # ── 配置导出 (比只备份 freenas-v1.db 更完整) ──

    def save_config(self) -> dict:
        """POST /config/save → 返回 {job_id}。产物是完整系统配置 tar。"""
        return self.post("/config/save")

    def jobs(self) -> list:
        return self.get("/core/get_jobs") or []

    def job(self, job_id: int) -> dict:
        return self.get(f"/core/get_jobs/id/{int(job_id)}") or {}

    # ── ZFS 闭环 ──

    def snapshot_for_zfs_send(self, dataset: str, name: str = "") -> dict:
        """为 `zfs send` 增量接收制备快照, 返回可直接喂给本机 ZFS 模块的信息。

        与 backend/handlers/storage_zfs.py 的接收端配套:
          1) 这里在 TrueNAS 上打快照 (不传 -R/-X, 由接收端决定)
          2) 接收端用 zfs send <snap> | zfs receive 落地 (需 SSH 通路;
             TrueNAS 侧无需额外安装, zfs 是系统自带)
        """
        snap = self.create_snapshot(dataset, name)
        full = snap.get("id") or snap.get("name") or ""
        return {
            "ok": bool(full),
            "snapshot": full,
            "dataset": dataset,
            # 供本机 ZFS 模块拼命令: ssh <host> "zfs send -i <prev> <full>" | zfs receive
            "send_hint": (f"zfs send {full} | <本机> zfs receive <目标数据集>"),
            "raw": snap,
        }
    # v5.24.0 · ZFS 闭环: scrub 巡检 / dataset 增删 / 快照克隆 / 复制任务
    # ═════════════════════════════════════════════════════════════

    def scrub_start(self, pool: str) -> dict:
        """POST /pool/scrub → 启动巡检 (返回 {id})"""
        return self._req("POST", "/pool/scrub", body={"pool": pool})


    def scrub_status(self, pool: str = "") -> list:
        """GET /pool/scrub → 各池巡检状态 (self-test/state/progress)"""
        return self._req("GET", "/pool/scrub") or []


    def dataset_create(self, dataset: str, quota: str = "", comments: str = "") -> dict:
        """POST /pool/dataset → 建数据集 (dataset 形如 tank/backups; quota 如 100GiB)"""
        body = {"name": dataset, "type": "FILESYSTEM"}
        if quota:
            body["quota"] = quota
        if comments:
            body["comments"] = comments
        return self._req("POST", "/pool/dataset", body=body)


    def dataset_delete(self, dataset: str, recursive: bool = False) -> dict:
        """DELETE /pool/dataset/id/<name> → 删数据集 (危险: confirm 由 handler 把守)"""
        return self._req("DELETE", "/pool/dataset/id/" + urllib.parse.quote(dataset, safe=""),
                         body={"recursive": recursive})


    def snapshot_clone(self, full_id: str, clone_name: str) -> dict:
        """POST /zfs/snapshot/id/<snap>/clone → 快照克隆为可写数据集 (恢复路径)"""
        return self._req("POST", f"/zfs/snapshot/id/{urllib.parse.quote(full_id, safe='')}/clone",
                         body={"dataset_dst": clone_name})


    def replications(self) -> list:
        """GET /replication/list/policies 或 replication 任务 — 只读展示"""
        try:
            return self._req("GET", "/replication/list/policies") or []
        except Exception:
            return []


def system_info(self) -> dict:
    """GET /system/info → 版本/主机名/ uptime 等 (v5.28.0 · 控制面板系统信息)"""
    try:
        return self._req("GET", "/system/info") or {}
    except Exception:
        return {}


def disks(self) -> list:
    """GET /disk → 物理盘列表 (只读展示)"""
    try:
        return self._req("GET", "/disk") or []
    except Exception:
        return []

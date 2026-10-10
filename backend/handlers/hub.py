"""Fonriv · 统一资源目录 (Resource Hub) — v5.50.0 P0-5

把「SSH 档案 / 云存储(远端) / 网络共享」聚合为**统一节点(Node)视图**, 供连接中心统一展示与调用,
消除"多个页面找资源、各页面各自维护服务器列表"的不一致。

设计取舍(见 docs/Fonriv_架构升级与下一步开发路线_v1.md §1):
  * 不合并数据表: server_profiles / remote_configs / shares 各自保留, 本模块只做**只读聚合**
  * 节点唯一键 = guid (档案 guid / 远端 uuid / 共享 uuid) → 前端按 guid 刷新列表行
  * 连接语义按 kind 区分(会话/无状态/挂载), 由 caps.conn_semantics 声明, 不在前端硬编码判断

暴露 action:
  hub_nodes     → {nodes:[...], kinds:{...}, msg}      统一节点列表 (默认 ssh+cloud+share)
  hub_node      → {node:{...}}                         单节点详情
  events_replay → {events:[...], seq, msg}             事件总线断线补拉 (P1-7, 按 seq 游标)
  events_stats  → {schema_version, seq, topics, ...}   事件总线健康度
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import WebSocket

from backend import db as _db
from backend import events as _events

# ── 连接语义: UI 上统一为「连接/断开」, 后端行为按类型不同 ───────────────────
CONN_SEMANTICS = {
    "ssh": "session",      # 长会话: ControlMaster + TTL (conn_open/conn_close)
    "cloud": "stateless",  # 无状态: 每次请求带凭据 → "连接"=凭据校验+会话缓存
    "share": "mount",      # 挂载态: share_mount / share_umount
}


def _sess_of(ws) -> Dict[str, Any]:
    """取当前 ws 的会话身份 (user_id/role); 取不到按匿名处理"""
    try:
        from backend.ws import active_sessions
        return dict(active_sessions.get(ws) or {})
    except Exception:
        return {}


def _uid_role(ws) -> tuple:
    s = _sess_of(ws)
    try:
        uid = int(s.get("user_id") or 1)
    except Exception:
        uid = 1
    return uid, (s.get("role") or "user")


def _cloud_caps(provider: str) -> Dict[str, Any]:
    """云存储能力位 (单一真源 backend/fonrvfs/caps.py), 失败返回最小集"""
    try:
        from backend.fonrvfs.caps import caps_for
        c = caps_for((provider or "").lower())
        if c is None:
            return {}
        out = {}
        for k in ("read", "write", "delete", "share", "versions", "server_side_copy",
                  "server_side_move", "range_read", "multipart", "mountable"):
            try:
                out[k] = bool(getattr(c, k))
            except Exception:
                pass
        return out
    except Exception:
        return {}


# ═══ v5.61.0 E5 · 连接中心统一资源: 节点 = 一台资源 + **多能力** ═══
#   单一真源: 能力清单来自 ①档案 protocols JSON 中 enabled 的块 ②ssh ③关联的 remote_uuid/share_id;
#   每个能力自带「去哪个面板使用」(panel) —— 前端不再硬编码"什么能力开什么页"。
#   连接语义仍由 caps.conn_semantics 声明(session/stateless/mount), 不按类型名硬判。
CAP_PANELS = {
    "share": "shares",
    "ssh": "transfer", "smb": "shares", "nfs": "shares", "afp": "shares", "webdav": "shares",
    "remote_storage": "remotes", "object_storage": "remotes", "private_cloud": "remotes",
    "rclone_remote": "remotes", "ftp": "remotes",
    "rdp": "rdp_console", "vnc": "vnc_direct", "pve_api": "proxmox", "pve_console": "pve_console",
    "docker": "docker", "truenas": "truenas", "database": "dbbackup",
    "remote_disk": "disk_manager", "kubernetes": "docker", "pbs": "pbs",
}
CAP_LABELS = {
    "ssh": "SSH", "smb": "SMB/CIFS", "nfs": "NFS", "afp": "AFP", "webdav": "WebDAV",
    "remote_storage": "远端存储", "object_storage": "对象存储", "private_cloud": "私有云",
    "rclone_remote": "rclone", "ftp": "FTP",
    "rdp": "RDP", "vnc": "VNC", "pve_api": "PVE API", "pve_console": "PVE 控制台",
    "docker": "Docker", "truenas": "TrueNAS", "database": "数据库",
    "remote_disk": "远端磁盘", "kubernetes": "K8s", "pbs": "PBS",
}
# 明细里只带**非敏感**字段(凭据一律不出网); 这些字段供前端展示与"跳转后定位"
CAP_SAFE_FIELDS = ("host", "port", "url", "endpoint", "bucket", "region", "provider", "type",
                   "proto", "share", "path", "user", "os_type", "context", "db_type",
                   "devices", "exports", "shares", "enabled")


def _cap_detail(cap: str, block: dict) -> dict:
    out = {"panel": CAP_PANELS.get(cap, ""), "label": CAP_LABELS.get(cap, cap.upper())}
    if isinstance(block, dict):
        for k in CAP_SAFE_FIELDS:
            if k in block and k != "enabled":
                v = block.get(k)
                if isinstance(v, str) and len(v) > 200:
                    v = v[:200]
                out[k] = v
    return out


def _caps_of_profile(d: dict) -> dict:
    """从一个档案行算出它**实际可用**的能力清单(含明细)。"""
    caps = {}
    if d.get("hostname"):
        caps["ssh"] = _cap_detail("ssh", {"host": d.get("hostname"), "port": d.get("ssh_port") or 22,
                                           "user": d.get("ssh_user") or "root"})
    # protocols JSON 里 enabled 的能力块
    try:
        from backend.handlers.server_profile import _parse_protocols
        proto = _parse_protocols(d.get("protocols"))
    except Exception:
        proto = {}
    for k, blk in (proto or {}).items():
        try:
            if not isinstance(blk, dict) or not blk.get("enabled"):
                continue
        except Exception:
            continue
        key = "remote_storage" if k in ("object_storage",) else k
        caps[key] = _cap_detail(key, blk)
    # 关联的云存储 / 网络共享(档案上的外键)
    if d.get("remote_uuid"):
        caps["remote_storage"] = _cap_detail("remote_storage", {"endpoint": "", "provider": ""})
    if d.get("share_id"):
        caps["smb"] = _cap_detail("smb", {})
    return caps


def _probe_of(guid):
    """v5.93.0 · 探测台账读取 (未探测 → None, 绝不回落成 online)。"""
    try:
        from backend.handlers import conn_probe as _cp
        return _cp.probe_state(guid)
    except Exception as e:
        print("[hub] probe_state fail: %s" % e)
        return None


def _reach_from_probe(guid):
    """台账结论 → reachable 三态: online=True / offline=False / 未探测=None。"""
    st = _probe_of(guid)
    if not st:
        return None
    return True if st.get("status") == "online" else (
        False if st.get("status") == "offline" else None)


def _probe_at(guid):
    """探测结论的时间戳(epoch 秒); 无结论 → 0。"""
    st = _probe_of(guid) or {}
    try:
        return float(st.get("at") or 0)
    except (TypeError, ValueError):
        return 0.0


def _mounted_ts(row):
    """last_mounted_at('YYYY-MM-DD HH:MM:SS' 本地时间) → epoch; 缺失/解析失败 → 0。"""
    s = str((row or {}).get("last_mounted_at") or "").strip()
    if not s:
        return 0.0
    import time as _t
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            return _t.mktime(_t.strptime(s, fmt))
        except ValueError:
            continue
    return 0.0


def _share_reach(mnt, row, guid):
    """v5.97.4 · 共享节点三态判定 (用户 2026-09-27 定夺)。

    规则: 未挂载 → 用探测台账结论; 已挂载 → 默认 True(挂上即可达),
    **但探测结论比挂载时间更新时以探测为准** —— 否则"陈挂载(CIFS 已死)+ 主机不可达"
    会一直显示可达, 与实际不符(实测 win10-192: mounted 但 NT_STATUS_HOST_UNREACHABLE)。
    """
    reach = _reach_from_probe(guid)
    if not mnt:
        return reach
    if _probe_at(guid) > _mounted_ts(row) + 1:      # +1s 容忍同秒
        return reach
    return True


def _ssh_nodes(uid: int, admin: bool, with_session: bool = True) -> List[Dict[str, Any]]:
    conn = _db.get_conn()
    if admin:
        rows = conn.execute(
            "SELECT guid, name, hostname, ssh_port, ssh_user, group_id, tags, is_starred, kind, "
            "protocols, remote_uuid, share_id "
            "FROM server_profiles ORDER BY is_starred DESC, sort_order, name").fetchall()
    else:
        rows = conn.execute(
            "SELECT guid, name, hostname, ssh_port, ssh_user, group_id, tags, is_starred, kind, "
            "protocols, remote_uuid, share_id "
            "FROM server_profiles WHERE user_id=? ORDER BY is_starred DESC, sort_order, name",
            (uid,)).fetchall()
    sessions = {}
    if with_session:
        try:
            from backend import conn_registry
            for s in (conn_registry.list_sessions() or []):
                sessions[(s.get("host"), str(s.get("port")), s.get("user"))] = s
        except Exception:
            sessions = {}
    out = []
    for r in rows:
        d = dict(r)
        st = sessions.get((d.get("hostname"), str(d.get("ssh_port") or 22), d.get("ssh_user") or "root"))
        _caps = _caps_of_profile(d)
        _cap_names = list(_caps.keys())
        out.append({
            "guid": d.get("guid"),
            "kind": "ssh",
            "caps_list": _cap_names,
            "caps_detail": _caps,
            "label": d.get("name") or d.get("hostname"),
            "sub": "%s:%s" % (d.get("hostname"), d.get("ssh_port") or 22),
            "group_id": d.get("group_id"),
            "tags": d.get("tags") or "",
            "starred": bool(d.get("is_starred")),
            "endpoint": {"host": d.get("hostname"), "port": d.get("ssh_port") or 22,
                         "user": d.get("ssh_user") or "root"},
            "caps": {"conn_semantics": CONN_SEMANTICS["ssh"], "list": _cap_names},
            # v5.93.0 · 会话为准; 无会话时用探测台账里最近一次结论(未探过仍是 None, 界面显式标"未探测")
            "state": {"session": bool(st), "session_id": (st or {}).get("session_id"),
                      "reachable": True if st else _reach_from_probe(d.get("guid")),
                      "probe": _probe_of(d.get("guid"))},
        })
    return out


def _cloud_nodes(uid: int, admin: bool) -> List[Dict[str, Any]]:
    try:
        rows = _db.remote_list(user_id=None if admin else uid, mask_secret=True)
    except Exception as e:
        print("[hub] remote_list fail: %s" % e)
        return []
    out = []
    for r in rows:
        prov = (r.get("provider") or r.get("type") or "").lower()
        caps = _cloud_caps(prov)
        caps["conn_semantics"] = CONN_SEMANTICS["cloud"]
        extra = r.get("extra") or {}
        endpoint = r.get("endpoint") or extra.get("endpoint") or ""
        bucket = r.get("bucket") or extra.get("bucket") or ""
        sub = prov + (" · " + endpoint if endpoint else "")
        if bucket:
            sub += "/" + str(bucket)
        out.append({
            "guid": r.get("uuid") or ("remote:%s" % r.get("id")),
            "kind": "cloud",
            "label": r.get("name") or r.get("label") or prov,
            "sub": sub,
            "remote_id": r.get("id"),
            "provider": prov,
            "group_id": None,
            "tags": r.get("tags") or "",
            "starred": False,
            "endpoint": {"provider": prov, "endpoint": endpoint, "bucket": bucket},
            "caps": caps,
            # 注意: 只放**能力名**(可映射到面板), 不放协议的布尔位(read/write/delete/... 属"能力位",
            #   仍留在 caps 里供详情展示) —— 否则能力计数与「去使用」会被这些旗标刷屏。
            "caps_list": ["remote_storage"],
            "caps_detail": {"remote_storage": _cap_detail("remote_storage",
                                                          {"provider": prov, "endpoint": endpoint,
                                                           "bucket": bucket})},
            # v5.93.0 · FIX(用户报"Seafile 没有绿点"): 此前恒 None → 前端恒灰。
            #   现在下发最近一次真实探测结论(remote_test 记录), 未探测仍为 None。
            "state": {"reachable": _reach_from_probe(r.get("uuid") or ("remote:%s" % r.get("id"))),
                      "session": False,
                      "probe": _probe_of(r.get("uuid") or ("remote:%s" % r.get("id")))},
        })
    return out


def _pool_nodes(uid: int, admin: bool) -> List[Dict[str, Any]]:
    """v6.13.0 · 批13(用户要求: 云存储池状态加入连接中心): 池作为**统一资源节点**下发。

    状态口径(与 CloudPool §51 一致, 不造绿点):
      - 成员 disabled 或 DETACHED(已脱离池) 不计入"在池成员";
      - 在池成员 = 0 → **不给 probe**(灰点, 前端显式"未探测/无成员");
      - 全部在池成员都异常(OFFLINE/QUARANTINED/FENCED…) → offline;
      - 部分异常 → degraded(黄);
      - 其余(ONLINE/未探针的 ACTIVE 等) → online(绿)。
      另附 summary(n/health/degraded) 与容量说明(有则带, 无则如实空)。
    """
    out: List[Dict[str, Any]] = []
    try:
        import os as _os
        import sqlite3 as _sq
        from backend import db as _dbb
        # cloudpool 独立库
        _cp_db = getattr(_dbb, "CPOOL_DB_PATH", None) or _os.path.join(
            _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))),
            "data", "cloudpool.db")
        conn = _sq.connect(_cp_db)
        conn.row_factory = _sq.Row
        try:
            pools = conn.execute("SELECT id, name, created_at FROM pools ORDER BY created_at").fetchall()
            for pr in pools:
                pid = str(pr["id"])
                rows = conn.execute(
                    "SELECT status, enabled FROM members WHERE pool_id=?", (pid,)).fetchall()
                live = [r for r in rows if int(r["enabled"] or 0) == 1 and (r["status"] or "") != "DETACHED"]
                bad = [r for r in live if (r["status"] or "").upper() in
                       ("OFFLINE", "QUARANTINED", "FENCED", "DEGRADED", "DRAINING")]
                n_live, n_bad = len(live), len(bad)
                probe = None
                note = ""
                if n_live == 0:
                    note = "池内暂无在池成员(去「存储池」页添加)"
                elif n_bad == 0:
                    probe = {"status": "online"}
                    note = "成员 %d/%d 正常" % (n_live - n_bad, n_live)
                elif n_bad < n_live:
                    probe = {"status": "degraded"}
                    note = "成员 %d/%d 正常(%d 异常)" % (n_live - n_bad, n_live, n_bad)
                else:
                    probe = {"status": "offline"}
                    note = "全部 %d 个成员异常" % n_live
                out.append({
                    "guid": "cloudpool:" + pid,
                    "kind": "cloudpool",
                    "label": str(pr["name"] or pid),
                    "sub": "成员 %d · %s" % (len(rows), note),
                    "pool_id": pid,
                    "group_id": None,
                    "tags": "",
                    "starred": False,
                    "caps": {"conn_semantics": "stateless"},
                    "caps_list": ["cloudpool"],
                    "caps_detail": {"cloudpool": {"label": "智能存储池", "pool_id": pid}},
                    "state": {"probe": probe, "session": False,
                              "note": note, "members": len(rows), "live": n_live},
                })
        finally:
            conn.close()
    except Exception as e:
        print("[hub] pool nodes fail: %s" % e)
    return out


def _share_nodes(uid: int, admin: bool) -> List[Dict[str, Any]]:
    try:
        rows = _db.share_list() or []
    except Exception as e:
        print("[hub] share_list fail: %s" % e)
        return []
    active = {}
    try:
        from backend.handlers.share import _active_share_mounts as active  # type: ignore
    except Exception:
        active = {}
    out = []
    for r in rows:
        u = r.get("uuid") or ("share:%s" % r.get("id"))
        mnt = (active or {}).get(u, {}).get("mnt") if isinstance(active, dict) else None
        proto = (r.get("proto") or r.get("protocol") or r.get("type") or "").lower()
        out.append({
            "guid": u,
            "kind": "share",
            "label": r.get("name") or r.get("label") or ("%s://%s" % (proto, r.get("host") or "")),
            "sub": "%s://%s%s" % (proto, r.get("host") or "", r.get("path") or r.get("share") or ""),
            "share_id": r.get("id"),
            "provider": proto,
            "group_id": None,
            "tags": "",
            "starred": False,
            "endpoint": {"proto": proto, "host": r.get("host"), "path": r.get("path") or r.get("share")},
            "caps": {"conn_semantics": CONN_SEMANTICS["share"], "mountable": True},
            "caps_list": [proto or "smb"],
            "caps_detail": {(proto or "smb"): _cap_detail(proto or "smb",
                                                          {"host": r.get("host"),
                                                           "share": r.get("share") or r.get("path"),
                                                           "path": mnt})},
            # v5.93.0 · 挂载态为准(挂上即在线); 未挂载则用最近一次 share_test 的结论
            # v5.97.4 · 但探测结论比挂载更新时以探测为准(陈挂载 + 主机不可达 不再谎报可达)
            "state": {"mounted": bool(mnt), "mnt": mnt, "session": False,
                      "reachable": _share_reach(mnt, r, u),
                      "probe": _probe_of(u)},
        })
    return out


async def handle_hub_nodes(ws: WebSocket, data: dict):
    """统一资源目录: 聚合 SSH 档案 / 云存储 / 网络共享 / 存储池(v6.13.0)。
    params: kinds("ssh,cloud,share,cloudpool", 默认全部), include_ssh(bool 默认 True)"""
    _req = data.get("req_id") or ""
    uid, role = _uid_role(ws)
    admin = role == "admin"
    want = str(data.get("kinds") or "ssh,cloud,share,cloudpool").lower()
    # v6.13.0 · 批13 FIX: 子串匹配会把 "cloudpool" 误当 "cloud" → 改精确集合
    _want = set(x.strip() for x in want.split(",") if x.strip())
    _only = str(data.get("guid") or "").strip()          # v5.61.0 E5 · 定向刷新单节点
    nodes: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {}
    try:
        if "ssh" in _want and data.get("include_ssh", True):
            n = _ssh_nodes(uid, admin)
            nodes += n
            counts["ssh"] = len(n)
        if "cloud" in _want:
            n = _cloud_nodes(uid, admin)
            nodes += n
            counts["cloud"] = len(n)
        if "share" in _want:
            n = _share_nodes(uid, admin)
            nodes += n
            counts["share"] = len(n)
        if "cloudpool" in _want:            # v6.13.0 · 批13: 存储池节点(状态=成员健康汇总)
            n = _pool_nodes(uid, admin)
            nodes += n
            counts["cloudpool"] = len(n)
        if _only:
            nodes = [x for x in nodes if x.get("guid") == _only]
        # 能力计数(前端可显示"其中 N 台支持 RDP"等)
        cap_counts: Dict[str, int] = {}
        for _x in nodes:
            for _c in (_x.get("caps_list") or []):
                if CAP_PANELS.get(_c):            # 只统计能"去使用"的真能力
                    cap_counts[_c] = cap_counts.get(_c, 0) + 1
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "nodes": nodes, "kinds": counts, "cap_counts": cap_counts,
                            "by_guid": bool(_only),
                            "msg": "共 %d 个资源 (主机 %d / 云 %d / 共享 %d / 池 %d)"
                                   % (len(nodes), counts.get("ssh", 0), counts.get("cloud", 0),
                                      counts.get("share", 0), counts.get("cloudpool", 0))})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "聚合资源失败: %s" % e})


async def handle_events_replay(ws: WebSocket, data: dict):
    """v5.50.0 · 事件总线断线补偿: 返回 seq > since_seq 的最近事件 (P1-7)。
    params: since_seq(int), limit(int=500)"""
    _req = data.get("req_id") or ""
    try:
        since = int(data.get("since_seq") or 0)
    except Exception:
        since = 0
    try:
        limit = int(data.get("limit") or 500)
    except Exception:
        limit = 500
    evs = _events.replay(since, limit)
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "events": evs, "seq": _events._evt_seq,
                        "msg": "补发 %d 条 (游标 %d → %d)" % (len(evs), since, _events._evt_seq)})


async def handle_events_stats(ws: WebSocket, data: dict):
    """v5.50.0 · 事件总线健康度 (投递可观测)"""
    _req = data.get("req_id") or ""
    st = _events.event_stats()
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, **st})

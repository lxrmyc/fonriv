"""Fonriv · v4.39.0 Phase 2a handlers.share: 网络共享配置 + 挂载/卸载

支持协议：SMB(CIFS) / NFS / AFP / WebDAV

挂载点命名空间：/var/lib/fonriv_mounts/shares/<uuid>
- 所有挂载是本机操作（不走 SSH），共享协议本身就是网络协议
- 挂载后是本机路径，传输走 direction='local'（v4.38.41 修复）

WS action:
  - share_list       列出所有共享配置
  - share_save       新增/编辑共享配置
  - share_delete     删除共享配置
  - share_mount      挂载共享到本机
  - share_umount     卸载共享
  - share_test       测试连通性（不挂载）
  - share_plugin_check  检测本机是否装了 cifs-utils/nfs-common 等
"""
from __future__ import annotations

import asyncio
import os
import shlex as _shlex
shlex = _shlex            # v5.16.0 · 新处理器直接用 shlex 命名
import shutil
import time

from fastapi import WebSocket, WebSocketDisconnect

from backend.log import log_operation

SHARE_MOUNT_ROOT = "/var/lib/fonriv_mounts/shares"

# 内存表：{share_uuid: {mnt, proto, host, ts}}
_active_share_mounts: dict = {}

# 每协议默认端口
_DEFAULT_PORT = {
    "smb": "445",
    "nfs": "2049",
    "afp": "548",
    "webdav": "443",
}

# 每协议所需二进制 + apt 包
_SHARE_PLUGIN_CHECKS = {
    "smb":    ("mount.cifs",  "cifs-utils"),
    "nfs":    ("mount.nfs",   "nfs-common"),
    "afp":    ("mount.afp",   "afpfs-ng-utils"),
    "webdav": ("mount.davfs", "davfs2"),
}


def _share_mnt(share_uuid: str) -> str:
    """挂载点路径：/var/lib/fonriv_mounts/shares/<uuid>"""
    return f"{SHARE_MOUNT_ROOT}/{share_uuid}"


def _unq(s: str) -> str:
    """shlex.quote 后取回原始字符串。

    注意：不能写 _shlex.quote(s)[1:-1] —— Python 对纯安全字符串
    （如 'admin'）不加引号，[1:-1] 会误删首尾字符（'admin'->'dmi'）。
    这里仅当 quote 确实加了引号时才剥离。
    """
    if not s:
        return ''
    q = _shlex.quote(s)
    if len(q) >= 2 and q[0] == "'" and q[-1] == "'":
        return q[1:-1]
    return q


async def _local_exec(cmd: str, timeout: int = 30) -> tuple:
    """本机执行命令 · 返回 (code, stdout+stderr)"""
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            out_s = (out or b"").decode("utf-8", errors="replace")
            return proc.returncode, out_s
        except asyncio.TimeoutError:
            proc.kill()
            return 124, "超时"
    except FileNotFoundError as e:
        return 127, str(e)
    except Exception as e:
        return 1, str(e)


async def _probe_rw(mnt: str, timeout: int = 8) -> tuple:
    """v4.40.0 · 探测挂载点实际读写能力（真实写入测试，非 mount option 推断）

    在挂载点根写临时探测文件 .rw_probe_<pid>_<ts>：
      - 写入+删除成功            -> ('rw', '')           实际可写
      - EROFS/EACCES/EPIPE 等失败 -> ('ro', '原因')       实际只读 (服务器 ACL 限制等)
      - 超时/其他异常            -> ('unknown', '原因')   NFS 硬超时等
    只读配置 (s.ro=1) 直接返回 ro 不做写入。探测文件名固定前缀，杜绝覆盖数据。
    """
    probe = os.path.join(mnt, f".rw_probe_{os.getpid()}_{int(time.time())}")
    try:
        with open(probe, "w") as f:
            f.write("fonriv rw probe")
        os.remove(probe)
        return "rw", ""
    except PermissionError as e:
        return "ro", f"写入被拒绝 ({e.__class__.__name__})"
    except OSError as e:
        # EROFS=30 只读文件系统; EACCES=13 权限; EIO=5 NFS stale; EPIPE/EINVAL 网络共享常见
        if e.errno in (30, 13, 1, 5, 32, 22):
            return "ro", f"{e.__class__.__name__}[{e.errno}]"
        return "unknown", f"{e.__class__.__name__}[{e.errno}]"
    except Exception as e:
        return "unknown", f"{e.__class__.__name__}"


def _rw_label(rw_state: str) -> str:
    """v4.40.0 · rw 状态 -> 中文标签"""
    return {"rw": "读写", "ro": "只读", "unknown": "未知"}.get(rw_state, "未知")


# v5.90.2 · 伪文件系统 fstype (不参与"挂载点"选择)
_PSEUDO_FSTYPE = frozenset((
    "tmpfs", "devtmpfs", "squashfs", "overlay", "ramfs", "efivarfs", "proc", "sysfs",
    "cgroup", "cgroup2", "devpts", "mqueue", "hugetlbfs", "fusectl", "tracefs", "debugfs",
    "securityfs", "pstore", "binfmt_misc", "autofs", "configfs", "rpc_pipefs", "nsfs", "bpf",
    "fuse.gvfsd-fuse", "fuse.portal",
))
_PSEUDO_PREFIX = ("/sys", "/proc", "/dev", "/run/credentials", "/run/user")


async def _mount_rows_fast(per_timeout: int = 3, with_size: bool = True) -> list:
    """v5.90.2 · 快速枚举本机实挂载点: findmnt 秒出清单 + **逐个** df 短超时取容量。

    背景(本机实测, 2026-09-24): 存在一个**已断线的 CIFS 挂载**
    (`.../shares/... → //192.168.1.192/win10`, 对端已关机), 全量 `df` 会**阻塞 40s**。
    旧实现 `df -PB1 ... | timeout=8/10` 必然超时 → ① 挂载点列表恒为空 (选择器 df 页空白、
      备份保存路径选不到本机盘) ② 登录后 share_list / mounts_list 各卡 8~12s, 前端表现为
      "左侧服务器/文件列表加载慢"(同期 WS 还会被拖断)。
    新做法: `findmnt -rn` 取清单(0.1s), 再对每个挂载点并发 `df -PB1 -- <mnt>` (每条 3s 上限),
      卡住的挂载点标记 `unresponsive=True` 并跳过容量, 不再拖住整体。

    返回 [{mount, source, fstype, options, total, used, avail, use_pct, readonly, unresponsive}]
    """
    try:
        _, fmo = await _local_exec("findmnt -rn -o TARGET,FSTYPE,OPTIONS,SOURCE 2>/dev/null || true",
                                  timeout=8)
    except Exception:
        return []
    cands = []
    for ln in (fmo or "").splitlines():
        p = ln.split(None, 3)
        if len(p) < 3:
            continue
        tgt, fstype, opts = p[0], p[1], p[2]
        src = p[3] if len(p) > 3 else ""
        if fstype.lower() in _PSEUDO_FSTYPE:
            continue
        if any(tgt == x or tgt.startswith(x + "/") for x in _PSEUDO_PREFIX):
            continue
        cands.append({"mount": tgt, "fstype": fstype, "options": opts, "source": src})

    async def _size(tgt: str):
        try:
            _, out = await _local_exec(
                "df -PB1 -- %s 2>/dev/null | tail -n +2 || true" % _shlex.quote(tgt), timeout=per_timeout)
        except Exception:
            return None
        for line in (out or "").splitlines():
            parts = line.split()
            if len(parts) >= 6:
                return parts
        return None

    # v6.16.15 · with_size=False: 只要挂载点清单(挂载态判定用), 不做逐盘 df(省 ~3s)
    if not with_size:
        for c in cands:
            c.update({"total": None, "used": None, "avail": None, "use_pct": "", "unreadable": False})
        return [{"mount": c["mount"], "source": c["source"], "fstype": c["fstype"], "options": c["options"],
                 "readonly": ("ro" in (c["options"].split(",") if c["options"] else [])),
                 "total": None, "used": None, "avail": None, "use_pct": "", "unresponsive": False} for c in cands]
    got = await asyncio.gather(*[_size(c["mount"]) for c in cands], return_exceptions=True)
    rows = []
    for c, parts in zip(cands, got):
        opts = c["options"] or ""
        row = {"mount": c["mount"], "source": c["source"], "fstype": c["fstype"],
               "options": opts, "readonly": "ro" in (opts.split(",") if opts else []),
               "total": None, "used": None, "avail": None, "use_pct": "", "unresponsive": False}
        if isinstance(parts, list):
            row["total"] = int(parts[1]) if parts[1].isdigit() else None
            row["used"] = int(parts[2]) if parts[2].isdigit() else None
            row["avail"] = int(parts[3]) if parts[3].isdigit() else None
            row["use_pct"] = parts[4]
        else:
            row["unresponsive"] = True     # 挂载点无响应 (对端关机/网络断) — 明确标记, 不静默当 0
        rows.append(row)
    return rows


async def _local_df_mounts() -> list:
    """v4.39.3 · 本机 df 挂载点列表 (SHARE_MOUNT_ROOT 下的网络共享 + 其他实挂载)
    返回 [{mount, source, total, used, avail, use_pct, options, readonly}]
    供前端 __dmDfMounts 合并，让共享挂载后立即出现在文件传输/DM 的 df 下拉中。
    v5.90.2 · 改用 _mount_rows_fast (全量 df 会被断线挂载阻塞 40s → 旧实现恒超时返回空)。
    """
    rows = await _mount_rows_fast()
    return [{"mount": r["mount"], "source": r["source"], "total": r["total"], "used": r["used"],
             "avail": r["avail"], "use_pct": r["use_pct"], "options": r["options"],
             "readonly": r["readonly"]}
            for r in rows if r["mount"].startswith(SHARE_MOUNT_ROOT + "/")]


# v4.40.0 · 持久挂载 (取代 v4.39.4 的 WS 会话追踪):
#   共享与 WS 会话生命周期解耦 -- "配置好就一直连接, 用户随时调用" (与远端存储一致):
#   · 服务启动 -> 自动挂载 last_status='ok' 的共享 (app.py startup 调 share_remount_all)
#   · 用户挂载成功 -> last_status='ok' (重启后自动恢复)
#   · 用户主动卸载 -> last_status='idle' (重启后不再自动挂载, 但配置保留)
#   · WS 断开不再卸载 (旧 on_share_ws_disconnect 已废弃删除)
async def share_remount_all() -> list:
    """v4.40.0 · 服务启动时自动重挂 last_status='ok' 的共享 (持久挂载)"""
    results = []
    try:
        from backend import db as _db
        rows = _db.share_list()
        for r in rows:
            uid = r.get('uuid') or ''
            if r.get('last_status') != 'ok':
                continue
            ok, msg = await _do_mount(r)   # _do_mount 幂等: 已挂载(findmnt)直接返回 ok
            rw_state, rw_reason = "", ""
            if ok:
                # v4.40.0 · 启动恢复挂载也做读写探测 (写日志供用户排查)
                if r.get('ro'):
                    rw_state, rw_reason = "ro", "配置为只读挂载"
                else:
                    rw_state, rw_reason = await _probe_rw(_share_mnt(uid))
                _st = _active_share_mounts.get(uid) or {}
                _st['rw'] = rw_state
                _st['rw_reason'] = rw_reason
                _active_share_mounts[uid] = _st
                _db.share_update_status(uid, 'ok', time.strftime('%Y-%m-%d %H:%M:%S'))
            results.append({'uuid': uid, 'name': r.get('name', ''), 'ok': ok,
                            'msg': msg, 'rw': rw_state, 'rw_reason': rw_reason})
        if results:
            ok_n = sum(1 for x in results if x['ok'])
            log_operation("网络共享", "服务启动自动挂载",
                          f"{ok_n}/{len(results)} 成功"
                          + ("".join(f" · {x['name']}={_rw_label(x.get('rw',''))}" for x in results if x['ok']) if ok_n else ""))
    except Exception as e:
        print(f"[share] remount_all fail: {e}")
    return results


async def handle_share_list(ws: WebSocket, data: dict, task_id: str = ""):
    """列出所有共享配置（密码已解密）"""
    # v5.90.2 · 显式带 req_id: 本动作已改 ROUTE_TASK 异步派发, 派发后主循环立即把
    #   ws._current_req_id 清空 → 靠猴补丁 echo req_id 的老机制会失效(前端无法关联响应)
    _req = data.get("req_id") or ""
    try:
        from backend import db as _db
        rows = _db.share_list()
        # 补充挂载状态
        # v6.16.15 · FIX(用户实测: 网络共享界面"一直加载/刷新中, 没有列表"): 此前**每个共享各跑一次
        #   findmnt**(单条 5s 上限且串行) —— 挂载点不可达(对端关机/网络断)时逐个累加, share_list
        #   几十秒不返回, 前端一直转圈。现改为**一次**读挂载表(findmnt -rn, ~0.1s)做集合判定。
        try:
            _mtset = {m["mount"] for m in await _mount_rows_fast(with_size=False)}
        except Exception as _e:
            _mtset = set()
            log_operation("网络共享", "挂载表读取失败(按未挂载显示)", str(_e)[:120])
        for r in rows:
            uid = r.get('uuid') or ''
            # v4.39.4 · 检查实际 OS 挂载状态, 服务重启后内存态丢失但 OS 层仍挂载
            if uid in _active_share_mounts:
                r['mounted'] = True
                r['mnt'] = _active_share_mounts[uid]['mnt']
            else:
                mnt = _share_mnt(uid)
                if mnt in _mtset:
                    # OS 层已挂载 -> 同步进 _active_share_mounts
                    _active_share_mounts[uid] = {'mnt': mnt, 'proto': r.get('proto',''), 'host': r.get('host',''), 'ts': time.time()}
                    r['mounted'] = True
                    r['mnt'] = mnt
                else:
                    r['mounted'] = False
                    r['mnt'] = ''
            # v4.40.0 · rw 状态: 优先取内存缓存, 缓存缺失时按配置推断
            _st = _active_share_mounts.get(uid) or {}
            r['rw'] = _st.get('rw', 'unknown')
            r['rw_reason'] = _st.get('rw_reason', '')
            r['rw_label'] = _rw_label(r.get('rw', 'unknown'))
        # v4.39.3 · 返回本机 df 挂载点列表，前端据此更新 __dmDfMounts
        #   让已挂载的共享在页面打开时即出现在 df 下拉中
        df_mounts = await _local_df_mounts()
        await ws.send_json({
            "type": "result", "status": "ok", "req_id": _req, "shares": rows,
            "df_mounts": df_mounts
        })
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": str(e)[:300]})


async def handle_share_auto_remount(ws: WebSocket, data: dict, task_id: str = ""):
    """v4.40.0 · 登录后自动重挂 last_status='ok' 的共享 (持久挂载 · 与 WS 会话解耦)

    服务启动时已由 app.py startup -> share_remount_all() 自动挂载。
    登录时再跑一遍做兜底 (服务运行期间 OS 层被外部卸载的场景),
    返回 df_mounts 供前端刷新 __dmDfMounts。
    """
    _req = data.get("req_id") or ""      # v5.90.2 · 异步派发后必须显式带 req_id (同上)
    try:
        remounted = await share_remount_all()
        log_operation("网络共享", "登录自动重挂(兜底)", f"{len(remounted)} 个共享")
        df_mounts = await _local_df_mounts()
        await ws.send_json({
            "type": "result", "status": "ok", "req_id": _req,
            "remounted": remounted,
            "df_mounts": df_mounts
        })
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": str(e)[:300]})


async def handle_share_save(ws: WebSocket, data: dict):
    """新增或编辑共享配置"""
    try:
        from backend import db as _db
        uuid = (data.get("uuid") or "").strip()
        # 校验必填
        name = (data.get("name") or "").strip()
        proto = (data.get("proto") or "smb").strip().lower()
        host = (data.get("host") or "").strip()
        share = (data.get("share") or "").strip()
        if not name:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": "名称不能为空"})
            return
        if proto not in _DEFAULT_PORT:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": f"不支持的协议: {proto}"})
            return
        if not host:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": "主机地址不能为空"})
            return
        if not share:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": "共享名/路径不能为空"})
            return
        # 组装数据
        save_data = {
            'name': name,
            'color': (data.get("color") or 'var(--blue)').strip(),
            'proto': proto,
            'host': host,
            'port': (data.get("port") or '').strip() or _DEFAULT_PORT.get(proto, ''),
            'share': share,
            'path': (data.get("path") or '').strip(),
            'user': (data.get("user") or '').strip(),
            'auth_type': (data.get("auth_type") or 'pass').strip().lower(),
            'auth_value': (data.get("auth_value") or '').strip(),  # 明文入，DB 层加密
            'domain': (data.get("domain") or '').strip(),
            'vers': (data.get("vers") or '').strip(),
            'ro': 1 if data.get("ro") else 0,
            'uid': (data.get("uid") or '0').strip(),
            'gid': (data.get("gid") or '0').strip(),
            'opts': (data.get("opts") or '').strip(),
            'sort_order': int(data.get("sort_order") or 0),
        }
        # 若 auth_value 为空且是编辑（无新密码）-> 不更新密码字段
        if uuid and not save_data['auth_value']:
            save_data.pop('auth_value')
        if uuid:
            r = _db.share_update(0, save_data, uuid=uuid)
            if not r:
                await ws.send_json({"type": "result", "status": "error",
                                    "msg": f"未找到 uuid={uuid} 的共享配置"})
                return
            log_operation("网络共享", "编辑共享配置", name)
            await ws.send_json({"type": "result", "status": "ok",
                                "uuid": uuid, "msg": "已更新"})
        else:
            # 新建 -> 先建行拿 id，再回填 uuid
            new_id = _db.share_create(save_data)
            # 查回这条拿 uuid
            row = _db.share_get(share_id=new_id)
            new_uuid = (row or {}).get('uuid') or ''
            log_operation("网络共享", "新建共享配置", name)
            await ws.send_json({"type": "result", "status": "ok",
                                "id": new_id, "uuid": new_uuid, "msg": "已创建"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": str(e)[:300]})


async def handle_share_delete(ws: WebSocket, data: dict):
    """删除共享配置 · 若已挂载先卸载"""
    try:
        from backend import db as _db
        uuid = (data.get("uuid") or "").strip()
        share_id = data.get("id")
        if not uuid and not share_id:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": "需要 uuid 或 id"})
            return
        # 若已挂载先卸载
        if uuid and uuid in _active_share_mounts:
            await _do_umount(uuid)
        if uuid:
            ok = _db.share_delete(0, uuid=uuid)
        else:
            ok = _db.share_delete(int(share_id or 0))
        log_operation("网络共享", "删除共享配置", uuid or str(share_id))
        await ws.send_json({"type": "result", "status": "ok" if ok else "error",
                            "msg": "已删除" if ok else "未找到"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": str(e)[:300]})


# v5.91.2 · SMB 口令改走 0600 凭据文件 —— 项目红线「密码不落命令行」
#   此前 mount 命令里带 password=..., 会出现在 /proc/<pid>/cmdline (同机任何用户可读),
#   smbclient 测试同样如此。改为: Python 以 0600 写临时凭据文件 → 命令行只出现文件路径 → 用完即删。
_CIFS_CRED_DIR = "/run/fonriv_cifs"


def _write_cifs_cred(s: dict) -> str:
    """写出 0600 凭据文件, 返回路径 (调用方负责用后删除)"""
    import tempfile
    try:
        os.makedirs(_CIFS_CRED_DIR, mode=0o700, exist_ok=True)
    except Exception:
        pass
    try:
        os.chmod(_CIFS_CRED_DIR, 0o700)
    except Exception:
        pass
    fd, path = tempfile.mkstemp(prefix='cifs_', dir=_CIFS_CRED_DIR)
    try:
        os.fchmod(fd, 0o600)
    except Exception:
        pass
    lines = []
    if (s.get('user') or '').strip():
        lines.append('username=' + str(s.get('user')))
    if (s.get('auth_value') or '').strip():
        lines.append('password=' + str(s.get('auth_value')))
    if (s.get('domain') or '').strip():
        lines.append('domain=' + str(s.get('domain')))
    with os.fdopen(fd, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    return path


def _drop_cifs_cred(path: str) -> None:
    if not path:
        return
    try:
        os.unlink(path)
    except Exception:
        pass


def _build_mount_cmd(s: dict, mnt: str, cred_path: str = "") -> str:
    """根据协议构造 mount 命令 (cred_path: SMB 凭据文件路径, 有则不再把口令写进命令行)"""
    proto = s.get('proto', 'smb')
    host = s.get('host', '')
    share = s.get('share', '')
    user = s.get('user', '')
    pwd = s.get('auth_value', '')  # 已解密
    domain = s.get('domain', '')
    vers = s.get('vers', '')
    ro = s.get('ro', 0)
    uid = s.get('uid', '0')
    gid = s.get('gid', '0')
    opts = s.get('opts', '')
    mnt_q = _shlex.quote(mnt)
    access = 'ro' if ro else 'rw'

    if proto == 'smb':
        # //host/share -o username=...,password=...,domain=...,vers=...,ro,uid=0,gid=0,iocharset=utf8
        o = [access, f'uid={uid}', f'gid={gid}', 'iocharset=utf8', 'nounix', 'noserverino']
        if vers:
            o.append(f'vers={vers}')
        # v5.52.0 修: "无密码共享" 此前恒被当成"空密码认证"挂不上
        #   根因: username 非空就一定拼 password=(即使为空) → cifs 按密码认证处理, 返回
        #   Permission denied / mount error(13); 而 guest 分支只有 username 为空才走到。
        #   实测: win10 共享(user=guest, 无密码) last_status=fail; OMV 共享(有密码)正常。
        #   修复: 无密码 / guest / anonymous / nobody 一律按**来宾(匿名)访问**处理,
        #        只加 guest, 不带 username/password, 不传空 password 触发认证。
        _u = (user or '').strip()
        _pwd = (pwd or '').strip()
        _anon = (not _pwd) or _u.lower() in ('guest', 'anonymous', 'nobody')
        if _anon:
            o.append('guest')
            if _u and _u.lower() not in ('guest', 'anonymous', 'nobody'):
                o.append(f'username={_unq(_u)}')   # 保留具名但无密码 -> 走 guest 映射
        elif cred_path:
            # v5.91.2 · 口令走 0600 凭据文件: 命令行里只有路径(用户名/口令/域都在文件里)
            o.append('credentials=' + _shlex.quote(cred_path))
        else:
            o.append(f'username={_unq(_u)}')
            o.append(f'password={_unq(_pwd)}')
        if domain and not cred_path:
            o.append(f'domain={_unq(domain)}')
        if opts:
            o.append(opts)
        opts_str = ','.join(o)
        return f"mount -t cifs //{_unq(host)}/{_unq(share)} {mnt_q} -o {opts_str} 2>&1"

    elif proto == 'nfs':
        # mount -t nfs host:share mnt -o ro,hard,timeo=30,retrans=2
        o = [access, 'hard', 'timeo=30', 'retrans=2']
        if vers:
            o.append(f'vers={vers}')  # vers=4 / vers=3
        if opts:
            o.append(opts)
        opts_str = ','.join(o)
        return f"mount -t nfs {_shlex.quote(host)}:{_shlex.quote(share)} {mnt_q} -o {opts_str} 2>&1"

    elif proto == 'afp':
        # mount -t afp "afp://user:pass@host/share" mnt -o ro
        # afpfs-ng 直接用 URL 内联凭据，无需额外文件
        cred = ''
        if user:
            cred = _unq(user) + (f':{_unq(pwd)}' if pwd else '') + '@'
        url = f'afp://{cred}{host}/{_unq(share)}'
        o = [access]
        if opts:
            o.append(opts)
        return f"mount -t afp {_shlex.quote(url)} {mnt_q} -o {','.join(o)} 2>&1"

    elif proto == 'webdav':
        # mount -t davfs https://host/path mnt -o ro
        # v4.39.1 Phase 2b: davfs2 凭据走 /etc/davfs2/secrets，挂载前自动写入
        scheme = 'https' if (s.get('port') in ('443', '') and ':' not in host) else 'http'
        # v4.39.1: URL 须含非标准端口 (80/443 可省略)
        _port_part = ''
        _sp = s.get('port') or ''
        if _sp and str(_sp) not in ('80', '443', ''):
            _port_part = f':{_sp}'
        url = f'{scheme}://{host}{_port_part}/{share.lstrip("/")}'
        o = [access]
        if opts:
            o.append(opts)
        return f"mount -t davfs {_shlex.quote(url)} {mnt_q} -o {','.join(o)} 2>&1"

    return f"echo '不支持协议 {proto}'"


async def _do_mount(s: dict) -> tuple:
    """执行挂载 · 返回 (ok, msg)"""
    uid = s.get('uuid')
    if not uid:
        return False, "共享配置无 uuid"
    mnt = _share_mnt(uid)
    # 已挂载？ (v4.39.4 · 优先检查实际挂载状态, 防止服务重启后 _active_share_mounts 丢失导致重复挂载 EBUSY)
    if uid in _active_share_mounts:
        return True, f"✓ 已挂载于 {_active_share_mounts[uid]['mnt']}"
    # v4.39.4 · findmnt 检查挂载点是否已被挂载 (服务重启后内存态丢失但 OS 层仍挂载)
    _, mo = await _local_exec(f"findmnt -no TARGET {_shlex.quote(mnt)} 2>/dev/null || true", timeout=5)
    if (mo or '').strip() == mnt:
        # OS 层已挂载 -> 同步进 _active_share_mounts, 视为成功
        _active_share_mounts[uid] = {
            'mnt': mnt, 'proto': s.get('proto', ''),
            'host': s.get('host', ''), 'ts': time.time(),
        }
        return True, f"✓ 已挂载于 {mnt} (挂载点已存在)"
    # 建挂载点
    os.makedirs(mnt, exist_ok=True)

    # v4.39.1 Phase 2b: WebDAV 挂载前自动写 davfs2 secrets 文件
    # davfs2 的 mount 不接受命令行 password，需写入 /etc/davfs2/secrets
    proto = s.get('proto', '')
    if proto == 'webdav':
        _user = s.get('user', '')
        _pwd = s.get('auth_value', '')  # 已解密
        _host = s.get('host', '')
        _port = s.get('port') or ''
        _share_path = s.get('share', '').lstrip('/')
        _scheme = 'https' if (s.get('port') in ('443', '') and ':' not in _host) else 'http'
        _port_part = ''
        if _port and str(_port) not in ('80', '443', ''):
            _port_part = f':{_port}'
        _url = f'{_scheme}://{_host}{_port_part}/{_share_path}'
        if _user and _pwd:
            try:
                os.makedirs('/etc/davfs2', exist_ok=True)
                # 读取现有 secrets，移除同 URL 的旧条目
                _existing = ''
                try:
                    with open('/etc/davfs2/secrets', 'r') as _f:
                        _existing = _f.read()
                except (IOError, OSError):
                    pass
                _lines = [l for l in _existing.splitlines()
                          if l.strip() and not l.strip().startswith('#')
                          and _url not in l]
                _lines.append(f'{_url} {_unq(_user)} {_unq(_pwd)}')
                # v5.20.0 · 凭据必须以 0600 落盘。原先 write() 之后再 chmod, 首次创建时
                #   存在一段按 umask (通常 0644) 可读的窗口。改为 os.open 带 mode 一次到位。
                _fd = os.open('/etc/davfs2/secrets',
                              os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                try:
                    os.write(_fd, ('\n'.join(_lines) + '\n').encode('utf-8'))
                finally:
                    os.close(_fd)
                try:
                    os.chmod('/etc/davfs2/secrets', 0o600)  # 兜底: 文件已存在且权限不对时纠正
                except OSError:
                    pass
            except PermissionError:
                # 非 root 或无写权限 -> 跳过，davfs2 会交互提示
                pass

    # v5.91.2 · SMB 非匿名访问 → 先落 0600 凭据文件, 命令行不再出现口令
    _cred = ""
    if (s.get('proto') == 'smb'
            and (s.get('auth_value') or '').strip()
            and (s.get('user') or '').strip().lower() not in ('guest', 'anonymous', 'nobody')):
        try:
            _cred = _write_cifs_cred(s)
        except Exception as e:
            return False, "挂载失败: 无法写凭据文件 (%s)" % e
    try:
        cmd = _build_mount_cmd(s, mnt, _cred)
        code, out = await _local_exec(cmd, timeout=30)
    finally:
        _drop_cifs_cred(_cred)
    if code == 0:
        _active_share_mounts[uid] = {
            'mnt': mnt, 'proto': s.get('proto', ''),
            'host': s.get('host', ''), 'ts': time.time(),
        }
        return True, f"✓ 已挂载到 {mnt}"
    else:
        # 清理空挂载点
        try:
            os.rmdir(mnt)
        except OSError:
            pass
        _err = (out or '').strip()[:300]
        # v5.52.0 · 失败原因具体化(禁止"挂载失败"一句话糊过去)
        _hint = ''
        _lo = _err.lower()
        _guest = (s.get('proto') == 'smb'
                  and (not (s.get('auth_value') or '').strip()
                       or (s.get('user') or '').strip().lower() in ('guest', 'anonymous', 'nobody', '')))
        if 'permission denied' in _lo or 'error(13)' in _lo or 'logon failure' in _lo:
            # v5.91.1 · 提示分两种情况(此前一律按"Windows 来宾被禁"给建议, 对 NAS 上"账号密码不对"
            #   这种最常见的情况完全是误导 —— 实测 OMV: 账号被拒也报 error(13))
            if _guest:
                _hint = ('\n提示: 来宾(无密码)访问被目标拒绝 — Windows 需在目标机启用'
                         '「允许不安全的来宾登录」(组策略: 网络安全 → LAN Manager 身份验证级别 '
                         '→ 发送 LM 和 NTLM); NAS(OMV/群晖等)需在服务端把该共享设为"公共/允许匿名"; '
                         'SMB1 老设备可加 opts=vers=1.0')
            else:
                _hint = ('\n提示: 服务端拒绝了这组账号/口令 (NT_STATUS_LOGON_FAILURE)。'
                         'NAS(OMV/群晖等)的 SMB 用户口令与 SSH 口令是分开设置的: 请在服务端确认'
                         '① 该用户已启用且设过密码 ② SMB/CIFS 服务已启用并"应用" ③ 该共享的权限允许此用户。'
                         '用「测试连接」可先单独验证认证; 也可临时加 opts=vers=1.0 排除协议版本问题。')
        elif 'no route' in _lo or 'timed out' in _lo or 'connection refused' in _lo:
            _hint = '\n提示: 网络不通或 445 端口被防火墙拦截, 先在「测试连接」确认可达'
        elif _guest and 'error(2)' in _lo:
            _hint = '\n提示: 共享名不存在或未开放 (公共共享名请与目标端一致)'
        return False, f"挂载失败: {_err}{_hint}"


async def _do_umount(share_uuid: str) -> tuple:
    """卸载共享"""
    mnt = _share_mnt(share_uuid)
    # 先检查是否真的挂载着（findmnt）
    _, mo = await _local_exec(f"findmnt -no TARGET {mnt} 2>/dev/null || true", timeout=5)
    is_mounted = (mo or '').strip() == mnt
    if is_mounted:
        code, out = await _local_exec(f"umount {mnt} 2>&1", timeout=15)
        if code != 0:
            # 强制 lazy umount 回落
            code2, out2 = await _local_exec(f"umount -l {mnt} 2>&1", timeout=10)
            if code2 != 0:
                return False, f"卸载失败: {(out or '').strip()[:200]}"
    # v4.39.1 Phase 2b: WebDAV 卸载后清理 secrets 文件中的对应条目
    _proto = _active_share_mounts.get(share_uuid, {}).get('proto', '')
    if _proto == 'webdav':
        try:
            if os.path.exists('/etc/davfs2/secrets'):
                with open('/etc/davfs2/secrets', 'r') as _f:
                    _existing = _f.read()
                _lines = [l for l in _existing.splitlines()
                          if l.strip() and not l.strip().startswith('#')
                          and mnt not in l and share_uuid not in l]
                with open('/etc/davfs2/secrets', 'w') as _f:
                    _f.write('\n'.join(_lines) + '\n')
        except (IOError, OSError):
            pass
    # 清理空目录
    try:
        os.rmdir(mnt)
    except OSError:
        pass
    _active_share_mounts.pop(share_uuid, None)
    return True, f"✓ 已卸载 {mnt}"


async def handle_share_mount(ws: WebSocket, data: dict):
    """挂载共享到本机"""
    try:
        from backend import db as _db
        uuid = (data.get("uuid") or "").strip()
        if not uuid:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": "需要 uuid"})
            return
        s = _db.share_get(uuid=uuid)
        if not s:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": f"未找到 uuid={uuid}"})
            return
        ok, msg = await _do_mount(s)
        # v4.40.0 · 挂载成功 -> 实际写入探测读写能力 (只读配置跳过探测)
        rw_state, rw_reason = "unknown", ""
        if ok:
            if s.get('ro'):
                rw_state, rw_reason = "ro", "配置为只读挂载"
            else:
                rw_state, rw_reason = await _probe_rw(_share_mnt(uuid))
            # 探测结果写内存态 (share_list 直接返回, 不再重复探测)
            _st = _active_share_mounts.get(uuid) or {}
            _st['rw'] = rw_state
            _st['rw_reason'] = rw_reason
            _active_share_mounts[uuid] = _st
        rw_desc = ""
        if ok:
            rw_desc = f" · {_rw_label(rw_state)}" + (f" ({rw_reason})" if rw_reason else "")
            log_operation("网络共享", "挂载+读写检测",
                          f"{s.get('name','')} {msg}{rw_desc}")
        else:
            log_operation("网络共享", "挂载", f"{s.get('name','')} -> {msg}")
        _db.share_update_status(uuid, 'ok' if ok else 'fail',
                                 time.strftime('%Y-%m-%d %H:%M:%S') if ok else '')
        # v4.40.0 · 持久挂载: 挂载成功即 last_status='ok', 服务重启后自动恢复 (无 WS 会话追踪)
        # v4.39.3 · 返回本机 df 挂载点列表，前端据此更新 __dmDfMounts
        #   即使挂载返回 busy/失败也刷新 (可能已挂载，df 列表仍需同步)
        df_mounts = await _local_df_mounts()
        await ws.send_json({"type": "result", "status": "ok" if ok else "error",
                            "uuid": uuid, "msg": msg, "rw": rw_state,
                            "rw_reason": rw_reason, "rw_label": _rw_label(rw_state),
                            "mnt": _share_mnt(uuid) if ok else '',
                            "df_mounts": df_mounts})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": str(e)[:300]})


async def handle_share_umount(ws: WebSocket, data: dict):
    """卸载共享"""
    try:
        uuid = (data.get("uuid") or "").strip()
        if not uuid:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": "需要 uuid"})
            return
        ok, msg = await _do_umount(uuid)
        try:
            from backend import db as _db
            if ok:
                # v4.40.0 · 持久挂载: 主动卸载 -> 'idle' (重启后不再自动挂载, 配置保留)
                _db.share_update_status(uuid, 'idle')
            else:
                _db.share_update_status(uuid, 'fail')
        except Exception:
            pass
        log_operation("网络共享", "卸载", f"{uuid} -> {msg}")
        # v4.39.3 · 返回本机 df 挂载点列表，前端据此更新 __dmDfMounts
        df_mounts = await _local_df_mounts()
        await ws.send_json({"type": "result", "status": "ok" if ok else "error",
                            "uuid": uuid, "msg": msg,
                            "df_mounts": df_mounts})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": str(e)[:300]})


async def handle_share_test(ws: WebSocket, data: dict):
    """测试连通性（不挂载）"""
    try:
        from backend import db as _db
        uuid = (data.get("uuid") or "").strip()
        if not uuid:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": "需要 uuid"})
            return
        s = _db.share_get(uuid=uuid)
        if not s:
            await ws.send_json({"type": "result", "status": "error",
                                "msg": f"未找到 uuid={uuid}"})
            return
        proto = s.get('proto', 'smb')
        host = s.get('host', '')
        port = s.get('port') or _DEFAULT_PORT.get(proto, '')
        share = s.get('share', '')
        user = s.get('user', '')
        pwd = s.get('auth_value', '')
        domain = s.get('domain', '')

        if proto == 'smb':
            # smbclient -L //host -U user%pass -m SMB3
            if shutil.which('smbclient'):
                # v5.91.2 · 口令不落命令行: 写 0600 凭据文件, smbclient 用 -A 读
                _cred2 = ""
                try:
                    _cred2 = _write_cifs_cred({'user': user, 'auth_value': pwd, 'domain': domain})
                except Exception:
                    _cred2 = ""
                if _cred2:
                    cmd = f"smbclient -L //{host} -A {_shlex.quote(_cred2)} -m SMB3 2>&1 | head -20"
                else:
                    cmd = f"smbclient -L //{host} -U {user} -m SMB3 2>&1 | head -20"
                code, out = await _local_exec(cmd, timeout=15)
                _drop_cifs_cred(_cred2)
                ok = code == 0 and 'NT_STATUS' not in (out or '').upper()
                # v5.91.1 · 认证失败给出人话结论(实测: 账号口令不对与共享名不对都表现为 NT_STATUS)
                if not ok:
                    _up = (out or '').upper()
                    if 'LOGON_FAILURE' in _up or 'ACCESS_DENIED' in _up:
                        out = ("认证失败: 服务端拒绝了账号/口令 (NT_STATUS_LOGON_FAILURE) — "
                               "核对 NAS 上的 SMB 用户与密码(与 SSH 口令可能不同), 并确认该共享权限允许此用户。\n原始输出: " + (out or '')[:400])
                    elif 'BAD_NETWORK_NAME' in _up:
                        out = ("共享名不存在或未开放: 请核对「共享名」与服务端实际名称一致。\n原始输出: " + (out or '')[:400])
            else:
                # 没 smbclient 用 nc 测端口
                cmd = f"timeout 3 bash -c 'echo > /dev/tcp/{host}/{port}' 2>&1 && echo OK || echo FAIL"
                code, out = await _local_exec(cmd, timeout=8)
                ok = 'OK' in (out or '')
                out = f"端口 {port} {'可达' if ok else '不可达'}（未装 smbclient，仅测端口）"
        elif proto == 'nfs':
            if shutil.which('showmount'):
                cmd = f"showmount -e {host} 2>&1 | head -10"
                code, out = await _local_exec(cmd, timeout=10)
                ok = code == 0 and share in (out or '')
            else:
                cmd = f"timeout 3 bash -c 'echo > /dev/tcp/{host}/{port}' 2>&1 && echo OK || echo FAIL"
                code, out = await _local_exec(cmd, timeout=8)
                ok = 'OK' in (out or '')
                out = f"端口 {port} {'可达' if ok else '不可达'}（未装 nfs-common，仅测端口）"
        elif proto == 'afp':
            # v4.39.1 Phase 2b: 优先用 afpclient 测连通，否则测端口
            if shutil.which('afpclient'):
                _afp_url = f'afp://{_unq(user)}:{_unq(pwd)}@{host}' if user else f'afp://{host}'
                cmd = f"afpclient ls {_afp_url}/{_unq(share)} 2>&1 | head -5"
                code, out = await _local_exec(cmd, timeout=10)
                ok = code == 0
            else:
                cmd = f"timeout 3 bash -c 'echo > /dev/tcp/{host}/{port}' 2>&1 && echo OK || echo FAIL"
                code, out = await _local_exec(cmd, timeout=8)
                ok = 'OK' in (out or '')
                out = f"端口 {port} {'可达' if ok else '不可达'}（未装 afpfs-ng，仅测端口）"
        elif proto == 'webdav':
            # v4.39.1 Phase 2b: 带凭据的 HTTP 测试 (curl -u user:pass -I)
            scheme = 'https' if port in ('443', '') else 'http'
            # v4.39.1: URL 须含非标准端口 (80/443 可省略)
            _port_part = ''
            if port and str(port) not in ('80', '443', ''):
                _port_part = f':{port}'
            _wurl = f'{scheme}://{host}{_port_part}/{share.lstrip("/")}'
            if user:
                cmd = f"curl -sI -m 8 -u {_shlex.quote(user)}:{_shlex.quote(pwd)} {_wurl} 2>&1 | head -5"
            else:
                cmd = f"curl -sI -m 8 {_wurl} 2>&1 | head -5"
            code, out = await _local_exec(cmd, timeout=12)
            _first = (out or '').split('\n')[0]
            # v4.39.1: 任何 HTTP 响应都视为可达 (200/301/302/401/403/404/405 均说明服务器在线)
            ok = 'HTTP' in (out or '')
            if '401' in _first:
                out = 'HTTP 401 需要认证（凭据可能错误）'
            elif not ok:
                out = f"无 HTTP 响应: {(out or '').strip()[:100]}"
            else:
                out = f'✓ 服务器可达: {_first.strip()}'
        else:
            ok, out = False, f"未知协议 {proto}"

        # v5.93.0 · 共享连通性结论入统一台账 → 连接中心 SMB/NFS 节点的圆点与之一致
        try:
            from backend.handlers import conn_probe as _cp
            # v5.95.0 · 网络共享 = 长期连接语义(挂载后长期在线, 除手动卸载)
            _cp.record_probe(uuid, ok=ok, msg=(out or '').strip(), long_lived=True)
        except Exception as _pe:
            print("[share] probe record fail: %s" % _pe)
        await ws.send_json({"type": "result", "status": "ok" if ok else "error",
                            "uuid": uuid, "msg": (out or '').strip()[:300]})
    except Exception as e:
        try:
            from backend.handlers import conn_probe as _cp
            _cp.record_probe((data.get("uuid") or "").strip(), ok=False, msg=str(e)[:300], long_lived=True)
        except Exception:
            pass
        await ws.send_json({"type": "result", "status": "error",
                            "msg": str(e)[:300]})


async def handle_share_plugin_check(ws: WebSocket, data: dict):
    """检测本机是否装了各协议所需工具"""
    try:
        results = []
        for proto, (bin_name, apt_pkg) in _SHARE_PLUGIN_CHECKS.items():
            installed = shutil.which(bin_name) is not None
            results.append({
                'proto': proto,
                'bin': bin_name,
                'apt_pkg': apt_pkg,
                'installed': installed,
            })
        # 探测发行版
        _, osr = await _local_exec(
            "cat /etc/os-release 2>/dev/null | grep -E '^(ID|ID_LIKE)=' || true", timeout=5
        )
        osr_lower = (osr or "").lower()
        if "debian" in osr_lower or "ubuntu" in osr_lower:
            pkg_mgr = "apt"
        elif any(x in osr_lower for x in ["rhel", "centos", "fedora", "rocky", "alma"]):
            pkg_mgr = "dnf"
        elif "opensuse" in osr_lower or "suse" in osr_lower:
            pkg_mgr = "zypper"
        elif "arch" in osr_lower:
            pkg_mgr = "pacman"
        else:
            pkg_mgr = "apt"
        await ws.send_json({"type": "result", "status": "ok",
                            "checks": results, "pkg_mgr": pkg_mgr})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": str(e)[:300]})


# ═══ v5.16.0 · 备份/导出目标位置: 真实挂载点枚举 + 可写性测试 ═══

async def handle_mounts_list(ws, data: dict, task_id: str = ""):
    """列出本机全部实挂载点 (供备份保存路径选择器用)。
    与 df_mounts 的区别: df_mounts 只收共享命名空间 (供传输下拉); 本接口返回系统真实挂载,
    含可用空间/文件系统类型/是否共享挂载/可写性 (以服务进程身份实测)。
    v5.90.2 · 改用 _mount_rows_fast: 全量 `df` 被断线挂载(CIFS 对端关机)阻塞 40s,
    旧实现 timeout=10 恒超时 → 前端"挂载点列表"空白; 现在 findmnt 秒出 + 逐挂载点短超时。"""
    _req = data.get("req_id") or ""
    try:
        rows = [dict(r) for r in await _mount_rows_fast()]
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"枚举失败: {e}"})
        return
    for r in rows:
        r["total"] = r["total"] or 0
        r["used"] = r["used"] or 0
        r["avail"] = r["avail"] or 0
        r["is_share"] = str(r.get("mount", "")).startswith(SHARE_MOUNT_ROOT + "/")
    # 共享挂载来源信息 (显示成 "SMB //host/share" 更直观)
    try:
        from backend import db as _db
        _sh = {SHARE_MOUNT_ROOT + "/" + str(s.get("uuid")): s for s in (_db.share_list() or [])}
    except Exception:
        _sh = {}
    for r in rows:
        s = _sh.get(r["mount"])
        if s:
            r["label"] = f"{s.get('proto','').upper()} {s.get('host','')}/{s.get('share','')}"
    rows.sort(key=lambda x: (not x["is_share"], x["mount"]))
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "mounts": rows})


def _writable_probe(path: str) -> tuple:
    """实测目录可写性 (以服务进程身份)。返回 (ok, msg)"""
    import os as _os
    try:
        if not _os.path.isdir(path):
            try:
                _os.makedirs(path, exist_ok=True)
            except Exception as e:
                return False, f"目录不存在且无法创建: {str(e)[:120]}"
        probe = _os.path.join(path, ".rp_write_probe")
        with open(probe, "w") as f:
            f.write("ok")
        _os.remove(probe)
        st = _os.statvfs(path)
        avail = st.f_bavail * st.f_frsize
        return True, f"可写 · 可用空间 {avail // (1024**3)} GB" if avail >= 1024**3 else f"可写 · 可用空间 {avail // (1024**2)} MB"
    except PermissionError:
        return False, "不可写 (权限不足 — 服务以当前用户身份运行)"
    except Exception as e:
        return False, f"不可写: {str(e)[:120]}"


async def handle_target_test(ws, data: dict):
    """备份/导出目标可写性测试。params: kind(local|server|share|df|cloud), path, host/...(SSH), remote_id"""
    _req = data.get("req_id") or ""
    kind = (data.get("kind") or "local").strip().lower()
    path = (data.get("path") or "").strip()
    try:
        if kind in ("local", "df", "share"):
            if not path:
                await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 path"})
                return
            ok, msg = _writable_probe(path)
            await ws.send_json({"type": "result", "status": "ok" if ok else "error", "req_id": _req,
                                "msg": (f"✓ {path}: {msg}" if ok else f"✗ {path}: {msg}"), "writable": ok})
            return
        if kind == "server":
            if not data.get("host"):
                await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少服务器连接"})
                return
            from backend.ssh_lib import SSHTarget, ssh_error_msg
            target = SSHTarget.from_ws_data(data)
            sp = (path or "/").rstrip("/")
            cmd = (f"mkdir -p {shlex.quote(sp)} 2>&1 && touch {shlex.quote(sp + '/.rp_write_probe')} 2>&1 && "
                   f"rm -f {shlex.quote(sp + '/.rp_write_probe')} && "
                   f"df -PB1 {shlex.quote(sp)} 2>/dev/null | tail -1 | awk '{{print $4}}'")
            try:
                async with target.runner() as run:
                    code, out, err = await run.exec(cmd, timeout=25, merge_stderr=True)
            except Exception as e:
                await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                    "msg": f"✗ 连接失败: {ssh_error_msg(str(e))}"})
                return
            txt = (out or "").strip()
            if code != 0:
                await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                    "msg": f"✗ {data.get('host')}:{sp} 不可写 — {txt[:180] or err[:180]}"})
                return
            last = txt.splitlines()[-1] if txt else "0"
            avail = int(last) if last.isdigit() else 0
            sz = (f"{avail // (1024**3)} GB" if avail >= 1024**3 else f"{avail // (1024**2)} MB")
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                                "msg": f"✓ SSH 连通 · {path} 可写 · 可用空间 {sz}", "writable": True})
            return
        if kind == "cloud":
            rid = int(data.get("remote_id") or 0)
            if not rid:
                await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 remote_id"})
                return
            from backend.db.remotes import remote_get
            from backend import db as _db
            r = remote_get(_db.get_conn(), rid)
            if not r:
                await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "远端存储配置不存在"})
                return
            # 本地 provider 直接测目录; 对象存储测 bucket 可达性
            prov = (r.get("provider") or "").lower()
            if prov == "local":
                ep = r.get("endpoint") or ""
                ok, msg = _writable_probe(ep)
                await ws.send_json({"type": "result", "status": "ok" if ok else "error", "req_id": _req,
                                    "msg": (f"✓ 本地远端 {ep}: {msg}" if ok else f"✗ {ep}: {msg}"), "writable": ok})
            else:
                await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                                    "msg": f"ℹ {r.get('provider')} ({r.get('name')}): 对象存储将在备份完成后由上传流程验证凭据",
                                    "writable": None})
            return
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"不支持的 kind: {kind}"})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"测试异常: {str(e)[:200]}"})

"""Fonriv - 统一服务器档案 handlers
v5.33.0: sp_list / sp_get / sp_save / sp_del / sp_get_by_host / sp_sync
v5.34.1 (连接中心 P1): 增量合并 + 乐观并发(version) + 审计 + 事件广播(profile.changed) +
         sp_probe 探测回填 + sp_batch 批量 + sg_* 分组树 + audit_query
面板: conn_center · 凭据列与 protocols 内敏感字段均 Fernet (ENC$) 加密。
"""
import asyncio
import json
import time
import uuid as _uuid
from typing import Optional

from backend.db import get_conn, conn_audit_insert
try:
    from backend.fonrvfs.errors import FonrError   # v5.60.0 E2-4 · resolve_resource 用
except ImportError:  # v5.81.0 · 社区版包剪掉 backend/fonrvfs/ → 提供**签名同构**的等价异常类
    class FonrError(Exception):
        """与 backend/fonrvfs/errors.py::FonrError 同构(code/message/detail/retryable + to_dict)"""

        def __init__(self, code: str, message: str, *, detail=None, retryable: bool = False):
            super().__init__(message)
            self.code = code
            self.message = message
            self.detail = detail or ""
            self.retryable = retryable

        def to_dict(self) -> dict:
            return {"code": self.code, "message": self.message,
                    "detail": self.detail, "retryable": self.retryable}

_ENCRYPT_COLS = ("ssh_auth_value", "ssh_passphrase")
# protocols JSON 块内统一敏感字段名 (任意块命中即加密)
_SENSITIVE_PROTO_FIELDS = {
    "api_pass", "token_value", "rdp_pass", "password", "db_pass",
    "key_passphrase", "access_key", "secret_key", "api_key",
}
# sp_save 可写字段白名单 (增量合并: 只覆盖 payload 显式携带的键)
_EDITABLE_COLS = {
    "name", "color", "tags", "hostname", "ssh_port", "ssh_user",
    "ssh_auth_type", "ssh_auth_value", "ssh_passphrase", "os_type", "notes",
    # v5.34.1 P1
    "kind", "description", "icon", "group_id", "sort_order", "is_starred",
    "ssh_timeout", "ssh_keepalive", "ssh_proxy_jump", "strict_host_key",
    "remote_uuid", "share_id",
}


def _fenc(v):
    from backend.db.crypto import encrypt_value
    from backend.db import _get_fernet
    return encrypt_value(_get_fernet(), v)


def _norm_atype(v) -> str:
    """v5.90.2 · 档案认证方式归一: 只有**显式** key*(如 key/key_pass)才算密钥, 其余一律按密码。

    历史坑: 旧数据里出现过 `ssh_auth_type='password'` 这类非法值, 而下游判定是
    `if atype == "pass"` → 非法值静默落进**密钥**分支, 把密码当成 `ssh -i <路径>` 的密钥,
    实测报 "Warning: Identity file <密码当文件名> not accessible" + Permission denied, 且被上层
    包装成"文件不存在/SSH 连接失败/离线", 排查成本极高。归一后此类脏值退化为密码登录。
    """
    s = str(v or "pass").strip().lower()
    return "key" if s.startswith("key") else "pass"


def _fdec(v):
    from backend.db.crypto import decrypt_value
    from backend.db import _get_fernet
    return decrypt_value(_get_fernet(), v)


def _enc_protocols(proto: dict) -> dict:
    """protocols 各能力块内敏感字段 → ENC$ (幂等)。"""
    out = {}
    for blk, cfg in (proto or {}).items():
        if isinstance(cfg, dict):
            cfg = dict(cfg)
            for f in _SENSITIVE_PROTO_FIELDS:
                v = cfg.get(f)
                if v and isinstance(v, str) and not v.startswith("ENC$"):
                    try:
                        cfg[f] = _fenc(v)
                    except Exception:
                        pass
        out[blk] = cfg
    return out


def _dec_protocols(proto: dict) -> dict:
    """protocols 各能力块内 ENC$ 字段 → 明文 (sp_get/sp_get_by_host 下发用)。"""
    out = {}
    for blk, cfg in (proto or {}).items():
        if isinstance(cfg, dict):
            cfg = dict(cfg)
            for f in _SENSITIVE_PROTO_FIELDS:
                v = cfg.get(f)
                if v and isinstance(v, str) and v.startswith("ENC$"):
                    try:
                        cfg[f] = _fdec(v)
                    except Exception:
                        pass
        out[blk] = cfg
    return out


def _parse_protocols(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        v = json.loads(raw or "{}")
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _row_dict(row):
    d = dict(row)
    d["protocols"] = _parse_protocols(d.get("protocols"))
    return d


def _owner_id(ws):
    from backend.auth import active_sessions
    return (active_sessions.get(ws) or {}).get("user_id") or 1


def _is_admin(ws) -> bool:
    from backend.auth import active_sessions
    return ((active_sessions.get(ws) or {}).get("role") or "").lower() == "admin"


def _actor(ws):
    from backend.auth import active_sessions
    s = active_sessions.get(ws) or {}
    return s.get("user_id") or 1, s.get("username") or ""


def _publish(topic, payload):
    try:
        from backend import events
        events.publish(topic, payload)
    except Exception as e:
        print(f"[sp] publish {topic} fail: {e}")


def _audit(ws, guid, action, protocol="", detail=""):
    uid, uname = _actor(ws)
    conn_audit_insert(uid, uname, guid, action, protocol, detail)


def _protocols_mask(proto: dict) -> list:
    """已启用的能力块名列表 (卡片徽章用)。"""
    out = []
    for blk, cfg in (proto or {}).items():
        if isinstance(cfg, dict) and cfg.get("enabled"):
            out.append(blk)
    if "ssh" not in out:
        out.insert(0, "ssh")
    return out


# ────────────────────────── 档案 CRUD ──────────────────────────

# ══════════════════════════════════════════════════════════════════════════
# v5.60.0 E2-4 · **统一资源解析入口**（阶段E 结构债）
#   为什么需要: 各页面此前各自读 server_profiles / remote_configs / shares 或凭据中心,
#   口径不一致 —— 曾有页面读错字段导致列表恒空并**静默回落成"本机"**(CLAUDE.md §3.7 的真实案例)。
#   本函数把"档案 → 某能力所需连接参数"收敛到一处:
#     ① 按 guid 取档案; ② **归属校验**(非管理员只能取自己的; 管理员豁免);
#     ③ 按能力组装参数(ssh / remote_storage / share / rdp / vnc / pve_api / docker / truenas / database);
#     ④ 能力未启用或凭据解密失败 → **明确报错**, 绝不回落成空凭据或本机。
#   注: 消费方(各面板)逐个切到本入口属 E5「连接中心统一资源」; 本版先落 API + 回归。
# ══════════════════════════════════════════════════════════════════════════
_RESOLVE_SECRET_HINT = ("pass", "secret", "token", "auth", "key", "credential")


def _dec_secret(field: str, val: str) -> str:
    """解 ENC$ 前缀(与 vfs.py 同一口径)。**加密态但解不开 → 明确报错**, 不把密文当明文用。"""
    v = val or ""
    if not v.startswith("ENC$"):
        if v.startswith("gAAAAA"):        # Fernet 密文却没带 ENC$ 前缀 → 可疑, 报错不猜
            raise FonrError("bad_request",
                            "凭据字段 %s 是加密态但无 ENC$ 前缀, 请重新保存该档案" % field)
        return v
    try:
        from backend import db as _db
        return _db._decrypt_value(v)
    except Exception as e:
        raise FonrError("bad_request",
                        "凭据字段 %s 解密失败(%s), 请重新保存该档案的密码" % (field, str(e)[:60]))


def resolve_resource(guid: str, capability: str, uid=None, role=None) -> dict:
    """统一资源解析: (档案 guid, 能力名) → 连接参数。uid=None 表示服务端内部调用(不做归属校验)。"""
    cap = (capability or "").strip().lower()
    if not guid:
        raise FonrError("bad_request", "缺少资源 guid")
    conn = get_conn()
    row = conn.execute("SELECT * FROM server_profiles WHERE guid=?", (guid,)).fetchone()
    if not row:
        raise FonrError("not_found", "未找到资源档案: %s" % guid)
    d = dict(row)
    if uid is not None and (role or "").lower() != "admin":
        owner = d.get("user_id")
        if owner is not None and int(owner) != int(uid):
            raise FonrError("forbidden", "无权使用他人资源档案(归属校验): %s" % guid)

    kind = d.get("kind") or "host"

    if cap in ("ssh",):
        _at = "key" if (d.get("ssh_auth_type") or "").startswith("key") else "pass"
        _pw = _dec_secret("ssh_auth_value", d.get("ssh_auth_value"))
        _pp = _dec_secret("ssh_passphrase", d.get("ssh_passphrase"))
        if not d.get("hostname"):
            raise FonrError("unsupported", "该档案未填写主机名/IP, 无法用于 SSH 连接")
        # v5.61.0 E5 · 无凭据时**明确报错**: 旧行为是拿空口令去连, 远端回 Permission denied,
        #   用户看到的是"认证失败"而不是"你没配凭据"(排查成本高)。密码/密钥至少要有一样。
        if _at == "pass" and not _pw:
            raise FonrError("unsupported",
                            "该档案未配置 SSH 密码(请到连接中心编辑该资源并填入密码/密钥)")
        if _at == "key" and not _pw:
            raise FonrError("unsupported",
                            "该档案未配置 SSH 私钥(或私钥解密失败, 请重新保存)")
        return {"guid": guid, "capability": "ssh", "kind": kind, "source": "server_profiles",
                "params": {"name": d.get("name") or d.get("hostname") or "",
                           "host": d.get("hostname") or "", "port": int(d.get("ssh_port") or 22),
                           "user": d.get("ssh_user") or "root",
                           "auth_type": _at,
                           "password": _pw if _at == "pass" else "",
                           "key": _pw if _at == "key" else "",
                           "passphrase": _pp,
                           "os_type": d.get("os_type") or "auto",
                           "timeout": d.get("ssh_timeout"), "keepalive": d.get("ssh_keepalive")}}

    if cap in ("remote_storage", "cloud", "s3"):
        ru = d.get("remote_uuid")
        if not ru:
            raise FonrError("unsupported", "该档案未关联远端存储(remote_uuid 为空), 请到连接中心为其启用存储能力")
        rr = conn.execute("SELECT * FROM remote_configs WHERE uuid=?", (ru,)).fetchone()
        if not rr:
            raise FonrError("not_found", "关联的远端存储不存在(可能已被删除): %s" % ru)
        rc = dict(rr)
        if uid is not None and (role or "").lower() != "admin" and rc.get("user_id") is not None \
                and int(rc["user_id"]) != int(uid):
            raise FonrError("forbidden", "无权使用他人的远端存储: %s" % ru)
        return {"guid": guid, "capability": "remote_storage", "kind": kind,
                "source": "remote_configs", "remote_uuid": ru,
                "params": {"provider": rc.get("provider") or "", "endpoint": rc.get("endpoint") or "",
                           "region": rc.get("region") or "", "bucket": rc.get("bucket") or "",
                           "prefix": rc.get("prefix") or "",
                           "access_key": _dec_secret("access_key", rc.get("access_key")),
                           "secret_key": _dec_secret("secret_key", rc.get("secret_key"))}}

    if cap in ("share", "smb", "nfs"):
        sid_ = d.get("share_id")
        if not sid_:
            raise FonrError("unsupported", "该档案未关联网络共享(share_id 为空)")
        sr = conn.execute("SELECT * FROM shares WHERE uuid=?", (sid_,)).fetchone()
        if not sr:
            raise FonrError("not_found", "关联的网络共享不存在: %s" % sid_)
        sh = dict(sr)
        if uid is not None and (role or "").lower() != "admin" and sh.get("user_id") is not None \
                and int(sh["user_id"]) != int(uid):
            raise FonrError("forbidden", "无权使用他人的网络共享: %s" % sid_)
        return {"guid": guid, "capability": "share", "kind": kind, "source": "shares",
                "share_uuid": sid_,
                "params": {"proto": sh.get("proto") or "", "host": sh.get("host") or "",
                           "port": sh.get("port"), "share": sh.get("share") or "",
                           "path": sh.get("path") or "", "user": sh.get("user") or "",
                           "auth_value": _dec_secret("auth_value", sh.get("auth_value")),
                           "domain": sh.get("domain") or "", "vers": sh.get("vers") or "",
                           "opts": sh.get("opts") or ""}}

    # 其余能力来自 protocols JSON (连接中心 v3 设计的能力块)
    _proto = _parse_protocols(d.get("protocols"))
    block = _proto.get(cap)
    if cap in ("rdp", "vnc", "pve_api", "docker", "truenas", "database", "webdav", "kubernetes"):
        if not block or not block.get("enabled"):
            raise FonrError("unsupported",
                            "该档案未启用 %s 能力 (请在连接中心编辑该资源并在「%s」页签勾选启用)"
                            % (cap.upper(), cap))
        params = {}
        for k, v in (block or {}).items():
            if k == "enabled":
                continue
            if isinstance(v, str) and any(h in k.lower() for h in _RESOLVE_SECRET_HINT):
                params[k] = _dec_secret(k, v)
            else:
                params[k] = v
        return {"guid": guid, "capability": cap, "kind": kind, "source": "server_profiles.protocols",
                "params": params}

    raise FonrError("unsupported",
                    "未知能力 %s (支持: ssh / remote_storage / share / rdp / vnc / pve_api / "
                    "docker / truenas / database / webdav / kubernetes)" % (cap or "(空)"))


async def handle_sp_list(ws, data: dict):
    _req = data.get("req_id") or ""
    uid = _owner_id(ws)
    _admin = _is_admin(ws)
    conn = get_conn()
    # v5.48.0 修: 管理员此前只看到 user_id=1 的档案, 别人建的档案 (user_id≠1) 全被挡掉 →
    #   三栏/连接中心的下拉里"少机器", 选中不到就回落成"本机:/" (用户报的"打开其他机器显示本机根目录")
    if _admin:
        rows = conn.execute(
            "SELECT * FROM server_profiles ORDER BY is_starred DESC, sort_order, name").fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM server_profiles WHERE user_id=? ORDER BY is_starred DESC, sort_order, name",
            (uid,)).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        proto = _parse_protocols(d.get("protocols"))
        d["has_ssh_creds"] = bool(d.get("ssh_auth_value"))
        d.pop("ssh_auth_value", None)
        d.pop("ssh_passphrase", None)
        d["protocols_mask"] = _protocols_mask(proto)
        d.pop("protocols", None)  # 列表不下发能力详情 (脱敏瘦身)
        items.append(d)
    if _admin:
        groups = conn.execute(
            "SELECT * FROM server_groups ORDER BY sort_order, name").fetchall()
    else:
        groups = conn.execute(
            "SELECT * FROM server_groups WHERE user_id=? ORDER BY sort_order, name", (uid,)).fetchall()
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "profiles": items, "groups": [dict(g) for g in groups]})


async def handle_sp_get(ws, data: dict):
    _req = data.get("req_id") or ""
    guid = (data.get("guid") or "").strip()
    conn = get_conn()
    row = conn.execute("SELECT * FROM server_profiles WHERE guid=?", (guid,)).fetchone()
    if not row:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "未找到"})
        return
    d = _row_dict(row)
    for col in _ENCRYPT_COLS:
        v = d.get(col, "")
        if v and str(v).startswith("ENC$"):
            try: d[col] = _fdec(v)
            except Exception: pass
    d["protocols"] = _dec_protocols(d["protocols"])
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "profile": d})


async def handle_sp_save(ws, data: dict):
    """保存档案 · v5.34.1 语义:
    - payload = data.profile (dict) 或 data 本身 (旧扁平兼容)
    - 增量合并: 仅覆盖白名单内显式携带的键; protocols 按块替换 (null=删块)
    - 乐观并发: expected_version 不匹配 → version_conflict + 服务端最新档案
    - 成功后写审计 + publish('profile.changed')
    """
    _req = data.get("req_id") or ""
    payload = data.get("profile") if isinstance(data.get("profile"), dict) else data
    uid = _owner_id(ws)
    guid = (payload.get("guid") or "").strip()
    hostname = (payload.get("hostname") or "").strip()
    conn = get_conn()

    # ── 档位限额: 上限由 backend/license.limits() 给出 (开源社区版 0 = 不限) ──
    #   注: 所有页面(文件传输/VNC 直链/PVE 控制台/网络共享/远端磁盘/备份中心)共用 server_profiles 一张表,
    #   所以这里按**该用户总行数**计, 与用户看到的一致。
    _is_new = True
    if guid:
        _is_new = conn.execute("SELECT 1 FROM server_profiles WHERE guid=?", (guid,)).fetchone() is None
    if _is_new:
        try:
            from backend import license as _L
            _mx = int((_L.limits() or {}).get("max_profiles") or 0)
        except Exception:
            _mx = 0
        if _mx:
            _n = conn.execute("SELECT COUNT(*) FROM server_profiles WHERE user_id=?", (uid,)).fetchone()[0]
            if _n >= _mx:
                await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                    "msg": "档案数已达上限 %d 个(文件传输/VNC/PVE/备份等页面共用), "
                                           "当前已有 %d 个。请删除不用的档案后重试。" % (_mx, _n)})
                return

    # ── 更新路径: 读旧档 → 校验版本 → 增量合并 ──
    old = None
    if guid:
        row = conn.execute("SELECT * FROM server_profiles WHERE guid=?", (guid,)).fetchone()
        if not row:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "档案不存在"})
            return
        old = dict(row)
        exp_v = data.get("expected_version")
        if exp_v is not None:
            try: exp_v = int(exp_v)
            except (TypeError, ValueError): exp_v = None
            if exp_v is not None and exp_v != int(old.get("version") or 1):
                await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                    "code": "version_conflict",
                                    "msg": "配置已被其他人修改, 请刷新后重试",
                                    "server_profile": {k: old.get(k) for k in
                                                       ("guid", "version", "updated_at", "name")}})
                return
    else:
        # v5.35.1 · kind=storage: hostname 可由 remote_storage.endpoint 推导
        if not hostname:
            try:
                _ep = str((((payload.get("protocols") or {}).get("remote_storage")) or {}).get("endpoint") or "").strip()
                if _ep:
                    hostname = _ep.split("//")[-1].split("/")[0].split(":")[0] or _ep
            except Exception:
                pass
        if not hostname:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 hostname"})
            return
        guid = str(_uuid.uuid4())

    # 合并身份/显示/行为列
    merged = dict(old or {})
    changed_fields = []
    for col in _EDITABLE_COLS:
        if col in payload:
            val = payload.get(col)
            # v5.90.2 · 认证方式落库前归一(界面/导入/接口任何来源都只存 pass|key)
            if col == "ssh_auth_type":
                val = _norm_atype(val)
            if col == "ssh_port":
                try: val = int(val or 22)
                except (TypeError, ValueError): val = 22
            elif col in ("is_starred", "sort_order", "ssh_timeout", "ssh_keepalive",
                         "strict_host_key", "share_id"):
                try: val = int(val or 0)
                except (TypeError, ValueError): val = 0
            if col in _ENCRYPT_COLS and val and not str(val).startswith("ENC$"):
                try: val = _fenc(str(val))
                except Exception: pass
            if merged.get(col) != val:
                changed_fields.append(col)
            merged[col] = val
    if not merged.get("hostname"):
        merged["hostname"] = hostname
    # v5.35.1 · kind=storage: hostname 可省 → 从 remote_storage.endpoint 自动推导
    if not merged.get("hostname"):
        try:
            _ep = (merged.get("protocols") or {}).get("remote_storage", {}).get("endpoint") or \
                  (payload.get("protocols") or {}).get("remote_storage", {}).get("endpoint") or ""
            _ep = str(_ep).strip()
            if _ep:
                merged["hostname"] = _ep.split("//")[-1].split("/")[0].split(":")[0] or _ep
        except Exception:
            pass
    if "ssh_port" not in merged:
        merged["ssh_port"] = 22

    # protocols 按块合并
    new_proto = None
    if "protocols" in payload:
        inc = payload.get("protocols")
        inc = _parse_protocols(inc) if inc else {}
        cur = _parse_protocols((old or {}).get("protocols"))
        for blk, cfg in inc.items():
            if cfg is None:
                cur.pop(blk, None)
            else:
                cur[blk] = cfg  # 整块替换 (页面只提交自己负责的块)
            changed_fields.append(f"protocols.{blk}")
        new_proto = _enc_protocols(cur)

    # 唯一性预检 (同用户+hostname+port)
    try:
        dup = conn.execute(
            "SELECT guid FROM server_profiles WHERE user_id=? AND hostname=? AND ssh_port=? "
            "AND hostname!='' AND guid!=?",
            (uid, merged.get("hostname") or "", int(merged.get("ssh_port") or 22), guid)).fetchone()
        if dup:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": f"同主机+端口已有档案 ({merged.get('hostname')}:{merged.get('ssh_port')})"})
            return
    except Exception:
        pass

    # v6.4.1 · 批4: 档案变更(端口/地址/凭据) → 失效 FonrVFS 连接/适配器缓存,
    #   否则改密后旧适配器会拿旧凭据重连直到进程重启(VFS.invalidate 此前 0 调用者)。
    try:
        from backend.fonrvfs.vfs import VFS as _VFS
        _VFS.invalidate()
    except Exception:
        pass
    version = int((old or {}).get("version") or 0) + 1
    # INSERT OR REPLACE 会整行重建 → protocols/created_at 必须显式携带, 否则被重置
    proto_val = (json.dumps(new_proto, ensure_ascii=False) if new_proto is not None
                 else (old or {}).get("protocols") or "{}")
    created_val = (old or {}).get("created_at") or time.strftime("%Y-%m-%d %H:%M:%S")
    cols = ["guid", "user_id", "version", "created_at", "updated_at", "protocols"] + \
           [c for c in _EDITABLE_COLS if c in merged]
    cols = list(dict.fromkeys(cols))
    vals = []
    for c in cols:
        if c == "guid": vals.append(guid)
        elif c == "user_id": vals.append(uid)
        elif c == "version": vals.append(version)
        elif c == "created_at": vals.append(created_val)
        elif c == "updated_at": vals.append(time.strftime("%Y-%m-%d %H:%M:%S"))
        elif c == "protocols": vals.append(proto_val)
        else: vals.append(merged.get(c))
    conn.execute(f"""INSERT OR REPLACE INTO server_profiles ({','.join(cols)})
        VALUES ({','.join(['?']*len(cols))})""", vals)
    conn.commit()

    # v5.35.1 · 存储双写: remote_storage 块变化 → 同步 remote_configs
    #   (三栏☁组 / TargetPicker 备份路径 / 远端存储页 的共同数据源)
    _storage_note = ""
    if new_proto is not None and "remote_storage" in (payload.get("protocols") or {}):
        _blk_req = payload["protocols"]["remote_storage"]
        if _blk_req is None:
            _sync = _storage_sync_to_remote(uid, guid, merged.get("name") or "", None, delete=True)
        else:
            _plain = dict(_blk_req)   # 密钥解密为明文再传 (remote_configs 层自加密)
            for _sf in _SENSITIVE_PROTO_FIELDS:
                _v = _plain.get(_sf)
                if _v and isinstance(_v, str) and _v.startswith("ENC$"):
                    try: _plain[_sf] = _fdec(_v)
                    except Exception: pass
            _sync = _storage_sync_to_remote(uid, guid, merged.get("name") or "", _plain, delete=False)
        if _sync.get("note"):
            _storage_note = " (" + _sync["note"] + ")"

    action_word = "update" if old else "create"
    _audit(ws, guid, "edit" if old else "create",
           detail=json.dumps({"fields": changed_fields[:20]}, ensure_ascii=False))
    _publish("profile.changed", {
        "guid": guid, "action": action_word, "fields": changed_fields[:20],
        "version": version, "name": merged.get("name") or merged.get("hostname"),
        "by": "conn_center", "actor": _actor(ws)[1],
    })
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "guid": guid, "version": version,
                        "msg": f"✓ 已保存 {merged.get('name') or merged.get('hostname')}{_storage_note}"})


async def handle_sp_del(ws, data: dict):
    _req = data.get("req_id") or ""
    guid = (data.get("guid") or "").strip()
    conn = get_conn()
    row = conn.execute("SELECT * FROM server_profiles WHERE guid=?", (guid,)).fetchone()
    if not row:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "档案不存在"})
        return
    d = dict(row)
    # 活跃会话保护: 任意用户对该 endpoint 的 connected 会话 → 拒绝
    try:
        from backend import conn_registry as cr
        ep = f"{d.get('ssh_user') or 'root'}@{d.get('hostname')}:{int(d.get('ssh_port') or 22)}"
        active = [s for s in cr.SESSIONS.values()
                  if s.get("endpoint") == ep and s.get("state") == "connected"]
        if active:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": f"有 {len(active)} 个活跃连接使用此服务器, 请先在连接中心断开"})
            return
    except Exception:
        pass
    # v5.35.1 · kind=storage → 级联删除链接的 remote_configs 行 (有引用则保留能力行)
    _del_note = ""
    if d.get("kind") == "storage" and d.get("remote_uuid"):
        _sync = _storage_sync_to_remote(_owner_id(ws), guid, d.get("name"), None, delete=True)
        if not _sync.get("ok"):
            _del_note = " (存储能力条目被引用, 已保留于远端存储页)"
    conn.execute("DELETE FROM server_profiles WHERE guid=?", (guid,))
    conn.commit()
    _audit(ws, guid, "delete", detail=json.dumps({"name": d.get("name")}, ensure_ascii=False))
    _publish("profile.deleted", {"guid": guid, "name": d.get("name"),
                                 "by": "conn_center", "actor": _actor(ws)[1]})
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "msg": "✓ 已删除" + _del_note})


async def handle_sp_get_by_host(ws, data: dict):
    _req = data.get("req_id") or ""
    hostname = (data.get("hostname") or "").strip()
    conn = get_conn()
    port = data.get("port") or data.get("ssh_port")
    # v5.49.0 · 审计报告 #1(P0): 按 hostname 取档此前不限用户 → 他人档案的元数据可被读到;
    #   现与 sp_list 一致: 非管理员限定自己的档案, 管理员可跨用户
    _admin = _is_admin(ws)
    _scope = ("" if _admin else " AND user_id=?")
    _uid = _owner_id(ws)
    if port:
        row = conn.execute("SELECT * FROM server_profiles WHERE hostname=? AND ssh_port=?"
                           + _scope,
                           ((hostname, int(port)) if _admin else (hostname, int(port), _uid))).fetchone()
    else:
        row = conn.execute("SELECT * FROM server_profiles WHERE hostname=?" + _scope,
                           ((hostname,) if _admin else (hostname, _uid))).fetchone()
    if not row:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "未找到"})
        return
    d = _row_dict(row)
    for col in _ENCRYPT_COLS:
        v = d.get(col, "")
        if v and str(v).startswith("ENC$"):
            try: d[col] = _fdec(v)
            except Exception: pass
    d["protocols"] = _dec_protocols(d["protocols"])
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "profile": d})


# ────────────────────────── v5.34.1 · P1 新增 ──────────────────────────

def _probe_profile_core(d: dict) -> dict:
    """v5.34.6 · P6 探测核心 (handle_sp_probe 与 scheduler 健康巡检共用)。
    d = server_profiles 行 dict (凭据列可为 ENC$, 内部解密)。同步阻塞, 调用方自行放 executor。"""
    import os
    import subprocess
    host = (d.get("hostname") or "").strip()
    port = int(d.get("ssh_port") or 22)
    user = d.get("ssh_user") or "root"
    av = d.get("ssh_auth_value") or ""
    if av and str(av).startswith("ENC$"):
        try:
            av = _fdec(av)
        except Exception:
            pass
    atype = _norm_atype(d.get("ssh_auth_type"))
    t0 = time.time()
    base = ["ssh", "-o", "ConnectTimeout=6", "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
            "-p", str(port)]
    env = dict(os.environ)
    if atype == "pass":
        cmd = ["sshpass", "-e"] + base
        env["SSHPASS"] = av or ""
    else:
        # v5.90.2 · 密钥分支前置校验: 路径不存在就**立刻**返回明确错误。
        #   此前会带着坏路径去连, ssh 回落到密码交互 → 卡满 12s 超时, 上层只报 "timeout",
        #   用户看到的是"点连接没反应"(实测 192.168.1.90 案例)。
        kp = str(av or "").strip()
        if not kp:
            return {"ok": False, "err": "未配置密钥文件(请在档案中填写密钥路径或粘贴密钥内容)",
                    "latency_ms": int((time.time() - t0) * 1000)}
        if not kp.startswith("-----BEGIN") and not os.path.isfile(os.path.expanduser(kp)):
            return {"ok": False, "err": "密钥文件不存在: %s" % kp,
                    "latency_ms": int((time.time() - t0) * 1000)}
        # v5.90.4 · 密钥处理统一收敛到 conn_registry.prepare_key_arg:
        #   ① 路径形态直接用 `-i <路径>`(此前把路径字符串当内容写进临时文件 → ssh 报
        #      `Load key ...: error in libcrypto`);
        #   ② 内容形态物化成 0600 临时文件;
        #   ③ 口令走 SSH_ASKPASS 助手(实测 `sshpass -e` 喂不动 ssh 的密钥口令提示, 会卡满超时);
        pp = d.get("ssh_passphrase") or ""
        if pp and str(pp).startswith("ENC$"):
            try:
                pp = _fdec(pp)
            except Exception:
                pass
        try:
            from backend.conn_registry import prepare_key_arg as _pka
            _kargs, _kenv, _ = _pka(kp, pp, "probe_%s" % str(host))
        except Exception as _ke:
            _kargs, _kenv = ["-i", kp], {}
            print("[sp_probe] prepare_key_arg 失败(退化为裸路径):", _ke)
        env.update(_kenv or {})
        cmd = base[:1] + list(_kargs) + base[1:]
        # v5.90.2 · 密钥分支禁用密码回落: 被服务端拒绝时立刻拿到
        #   "Permission denied (publickey)" 而不是卡满 12s 报 timeout
        #   (实测 9.90: 无此参数 → ssh 回落密码交互, 界面只见 timeout, 用户无从判断)
        _ins = 1
        cmd = cmd[:_ins] + ["-o", "PasswordAuthentication=no",
                            "-o", "KbdInteractiveAuthentication=no"] + cmd[_ins:]
    cmd += [f"{user}@{host}",
            'echo __OK__; . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"; uname -m; hostname']
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=12, env=env)
    except subprocess.TimeoutExpired:
        return {"ok": False, "err": "timeout", "latency_ms": int((time.time() - t0) * 1000)}
    latency = int((time.time() - t0) * 1000)
    if p.returncode != 0 or "__OK__" not in (p.stdout or ""):
        return {"ok": False, "err": (p.stderr or "").strip()[:160] or f"exit={p.returncode}",
                "latency_ms": latency}
    lines_out = [l.strip() for l in (p.stdout or "").splitlines() if l.strip()]
    _ARCH = {"x86_64", "aarch64", "arm64", "i686", "riscv64"}
    pretty = arch = real = ""
    if len(lines_out) >= 4:
        pretty, arch, real = lines_out[1], lines_out[2], lines_out[3]
    elif len(lines_out) == 3:
        if lines_out[1] in _ARCH:
            arch, real = lines_out[1], lines_out[2]
        else:
            pretty, real = lines_out[1], lines_out[2]
    return {"ok": True, "latency_ms": latency, "os_version": pretty, "arch": arch,
            "hostname_real": real, "os_type": "linux"}


async def handle_sp_probe(ws, data: dict, task_id: str = ""):
    """SSH 探测: 连通性/延迟/系统信息 → 回填健康列 + 广播。"""
    _req = data.get("req_id") or ""
    guid = (data.get("guid") or "").strip()
    conn = get_conn()
    row = conn.execute("SELECT * FROM server_profiles WHERE guid=?", (guid,)).fetchone()
    if not row:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "档案不存在"})
        return
    d = dict(row)
    r = _probe_profile_core(d)

    def _tcp_checks():
        import socket as _sock
        proto = _parse_protocols(d.get("protocols"))
        checks = {}
        for blk, cfg in proto.items():
            if not (isinstance(cfg, dict) and cfg.get("enabled")):
                continue
            if blk == "rdp":
                port = int(cfg.get("port") or 3389)
            elif blk == "vnc":
                port = int(cfg.get("port") or 5900)
            elif blk == "pve_api":
                url = (cfg.get("api_url") or "").strip()
                port = 8006
                if url.startswith("https://"):
                    p = url.split(":")[2].split("/")[0] if url.count(":") >= 2 else ""
                    if p.isdigit(): port = int(p)
            elif blk == "docker":
                if not cfg.get("use_tls"):
                    continue
                port = int(cfg.get("tcp_port") or 2376)
            else:
                continue
            t0 = time.time()
            try:
                s = _sock.create_connection(((d.get("hostname") or "").strip(), port), timeout=3)
                s.close()
                checks[blk] = {"ok": True, "port": port, "ms": int((time.time()-t0)*1000)}
            except Exception as e:
                checks[blk] = {"ok": False, "port": port, "err": str(e)[:80]}
        return checks

    async def _probe_full():
        r = await loop.run_in_executor(None, _probe_profile_core, d)
        r["tcp"] = await loop.run_in_executor(None, _tcp_checks)
        return r

    loop = asyncio.get_event_loop()
    r = await _probe_full()
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    conn.execute("""UPDATE server_profiles SET status=?, last_seen=?, last_latency_ms=?,
        os_version=CASE WHEN ?!='' THEN ? ELSE os_version END,
        arch=CASE WHEN ?!='' THEN ? ELSE arch END,
        hostname_real=CASE WHEN ?!='' THEN ? ELSE hostname_real END,
        os_type=CASE WHEN ?!='' THEN ? ELSE os_type END, updated_at=? WHERE guid=?""",
        ("online" if r.get("ok") else "offline", now,
         r.get("latency_ms", -1),
         r.get("os_version") or "", r.get("os_version") or "",
         r.get("arch") or "", r.get("arch") or "",
         r.get("hostname_real") or "", r.get("hostname_real") or "",
         r.get("os_type") or "", r.get("os_type") or "",
         now, guid))
    conn.commit()
    _audit(ws, guid, "probe", detail=json.dumps({"ok": r.get("ok")}, ensure_ascii=False))
    _publish("profile.changed", {"guid": guid, "action": "update",
                                 "fields": ["status", "last_latency_ms"], "by": "sp_probe"})
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "msg": "✓ 在线 · " + str(r.get("latency_ms")) + "ms" if r.get("ok")
                        else "✗ " + (r.get("err") or "不可达"),
                        "probe": r})


async def handle_sp_batch(ws, data: dict):
    """批量: op=star|unstar|move|delete|tag, guids=[...]。"""
    _req = data.get("req_id") or ""
    op = (data.get("op") or "").strip()
    guids = data.get("guids") or []
    if not guids or not isinstance(guids, list):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 guids"})
        return
    conn = get_conn()
    ph = ",".join(["?"] * len(guids))
    n = 0
    if op in ("star", "unstar"):
        cur = conn.execute(f"UPDATE server_profiles SET is_starred=?, updated_at=datetime('now') "
                           f"WHERE guid IN ({ph})", (1 if op == "star" else 0, *guids))
        n = cur.rowcount
    elif op == "move":
        gid = (data.get("group_id") or "").strip()
        cur = conn.execute(f"UPDATE server_profiles SET group_id=?, updated_at=datetime('now') "
                           f"WHERE guid IN ({ph})", (gid, *guids))
        n = cur.rowcount
    elif op == "tag":
        tag = (data.get("tag") or "").strip()
        if tag:
            rows = conn.execute(f"SELECT guid, tags FROM server_profiles WHERE guid IN ({ph})",
                                guids).fetchall()
            for g, tags in rows:
                tl = [t for t in (tags or "").split(",") if t]
                if tag not in tl:
                    tl.append(tag)
                    conn.execute("UPDATE server_profiles SET tags=? WHERE guid=?",
                                 (",".join(tl), g))
                    n += 1
    elif op == "delete":
        for g in guids:
            row = conn.execute("SELECT ssh_user, hostname, ssh_port FROM server_profiles WHERE guid=?",
                               (g,)).fetchone()
            if row:
                try:
                    from backend import conn_registry as cr
                    ep = f"{row[0] or 'root'}@{row[1]}:{int(row[2] or 22)}"
                    if any(s.get("endpoint") == ep and s.get("state") == "connected"
                           for s in cr.SESSIONS.values()):
                        continue  # 有活跃会话 → 跳过该台
                except Exception:
                    pass
            cur = conn.execute("DELETE FROM server_profiles WHERE guid=?", (g,))
            n += cur.rowcount
    else:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"未知 op: {op}"})
        return
    conn.commit()
    if n:
        _audit(ws, "", "batch_" + op, detail=json.dumps({"count": n}, ensure_ascii=False))
        _publish("profile.changed", {"guid": "", "action": "bulk", "op": op, "count": n,
                                     "by": "conn_center", "actor": _actor(ws)[1]})
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "count": n,
                        "msg": f"✓ 批量{op} {n} 条"})


# ────────────────────────── 分组树 sg_* ──────────────────────────

async def handle_sg_list(ws, data: dict):
    _req = data.get("req_id") or ""
    uid = _owner_id(ws)
    rows = get_conn().execute(
        "SELECT * FROM server_groups WHERE user_id=? ORDER BY sort_order, name", (uid,)).fetchall()
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "groups": [dict(r) for r in rows]})


async def handle_sg_save(ws, data: dict):
    _req = data.get("req_id") or ""
    uid = _owner_id(ws)
    payload = data.get("group") if isinstance(data.get("group"), dict) else data
    guid = (payload.get("guid") or "").strip()
    name = (payload.get("name") or "").strip()
    if not guid and not name:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少名称"})
        return
    conn = get_conn()
    if not guid:
        guid = str(_uuid.uuid4())
    conn.execute("""INSERT OR REPLACE INTO server_groups
        (guid, user_id, name, color, icon, parent_id, sort_order)
        VALUES(?,?,?,?,?,?,?)""",
        (guid, uid, name, payload.get("color") or "", payload.get("icon") or "folder",
         (payload.get("parent_id") or "").strip(),
         int(payload.get("sort_order") or 0)))
    conn.commit()
    _publish("group.changed", {"guid": guid, "action": "save"})
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "guid": guid,
                        "msg": f"✓ 已保存分组 {name}"})


async def handle_sg_del(ws, data: dict):
    _req = data.get("req_id") or ""
    guid = (data.get("guid") or "").strip()
    conn = get_conn()
    # 组内档案 → 移到未分组; 子组 → 上提一层
    conn.execute("UPDATE server_profiles SET group_id='' WHERE group_id=?", (guid,))
    conn.execute("UPDATE server_groups SET parent_id=(SELECT parent_id FROM server_groups WHERE guid=?) "
                 "WHERE parent_id=?", (guid, guid))
    conn.execute("DELETE FROM server_groups WHERE guid=?", (guid,))
    conn.commit()
    _publish("group.changed", {"guid": guid, "action": "delete"})
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "msg": "✓ 已删除分组"})


async def handle_sg_reorder(ws, data: dict):
    _req = data.get("req_id") or ""
    items = data.get("items") or []  # [{guid, sort_order, parent_id?}]
    conn = get_conn()
    n = 0
    for it in items:
        if not isinstance(it, dict) or not it.get("guid"):
            continue
        if "parent_id" in it:
            conn.execute("UPDATE server_groups SET sort_order=?, parent_id=? WHERE guid=?",
                         (int(it.get("sort_order") or 0), (it.get("parent_id") or "").strip(),
                          it["guid"]))
        else:
            conn.execute("UPDATE server_groups SET sort_order=? WHERE guid=?",
                         (int(it.get("sort_order") or 0), it["guid"]))
        n += 1
    conn.commit()
    if n:
        _publish("group.changed", {"guid": "", "action": "reorder", "count": n})
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "count": n, "msg": f"✓ 已更新 {n} 项"})


# ────────────────────────── 审计查询 ──────────────────────────

async def handle_audit_query(ws, data: dict):
    _req = data.get("req_id") or ""
    from backend.db import conn_audit_recent
    rows = conn_audit_recent((data.get("profile_guid") or "").strip(),
                             int(data.get("limit") or 50))
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "logs": rows})


# ────────────────────────── v5.34.2 · P2 导入/导出 ──────────────────────────

async def handle_sp_export(ws, data: dict):
    """导出档案 JSON。include_creds=true 需 admin (凭据解密明文, 跨机迁移用)。"""
    _req = data.get("req_id") or ""
    from backend.auth import active_sessions
    uid, uname = _actor(ws)
    include_creds = bool(data.get("include_creds"))
    if include_creds:
        role = (active_sessions.get(ws) or {}).get("role") or ""
        if role != "admin":
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": "含凭据导出仅管理员可用"})
            return
    guids = data.get("guids") or []
    conn = get_conn()
    if guids:
        ph = ",".join(["?"] * len(guids))
        rows = conn.execute(f"SELECT * FROM server_profiles WHERE user_id=? AND guid IN ({ph}) "
                            f"ORDER BY name", (uid, *guids)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM server_profiles WHERE user_id=? ORDER BY name",
                            (uid,)).fetchall()
    from backend.db.crypto import decrypt_value
    from backend.db import _get_fernet
    out = []
    for r in rows:
        d = dict(r)
        proto = _parse_protocols(d.get("protocols"))
        if include_creds:
            for col in _ENCRYPT_COLS:
                v = d.get(col, "")
                if v and str(v).startswith("ENC$"):
                    try: d[col] = decrypt_value(_get_fernet(), v)
                    except Exception: pass
            proto = _dec_protocols(proto)
        else:
            # 不含凭据: 敏感字段整体剔除
            for col in _ENCRYPT_COLS:
                d[col] = ""
            for blk in proto.values():
                if isinstance(blk, dict):
                    for f in _SENSITIVE_PROTO_FIELDS:
                        blk.pop(f, None)
        d["protocols"] = proto
        d.pop("user_id", None)
        d.pop("version", None)
        out.append(d)
    payload = {"fonriv_profiles": 1, "exported_at": time.strftime("%Y-%m-%d %H:%M:%S"),
               "include_creds": include_creds, "count": len(out), "profiles": out}
    _audit(ws, "", "export", detail=json.dumps(
        {"count": len(out), "creds": include_creds,
         "guids": [d.get("guid") for d in out][:50]}, ensure_ascii=False))
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "data": json.dumps(payload, ensure_ascii=False, indent=1),
                        "count": len(out)})


def _parse_ssh_config(text: str) -> list:
    """解析 ~/.ssh/config: Host/HostName/Port/User/IdentityFile → 档案数组。"""
    items, cur = [], None
    for ln in (text or "").splitlines():
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        key, _, val = s.partition(" ")
        val = val.strip() or s[len(key):].strip()
        key = key.lower()
        if key == "host":
            names = [v for v in val.split() if v and not v.startswith("*")]
            if names:
                if cur: items.append(cur)
                cur = {"name": names[0], "hostname": names[0]}
        elif cur is None:
            continue
        elif key == "hostname":
            cur["hostname"] = val
        elif key == "port":
            try: cur["ssh_port"] = int(val)
            except ValueError: pass
        elif key == "user":
            cur["ssh_user"] = val
        elif key == "identityfile":
            cur["ssh_auth_type"] = "key"
            cur["ssh_auth_value"] = val.replace("~", "~")
    if cur: items.append(cur)
    return [i for i in items if i.get("hostname") and "*" not in i["hostname"]]


async def handle_sp_import(ws, data: dict):
    """导入档案: format=json|ssh_config, data=文本; overwrite=false 跳过同 host:port。"""
    _req = data.get("req_id") or ""
    uid = _owner_id(ws)
    fmt = (data.get("format") or "json").strip().lower()
    text = data.get("data") or ""
    overwrite = bool(data.get("overwrite"))
    conn = get_conn()
    created = skipped = 0
    errors = []
    # ── v5.83.3 · 档位限额: 导入同样受限(否则导入 N 条即可绕过) ──
    _mx_imp = 0
    try:
        from backend import license as _L
        _mx_imp = int((_L.limits() or {}).get("max_profiles") or 0)
    except Exception:
        _mx_imp = 0
    created_guids = []
    try:
        if fmt == "ssh_config":
            items = _parse_ssh_config(text)
        else:
            payload = json.loads(text)
            items = payload.get("profiles") if isinstance(payload, dict) else payload
        if not isinstance(items, list):
            raise ValueError("格式错误: 缺 profiles 数组")
        if _mx_imp:
            # v5.83.4 · 按"**实际新增**条数"判定: 全是重复项(同 host:port 且不 overwrite)时必须放行,
            #   否则用户拿自己导出的文件回导会被上限直接拦住(实测踩到)。
            _n0 = conn.execute("SELECT COUNT(*) FROM server_profiles WHERE user_id=?", (uid,)).fetchone()[0]
            _fresh = 0
            for _it in items:
                if not isinstance(_it, dict):
                    continue
                _h = (_it.get("hostname") or "").strip()
                if not _h:
                    continue
                try: _p = int(_it.get("ssh_port") or 22)
                except (TypeError, ValueError): _p = 22
                if conn.execute("SELECT 1 FROM server_profiles WHERE user_id=? AND hostname=? AND ssh_port=?",
                                (uid, _h, _p)).fetchone() is None:
                    _fresh += 1
                    if not overwrite and _n0 + _fresh > _mx_imp:
                        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                            "msg": "档案数将超出上限 %d 个(当前已有 %d 个, 本次新增 %d 个)。"
                                                   "请先清理不用的档案后重试。" % (_mx_imp, _n0, _fresh)})
                        return
        for it in items:
            if not isinstance(it, dict) or not (it.get("hostname") or "").strip():
                continue
            host = it["hostname"].strip()
            try: port = int(it.get("ssh_port") or 22)
            except (TypeError, ValueError): port = 22
            existing = conn.execute(
                "SELECT guid FROM server_profiles WHERE user_id=? AND hostname=? AND ssh_port=?",
                (uid, host, port)).fetchone()
            if existing and not overwrite:
                skipped += 1
                continue
            guid = (existing[0] if existing else str(_uuid.uuid4()))
            av = it.get("ssh_auth_value") or ""
            if av and not str(av).startswith("ENC$"):
                try: av = _fenc(str(av))
                except Exception: pass
            pp = it.get("ssh_passphrase") or ""
            if pp and not str(pp).startswith("ENC$"):
                try: pp = _fenc(str(pp))
                except Exception: pass
            proto = _enc_protocols(_parse_protocols(it.get("protocols")))
            conn.execute("""INSERT OR REPLACE INTO server_profiles
                (guid, user_id, name, color, tags, hostname, ssh_port, ssh_user,
                 ssh_auth_type, ssh_auth_value, ssh_passphrase, protocols, os_type,
                 notes, kind, description, icon, group_id, sort_order, is_starred,
                 created_at, updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))""",
                (guid, uid, it.get("name") or host, it.get("color") or "",
                 it.get("tags") or "", host, port, it.get("ssh_user") or "root",
                 it.get("ssh_auth_type") or "pass", av, pp,
                 json.dumps(proto, ensure_ascii=False), it.get("os_type") or "",
                 it.get("notes") or "", it.get("kind") or "linux",
                 it.get("description") or "", it.get("icon") or "server",
                 it.get("group_id") or "", int(it.get("sort_order") or 0),
                 int(it.get("is_starred") or 0)))
            created += 1
            created_guids.append(guid)
        conn.commit()
    except Exception as e:
        errors.append(str(e)[:200])
    if created:
        # v5.34.2 · detail 携带 guid 清单 → 各档案的审计可追溯 (audit_query 按 guid 也匹配 detail)
        _audit(ws, "", "import", detail=json.dumps(
            {"created": created, "fmt": fmt, "guids": created_guids[:50]}, ensure_ascii=False))
        _publish("profile.changed", {"guid": "", "action": "bulk", "count": created,
                                     "by": "sp_import", "actor": _actor(ws)[1]})
    await ws.send_json({"type": "result", "status": "ok" if not errors else "error",
                        "req_id": _req, "created": created, "skipped": skipped,
                        "errors": errors, "msg": f"✓ 导入 {created} 条, 跳过 {skipped} 条"})


# ────────────────────────── v5.34.3 · P3 跨页凭据解析 ──────────────────────────

async def handle_sp_resolve(ws, data: dict):
    """跨页凭据解析服务 (页面连服务器前的统一入口)。

    入参: {host, port?, user?, need?=['ssh','rdp','pve_api',...]}
    优先级:
      ① conn_registry 活跃会话命中 (同 owner, endpoint 匹配) → via_session=true,
         直接返回该会话凭据 (免重复认证, 免"测试连接")
      ② server_profiles 档案命中 → 解密返回 ssh 凭据 + 请求的能力块
      ③ 都未命中 → matched=false (页面按手工输入老路径走, 零回归)

    返回: {matched, via_session, guid, creds:{auth_type,password,key,passphrase...},
           caps:{rdp:{...}, pve_api:{...}}, profile_summary:{name,status,...}}
    """
    _req = data.get("req_id") or ""
    host = (data.get("host") or "").strip()
    if not host:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 host"})
        return
    try:
        port = int(data.get("port") or 22)
    except (TypeError, ValueError):
        port = 22
    need = data.get("need") or []
    if not isinstance(need, list):
        need = []
    user_arg = (data.get("user") or "").strip()
    uid = _owner_id(ws)
    from backend.auth import active_sessions
    owner = (active_sessions.get(ws) or {}).get("user") or "root"

    # ① 活跃会话命中 → 免认证凭据直达
    try:
        from backend import conn_registry as cr
        # 直接按会话字段比对 (user 为空时通配; 避免 endpoint 字符串构造歧义)
        sess = None
        for _s in cr.SESSIONS.values():
            if _s.get("host") != host or str(_s.get("port")) != str(port):
                continue
            if _s.get("state") not in ("connected", "connecting"):
                continue
            if owner and _s.get("created_by") != owner:
                continue
            if user_arg and _s.get("user") != user_arg:
                continue
            sess = _s
            break
        if sess is not None:
            _audit(ws, "", "resolve", protocol="session",
                   detail=json.dumps({"host": host, "port": port, "via": "session"}))
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                                "matched": True, "via_session": True,
                                "guid": sess.get("config_id") or "",
                                "creds": {"host": host, "port": port,
                                          "user": sess.get("user") or "root",
                                          "auth_type": sess.get("auth_type") or "pass",
                                          "password": sess.get("password") or "",
                                          "key": sess.get("key") or "",
                                          "passphrase": sess.get("passphrase") or ""},
                                "caps": {},
                                "profile_summary": {"name": sess.get("name") or host}})
            return
    except Exception as e:
        print(f"[sp_resolve] session lookup fail: {e}")

    # ② 档案命中 → 解密凭据 + 按需能力块
    conn = get_conn()
    # v5.52.0 修: 此前严格 `user_id=<会话用户>` → 管理员浏览**他人档案**(如 user_id=2 的 srv-21)时
    #   恒 matched=False → 调用方拿到空凭据 → SSH 空密码认证失败(Permission denied),
    #   表现为"机器在列表里却连不上/回落本机"。与 v5.48.0 的列表可见性口径统一: 管理员跨用户。
    _admin = False
    try:
        from backend.auth import active_sessions as _as
        _admin = ((_as.get(ws) or {}).get("role") == "admin")
    except Exception as _e:
        print(f"[sp_resolve] 取角色失败(按非管理员处理): {_e}")
    if _admin:
        # 注意: server_profiles 无 id 列 (主键是 guid) — 按 v5.52.0 教训, 排序只用实际存在的列
        row = conn.execute("SELECT * FROM server_profiles WHERE hostname=? AND ssh_port=? "
                           "ORDER BY is_starred DESC, sort_order, name", (host, port)).fetchone()
        if not row:
            row = conn.execute("SELECT * FROM server_profiles WHERE hostname=? "
                               "ORDER BY is_starred DESC, sort_order, name", (host,)).fetchone()
    else:
        row = conn.execute("SELECT * FROM server_profiles WHERE user_id=? AND hostname=? AND ssh_port=?",
                           (uid, host, port)).fetchone()
        if not row:
            row = conn.execute("SELECT * FROM server_profiles WHERE user_id=? AND hostname=?",
                               (uid, host)).fetchone()
    if not row:
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "matched": False, "via_session": False,
                            "msg": "未登记档案 (按手工输入继续)"})
        return
    d = _row_dict(row)
    av = d.get("ssh_auth_value") or ""
    if av and str(av).startswith("ENC$"):
        try: av = _fdec(av)
        except Exception: pass
    pp = d.get("ssh_passphrase") or ""
    if pp and str(pp).startswith("ENC$"):
        try: pp = _fdec(pp)
        except Exception: pass
    atype = _norm_atype(d.get("ssh_auth_type"))
    proto_full = _dec_protocols(d["protocols"])
    # v5.34.6 · P6 保险库引用: protocols.ssh.credential_guid → 覆盖 SSH 凭据 (跨机共用)
    _cg = (proto_full.get("ssh") or {}).get("credential_guid") or ""
    if _cg:
        v = _cred_lookup(uid, _cg)
        if v:
            user_arg = v.get("username") or user_arg
            av = v.get("password") or v.get("private_key") or av
            pp = v.get("passphrase") or pp
            atype = "key" if v.get("private_key") else atype
    # caps 只回请求的能力块 (最小暴露面); need 空 → 全部已启用块
    caps = {}
    for blk, cfg in proto_full.items():
        if not isinstance(cfg, dict):
            continue
        if need and blk not in need:
            continue
        if not need and not cfg.get("enabled"):
            continue
        caps[blk] = cfg
    _audit(ws, d.get("guid") or "", "resolve", protocol="profile",
           detail=json.dumps({"host": host, "port": port, "need": need[:10]}))
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "matched": True, "via_session": False,
                        "guid": d.get("guid"),
                        "creds": {"host": d.get("hostname"), "port": int(d.get("ssh_port") or 22),
                                  "user": user_arg or d.get("ssh_user") or "root",
                                  "auth_type": atype,
                                  "password": av if atype == "pass" else "",
                                  "key": av if atype == "key" else "",
                                  "passphrase": pp},
                        "caps": caps,
                        "profile_summary": {
                            "name": d.get("name"), "kind": d.get("kind"),
                            "status": d.get("status"), "os_version": d.get("os_version"),
                            "last_latency_ms": d.get("last_latency_ms"),
                            "protocols_mask": _protocols_mask(proto_full)}})


# ────────────────────────── v5.87.0 · 服务端凭据补齐 (供直连 SSH 的 handler 复用) ──────────────────────────

def resolve_ssh_creds(ws, host: str, port, user: str = "") -> dict | None:
    """前端档案源出于安全不下发密码(serverRows 无 auth_value) → 空凭据直连 SSH 必
    "Permission denied (publickey,password)"。供 list_remote_dir / 预览等 handler 在
    收到空凭据时按 host+port 服务端解析补齐(与 sp_resolve 同一套规则, 不经前端)。

    命中: 返回 {auth_type,password,key,passphrase,user?}; 未命中: None(走手工输入)。
    """
    host = (host or "").strip()
    if not host:
        return None
    try:
        port = int(port or 22)
    except (TypeError, ValueError):
        port = 22
    user = (user or "").strip()
    # ① 活跃会话 (同 owner, endpoint 匹配) → 免认证凭据直达
    try:
        from backend import conn_registry as cr
        from backend.auth import active_sessions as _as
        owner = (_as.get(ws) or {}).get("user") or "root"
        for _s in cr.SESSIONS.values():
            if _s.get("host") != host or str(_s.get("port")) != str(port):
                continue
            if _s.get("state") not in ("connected", "connecting"):
                continue
            if owner and _s.get("created_by") != owner:
                continue
            if user and _s.get("user") != user:
                continue
            return {"user": _s.get("user") or user or "root",
                    "auth_type": _s.get("auth_type") or "pass",
                    "password": _s.get("password") or "",
                    "key": _s.get("key") or "",
                    "passphrase": _s.get("passphrase") or ""}
    except Exception as e:
        print(f"[resolve_ssh_creds] session lookup fail: {e}")
    # ② server_profiles 档案 (管理员跨用户, 与 sp_resolve v5.52.0 口径一致)
    try:
        uid = _owner_id(ws)
        from backend.auth import active_sessions as _as
        _admin = ((_as.get(ws) or {}).get("role") == "admin")
        conn = get_conn()
        if _admin:
            row = conn.execute("SELECT * FROM server_profiles WHERE hostname=? AND ssh_port=? "
                               "ORDER BY is_starred DESC, sort_order, name", (host, port)).fetchone()
            if not row:
                row = conn.execute("SELECT * FROM server_profiles WHERE hostname=? "
                                   "ORDER BY is_starred DESC, sort_order, name", (host,)).fetchone()
        else:
            row = conn.execute("SELECT * FROM server_profiles WHERE user_id=? AND hostname=? AND ssh_port=?",
                               (uid, host, port)).fetchone()
            if not row:
                row = conn.execute("SELECT * FROM server_profiles WHERE user_id=? AND hostname=?",
                                   (uid, host)).fetchone()
        if not row:
            return None
        d = _row_dict(row)
        av = d.get("ssh_auth_value") or ""
        if av and str(av).startswith("ENC$"):
            try:
                av = _fdec(av)
            except Exception:
                pass
        pp = d.get("ssh_passphrase") or ""
        if pp and str(pp).startswith("ENC$"):
            try:
                pp = _fdec(pp)
            except Exception:
                pass
        atype = _norm_atype(d.get("ssh_auth_type"))
        # 保险库引用覆盖 (跨机共用凭据)
        try:
            proto_full = _dec_protocols(d["protocols"])
            _cg = (proto_full.get("ssh") or {}).get("credential_guid") or ""
            if _cg:
                v = _cred_lookup(uid, _cg)
                if v:
                    user = v.get("username") or user
                    av = v.get("password") or v.get("private_key") or av
                    pp = v.get("passphrase") or pp
                    atype = "key" if v.get("private_key") else atype
        except Exception:
            pass
        if not av:
            return None
        return {"user": user or d.get("ssh_user") or "root",
                "auth_type": atype,
                "password": av if atype == "pass" else "",
                "key": av if atype == "key" else "",
                "passphrase": pp}
    except Exception as e:
        print(f"[resolve_ssh_creds] profile lookup fail: {e}")
        return None


# ────────────────────────── v5.34.6 · P6 凭据保险库 cred_* ──────────────────────────

_CRED_ENC_COLS = ("password", "private_key", "passphrase")


async def handle_cred_list(ws, data: dict):
    _req = data.get("req_id") or ""
    uid = _owner_id(ws)
    rows = get_conn().execute(
        "SELECT guid,name,type,username,created_at,updated_at FROM credentials "
        "WHERE user_id=? ORDER BY name", (uid,)).fetchall()
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "creds": [dict(r) for r in rows]})


async def handle_cred_save(ws, data: dict):
    _req = data.get("req_id") or ""
    payload = data.get("cred") if isinstance(data.get("cred"), dict) else data
    name = (payload.get("name") or "").strip()
    if not name:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少名称"})
        return
    uid = _owner_id(ws)
    guid = (payload.get("guid") or "").strip() or str(_uuid.uuid4())
    conn = get_conn()
    old = conn.execute("SELECT password,private_key,passphrase FROM credentials WHERE guid=?",
                       (guid,)).fetchone()
    vals = {}
    for col in _CRED_ENC_COLS:
        v = payload.get(col) or ""
        # 留空 → 保留旧密文 (增量语义, 与档案一致)
        if not v and old and old[col]:
            vals[col] = old[col]
        elif v:
            try:
                vals[col] = _fenc(str(v))
            except Exception:
                vals[col] = v
        else:
            vals[col] = ""
    conn.execute("""INSERT OR REPLACE INTO credentials
        (guid, user_id, name, type, username, password, private_key, passphrase, extra_json, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))""",
        (guid, uid, name, payload.get("type") or "ssh", payload.get("username") or "",
         vals["password"], vals["private_key"], vals["passphrase"],
         json.dumps(payload.get("extra") or {}, ensure_ascii=False)))
    conn.commit()
    _audit(ws, "", "cred_save", detail=json.dumps({"name": name}, ensure_ascii=False))
    _publish("cred.changed", {"guid": guid, "action": "save"})
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "guid": guid,
                        "msg": f"✓ 已保存凭据 {name}"})


async def handle_cred_del(ws, data: dict):
    _req = data.get("req_id") or ""
    guid = (data.get("guid") or "").strip()
    conn = get_conn()
    conn.execute("DELETE FROM credentials WHERE guid=? AND user_id=?", (guid, _owner_id(ws)))
    conn.commit()
    _audit(ws, "", "cred_delete", detail=guid[:32])
    _publish("cred.changed", {"guid": guid, "action": "delete"})
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "msg": "✓ 已删除"})


def _storage_sync_to_remote(uid: int, guid: str, name: str,
                            blk: dict = None, delete: bool = False) -> dict:
    """v5.35.1 · 连接中心存储档案 → remote_configs 双写 (能力表)。

    remote_configs 是传输/浏览的能力存储 (三栏☁组/TargetPicker/远端存储页的数据源),
    档案是统一视图。sp_save 写 remote_storage 块时同步:
      - 新建/更新 → upsert remote_configs (uuid 回写档案.remote_uuid)
      - 块删除(null) → safe_delete 链接行 (有引用则保留并在结果中说明)
    返回 {ok, uuid, note}
    """
    out = {"ok": True, "uuid": "", "note": ""}
    try:
        import json as _json
        import time as _time
        from backend import db as _db
        conn = _db.get_conn()
        prof = conn.execute("SELECT remote_uuid, kind FROM server_profiles WHERE guid=?",
                            (guid,)).fetchone()
        if not prof:
            return out
        remote_uuid = prof["remote_uuid"] or ""
        if delete or blk is None:
            if remote_uuid:
                res = _db.safe_delete("remote_configs", remote_uuid)
                if not res.get("ok"):
                    out["ok"] = False
                    out["note"] = f"存储被 {len(res.get('blocked_by', []))} 处引用, 已保留能力条目"
                else:
                    conn.execute("UPDATE server_profiles SET remote_uuid='' WHERE guid=?", (guid,))
                    conn.commit()
            return out
        if not isinstance(blk, dict) or not blk.get("enabled"):
            return out
        fields = {
            "name": (name or "").strip() or (blk.get("endpoint") or "").strip(),
            "provider": (blk.get("provider") or "s3").strip().lower(),
            "endpoint": (blk.get("endpoint") or "").strip(),
            "region": (blk.get("region") or "").strip(),
            "bucket": (blk.get("bucket") or "").strip(),
            "prefix": (blk.get("prefix") or "").strip(),
            "access_key": (blk.get("access_key") or "").strip(),
            "secret_key": (blk.get("secret_key") or "").strip(),
        }
        # 敏感字段留空 → 保留旧值 (先读旧行)
        if remote_uuid:
            old = _db.remote_get(uuid=remote_uuid, decrypt=True)
            if old:
                if not fields["secret_key"]:
                    fields["secret_key"] = old.get("secret_key") or ""
                if not fields["access_key"]:
                    fields["access_key"] = old.get("access_key") or ""
        if remote_uuid:
            row = conn.execute("SELECT id FROM remote_configs WHERE uuid=?",
                               (remote_uuid,)).fetchone()
            if row:
                _db.remote_update(row["id"], uuid=remote_uuid, **{k: v for k, v in fields.items()})
                out["uuid"] = remote_uuid
                return out
        # 新建能力行 (remote_create 生成合法 uuidv7; 勿覆写 — safe_delete 校验 uuid 格式)
        rid = _db.remote_create(uid, fields["name"], fields["provider"],
                                endpoint=fields["endpoint"], region=fields["region"],
                                bucket=fields["bucket"], prefix=fields["prefix"],
                                access_key=fields["access_key"],
                                secret_key=fields["secret_key"])
        _urow = conn.execute("SELECT uuid FROM remote_configs WHERE id=?", (rid,)).fetchone()
        new_uuid = (_urow[0] if _urow else "") or ""
        if new_uuid:
            conn.execute("UPDATE server_profiles SET remote_uuid=? WHERE guid=?", (new_uuid, guid))
            conn.commit()
        out["uuid"] = new_uuid
    except Exception as e:
        out["ok"] = False
        out["note"] = str(e)[:160]
        print(f"[storage_sync] fail: {e}")
    return out


def _cred_lookup(uid: int, guid: str) -> Optional[dict]:
    """保险库条目 → 解密 dict (供 sp_resolve 引用覆盖)。"""
    row = get_conn().execute(
        "SELECT * FROM credentials WHERE guid=? AND user_id=?", (guid, uid)).fetchone()
    if not row:
        return None
    d = dict(row)
    for col in _CRED_ENC_COLS:
        v = d.get(col) or ""
        if v and str(v).startswith("ENC$"):
            try:
                d[col] = _fdec(v)
            except Exception:
                pass
    return d


# ────────────────────────── v5.34.6 · P6 Wake-on-LAN ──────────────────────────

async def handle_sp_wol(ws, data: dict):
    """魔术包唤醒 (纯 Python socket, 零外部依赖)。protocols.wol = {enabled, mac, broadcast}。"""
    _req = data.get("req_id") or ""
    guid = (data.get("guid") or "").strip()
    row = get_conn().execute("SELECT hostname,protocols FROM server_profiles WHERE guid=?",
                             (guid,)).fetchone()
    if not row:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "档案不存在"})
        return
    wol = _parse_protocols(row["protocols"]).get("wol") or {}
    mac = (data.get("mac") or wol.get("mac") or "").strip()
    bcast = (data.get("broadcast") or wol.get("broadcast") or "255.255.255.255").strip()
    if not mac or mac.count(":") != 5:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "无效 MAC (格式 aa:bb:cc:dd:ee:ff)"})
        return
    try:
        pkt = b"\xff" * 6 + bytes.fromhex(mac.replace(":", "").replace("-", "")) * 16
        # broadcast 支持 "host" 或 "host:port" (默认端口 9)
        _bhost, _, _bport = bcast.rpartition(":")
        _baddr = (_bhost or bcast, int(_bport) if _bport.isdigit() else 9)
        import socket as _sock
        s = _sock.socket(_sock.AF_INET, _sock.SOCK_DGRAM)
        s.setsockopt(_sock.SOL_SOCKET, _sock.SO_BROADCAST, 1)
        s.sendto(pkt, _baddr)
        s.close()
        _audit(ws, guid, "wol", detail=f"{mac} → {bcast}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": f"✓ 已发送魔术包 {mac} → {bcast} (主机约 5-20 秒后上线, 可点探测确认)"})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"发送失败: {e}"})


# v6.16.14 · 会话录制三动作已迁至 handlers/vnc_rec.py (随该文件按档位整体剪除; 社区/专业包不保留录制源码)

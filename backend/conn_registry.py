"""Fonriv - 统一连接中心 · 会话注册表 (v5.32.0)

把「连接」从瞬时动作升级为有生命周期的一等实体:
  连接 = ControlMaster 复用通道 + TTL + 状态 + 心跳, 跨页可查可复用。

设计要点 (方案文档: docs/连接中心_评估与方案.md, 用户已拍板):
  · 内存注册表为权威 (socket 随进程存活); 不做 DB 镜像, 杜绝"假已连接"
  · 持续连接上限 7 天 (防 socket 泄漏)
  · 会话按创建用户隔离, 不共享
  · 连接失败自动重试 1 次
  · 双向兼容: 未登记的 endpoint, SSHTarget 走老路径 (不带 ControlPath)
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
import uuid

CM_DIR = "/tmp/fonriv_cm"
MAX_PERSISTENT_SEC = 7 * 86400        # 持续连接上限 7 天
# ═══ v5.60.0 E2-2 · 连接池上限与 LRU 驱逐 (阶段E 结构债, 报告01 §7.2 问题3) ═══
#   背景: ControlMaster 每条 endpoint 一个常驻 ssh 主进程 + unix socket, **没有数量上限**。
#   连 50+ 台主机时文件描述符/进程数会持续膨胀, 且没有地方能看到"当前几条通道"。
#   策略: ①超过上限时按**最近使用时间(LRU)**关闭最久未用的通道(不留孤儿)
#        ②上限可配(应用设置 ssh_max_live_sessions, 默认 30)
#        ③可观测: 存活/上限/驱逐次数/峰值/最久空闲时长
POOL_MAX_DEFAULT = 30
_pool_evicted = {"evicted": 0, "peak": 0}
RETRY_ONCE_DELAY = 2.0                # 连接失败自动重试 1 次 (2s 后)

# session_id -> session dict (内存权威)
SESSIONS: dict = {}


def _sock_dir():
    os.makedirs(CM_DIR, exist_ok=True)
    return CM_DIR


def _sock_path(endpoint: str, owner: str) -> str:
    h = hashlib.sha1(f"{owner}|{endpoint}".encode()).hexdigest()[:12]
    return os.path.join(_sock_dir(), f"cm_{h}.sock")


def _endpoint(host: str, port, user: str) -> str:
    return f"{user}@{host}:{port}"


def _ttl_normalize(ttl_sec) -> int:
    """返回 (ttl_sec, persistent)。持续=0 → 上限 7 天。"""
    try:
        v = int(ttl_sec or 0)
    except (TypeError, ValueError):
        v = 3600
    if v <= 0:
        return MAX_PERSISTENT_SEC, True
    return v, False


def alive(sock_path: str, endpoint: str) -> bool:
    """ControlMaster 是否存活 (ssh -O check, 零开销)。"""
    if not os.path.exists(sock_path):
        return False
    import subprocess
    host = endpoint.split("@", 1)[1] if "@" in endpoint else endpoint
    try:
        r = subprocess.run(
            ["ssh", "-O", "check", "-o", f"ControlPath={sock_path}",
             "-o", "ConnectTimeout=5", host],
            # v5.98.1 · 8s → 3.5s: 这是**本地 mux socket** 的往返(不真连远端), 正常 <100ms;
            # 8s 只会让"控制 socket 已僵死"的会话把连接中心拖到十几秒(实测 conn_list 10.3s)。
            capture_output=True, text=True, timeout=3.5)
        return r.returncode == 0
    except Exception:
        return False


def kill_master(sock_path: str, endpoint: str):
    import subprocess
    host = endpoint.split("@", 1)[1] if "@" in endpoint else endpoint
    try:
        subprocess.run(["ssh", "-O", "exit", "-o", f"ControlPath={sock_path}", host],
                       capture_output=True, timeout=8)
    except Exception:
        pass
    try:
        if os.path.exists(sock_path):
            os.remove(sock_path)
    except Exception:
        pass


def master_opts(host: str, port, user: str) -> list:
    """SSHTarget 集成点: 该 endpoint 有活跃会话 → 返回复用参数, 否则 [] (老路径)。"""
    ep = _endpoint(host, port, user)
    for s in SESSIONS.values():
        if s["endpoint"] == ep and s["state"] == "connected" and os.path.exists(s["control_path"]):
            return ["-o", f"ControlPath={s['control_path']}", "-o", "ControlMaster=no"]
    return []


def pool_limit() -> int:
    """连接池上限 (应用设置 ssh_max_live_sessions, 默认 30; <=0 表示不限)。"""
    try:
        from backend import db as _db
        raw = _db.setting_get("ssh_max_live_sessions", "")
        if raw not in (None, ""):
            iv = int(raw)
            return iv
    except Exception as e:
        logging.debug("conn_registry: 读取 ssh_max_live_sessions 失败, 用默认: %s", e)
    return POOL_MAX_DEFAULT


def _live_sessions() -> list:
    return [x for x in SESSIONS.values() if x.get("state") in ("connected", "connecting")]


def enforce_limit(keep_ep: str = "") -> int:
    """超过上限时按 LRU 驱逐最久未用的通道。返回本次驱逐条数。

    仅在**超限**时动手(不做空闲超时): 用户显式建立的会话(TTL 最长 7 天)不应被静默关掉。
    """
    lim = pool_limit()
    if lim <= 0:
        return 0
    live = _live_sessions()
    _pool_evicted["peak"] = max(_pool_evicted["peak"], len(live))
    n_evict = 0
    while len(live) > lim:
        cands = [x for x in live if x.get("endpoint") != keep_ep]
        if not cands:
            break
        victim = min(cands, key=lambda x: x.get("last_used") or x.get("started_at") or 0)
        try:
            kill_master(victim["control_path"], victim["endpoint"])
        except Exception as e:
            logging.info("conn_registry: 驱逐 kill_master 失败(%s): %s", victim["endpoint"], e)
        victim["state"] = "evicted"
        # 凭据不留在内存里
        for k in ("password", "key", "passphrase"):
            victim[k] = ""
        live.remove(victim)
        _pool_evicted["evicted"] += 1
        n_evict += 1
        logging.info("conn_registry: 连接池超限(%d/%d), 按 LRU 驱逐 %s (末次使用 %.0fs 前)",
                     len(live), lim, victim["endpoint"],
                     time.time() - (victim.get("last_used") or time.time()))
    return n_evict


def pool_stats() -> dict:
    """连接池可观测(供连接中心/核心运行状况)。"""
    now = time.time()
    live = _live_sessions()
    idles = [now - (x.get("last_used") or x.get("started_at") or now) for x in live]
    return {"live": len(live), "limit": pool_limit(), "evicted": _pool_evicted["evicted"],
            "peak": max(_pool_evicted["peak"], len(live)),
            "oldest_idle_sec": int(max(idles)) if idles else 0,
            "total_known": len(SESSIONS)}


def find_session(host: str, port, user: str, owner: str = None):
    ep = _endpoint(host, port, user)
    for s in SESSIONS.values():
        if s["endpoint"] == ep and s["state"] in ("connected", "connecting"):
            if owner is None or s["created_by"] == owner:
                s["last_used"] = time.time()          # v5.60.0 E2-2 · LRU 依据
                return s
    return None


def prepare_key_arg(key: str, passphrase: str, sid: str) -> tuple:
    """v5.90.4 · 把档案里的「密钥」整理成 ssh 可用的 `-i` 参数 (+ 需要时物化内容)。

    修两个实测缺陷 (用户报「连接中心点连接没反应/连上显示离线」的根因之一):
      ① 档案里存的既可能是**密钥内容**(PEM 正文)也可能是**密钥路径**(用户明确要求两种都支持)。
         旧实现把「路径字符串」当内容写进 `/tmp/fonriv_cm/key_<sid>` 再用 `-i` 指向它 →
         ssh 读到的是 21 字节文本 → 报 `Load key "...": error in libcrypto`, 连接必失败
         (实测 192.168.1.90 档案存的就是 `/root/.ssh/id_ed25519`)。
      ② 带**密钥口令**的档案此前是 `pass  # 密钥口令场景走 ssh-agent, MVP 暂不支持` → 永远连不上。
    返回 (ssh 参数列表, 需要注入的环境变量, 临时文件路径或 None)
    """
    args, env_extra, tmp = [], {}, None
    k = (key or "").strip()
    if not k:
        return args, env_extra, tmp
    is_content = k.startswith("-----BEGIN") or "PRIVATE KEY" in k
    path = k
    if is_content:
        try:
            tmp = os.path.join(_sock_dir(), "key_%s" % sid)
            with open(tmp, "w") as f:
                f.write(k if k.endswith("\n") else k + "\n")
            os.chmod(tmp, 0o600)
            path = tmp
        except OSError as e:
            print("[conn_registry] 密钥内容物化失败:", e)
    else:
        path = os.path.expanduser(k)      # 路径形态: 直接用, 不复制 (ssh 自己会报"文件不存在")
    args += ["-i", path]
    if passphrase:
        # v5.90.4 · 口令用 SSH_ASKPASS 喂 (实测 `sshpass -e` 喂不动 ssh 的密钥口令提示:
        #   sshpass 只匹配 "assword", 而提示是 "Enter passphrase for key ..." → 卡住/报
        #   `ssh_askpass: exec(/usr/bin/ssh-askpass): No such file or directory`)。
        #   这里放一个 0700 目录下的极小助手脚本从环境变量取口令: 口令仍只走 env,
        #   不落命令行 (与本项目 SSHPASS 约定一致)。
        env_extra["FONRIV_KEY_PP"] = passphrase
        try:
            helper = os.path.join(_sock_dir(), "askpass.sh")
            if not os.path.isfile(helper):
                with open(helper, "w") as f:
                    f.write("#!/bin/sh\nprintf '%s\\n' \"$FONRIV_KEY_PP\"\n")
                os.chmod(helper, 0o700)
            env_extra["SSH_ASKPASS"] = helper
            env_extra["SSH_ASKPASS_REQUIRE"] = "force"
            env_extra.setdefault("DISPLAY", ":0")     # 旧版 ssh 需 DISPLAY 才走 askpass
        except OSError as e:
            print("[conn_registry] askpass 助手创建失败:", e)
        env_extra["SSHPASS"] = passphrase              # 兜底: 若外层仍用 sshpass 包装
    return args, env_extra, tmp

def _askpass_helper(var_name: str, fname: str) -> str:
    """生成/复用 askpass 助手脚本 (放在 0700 的 CM_DIR 内, 口令只走环境变量, 不落命令行)。"""
    helper = os.path.join(_sock_dir(), fname)
    try:
        if not os.path.isfile(helper):
            with open(helper, "w") as f:
                f.write("#!/bin/sh\nprintf '%%s\\n' \"$%s\"\n" % var_name)
            os.chmod(helper, 0o700)
    except OSError as e:
        print("[conn_registry] askpass 助手创建失败:", e)
    return helper


# ══════════════ 连接建立 / 停止 / 续期 ══════════════

async def open_session(owner: str, host: str, port, user: str,
                       auth_type: str = "pass", password: str = "",
                       key: str = "", passphrase: str = "",
                       ttl_sec=None, name: str = "", config_id=None,
                       progress=None) -> dict:
    """创建 (或复用) 一条连接会话。返回会话 dict。

    失败自动重试 1 次 (用户拍板); 重试仍失败 → state=failed。
    """
    def _say(m, lv="info"):
        if progress:
            try:
                progress(m, lv)
            except Exception:
                pass

    port = str(port or 22)
    ep = _endpoint(host, port, user)
    ttl, persistent = _ttl_normalize(ttl_sec)

    # 去重: 同用户同 endpoint 且活跃 → 直接续期复用
    exist = find_session(host, port, user, owner)
    if exist:
        exist["expires_at"] = time.time() + ttl if not persistent else None
        exist["ttl_mode"] = "persistent" if persistent else "fixed"
        _say(f"复用已有连接 {ep}")
        return exist

    sid = "cs_" + uuid.uuid4().hex[:10]
    sock = _sock_path(ep, owner)
    sess = {
        "session_id": sid, "endpoint": ep, "host": host, "port": str(port),
        "user": user, "name": name or host, "config_id": config_id,
        "state": "connecting", "ttl_mode": "persistent" if persistent else "fixed",
        "ttl_sec": ttl, "started_at": time.time(),
        "expires_at": None if persistent else time.time() + ttl,
        "created_by": owner, "control_path": sock,
        "auth_type": auth_type, "password": password,
        "key": key, "passphrase": passphrase, "latency_ms": None,
        "last_used": time.time(),                 # v5.60.0 E2-2 · LRU
    }
    SESSIONS[sid] = sess
    # v5.60.0 E2-2 · 登记后立刻按上限做 LRU 驱逐(留出名额, 避免 fd/进程无上限膨胀);
    #   放在登记**之后**才能保证"池内绝不长期超过上限"(newest 不会被自己挤掉)。
    try:
        _ev = enforce_limit(keep_ep=ep)
        if _ev:
            _say("连接池超限, 已按 LRU 关闭最久未用的 %d 条通道" % _ev, "warn")
    except Exception as _ee:
        _say("连接池清理失败(继续): %s" % str(_ee)[:80], "warn")
    _say(f"连接 {ep} …")

    async def _create() -> tuple:
        import subprocess
        ssh_args = [
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", f"ControlPath={sock}",
            "-o", f"ControlPersist={ttl}s",
            "-o", "ControlMaster=auto",
            "-o", "ConnectTimeout=12",
            "-p", str(port),
        ]
        # v5.90.4 · 密钥交给 prepare_key_arg: 路径直接用 / 内容物化成 0600 临时文件;
        #   口令用 sshpass -e 喂 ssh 的口令提示 (此前 `pass # MVP 暂不支持` = 带口令档案永远连不上)
        _kargs, _kenv, _ktmp = prepare_key_arg(key, passphrase, sid)
        ssh_args += _kargs
        argv = ["ssh"] + ssh_args + ["-N", "-f", f"{user}@{host}"]
        if auth_type == "pass":
            if not password:
                raise RuntimeError("缺少密码")
            # v1.0.0 · 主连接(master)改用 SSH_ASKPASS 喂口令, **不再套 sshpass**:
            #   sshpass 会给 ssh 建一个 pty; `ssh -N -f` 把自己后台化之后, pty 随 sshpass 退出
            #   而关闭 → 主连接在部分环境(实测 LXC 容器 + systemd 服务, 无 tty)当场死亡。
            #   表现: conn_open 报"✓ 已连接", 紧接着 conn_list 的 `ssh -O check` 就
            #   "Connection refused"(socket 成僵尸) → 卡片/圆点"连上了又变未连接",
            #   传输也要反复重新认证(用户实测环境报障)。
            #   实测同机对比: sshpass 方式 master 秒退; ASKPASS 方式 `Master running` 稳定存活。
            env = {**os.environ,
                   "FONRIV_SSH_PW": password,
                   "SSH_ASKPASS": _askpass_helper("FONRIV_SSH_PW", "askpass_pw.sh"),
                   "SSH_ASKPASS_REQUIRE": "force",
                   "DISPLAY": os.environ.get("DISPLAY", ":0")}
            argv = ["ssh"] + ssh_args + ["-N", "-f", f"{user}@{host}"]
        elif _kenv:
            # v5.90.4 · 密钥口令: 用 SSH_ASKPASS 助手喂 (见 prepare_key_arg), 不再套 sshpass
            env = {**os.environ, **_kenv}
        else:
            env = os.environ.copy()
        t0 = time.time()
        proc = await asyncio.create_subprocess_exec(
            *argv, env=env, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=25)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            raise RuntimeError("连接超时 (25s)")
        rc = proc.returncode or 0
        return rc, (out or b"").decode("utf-8", "replace"), (time.time() - t0) * 1000

    last_err = ""
    for attempt in (1, 2):        # 用户拍板: 固定重试 1 次
        try:
            rc, out, ms = await _create()
            if rc == 0 and os.path.exists(sock):
                sess["state"] = "connected"
                sess["latency_ms"] = int(ms)
                _say(f"✓ 已连接 {ep} ({ms:.0f}ms)")
                return sess
            last_err = (out or f"rc={rc}").strip()[-160:]
        except Exception as e:
            last_err = str(e)[-160:]
        if attempt == 1:
            _say(f"第 1 次连接失败, 自动重试 1 次…", "warn")
            await asyncio.sleep(RETRY_ONCE_DELAY)
    sess["state"] = "failed"
    kill_master(sock, ep)
    _say(f"✗ 连接失败: {last_err}", "error")
    sess["last_error"] = last_err
    return sess


async def close_session(session_id: str, owner: str = None) -> tuple:
    s = SESSIONS.get(session_id)
    if not s:
        return False, "会话不存在"
    if owner and s["created_by"] != owner:
        return False, "无权操作他人会话"
    kill_master(s["control_path"], s["endpoint"])
    s["state"] = "disconnected"
    for _k in ("password", "key", "passphrase"):     # v5.60.0 E2-2 · 关闭即清凭据
        s[_k] = ""
    return True, f"✓ 已停止 {s['endpoint']}"


def renew_session(session_id: str, ttl_sec, owner: str = None) -> tuple:
    s = SESSIONS.get(session_id)
    if not s:
        return False, "会话不存在"
    if owner and s["created_by"] != owner:
        return False, "无权操作他人会话"
    ttl, persistent = _ttl_normalize(ttl_sec)
    s["ttl_mode"] = "persistent" if persistent else "fixed"
    s["expires_at"] = None if persistent else time.time() + ttl
    s["state"] = "connected"
    return True, "✓ 已续期"


def list_sessions(owner: str = None) -> list:
    now = time.time()
    out = []
    for s in SESSIONS.values():
        if owner and s["created_by"] != owner:
            continue
        # 惰性到期评估
        if s["state"] == "connected":
            if s.get("expires_at") and now > s["expires_at"]:
                s["state"] = "expired"
            elif not os.path.exists(s["control_path"]):
                s["state"] = "disconnected"
        remain = None
        if s.get("expires_at"):
            remain = max(0, int(s["expires_at"] - now))
        out.append({k: s.get(k) for k in
                    ("session_id", "endpoint", "host", "port", "user", "name",
                     "state", "ttl_mode", "expires_at", "started_at",
                     "latency_ms", "created_by", "config_id", "last_error")})
        out[-1]["remain_sec"] = remain
    return out


def sweep_expired():
    """scheduler 每 30s tick 调用: 回收到期/死掉的 master。"""
    now = time.time()
    for s in list(SESSIONS.values()):
        if s["state"] != "connected":
            continue
        expired = s.get("expires_at") and now > s["expires_at"]
        dead = not os.path.exists(s["control_path"])
        if expired or dead:
            kill_master(s["control_path"], s["endpoint"])
            s["state"] = "expired" if expired else "disconnected"

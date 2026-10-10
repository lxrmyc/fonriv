"""Fonriv - G 系列安全专项 (v4.84.0)

G2 rclone crypt · G3 S3 lifecycle · G4 MFA TOTP · G5 rclone serve
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import shlex
import shutil
import struct
import time
import uuid

from fastapi import WebSocket, WebSocketDisconnect

from backend import db
from backend.log import log_operation


async def _rclone_cmd(args: str, timeout: int = 60) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_shell(
        f"rclone {args}", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        return proc.returncode or 0, (out or b"").decode("utf-8", "replace")
    except asyncio.TimeoutError:
        try: proc.kill()
        except Exception: pass
        return 1, f"rclone 超时"


# ── G2 rclone crypt ──

async def handle_g2_crypt_create(ws, data: dict):
    _req = data.get("req_id") or ""
    name = (data.get("crypt_name") or "").strip()
    remote_base = (data.get("remote_base") or "").strip()
    password = data.get("password") or ""
    salt = data.get("salt") or ""
    fn_enc = data.get("filename_encryption") or "standard"
    dir_enc = data.get("directory_encryption", True)
    if not name or not remote_base or not password:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "名称/底层remote/密码必填"})
        return
    if not shutil.which("rclone"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "rclone 未安装"})
        return
    _, obs_pw = await _rclone_cmd(f"obscure {shlex.quote(password)}")
    obs_pw = obs_pw.strip()
    _, obs_salt = await _rclone_cmd(f"obscure {shlex.quote(salt or password)}")
    obs_salt = obs_salt.strip()
    config_path = os.path.expanduser("~/.config/rclone/rclone.conf")
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    # v5.28.5 防重: 同名段已存在 (无论类型) 拒绝创建, 防重复段累积
    if os.path.exists(config_path):
        existing = {nm for nm, _ in _parse_conf_sections(config_path)}
        if name in existing:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": f"remote '{name}' 已存在, 请换名或先删除旧条目"})
            return
    with open(config_path, "a") as f:
        f.write("\n" + "\n".join([f"[{name}]", "type = crypt", f"remote = {remote_base}",
                                   f"password = {obs_pw}", f"password2 = {obs_salt}",
                                   f"filename_encryption = {fn_enc}",
                                   f"directory_name_encryption = {'true' if dir_enc else 'false'}"]) + "\n")
    log_operation("rclone crypt", f"创建 {name} → {remote_base}")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "msg": f"crypt remote '{name}' 已创建 · 底层: {remote_base}"})


async def handle_g2_crypt_list(ws, data: dict):
    _req = data.get("req_id") or ""
    _, out = await _rclone_cmd("listremotes", timeout=15)
    remotes = [l.strip().rstrip(":") for l in out.splitlines() if l.strip().endswith(":")]
    config_path = os.path.expanduser("~/.config/rclone/rclone.conf")
    details = []
    if os.path.exists(config_path):
        current = {}
        for line in open(config_path):
            line = line.strip()
            if line.startswith("[") and line.endswith("]"):
                if current: details.append(current)
                current = {"name": line[1:-1], "type": "", "remote": ""}
            elif "=" in line and current is not None:
                k, _, v = line.partition("=")
                if k.strip() == "type": current["type"] = v.strip()
                if k.strip() == "remote": current["remote"] = v.strip()
        if current: details.append(current)
    crypt_count = sum(1 for d in details if d.get("type") == "crypt")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "remotes": details, "crypt_count": crypt_count})


async def handle_g2_crypt_test(ws, data: dict):
    _req = data.get("req_id") or ""
    name = (data.get("crypt_name") or "").strip()
    code, out = await _rclone_cmd(f"lsd {shlex.quote(name + ':')} --max-depth 1 2>&1", timeout=60)
    ok = code == 0 and "error" not in out.lower()
    first = out.strip().splitlines()[0][:80] if out.strip() else ""
    await ws.send_json({"type": "result", "status": "ok" if ok else "error", "req_id": _req,
                        "msg": f"{'✓ 连通' if ok else '✗ 失败'}: {first}"})



# ── v5.22.3 · G2 crypt 编辑/删除 (用户请求: 创建的 crypt remote 可增删改) ──
def _crypt_conf_path() -> str:
    return os.path.expanduser("~/.config/rclone/rclone.conf")


def _parse_conf_sections(path: str) -> list:
    """解析 rclone.conf → [(段名, [原始行...]), ...] (保留其余内容原样)"""
    sections, cur_name, cur_lines = [], None, []
    for line in open(path, encoding="utf-8"):
        t = line.strip()
        if t.startswith("[") and t.endswith("]"):
            if cur_name is not None:
                sections.append((cur_name, cur_lines))
            cur_name, cur_lines = t[1:-1], []
        else:
            if cur_name is None:
                continue  # 段外内容 (注释/空行) 丢弃由重建时的段前缀替代
            cur_lines.append(line.rstrip("\n"))
    if cur_name is not None:
        sections.append((cur_name, cur_lines))
    return sections


def _is_crypt_section(lines: list) -> bool:
    return any(l.strip().startswith("type") and "crypt" in l for l in lines)


async def handle_g2_crypt_delete(ws, data: dict):
    """删除 crypt remote (仅允许删 type=crypt 的段, 防误删底层 remote)。confirm 必须。"""
    _req = data.get("req_id") or ""
    name = (data.get("crypt_name") or "").strip()
    if not name or not data.get("confirm"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "缺少 crypt_name 或未确认 (confirm=true); 删除仅移除本机 rclone 配置, 不动云端数据"})
        return
    path = _crypt_conf_path()
    if not os.path.exists(path):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "rclone.conf 不存在"})
        return
    sections = _parse_conf_sections(path)
    kept, removed = [], False
    for nm, lines in sections:
        if nm == name and _is_crypt_section(lines):
            removed = True
            continue
        kept.append((nm, lines))
    if not removed:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"未找到 crypt remote: {name} (不存在或不是 crypt 类型)"})
        return
    with open(path, "w", encoding="utf-8") as f:
        for nm, lines in kept:
            f.write(f"\n[{nm}]\n" + "\n".join(lines) + "\n")
    log_operation("rclone crypt", f"删除 {name}")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "msg": f"✓ crypt remote '{name}' 已从 rclone.conf 移除 (云端数据不受影响)"})


async def handle_g2_crypt_update(ws, data: dict):
    """编辑 crypt remote: 可改底层 remote / 密码 / salt / 文件名加密模式 (仅 crypt 段)。"""
    _req = data.get("req_id") or ""
    name = (data.get("crypt_name") or "").strip()
    if not name:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 crypt_name"})
        return
    path = _crypt_conf_path()
    if not os.path.exists(path):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "rclone.conf 不存在"})
        return
    sections = _parse_conf_sections(path)
    idx = next((i for i, (nm, lines) in enumerate(sections)
                if nm == name and _is_crypt_section(lines)), -1)
    if idx < 0:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"未找到 crypt remote: {name}"})
        return
    nm, lines = sections[idx]
    def _get(key, default=""):
        for l in lines:
            k, _, v = l.partition("=")
            if k.strip() == key:
                return v.strip()
        return default
    new_remote = (data.get("remote_base") or "").strip() or _get("remote")
    new_pw = data.get("password") or ""
    new_salt = data.get("salt") or ""
    new_fn = (data.get("filename_encryption") or "").strip() or _get("filename_encryption", "standard")
    dir_enc = data.get("directory_encryption")
    if dir_enc is None:
        dir_enc = _get("directory_name_encryption", "true") == "true"
    if not shutil.which("rclone"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "rclone 未安装"})
        return
    if new_pw:
        _, obs_pw = await _rclone_cmd(f"obscure {shlex.quote(new_pw)}")
        obs_pw = obs_pw.strip()
    else:
        obs_pw = _get("password")
    if new_salt:
        _, obs_salt = await _rclone_cmd(f"obscure {shlex.quote(new_salt)}")
        obs_salt = obs_salt.strip()
    else:
        obs_salt = _get("password2")
    new_lines = ["type = crypt", f"remote = {new_remote}", f"password = {obs_pw}",
                 f"password2 = {obs_salt}", f"filename_encryption = {new_fn}",
                 f"directory_name_encryption = {'true' if dir_enc else 'false'}"]
    sections[idx] = (nm, new_lines)
    with open(path, "w", encoding="utf-8") as f:
        for n2, l2 in sections:
            f.write(f"\n[{n2}]\n" + "\n".join(l2) + "\n")
    log_operation("rclone crypt", f"编辑 {name} → {new_remote}")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "msg": f"✓ crypt remote '{name}' 已更新 (改了密码则下次传输生效)"})




# ═══ v5.28.5 · 安全检查 + 端口/服务管理 ═══

async def handle_sec_check(ws, data: dict):
    """自动化安全检查: 端口暴露/认证策略/文件权限/防火墙/SSH 配置等"""
    import asyncio as _aio
    import subprocess as _sp
    _req = data.get("req_id") or ""
    loop = _aio.get_event_loop()

    def _check():
        import os as _os
        findings = []
        score = 100
        seen = set()
        def _add(level, check, advice, cost):
            nonlocal score
            if check in seen: return
            seen.add(check)
            findings.append({"level": level, "check": check, "advice": advice})
            score -= cost
        # ① 开放端口 (IPv4/IPv6 同端口只报一次)
        try:
            ss_out = _sp.run("ss -tlnp", shell=True, capture_output=True, text=True, timeout=10).stdout
            risky = {"3306":"MySQL 限制到 127.0.0.1","5432":"PostgreSQL 限制到 127.0.0.1",
                     "6379":"Redis 限制到 127.0.0.1","27017":"MongoDB","23":"Telnet 应禁用",
                     "111":"rpcbind 如无用建议关闭"}
            exposed = set()
            for line in ss_out.splitlines():
                for port in risky:
                    if f":{port} " in line and "127.0.0.1" not in line and "::1" not in line:
                        exposed.add(port)
            for port in sorted(exposed, key=int):
                _add("high", f"端口 {port} 对外暴露", risky[port], 15)
        except Exception: pass
        # ② SSH
        try:
            ssh = _sp.run("grep -E 'PermitRootLogin|PasswordAuthentication' /etc/ssh/sshd_config 2>/dev/null | grep -v '^#'", shell=True, capture_output=True, text=True, timeout=5).stdout
            if "PermitRootLogin yes" in ssh:
                _add("medium", "SSH 允许 root 直接登录", "改为 prohibit-password", 10)
        except Exception: pass
        # ③ /etc/shadow 权限
        try:
            st = _os.stat("/etc/shadow"); mode = oct(st.st_mode)[-3:]
            if mode not in ("000","600","640"):
                _add("high", f"/etc/shadow 权限 {mode}", "应为 600/640", 10)
        except Exception: pass
        # ④ 防火墙
        fw = "未检测"
        try:
            ufw = _sp.run("ufw status 2>/dev/null", shell=True, capture_output=True, text=True, timeout=5).stdout
            fw = "ufw active" if "active" in ufw else "无防火墙规则"
        except Exception: pass
        if "无" in fw:
            _add("medium", "防火墙未启用", "建议启用 ufw 或 iptables", 10)
        # ⑤ uid=0 非 root
        try:
            for ln in open("/etc/passwd"):
                p2 = ln.strip().split(":")
                if len(p2) >= 3 and int(p2[2]) == 0 and p2[0] != "root":
                    _add("high", f"uid=0 非 root: {p2[0]}", "检查后门账号", 20)
        except Exception: pass
        return {"findings": findings, "score": max(0, min(100, score)), "firewall": fw}

    r = await loop.run_in_executor(None, _check)
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "sec_result": True, **r})


async def handle_sec_ports(ws, data: dict):
    """列出监听端口/服务 (sub=list) 或防火墙规则 (sub=firewall)"""
    import asyncio as _aio
    import subprocess as _sp
    _req = data.get("req_id") or ""
    loop = _aio.get_event_loop()
    def _run():
        if (data.get("sub") or "list") == "firewall":
            st = _sp.run("ufw status 2>/dev/null || echo 'ufw 未安装'", shell=True, capture_output=True, text=True, timeout=10)
            return {"firewall": (st.stdout or "").strip()[:2000]}
        r = _sp.run("ss -tlnp 2>/dev/null", shell=True, capture_output=True, text=True, timeout=10)
        ports = []
        for line in (r.stdout or "").splitlines()[1:]:
            parts = line.split()
            if len(parts) < 4: continue
            addr = parts[3]
            port = addr.rsplit(":", 1)[-1] if ":" in addr else ""
            proc = ""
            for p in parts[5:]:
                if "pid=" in p:
                    proc = p.split(",")[1].rstrip(")") if "," in p else p; break
            if port and port.isdigit():
                ports.append({"port": int(port), "process": proc, "addr": addr})
        ports.sort(key=lambda x: x["port"])
        return {"ports": ports}
    r = await loop.run_in_executor(None, _run)
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "sec_result": True, **r})

# ── G3 S3 lifecycle ──

def _sub_action(data: dict, default: str = "get") -> str:
    """子动作解析: sub_action 优先 (v5.14.0 规范); 兼容旧客户端直接把 get/put 放 action
    (envelope action 被覆盖时路由本就不会到达这里, 到达时 action=路由名 → 回落 default)。"""
    v = (data.get("sub_action") or "").strip().lower()
    if v in ("get", "put", "set"):
        return v
    v = (data.get("action") or "").strip().lower()
    if v in ("get", "put", "set"):
        return v
    return default


async def handle_g3_s3_lifecycle(ws, data: dict):
    _req = data.get("req_id") or ""
    action = _sub_action(data, "get")
    bucket = data.get("bucket") or ""
    if not bucket:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 bucket"})
        return
    if not shutil.which("aws"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "aws-cli 未安装"})
        return
    env = dict(os.environ)
    if data.get("access_key"): env["AWS_ACCESS_KEY_ID"] = data["access_key"]
    if data.get("secret_key"): env["AWS_SECRET_ACCESS_KEY"] = data["secret_key"]
    url_opt = f"--endpoint-url {data['endpoint']}" if data.get("endpoint") else ""
    if action == "get":
        cmd = f"aws s3api get-bucket-lifecycle-configuration --bucket {shlex.quote(bucket)} {url_opt} 2>&1"
        proc = await asyncio.create_subprocess_shell(cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env)
        out, _ = await proc.communicate()
        text = out.decode()
        try:
            import json as _j
            rules = _j.loads(text).get("Rules", [])
        except Exception:
            rules = []
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "rules": rules})
    else:
        rules = {"Rules": [{"ID": data.get("rule_id") or "auto", "Status": "Enabled",
                             "Filter": {"Prefix": data.get("prefix") or ""}}]}
        r0 = rules["Rules"][0]
        if data.get("expire_days"): r0["Expiration"] = {"Days": int(data["expire_days"])}
        if data.get("transition_days") and data.get("storage_class"):
            r0["Transitions"] = [{"Days": int(data["transition_days"]), "StorageClass": data["storage_class"]}]
        tf = f"/tmp/s3_lc_{uuid.uuid4().hex[:6]}.json"
        with open(tf, "w") as f: json.dump(rules, f)
        cmd = f"aws s3api put-bucket-lifecycle-configuration --bucket {shlex.quote(bucket)} --lifecycle-configuration file://{tf} {url_opt} 2>&1; rm -f {tf}"
        proc = await asyncio.create_subprocess_shell(cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env)
        out, _ = await proc.communicate()
        await ws.send_json({"type": "result", "status": "ok" if proc.returncode == 0 else "error",
                            "req_id": _req, "msg": out.decode()[:300]})


# ── G3.5 S3 Object Lock (v5.14.0 · 对象锁 WORM: 模式/保留期图形化+执行) ──

async def handle_g3_object_lock(ws, data: dict):
    _req = data.get("req_id") or ""
    action = _sub_action(data, "get")
    bucket = data.get("bucket") or ""
    if not bucket:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少 bucket"})
        return
    if not shutil.which("aws"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "aws-cli 未安装"})
        return
    env = dict(os.environ)
    if data.get("access_key"): env["AWS_ACCESS_KEY_ID"] = data["access_key"]
    if data.get("secret_key"): env["AWS_SECRET_ACCESS_KEY"] = data["secret_key"]
    url_opt = f"--endpoint-url {data['endpoint']}" if data.get("endpoint") else ""
    if action == "get":
        cmd = f"aws s3api get-object-lock-configuration --bucket {shlex.quote(bucket)} {url_opt} 2>&1"
        proc = await asyncio.create_subprocess_shell(cmd, stdout=asyncio.subprocess.PIPE,
                                                     stderr=asyncio.subprocess.STDOUT, env=env)
        out, _ = await proc.communicate()
        text = out.decode()
        cfg = None
        try:
            cfg = json.loads(text).get("ObjectLockConfiguration")
        except Exception:
            cfg = None
        if proc.returncode != 0 and "ObjectLockConfigurationNotFoundError" in text:
            # 桶存在但从未配置对象锁 → 未启用 (不是错误)
            await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "enabled": False})
            return
        await ws.send_json({"type": "result", "status": "ok" if proc.returncode == 0 else "error",
                            "req_id": _req, "enabled": bool(cfg),
                            "config": cfg, "msg": "" if proc.returncode == 0 else text[:300]})
    elif action == "set":
        mode = (data.get("mode") or "governance").strip().lower()
        days = int(data.get("days") or 0)
        if mode not in ("governance", "compliance") or days <= 0:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": "mode 必须是 governance/compliance, days > 0"})
            return
        lock = {"ObjectLockEnabled": "Enabled",
                "Rule": {"DefaultRetention": {"Mode": mode.capitalize(), "Days": days}}}
        tf = f"/tmp/s3_ol_{uuid.uuid4().hex[:6]}.json"
        with open(tf, "w") as f: json.dump(lock, f)
        cmd = (f"aws s3api put-object-lock-configuration --bucket {shlex.quote(bucket)} "
               f"--object-lock-configuration file://{tf} {url_opt} 2>&1; rm -f {tf}")
        proc = await asyncio.create_subprocess_shell(cmd, stdout=asyncio.subprocess.PIPE,
                                                     stderr=asyncio.subprocess.STDOUT, env=env)
        out, _ = await proc.communicate()
        ok = proc.returncode == 0
        if ok:
            log_operation("S3 Object Lock", f"{bucket} → {mode} {days}天")
        await ws.send_json({"type": "result", "status": "ok" if ok else "error", "req_id": _req,
                            "msg": (f"✓ 对象锁已启用: {mode} 保留 {days} 天 (新写入对象默认受保护)"
                                    if ok else out.decode()[:300])})
    else:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"不支持 action: {action} (get/set)"})


# ── G5 rclone serve ──

_serve_procs = {}

# ── v6.10.0 · 批10: rclone serve 改 **systemd 托管**(修批3 遗留"重启即丢") ──
#   旧实现: asyncio 子进程 + 内存表 —— 服务重启/机器重启后实例全丢, 台账 live 只能报"已不在";
#   现改为生成 `fonriv-serve-<name>.service`(Restart=always + 开机自启),
#   台账 ref 从 pid 换成单元名 → 重启后由 systemd 自动拉起, live 检查走 systemctl。
#   无 systemd 的环境保留旧的内存子进程路径(fallback, 行为与升级前一致)。
_SERVE_UNIT_PREFIX = "fonriv-serve-"


def _serve_unit_name(name: str) -> str:
    safe = re.sub(r"[^a-z0-9-]+", "-", (name or "").lower()).strip("-") or "serve"
    return _SERVE_UNIT_PREFIX + safe[:40] + ".service"


def _serve_unit_path(unit: str) -> str:
    return os.path.join("/etc/systemd/system", unit)


def _systemctl(*args, timeout: int = 60):
    """可 monkeypatch 的 systemctl 包装(单测不打真系统)。返回 (rc, stdout+stderr)。"""
    import subprocess as _sp
    try:
        r = _sp.run(["systemctl", *args], capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return 127, "%s: %s" % (type(e).__name__, e)


def _journal_tail(unit: str, n: int = 6) -> str:
    import subprocess as _sp
    try:
        r = _sp.run(["journalctl", "-u", unit, "-n", str(n), "--no-pager", "-o", "cat"],
                    capture_output=True, text=True, timeout=20)
        return (r.stdout or r.stderr or "").strip()[-400:]
    except Exception as e:
        return str(e)


def _serve_unit_text(proto: str, path: str, port: int, user: str, pw: str,
                     mtls: bool, certs) -> str:
    """生成 systemd 单元。参数经 shlex.quote 防注入/空格路径崩。"""
    import shlex as _shq
    exe = _rclone_bin()          # v6.12.0 · 批12: 优先应用内置组件(可升级解锁 s3/ftp/nfs)
    args = [exe, "serve", proto, path, "--addr", ":%d" % int(port)]
    if user and pw:
        if proto == "s3":
            args += ["--auth-key", "%s,%s" % (user, pw)]      # v6.12.0 · serve s3 的鉴权旗标不同
        else:
            args += ["--user", user, "--pass", pw]
    if mtls and certs:
        args += ["--cert", certs["server_cert"], "--key", certs["server_key"],
                 "--client-ca", certs["ca_cert"]]
    exec_line = " ".join(_shq.quote(str(a)) for a in args)
    return ("[Unit]\n"
            "Description=Fonriv rclone serve (%s :%d)\n"
            "After=network-online.target\nWants=network-online.target\n\n"
            "[Service]\nType=simple\nExecStart=%s\n"
            "Restart=always\nRestartSec=5\n\n"
            "[Install]\nWantedBy=multi-user.target\n"
            % (proto, int(port), exec_line))


def _serve_systemd_ready() -> bool:
    import shutil as _sh
    return bool(_sh.which("systemctl")) and os.path.isdir("/etc/systemd/system")

_SERVE_PROTO_CACHE = {"ts": 0.0, "protos": [], "bin": ""}


def _serve_protos_available() -> tuple:
    """探测可用 serve 协议(委托 _rclone_serve_protos 的单一实现)。

    缓存 10 分钟且**绑定二进制路径**(升级组件换二进制 → 自动重探, 不靠手动清缓存);
    探测失败给保守集(webdav/http) —— 宁可少给选项, 不给点了会报错的选项。
    docker 是卷插件 API, 非终端设备挂载协议 → 排除。
    """
    import time as _t
    binp = _rclone_bin()
    if (_t.time() - _SERVE_PROTO_CACHE["ts"] < 600
            and _SERVE_PROTO_CACHE.get("protos")
            and _SERVE_PROTO_CACHE.get("bin") == binp):
        return tuple(_SERVE_PROTO_CACHE["protos"])
    protos = tuple(p for p in _rclone_serve_protos(binp) if p != "docker")
    if not protos:
        protos = ("webdav", "http")   # 保守兜底
    _SERVE_PROTO_CACHE.update({"ts": _t.time(), "protos": list(protos), "bin": binp})
    return protos


async def handle_g5_serve_protos(ws, data: dict):
    """返回本机 rclone 实际支持的 serve 协议 (供前端下拉动态填充)。"""
    _req = data.get("req_id") or ""
    protos = _serve_protos_available()
    desc = {
        "webdav": "通用 — 鸿蒙/Nextcloud 客户端/多数文件管理器都能挂载",
        "http": "浏览器直接下载 (只读)",
        "sftp": "需要 SSH 客户端 (需配 --user/--pass)",
        "dlna": "电视/投影等媒体设备",
        "restic": "restic 备份仓库端点",
        "ftp": "老设备/相机/扫描仪",
        "nfs": "Linux/macOS 原生挂载",
        "s3": "兼容 S3 的客户端/备份软件",
    }
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "protos": [{"id": p, "label": p, "desc": desc.get(p, "")} for p in protos],
                        "note": ("可用项由本机 rclone 版本决定; 若需要 ftp/nfs/s3, "
                                 "点本页「⬆ 升级 rclone 组件」即可解锁(下载到应用组件目录, 不动系统包)")})


# ═══ v5.24.0 · 零信任传输 (mTLS): 证书自动生成 + 状态 ═══

_MTLS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "mtls")


def ensure_mtls_certs(force: bool = False) -> dict:
    """生成 mTLS 三件套: CA / 服务端证书 (SAN 含本机 IP) / 客户端证书 (10 年)。

    已存在且未 force 则直接返回路径。客户端拿到 ca.crt+client.crt+client.key 后,
    任何标准 HTTP/WebDAV 客户端都能以双向认证接入 (信任边界 = 客户端私钥的分发)。
    """
    import subprocess as _sp
    d = _MTLS_DIR
    os.makedirs(d, exist_ok=True)
    ca_key, ca_crt = os.path.join(d, "ca.key"), os.path.join(d, "ca.crt")
    sv_key, sv_crt = os.path.join(d, "server.key"), os.path.join(d, "server.crt")
    cl_key, cl_crt = os.path.join(d, "client.key"), os.path.join(d, "client.crt")
    need = force or not all(os.path.exists(x) for x in (ca_key, ca_crt, sv_key, sv_crt, cl_key, cl_crt))
    if need:
        try:
            def _run(cmd):
                r = _sp.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
                if r.returncode != 0:
                    raise RuntimeError((r.stderr or r.stdout or "")[:200])
            _run(f'openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Fonriv-mTLS-CA" '
                 f'-keyout {ca_key} -out {ca_crt}')
            # 服务端 SAN: localhost + 本机 IP
            ip = ""
            try:
                import socket as _s
                _s0 = _s.socket(_s.AF_INET, _s.SOCK_DGRAM); _s0.connect(("10.255.255.255", 1))
                ip = _s0.getsockname()[0]; _s0.close()
            except Exception:
                pass
            san = f"IP:127.0.0.1,IP:{ip},DNS:localhost" if ip else "DNS:localhost"
            # /bin/sh 不支持进程替换 → ext 内容先落盘
            ext_file = os.path.join(d, "server.ext")
            with open(ext_file, "w") as ef:
                ef.write(f"subjectAltName={san}\n")
            _run(f'openssl req -newkey rsa:2048 -nodes -subj "/CN=fonriv-server" '
                 f'-keyout {sv_key} -out {d}/server.csr && '
                 f'openssl x509 -req -in {d}/server.csr -CA {ca_crt} -CAkey {ca_key} -days 1825 '
                 f'-extfile {ext_file} -CAcreateserial -out {sv_crt}')
            _run(f'openssl req -newkey rsa:2048 -nodes -subj "/CN=fonriv-client" '
                 f'-keyout {cl_key} -out {d}/client.csr && '
                 f'openssl x509 -req -in {d}/client.csr -CA {ca_crt} -CAkey {ca_key} -days 3650 '
                 f'-CAcreateserial -out {cl_crt}')
            for x in (d,):
                try: os.chmod(x, 0o700)
                except Exception: pass
            for x in (ca_key, sv_key, cl_key):
                try: os.chmod(x, 0o600)
                except Exception: pass
        except Exception as e:
            return {"ok": False, "msg": str(e)}
    return {"ok": True, "dir": d, "ca_cert": ca_crt, "server_cert": sv_crt, "server_key": sv_key,
            "client_cert": cl_crt, "client_key": cl_key}


async def handle_zt_mtls_status(ws, data: dict):
    """mTLS 证书状态 + 客户端接入说明。sub=setup 强制重生成 (confirm)。"""
    _req = data.get("req_id") or ""
    if data.get("sub") == "setup" and not data.get("confirm"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "重新生成证书会使已分发客户端证书失效, 需 confirm=true"})
        return
    info = ensure_mtls_certs(force=bool(data.get("sub") == "setup"))
    if not info.get("ok"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": info.get("msg", "")})
        return
    import subprocess as _sp
    fp = ""
    try:
        r = _sp.run(f'openssl x509 -in {info["ca_cert"]} -noout -fingerprint -sha256',
                    shell=True, capture_output=True, text=True, timeout=10)
        fp = (r.stdout or "").strip().split("=")[-1]
    except Exception:
        pass
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "mtls": True,
                        **{k: info[k] for k in ("ca_cert", "client_cert", "client_key", "server_cert")},
                        "ca_fingerprint": fp,
                        "client_hint": (f"curl --cert {info['client_cert']} --key {info['client_key']} "
                                        f"--cacert {info['ca_cert']} https://<本机>:<端口>/"),
                        "msg": "✓ mTLS 证书就绪 — rclone serve 勾选 mTLS 后仅持客户端证书者可连"})


async def handle_g5_serve_start(ws, data: dict):
    _req = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    proto = (data.get("proto") or "webdav").strip().lower()
    port = int(data.get("port") or 8080)
    name = (data.get("name") or f"serve_{port}").strip()
    user = data.get("user") or ""
    pw = data.get("pass") or ""
    if not path or not os.path.exists(path):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "路径不存在"})
        return
    # v5.20.0 · 阶段5: 面向"异构设备作客户端"的接入场景 (鸿蒙 NEXT 等拿不到块设备,
    #   无法像 Linux 那样被 SSH 纳管; 但它们都能挂载标准协议 → 让设备来访问我们)。
    #
    # ⚠ 可用协议**按本机 rclone 实际能力探测**, 不硬编码 —— 实测本机 rclone
    #   v1.60.1-DEV 只支持 dlna/docker/http/restic/sftp/webdav, **没有 ftp/nfs/s3**
    #   (这几个是更新版 rclone 才加的)。硬编码一张"看起来很全"的清单会让用户
    #   点了之后拿到一个费解的 "unknown flag: --addr", 所以必须探测后再校验。
    _SERVE_PROTO_OK = _serve_protos_available()
    if proto not in _SERVE_PROTO_OK:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"不支持: {proto} (可用: {', '.join(_SERVE_PROTO_OK)})"})
        return
    if name in _serve_procs and _serve_procs[name].returncode is None:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"'{name}' 已在运行"})
        return
    args = ["rclone", "serve", proto, path, "--addr", f":{port}"]
    if user and pw:
        args += ["--user", user, "--pass", pw]
    # v5.24.0 · 零信任传输 (mTLS): 自动生成 CA/服务端/客户端证书并强制双向校验。
    #   客户端必须持有 CA 签发的客户端证书才能连接 (curl --cert/--key 或 rclone --client-cert)。
    if data.get("mtls"):
        cert_info = ensure_mtls_certs()
        if not cert_info.get("ok"):
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": f"mTLS 证书生成失败: {cert_info.get('msg')}"})
            return
        args += ["--cert", cert_info["server_cert"], "--key", cert_info["server_key"],
                 "--client-ca", cert_info["ca_cert"]]
    # v6.10.0 · 批10: systemd 托管优先 —— 启动即开机自启, 重启后自动拉起(修"重启即丢")
    serve_ref = ""
    if _serve_systemd_ready():
        unit = _serve_unit_name(name)
        _rc, out = _systemctl("is-active", unit)
        if (out or "").strip() == "active":
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": f"'{name}' 已在运行({unit})"})
            return
        _certs = cert_info if data.get("mtls") else None
        try:
            with open(_serve_unit_path(unit), "w", encoding="utf-8") as f:
                f.write(_serve_unit_text(proto, path, port, user, pw, bool(data.get("mtls")), _certs))
            os.chmod(_serve_unit_path(unit), 0o644)
        except Exception as e:
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": "写 systemd 单元失败: %s" % e})
            return
        _systemctl("daemon-reload")
        _rc2, _o2 = _systemctl("enable", "--now", unit)
        await asyncio.sleep(1.5)
        _rc3, act = _systemctl("is-active", unit)
        if (act or "").strip() != "active":
            tail = _journal_tail(unit)
            try:
                os.remove(_serve_unit_path(unit))
            except OSError:
                pass
            _systemctl("daemon-reload")
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": "启动失败(%s): %s" % ((act or "").strip(), tail[-300:])})
            return
        serve_ref = unit
        log_operation("rclone serve", f"{proto} :{port} · {path} · unit={unit}")
    else:
        proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.DEVNULL,
                                                     stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
        _serve_procs[name] = proc
        await asyncio.sleep(1)
        if proc.returncode is not None:
            del _serve_procs[name]
            await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "启动失败"})
            return
        serve_ref = str(proc.pid)
        log_operation("rclone serve", f"{proto} :{port} · {path}")
    # v6.4.0 · 批3: 登记统一台账(分享管理页可见; serve 为内存态, 重启后 live 会如实标"已不在")
    try:
        from backend import db as _db
        _db.share_reg_register(
            source_module="security", type="serve",
            name=name, path=path, protocol=proto,
            perm=("ro" if data.get("ro") else "rw"), owner=user or "",
            status="active", ref=serve_ref,
            meta={"port": port, "mtls": bool(data.get("mtls")),
                  "unit": serve_ref.endswith(".service")})
    except Exception as _e:
        print("[security_g] share registry register fail:", _e)
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "msg": ("✓ %s 已启动 · 端口 %d" % (proto, port))
                               + ("(systemd 托管: 开机自启, 重启后自动拉起)" if serve_ref.endswith(".service") else ""),
                        "name": name, "port": port, "unit": serve_ref if serve_ref.endswith(".service") else ""})

async def handle_g5_serve_stop(ws, data: dict):
    _req = data.get("req_id") or ""
    name = (data.get("name") or "").strip()
    stopped = False
    # v6.10.0 · 批10: systemd 单元优先(disable+stop+删单元); name 也接受直接传单元名
    unit = name if name.startswith(_SERVE_UNIT_PREFIX) else _serve_unit_name(name)
    if not unit.endswith(".service"):
        unit += ".service"
    if os.path.exists(_serve_unit_path(unit)):
        _systemctl("disable", "--now", unit)
        try:
            os.remove(_serve_unit_path(unit))
        except OSError:
            pass
        _systemctl("daemon-reload")
        stopped = True
    proc = _serve_procs.pop(name, None)
    if proc:
        try:
            proc.terminate()
        except Exception:
            pass
        stopped = True
    # v6.4.0 · 批3: 台账同步(停止即从清单移除)
    try:
        from backend import db as _db
        for row in _db.share_reg_list(source_module="security", type="serve"):
            if (row.get("name") or "") == name:
                _db.share_reg_remove(int(row["id"]))
    except Exception as _e:
        print("[security_g] share registry stop sync fail:", _e)
    if stopped:
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "msg": "已停止(并取消开机自启)"})
    else:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "未找到"})

async def handle_g5_serve_status(ws, data: dict):
    _req = data.get("req_id") or ""    # v6.10.0 · 批10 FIX: 旧实现连 req_id 都没回(前端永远匹配不到响应)
    rows = []
    try:
        from backend import db as _db
        regs = _db.share_reg_list(source_module="security", type="serve")
    except Exception:
        regs = []
    for r in regs:
        ref = str(r.get("ref") or "")
        meta = r.get("meta") or {}
        unit = ref if ref.startswith(_SERVE_UNIT_PREFIX) else ""
        running = False
        if unit:
            _rc, out = _systemctl("is-active", unit)
            running = (out or "").strip() == "active"
        elif ref.isdigit():
            running = os.path.exists("/proc/%s" % ref)
        rows.append({"name": r.get("name") or "", "proto": r.get("protocol") or "",
                     "port": meta.get("port"), "path": r.get("path") or "",
                     "running": running, "unit": unit, "autostart": bool(unit)})
    for n, p in _serve_procs.items():          # 旧式内存实例(无 systemd 环境/升级前遗留)
        if not any(x.get("name") == n for x in rows):
            rows.append({"name": n, "proto": "", "port": None, "path": "",
                         "running": p.returncode is None, "unit": "", "autostart": False})
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "running": rows})


# ── v6.12.0 · 批12: rclone 组件升级(应用侧自带新二进制, 解锁 s3/ftp/nfs serve; 不动系统包) ──
#   背景: 本机系统 rclone v1.60 只有 dlna/http/sftp/webdav; s3/ftp/nfs 要 1.65+。
#   方案: 从 downloads.rclone.org 下载官方 zip 到**应用自己的组件目录**(data/components/,
#   已随发行排除), 之后 serve 一律优先用内置二进制 —— 可回退(删文件即回系统版), 不碰系统包。
#   组件目录选 /var/lib/fonriv/components(系统标准位置, 仓库外): 天然不进 git/发行包,
#   也避免"dev 仓库里塞 85MB 二进制"; 不可写时回退仓库 data/components。
def _components_dir() -> str:
    cands = [
        "/var/lib/fonriv/components",
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "components"),
    ]
    for d in cands:
        try:
            os.makedirs(d, exist_ok=True)
            return d
        except OSError:
            continue
    return "/tmp/fonriv-components"


_COMPONENTS_DIR = _components_dir()
_RCLONE_BIN = os.path.join(_COMPONENTS_DIR, "rclone")
_RCLONE_URL = "https://downloads.rclone.org/rclone-current-linux-amd64.zip"
_rclone_job = {"state": "none", "lines": [], "version": "", "error": ""}
# v6.12.0 · 重启后把"运行中"的旧任务视为中断(与 fonr job 的 boot 口径一致)


def _rclone_bin() -> str:
    """serve 用 rclone: 优先应用内置组件(可升级), 否则系统 PATH 里的。"""
    if os.path.exists(_RCLONE_BIN) and os.access(_RCLONE_BIN, os.X_OK):
        return _RCLONE_BIN
    import shutil as _sh
    return _sh.which("rclone") or "rclone"


def _rclone_version(bin_path: str = "") -> str:
    import subprocess as _sp
    try:
        r = _sp.run([bin_path or _rclone_bin(), "version"], capture_output=True, text=True, timeout=20)
        return ((r.stdout or "").splitlines() or [""])[0].replace("rclone ", "").strip()
    except Exception:
        return ""


def _rclone_serve_protos(bin_path: str = "") -> list:
    """探测该二进制的 serve 子命令(**单一实现**; 兼容 1.60/1.75 两代 help 文本)。

    实测坑: rclone v1.60 段头是 `Available Commands:`, v1.75 改成小写 `Available commands:`
    —— 旧探测只认大写, 升级组件后解析失败还会给"webdav/http"兜底(表现为"升级了却没有 s3")。
    """
    import subprocess as _sp
    try:
        r = _sp.run([bin_path or _rclone_bin(), "serve", "--help"],
                    capture_output=True, text=True, timeout=20)
        txt = (r.stdout or "") + (r.stderr or "")
        mm = re.search(r"Available commands:\s*\n((?:\s{2,}\S.*\n)+)", txt, re.I)
        if not mm:
            return []
        protos = []
        for line in mm.group(1).splitlines():
            m2 = re.match(r"\s{2,}([a-z0-9]+)\s", line)
            if m2:
                protos.append(m2.group(1))
        return protos
    except Exception:
        return []


# v6.16.1 · 组件状态缓存(60s): status 每次都 spawn rclone --help + version 两个子进程,
#   闸并发下被拖到超时 → 前端永远显示"读取中"。组件不会频繁变, 缓存 60s 足够。
_RCLONE_STATUS_CACHE = {"ts": 0.0, "bin": "", "payload": None}


async def handle_rclone_component_status(ws, data: dict):
    """rclone 组件现状: 版本 / 是否内置 / 可用 serve 协议 / 是否已含 s3。"""
    import time as _t
    _req = data.get("req_id") or ""
    binp = _rclone_bin()
    if (_t.time() - _RCLONE_STATUS_CACHE["ts"] < 60
            and _RCLONE_STATUS_CACHE.get("payload")
            and _RCLONE_STATUS_CACHE.get("bin") == binp):
        payload = dict(_RCLONE_STATUS_CACHE["payload"])
        payload["req_id"] = _req
        await ws.send_json({"type": "result", "status": "ok", **payload})
        return
    import asyncio as _aio
    protos = await _aio.to_thread(_rclone_serve_protos, binp)
    ver = await _aio.to_thread(_rclone_version, binp)
    payload = {"bin": binp, "bundled": binp == _RCLONE_BIN,
               "version": ver, "protos": protos, "has_s3": "s3" in protos,
               "msg": "rclone %s (%s) · 可用 serve: %s"
                      % (ver or "?", "内置" if binp == _RCLONE_BIN else "系统",
                         "/".join(protos) or "?")}
    _RCLONE_STATUS_CACHE.update({"ts": _t.time(), "bin": binp, "payload": dict(payload)})
    await ws.send_json({"type": "result", "status": "ok", **payload})


def _rclone_upgrade_bg():
    job = _rclone_job

    def _say(line):
        job["lines"].append(line)

    try:
        import tempfile as _tf
        import zipfile as _zf
        import urllib.request as _ur
        os.makedirs(_COMPONENTS_DIR, exist_ok=True)
        tmp_zip = os.path.join(_tf.gettempdir(), "fonriv-rclone-%d.zip" % os.getpid())
        _say("开始下载 %s …" % _RCLONE_URL)
        # v6.12.0 · 实测: urllib 在本机对该源会**连接挂起**(无进度无报错, 与 curl 5.9MB/s 的矛盾
        #   由 IPv6/连接选择差异导致) → 优先用 curl(带重试/超时), 无 curl 再回退 urllib。
        import subprocess as _sp2
        import shutil as _sh2
        ok = False
        last_err = ""
        if _sh2.which("curl"):
            for attempt in range(1, 4):
                try:
                    r = _sp2.run(["curl", "-fL", "--retry", "2", "--retry-delay", "2",
                                  "--connect-timeout", "20", "--max-time", "280",
                                  "-o", tmp_zip, _RCLONE_URL],
                                 capture_output=True, text=True, timeout=300)
                    if r.returncode == 0 and os.path.exists(tmp_zip) and os.path.getsize(tmp_zip) > 5 * 1048576:
                        _say("下载完成(%.1f MB)" % (os.path.getsize(tmp_zip) / 1048576.0))
                        ok = True
                        break
                    last_err = "curl rc=%s: %s" % (r.returncode, (r.stderr or "").strip()[:150])
                    _say("第 %d 次下载失败: %s" % (attempt, last_err))
                except Exception as e:
                    last_err = "%s: %s" % (type(e).__name__, e)
                    _say("第 %d 次下载失败: %s" % (attempt, last_err))
        else:
            for attempt in range(1, 4):
                try:
                    req = _ur.Request(_RCLONE_URL, headers={"User-Agent": "fonriv-updater"})
                    with _ur.urlopen(req, timeout=120) as resp, open(tmp_zip, "wb") as f:
                        total = 0
                        while True:
                            chunk = resp.read(256 * 1024)
                            if not chunk:
                                break
                            f.write(chunk)
                            total += len(chunk)
                    _say("下载完成(%.1f MB)" % (total / 1048576.0))
                    ok = True
                    break
                except Exception as e:
                    last_err = "%s: %s" % (type(e).__name__, e)
                    _say("第 %d 次下载失败: %s" % (attempt, last_err))
        if not ok:
            raise RuntimeError("下载失败: %s" % last_err)
        _say("解包并安装到组件目录 …")
        with _zf.ZipFile(tmp_zip) as z:
            member = ""
            for nm in z.namelist():
                if nm.endswith("/rclone"):
                    member = nm
                    break
            if not member:
                raise RuntimeError("zip 内未找到 rclone 可执行文件")
            with z.open(member) as srcf, open(_RCLONE_BIN + ".new", "wb") as dst:
                while True:
                    b = srcf.read(1024 * 1024)
                    if not b:
                        break
                    dst.write(b)
        os.chmod(_RCLONE_BIN + ".new", 0o755)
        ver_rc, ver_out = 0, ""
        import subprocess as _sp
        try:
            vr = _sp.run([_RCLONE_BIN + ".new", "version"], capture_output=True, text=True, timeout=20)
            ver_rc = vr.returncode
            ver_out = ((vr.stdout or "").splitlines() or [""])[0]
        except Exception as e:
            ver_rc, ver_out = 127, str(e)
        if ver_rc != 0:
            raise RuntimeError("新二进制自检失败: %s" % ver_out[:200])
        os.replace(_RCLONE_BIN + ".new", _RCLONE_BIN)
        try:
            os.remove(tmp_zip)
        except OSError:
            pass
        _SERVE_PROTO_CACHE["ts"] = 0                     # 探测缓存作废 → 新协议立即生效
        protos = _rclone_serve_protos(_RCLONE_BIN)
        job["state"] = "ok"
        job["version"] = ver_out.replace("rclone ", "").strip()
        _say("✓ 已升级: %s (可用 serve: %s)" % (job["version"], "/".join(protos) or "?"))
        log_operation("rclone", "组件升级", job["version"])
    except Exception as e:
        try:
            if os.path.exists(_RCLONE_BIN + ".new"):
                os.remove(_RCLONE_BIN + ".new")
        except OSError:
            pass
        job["state"] = "fail"
        job["error"] = "%s: %s" % (type(e).__name__, str(e)[:300])
        _say("✗ 升级失败: %s" % job["error"])
        log_operation("rclone", "组件升级失败", job["error"][:120])


async def handle_rclone_upgrade_start(ws, data: dict):
    """下载并安装新版 rclone 到应用组件目录(需 confirm; 后台线程跑, 轮询 status 看进度)。"""
    _req = data.get("req_id") or ""
    if not data.get("confirm"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "升级需要 confirm=true(将从 downloads.rclone.org 下载官方 linux-amd64 包)"})
        return
    if _rclone_job.get("state") == "running":
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "started": True,
                            "msg": "⏳ 升级任务已在执行中, 请等待完成"})
        return
    _rclone_job.update({"state": "running", "lines": ["开始升级…"], "version": "", "error": ""})
    import threading as _th
    _th.Thread(target=_rclone_upgrade_bg, daemon=True).start()
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "started": True,
                        "msg": "⏳ 正在下载并安装 rclone 组件(约 30MB,视网速 10-60 秒)…"})


async def handle_rclone_upgrade_status(ws, data: dict):
    _req = data.get("req_id") or ""
    j = _rclone_job
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "state": j.get("state") or "none",
                        "lines": (j.get("lines") or [])[-30:],
                        "version": j.get("version") or "",
                        "error": j.get("error") or ""})


# ── G4 MFA TOTP ──

def _totp_verify(secret: str, code: str, window: int = 1) -> bool:
    key = base64.b32decode(secret + "=" * ((8 - len(secret) % 8) % 8))
    counter = int(time.time()) // 30
    for offset in range(-window, window + 1):
        msg = struct.pack(">Q", counter + offset)
        h = hmac.new(key, msg, hashlib.sha1).digest()
        o = h[19] & 0x0F
        val = (struct.unpack(">I", h[o:o+4])[0] & 0x7FFFFFFF) % 1000000
        if f"{val:06d}" == code.strip():
            return True
    return False

async def handle_mfa_setup(ws, data: dict):
    _req = data.get("req_id") or ""
    label = data.get("label") or "Fonriv"
    secret = base64.b32encode(os.urandom(20)).decode("utf-8").rstrip("=")
    uri = f"otpauth://totp/{shlex.quote(label)}?secret={secret}&issuer=Fonriv"
    db.setting_set("mfa_totp_secret", secret)
    db.setting_set("mfa_enabled", "pending")
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "secret": secret, "uri": uri,
                        "msg": "请用 Google Authenticator 扫码, 然后验证 6 位码"})

async def handle_mfa_verify(ws, data: dict):
    _req = data.get("req_id") or ""
    code = (data.get("code") or "").strip()
    secret = db.setting_get("mfa_totp_secret", "")
    if not secret:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "MFA 未配置"})
        return
    if _totp_verify(secret, code):
        if db.setting_get("mfa_enabled") == "pending":
            db.setting_set("mfa_enabled", "true")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "msg": "✓ 验证通过"})
    else:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "✗ 验证码错误"})

async def handle_mfa_status(ws, data: dict):
    enabled = db.setting_get("mfa_enabled", "")
    await ws.send_json({"type": "result", "status": "ok",
                        "mfa_enabled": enabled == "true", "mfa_pending": enabled == "pending",
                        "mfa_configured": bool(db.setting_get("mfa_totp_secret", ""))})

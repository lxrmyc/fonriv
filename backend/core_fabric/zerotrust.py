"""零信任传输基础件 (v5.20.0 · 阶段 5)

目标: 不再假设"内网就是可信的"。在既有 L1/L2/L3 分层之上补两件可落地的东西:

① **主机密钥钉死 (host key pinning)**
   现状: `ssh_opts()` 用的是 `StrictHostKeyChecking=accept-new` —— 这是 TOFU
   (首次信任), 首次连上之后才拒绝变更。问题在于**首次连接本身没有任何校验**,
   内网被投毒(ARP/DNS 欺骗)时会静默连到伪造主机。
   本模块把首次见到的密钥指纹**落库钉死**, 之后每次连接都核对; 变更即告警并拒绝,
   除非管理员显式重新信任。这是"零信任"里成本最低、收益最直接的一步。

② **短时效传输令牌 (transfer token)**
   用途: 让"发起一次传输"这件事本身需要凭证, 而不是"只要能连上就能传"。
   · HMAC-SHA256 签发, 载荷含 scope(源/目标/动作) + 过期时间 + 唯一 id
   · 默认 TTL 120s, 一次性消耗 (nonce 落库防重放)
   · 与 license 门控互补: license 管"这台机器能不能用", 令牌管"这一次动作被授权过"

诚实边界
--------
· 令牌保护的是**控制面**(谁可以下令传输), 不替代数据面加密 (那是 L1/L2 的职责)。
· 主机密钥钉死依赖首次连接可信。**首次连接请在可信网络内完成**, 或预先导入
  known_hosts —— 这一点必须如实告知运维, 不能宣称"完全免疫中间人"。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import time

# 令牌默认有效期 (秒)
TOKEN_TTL = 120
# 钉死记录的存储 (JSON 文件, 0600)
_PIN_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "data", "hostkey_pins.json")
_SECRET_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "data", "zt_secret.key")

_LOCK = None


def _lock():
    global _LOCK
    if _LOCK is None:
        import threading
        _LOCK = threading.Lock()
    return _LOCK


# ═════════════════════════════════════════════════════════════
# 主机密钥钉死
# ═════════════════════════════════════════════════════════════

def _load_pins() -> dict:
    try:
        with open(_PIN_FILE, encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_pins(d: dict) -> None:
    os.makedirs(os.path.dirname(_PIN_FILE), exist_ok=True)
    tmp = _PIN_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, json.dumps(d, ensure_ascii=False, indent=1).encode("utf-8"))
    finally:
        os.close(fd)
    os.replace(tmp, _PIN_FILE)


def _key(host: str, port) -> str:
    return f"{str(host).strip()}:{int(port or 22)}"


def scan_host_key(host: str, port=22, timeout: int = 15) -> dict:
    """用 ssh-keyscan 取远端主机密钥指纹。

    返回 {ok, keytype, fingerprint, raw, msg}
    """
    host = str(host or "").strip()
    if not host:
        return {"ok": False, "msg": "缺少 host"}
    try:
        r = subprocess.run(
            ["ssh-keyscan", "-p", str(int(port or 22)), "-T", str(timeout), host],
            capture_output=True, text=True, timeout=timeout + 8)
        lines = [l for l in (r.stdout or "").splitlines()
                 if l.strip() and not l.startswith("#") and " " in l]
        if not lines:
            return {"ok": False, "msg": f"未取到主机密钥 ({(r.stderr or '').strip()[:120] or '无输出'})"}
        # 优先 ed25519, 其次 rsa/ecdsa (与 OpenSSH 默认偏好一致)
        order = {"ssh-ed25519": 0, "ecdsa-sha2-nistp256": 1, "rsa-sha2-512": 2,
                 "ssh-rsa": 3, "ssh-dss": 9}
        best = sorted(lines, key=lambda l: order.get(l.split()[1] if len(l.split()) > 1 else "", 8))[0]
        parts = best.split()
        keytype = parts[1] if len(parts) > 1 else "?"
        b64 = parts[2] if len(parts) > 2 else ""
        fp = _fingerprint(b64)
        return {"ok": True, "keytype": keytype, "fingerprint": fp,
                "raw": best, "msg": f"{keytype} {fp}"}
    except FileNotFoundError:
        return {"ok": False, "msg": "本机缺少 ssh-keyscan (openssh-client)"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "msg": "ssh-keyscan 超时"}
    except Exception as e:
        return {"ok": False, "msg": f"{type(e).__name__}: {e}"}


def _fingerprint(b64_blob: str) -> str:
    """把 base64 密钥体转成 SHA256:xxx 指纹 (与 ssh-keygen -lf 同格式)。"""
    try:
        raw = base64.b64decode(b64_blob)
        h = hashlib.sha256(raw).digest()
        return "SHA256:" + base64.b64encode(h).decode("ascii").rstrip("=")
    except Exception:
        return ""


def verify_host_key(host: str, port=22, allow_tofu: bool = True,
                    expect_fingerprint: str = "") -> dict:
    """核对主机密钥。

    allow_tofu=True 时: 首次见到的密钥会被**钉死**并放行 (需在可信网络内完成首次连接)。
    allow_tofu=False 时: 未登记即拒绝 (严格模式, 适合生产)。

    返回 {ok, status, msg, fingerprint}
      status: pinned(已登记且一致) | tofu_pinned(首次登记) | mismatch(变更!)
              | unknown(严格模式下未登记) | error
    """
    k = _key(host, port)
    cur = scan_host_key(host, port)
    if not cur.get("ok"):
        return {"ok": False, "status": "error", "msg": cur.get("msg", "取指纹失败")}
    fp = cur["fingerprint"]

    # 调用方显式给了期望指纹 → 直接比对 (证书锁定语义)
    if expect_fingerprint:
        same = hmac.compare_digest(fp, expect_fingerprint.strip())
        return {"ok": same, "status": "pinned" if same else "mismatch",
                "fingerprint": fp, "keytype": cur["keytype"],
                "msg": "指纹一致" if same else
                       f"指纹与期望不符! 期望 {expect_fingerprint[:24]}… 实际 {fp[:24]}…"}

    with _lock():
        pins = _load_pins()
        rec = pins.get(k)
        if not rec:
            if not allow_tofu:
                return {"ok": False, "status": "unknown", "fingerprint": fp,
                        "msg": f"严格模式: {k} 未登记主机密钥, 请先执行一次信任操作"}
            pins[k] = {"fingerprint": fp, "keytype": cur["keytype"],
                       "raw": cur["raw"], "pinned_at": time.time(),
                       "pinned_by": "tofu"}
            _save_pins(pins)
            return {"ok": True, "status": "tofu_pinned", "fingerprint": fp,
                    "keytype": cur["keytype"],
                    "msg": f"首次连接已钉死 {cur['keytype']} {fp}。"
                           f"注意: 首次信任需在可信网络内完成, 否则无法免疫中间人"}
        if hmac.compare_digest(fp, rec.get("fingerprint", "")):
            pins[k]["last_ok"] = time.time()
            _save_pins(pins)
            return {"ok": True, "status": "pinned", "fingerprint": fp,
                    "keytype": cur["keytype"], "msg": "主机密钥与登记一致"}
        return {"ok": False, "status": "mismatch", "fingerprint": fp,
                "keytype": cur["keytype"], "expected": rec.get("fingerprint", ""),
                "msg": (f"⚠ 主机密钥已变更! 登记 {rec.get('fingerprint','')[:24]}… "
                        f"实际 {fp[:24]}… —— 可能是重装系统, 也可能是中间人攻击。"
                        f"确认无误后请显式「重新信任」")}


def list_pins() -> dict:
    return _load_pins()


def trust(host: str, port=22, fingerprint: str = "") -> dict:
    """显式（重新）信任: 用当前实际指纹覆盖登记。"""
    cur = scan_host_key(host, port)
    if not cur.get("ok"):
        return {"ok": False, "msg": cur.get("msg", "取指纹失败")}
    if fingerprint and not hmac.compare_digest(cur["fingerprint"], fingerprint.strip()):
        return {"ok": False, "msg": "当前实际指纹与传入的期望指纹不一致, 拒绝覆盖"}
    k = _key(host, port)
    with _lock():
        pins = _load_pins()
        old = (pins.get(k) or {}).get("fingerprint", "")
        pins[k] = {"fingerprint": cur["fingerprint"], "keytype": cur["keytype"],
                   "raw": cur["raw"], "pinned_at": time.time(), "pinned_by": "manual"}
        _save_pins(pins)
    return {"ok": True, "fingerprint": cur["fingerprint"],
            "msg": f"已信任 {k} → {cur['fingerprint']}" + (f" (原 {old[:24]}…)" if old else "")}


def untrust(host: str, port=22) -> dict:
    k = _key(host, port)
    with _lock():
        pins = _load_pins()
        had = pins.pop(k, None)
        _save_pins(pins)
    return {"ok": True, "msg": f"已移除 {k} 的钉死记录" if had else f"{k} 本来就没有登记"}


# ═════════════════════════════════════════════════════════════
# 短时效传输令牌
# ═════════════════════════════════════════════════════════════

def _secret() -> bytes:
    try:
        with open(_SECRET_FILE, "rb") as f:
            s = f.read()
            if len(s) >= 32:
                return s
    except OSError:
        pass
    os.makedirs(os.path.dirname(_SECRET_FILE), exist_ok=True)
    s = secrets.token_bytes(48)
    fd = os.open(_SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, s)
    finally:
        os.close(fd)
    return s


_USED = {}   # nonce -> 过期时间 (内存防重放; 单机足够)


def issue_token(scope: dict, ttl: int = TOKEN_TTL) -> str:
    """签发传输令牌。scope 例: {"action":"rsync","src":"/a","dst":"/b","host":"1.2.3.4"}"""
    payload = {
        "scope": scope or {},
        "iat": int(time.time()),
        "exp": int(time.time()) + max(10, int(ttl or TOKEN_TTL)),
        "nonce": secrets.token_hex(8),
    }
    body = base64.urlsafe_b64encode(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).decode("ascii").rstrip("=")
    sig = hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).hexdigest()[:32]
    return f"ZT1.{body}.{sig}"


def verify_token(token: str, need_scope: dict = None) -> dict:
    """校验令牌 (签名 + 时效 + 一次性 + 可选 scope 匹配)。"""
    t = (token or "").strip()
    if not t.startswith("ZT1."):
        return {"ok": False, "msg": "令牌格式不正确"}
    parts = t.split(".")
    if len(parts) != 3:
        return {"ok": False, "msg": "令牌格式不正确"}
    _, body, sig = parts
    want = hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(want, sig):
        return {"ok": False, "msg": "令牌签名校验失败"}
    try:
        pad = "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(body + pad).decode("utf-8"))
    except Exception:
        return {"ok": False, "msg": "令牌载荷解析失败"}
    now = int(time.time())
    if now > int(payload.get("exp", 0)):
        return {"ok": False, "msg": f"令牌已过期 ({now - int(payload.get('exp', 0))}s)"}
    n = payload.get("nonce", "")
    # 清理过期 nonce
    for k in [k for k, v in list(_USED.items()) if v < now]:
        _USED.pop(k, None)
    if n in _USED:
        return {"ok": False, "msg": "令牌已被使用过 (防重放)"}
    if need_scope:
        sc = payload.get("scope") or {}
        for k, v in need_scope.items():
            if v is None or v == "":
                continue
            if str(sc.get(k, "")) != str(v):
                return {"ok": False, "msg": f"令牌 scope 不匹配: {k} 期望 {v} 实际 {sc.get(k, '')}"}
    _USED[n] = int(payload.get("exp", 0))
    return {"ok": True, "msg": "令牌有效", "scope": payload.get("scope") or {},
            "exp": payload.get("exp")}


def status() -> dict:
    """供自检页展示的零信任概览。"""
    pins = _load_pins()
    return {
        "pinned_hosts": len(pins),
        "hosts": [{"host": k, "fingerprint": (v.get("fingerprint") or "")[:28] + "…",
                   "keytype": v.get("keytype", ""), "pinned_by": v.get("pinned_by", "")}
                  for k, v in sorted(pins.items())],
        "token_ttl_sec": TOKEN_TTL,
        "policy": "主机密钥首次连接即钉死, 之后每次核对, 变更即拒绝并告警; "
                  "传输动作需短时效一次性令牌。首次信任须在可信网络内完成。",
    }


def known_hosts_for(host: str, port=22) -> str:
    """把已钉死的主机密钥写成临时 known_hosts 文件, 返回路径 (未钉死返回 "")。

    为什么这样做: OpenSSH 不接受"直接传指纹"这种参数, 但接受
    `-o UserKnownHostsFile=<file> -o StrictHostKeyChecking=yes`。
    把钉死的密钥单独写一个文件交给它, 就由 OpenSSH 自己执行强校验
    —— 比我们在旁边"看一眼再放行"更强 (校验在握手内完成, 无 TOCTOU 窗口)。
    """
    rec = (_load_pins() or {}).get(_key(host, port))
    if not rec or not rec.get("raw"):
        return ""
    d = os.path.join(os.path.dirname(_PIN_FILE), "known_hosts_pinned")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, f"{str(host).replace('/', '_')}_{int(port or 22)}")
    line = rec["raw"].strip() + "\n"
    # 内容变了才写 (避免每次连接都动文件)
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == line:
                return path
    except OSError:
        pass
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)
    return path


def pin_mode_for(host: str, port=22) -> str:
    """返回该主机应采用的校验模式: 'pinned' | 'tofu' | ''(未启用)。"""
    rec = (_load_pins() or {}).get(_key(host, port))
    if rec and rec.get("raw"):
        return "pinned"
    try:
        from backend import db
        return "tofu" if (db.setting_get("zt_pin_enable", "0") or "0") == "1" else ""
    except Exception:
        return ""

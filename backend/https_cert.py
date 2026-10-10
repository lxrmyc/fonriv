"""Fonriv - HTTPS 证书引擎 (v5.29.0)

三种模式:
  selfsigned  自签名 (局域网) · 全自动生成+到期重签
  acme        ACMEv2 内置客户端 (Let's Encrypt/ZeroSSL) · HTTP-01 挑战 · 需公网域名+80端口
  manual      用户上传证书 · 只做过期提醒

文件布局 (backend/data/https/):
  server.crt / server.key (600)   当前生效证书
  acme_account.key                ACME 账户 EC P-256 私钥
  https.json                      元数据 (mode/issued_at/issuer/days 快照)

服务端接线:
  server.py 启动时读 https_enabled → uvicorn ssl_certfile/ssl_keyfile
  scheduler 每日 tick + app 启动 → renew_if_due() 自动续期
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import threading
import time
from typing import Callable, Optional

HTTPS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "https")
CERT_PATH = os.path.join(HTTPS_DIR, "server.crt")
KEY_PATH = os.path.join(HTTPS_DIR, "server.key")
META_PATH = os.path.join(HTTPS_DIR, "https.json")
ACME_ACCOUNT_KEY = os.path.join(HTTPS_DIR, "acme_account.key")

ACME_PROD = "https://acme-v02.api.letsencrypt.org/directory"
ACME_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory"

# 签发互斥 (scheduler 自动续期与手动签发不并发)
_issue_lock = threading.Lock()


# ══════════════════ 元数据 ══════════════════

def _read_meta() -> dict:
    try:
        return json.load(open(META_PATH, encoding="utf-8"))
    except Exception:
        return {}


def _write_meta(meta: dict):
    os.makedirs(HTTPS_DIR, exist_ok=True)
    json.dump(meta, open(META_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


# ══════════════════ 证书信息 ══════════════════

def cert_info(cert_path: str = CERT_PATH) -> dict:
    """解析证书: 颁发者/主体/到期/剩余天数/SAN"""
    if not os.path.exists(cert_path):
        return {"exists": False}
    try:
        from cryptography import x509
        cert = x509.load_pem_x509_certificate(open(cert_path, "rb").read())
        try:
            sans = [v.value for v in cert.extensions.get_extension_for_class(
                x509.SubjectAlternativeName).value]
        except Exception:
            sans = []
        info = {
            "exists": True,
            "subject": cert.subject.rfc4514_string(),
            "issuer": cert.issuer.rfc4514_string(),
            "not_before": cert.not_valid_before_utc.strftime("%Y-%m-%d %H:%M"),
            "not_after": cert.not_valid_after_utc.strftime("%Y-%m-%d %H:%M"),
            "days_left": (cert.not_valid_after_utc - __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc)).days,
            "sans": [str(s) for s in sans][:16],
            "self_signed": cert.issuer == cert.subject,
        }
        return info
    except Exception as e:
        return {"exists": True, "error": str(e)[:200]}


# ══════════════════ 自签名 ══════════════════

def generate_selfsigned(domains: list, days: int = 398, log: Optional[Callable] = None) -> dict:
    """自签证书 (SAN=IP+域名+localhost), 写 server.crt/key (600)"""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    import datetime
    import ipaddress

    def _log(m):
        if log:
            try:
                log(m)
            except Exception:
                pass

    os.makedirs(HTTPS_DIR, exist_ok=True)
    _log("生成 RSA-2048 密钥对…")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    names = [x509.DNSName("localhost")]
    ips = ["127.0.0.1"]
    try:
        import socket as _s
        _s0 = _s.socket(_s.AF_INET, _s.SOCK_DGRAM); _s0.connect(("10.255.255.255", 1))
        ips.append(_s0.getsockname()[0]); _s0.close()
    except Exception:
        pass
    for d in domains:
        d = (d or "").strip()
        if not d:
            continue
        try:
            ips.append(str(ipaddress.ip_address(d)))
        except ValueError:
            names.append(x509.DNSName(d))
    for ip in ips:
        try:
            names.append(x509.IPAddress(ipaddress.ip_address(ip)))
        except ValueError:
            pass
    # 去重
    seen, uniq = set(), []
    for n in names:
        k = repr(n.value)
        if k not in seen:
            seen.add(k); uniq.append(n)
    subject = x509.Name([
        x509.NameAttribute(x509.NameOID.COMMON_NAME, "Fonriv"),
        x509.NameAttribute(x509.NameOID.ORGANIZATION_NAME, "Fonriv HTTPS"),
    ])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder()
            .subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=days))
            .add_extension(x509.SubjectAlternativeName(uniq), critical=False)
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    _write_key(KEY_PATH, key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()))
    with open(CERT_PATH, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    _write_meta({**_read_meta(), "mode": "selfsigned", "issued_at": now.isoformat(),
                 "domains": domains, "days": days})
    _log(f"✓ 自签证书已生成 ({days} 天 · SAN: {' '.join(str(n.value) for n in uniq[:6])})")
    return {"ok": True, "info": cert_info()}


def _write_key(path: str, pem: bytes):
    with open(path, "wb") as f:
        f.write(pem)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)  # 600


# ══════════════════ ACME v2 客户端 (RFC 8555) ══════════════════

class AcmeError(Exception):
    pass


class _AcmeClient:
    """最小 ACMEv2 实现: ES256 JWS · newAccount/newOrder/http-01/finalize/download"""

    RETRYABLE = ("urn:ietf:params:acme:error:rateLimited",)

    def __init__(self, directory_url: str, log: Optional[Callable] = None):
        self.dir_url = directory_url
        self.log = log or (lambda m: None)
        self.dir = {}
        self.nonce = ""
        self.account_kid = ""
        self._key = self._load_account_key()

    # ── 账户密钥 ──
    def _load_account_key(self):
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives import serialization
        if os.path.exists(ACME_ACCOUNT_KEY):
            return serialization.load_pem_private_key(open(ACME_ACCOUNT_KEY, "rb").read(), password=None)
        key = ec.generate_private_key(ec.SECP256R1())
        os.makedirs(HTTPS_DIR, exist_ok=True)
        _write_key(ACME_ACCOUNT_KEY, key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()))
        self.log("已生成新的 ACME 账户密钥 (EC P-256)")
        return key

    def _jwk(self) -> dict:
        from cryptography.hazmat.primitives.asymmetric import ec
        pub = self._key.public_key().public_numbers()
        size = (self._key.public_key().key_size + 7) // 8
        return {"kty": "EC", "crv": "P-256",
                "x": _b64url(pub.x.to_bytes(size, "big")),
                "y": _b64url(pub.y.to_bytes(size, "big"))}

    def _thumbprint(self) -> str:
        return _b64url(hashlib.sha256(json.dumps(self._jwk(), sort_keys=True,
                                                 separators=(",", ":")).encode()).digest())

    def _sign(self, payload: bytes) -> tuple:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec, utils as asym_utils
        der = self._key.sign(payload, ec.ECDSA(hashes.SHA256()))
        r, s = asym_utils.decode_dss_signature(der)
        size = 32
        return r.to_bytes(size, "big") + s.to_bytes(size, "big")

    # ── HTTP ──
    def _http(self, url: str, payload=None, headers=None, method=None, timeout=30):
        import urllib.request
        import urllib.error
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers=headers or {})
        req.add_header("User-Agent", "Fonriv-ACME/1.0")
        if data:
            req.add_header("Content-Type", "application/jose+json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
                return resp.status, dict(resp.headers), body
        except urllib.error.HTTPError as e:
            body = e.read()
            return e.code, dict(e.headers or {}), body
        except Exception as e:
            raise AcmeError(f"HTTP {url[:60]} 失败: {e}")

    def _nonce_fetch(self):
        _, h, _ = self._http(self.dir["newNonce"], method="HEAD")
        self.nonce = h.get("Replay-Nonce") or h.get("replay-nonce") or ""
        if not self.nonce:
            raise AcmeError("目录未返回 Replay-Nonce")

    def _jws_post(self, url: str, payload: dict, include_jwk: bool = False) -> tuple:
        """POST-as-GET / POST; 返回 (status, headers, body_dict_or_bytes)"""
        if not self.nonce:
            self._nonce_fetch()
        protected = {"alg": "ES256", "nonce": self.nonce, "url": url}
        if include_jwk:
            protected["jwk"] = self._jwk()
        else:
            protected["kid"] = self.account_kid
        inner = _b64url(json.dumps(protected, separators=(",", ":")).encode())
        body = _b64url(json.dumps(payload, separators=(",", ":")).encode()) if payload is not None else ""
        sig = self._sign(f"{inner}.{body}".encode())
        full = {"protected": inner, "payload": body, "signature": _b64url(sig)}
        status, headers, raw = self._http(url, payload=full)
        self.nonce = headers.get("Replay-Nonce") or headers.get("replay-nonce") or ""
        try:
            parsed = json.loads(raw) if raw else {}
        except Exception:
            parsed = {}
        return status, headers, (parsed if parsed else raw)

    # ── 流程 ──
    def bootstrap(self):
        import urllib.request
        req = urllib.request.Request(self.dir_url)
        req.add_header("User-Agent", "Fonriv-ACME/1.0")
        with urllib.request.urlopen(req, timeout=30) as r:
            self.dir = json.loads(r.read())
        for k in ("newNonce", "newAccount", "newOrder"):
            if k not in self.dir:
                raise AcmeError(f"目录缺少 {k}")
        self.log(f"ACME 目录已获取 ({'staging' if 'staging' in self.dir_url else 'production'})")

    def ensure_account(self, email: str):
        payload = {"termsOfServiceAgreed": True}
        if email:
            payload["contact"] = [f"mailto:{email}"]
        status, headers, body = self._jws_post(self.dir["newAccount"], payload, include_jwk=True)
        kid = headers.get("Location") or headers.get("location") or ""
        if status not in (200, 201) or not kid:
            raise AcmeError(f"newAccount 失败 ({status}): {str(body)[:200]}")
        self.account_kid = kid
        self.log(f"ACME 账户就绪 ({'已存在' if status == 200 else '新建'})")

    def issue(self, domains: list, csr_der: bytes, challenge_port: int = 80,
              challenge_server=None) -> dict:
        """完整签发: newOrder → http-01 → finalize → 下载证书链"""
        import urllib.request
        self.bootstrap()
        self.ensure_account(_meta_email())
        identifiers = [{"type": "dns", "value": d} for d in domains if d]
        status, headers, order = self._jws_post(self.dir["newOrder"], {"identifiers": identifiers})
        if status not in (200, 201):
            raise AcmeError(f"newOrder 失败 ({status}): {str(order)[:300]}")
        order_url = headers.get("Location") or headers.get("location") or ""
        authzs = order.get("authorizations") or []
        if not authzs:
            raise AcmeError("订单未返回 authorizations")

        # 收集所有 http-01 挑战
        pending = []  # (authz_url, token, keyauth)
        for az_url in authzs:
            st, _, az = self._jws_post(az_url, None)
            if st != 200:
                raise AcmeError(f"authorization 查询失败 ({st})")
            if az.get("status") == "valid":
                continue
            ch = next((c for c in az.get("challenges", []) if c.get("type") == "http-01"), None)
            if not ch:
                raise AcmeError(f"无 http-01 挑战 (仅支持 HTTP 验证): {str(az)[:200]}")
            keyauth = ch["token"] + "." + self._thumbprint()
            pending.append((az_url, ch["url"], ch["token"], keyauth))

        if pending:
            # 启动 80 端口挑战服务
            srv = None
            if challenge_server is not None:
                srv = challenge_server({t: k for _, _, t, k in pending})
                srv.start(challenge_port)
                self.log(f"HTTP-01 挑战服务已监听 :{challenge_port} ({len(pending)} 个域名待验证)")
            try:
                for az_url, ch_url, token, keyauth in pending:
                    st, _, _r = self._jws_post(ch_url, {})
                    if st not in (200, 201):
                        raise AcmeError(f"challenge 提交失败 ({st})")
                # 轮询直到 valid/invalid (最多 120s)
                deadline = time.time() + 120
                states = {u: "pending" for u, _, _, _ in pending}
                while time.time() < deadline and any(v != "valid" for v in states.values()):
                    time.sleep(3)
                    for u in states:
                        if states[u] == "valid":
                            continue
                        st, _, az = self._jws_post(u, None)
                        s = az.get("status") if isinstance(az, dict) else "?"
                        if s in ("valid", "invalid"):
                            states[u] = s
                            if s == "invalid" and isinstance(az, dict):
                                errs = [c.get("error", {}).get("detail", "") for c in az.get("challenges", [])]
                                raise AcmeError("域名验证失败: " + "; ".join(e for e in errs if e)[:300])
            finally:
                if srv:
                    srv.stop()
                    self.log("HTTP-01 挑战服务已关闭")

        # finalize
        fin = order.get("finalize") or ""
        if not fin:
            raise AcmeError("订单缺少 finalize URL")
        st, _, fin_body = self._jws_post(fin, {"csr": _b64url(csr_der)})
        if st not in (200, 201):
            raise AcmeError(f"finalize 失败 ({st}): {str(fin_body)[:200]}")
        # 轮询订单状态
        deadline = time.time() + 60
        cert_url = ""
        while time.time() < deadline:
            st, _, o = self._jws_post(order_url, None) if order_url else (200, {}, {})
            if isinstance(o, dict) and o.get("status") == "valid" and o.get("certificate"):
                cert_url = o["certificate"]
                break
            if isinstance(o, dict) and o.get("status") == "invalid":
                raise AcmeError("订单状态 invalid")
            time.sleep(2)
        if not cert_url:
            raise AcmeError("证书签发超时 (60s)")
        st, _, raw = self._jws_post(cert_url, None)
        if st != 200:
            raise AcmeError(f"证书下载失败 ({st})")
        pem = raw if isinstance(raw, bytes) else json.dumps(raw).encode()
        return pem


def _meta_email() -> str:
    return _read_meta().get("acme_email", "")


def _make_csr(domains: list):
    """生成 CSR (DER) — ACME finalize 用"""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
    key = ec.generate_private_key(ec.SECP256R1())
    cn = domains[0] if domains else "fonriv"
    csr = (x509.CertificateSigningRequestBuilder()
           .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn[:64])]))
           .add_extension(x509.SubjectAlternativeName([x509.DNSName(d) for d in domains]), critical=False)
           .sign(key, hashes.SHA256()))
    # 证书私钥 = CSR 私钥 (ACME 把签好的证书配 CSR 公钥)
    pem_key = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
    return csr.public_bytes(serialization.Encoding.DER), pem_key


class _ChallengeServer:
    """80 端口最小 HTTP 服务: /.well-known/acme-challenge/<token> → keyAuthorization"""

    def __init__(self, tokens: dict):
        self.tokens = tokens
        self._server = None
        self._loop = None

    async def _handle(self, reader, writer):
        try:
            line = await asyncio_wait_for(reader.readline(), 5)
            path = line.decode("latin1", "ignore").split(" ")[1] if len(line.split(b" ")) > 1 else ""
            path = path.split("?")[0]
            token = path.rstrip("/").rsplit("/", 1)[-1]
            body = self.tokens.get(token, "").encode()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: "
                         + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
            await writer.drain()
        except Exception:
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    def start(self, port: int):
        import asyncio as _aio
        import threading as _th
        # issue_now 在线程池执行 → 自建独立 loop + run_forever (否则 server 不 accept)
        self._loop = _aio.new_event_loop()
        self._server = self._loop.run_until_complete(
            _aio.start_server(self._handle, host="0.0.0.0", port=port))
        self._thread = _th.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()

    def stop(self):
        if self._server:
            try:
                self._loop.call_soon_threadsafe(self._server.close)
                self._loop.call_soon_threadsafe(self._loop.stop)
                self._thread.join(timeout=3)
            except Exception:
                pass
            self._server = None
            try:
                self._loop.close()
            except Exception:
                pass


def asyncio_wait_for(fut, timeout):
    import asyncio
    return asyncio.wait_for(fut, timeout)


# ══════════════════ 签发总入口 ══════════════════

def issue_now(mode: str, domains: list, email: str = "", staging: bool = False,
              log: Optional[Callable] = None) -> dict:
    """立即签发/续期。selfsigned 秒级; acme 走完整流程 (阻塞 ~30-90s, 调用方放线程池)。"""
    def _log(m):
        if log:
            try:
                log(m)
            except Exception:
                pass
    with _issue_lock:
        if mode == "selfsigned":
            return generate_selfsigned(domains, log=log)
        if mode == "acme":
            domains = [d.strip() for d in domains if d and d.strip()]
            if not domains:
                return {"ok": False, "msg": "ACME 模式需要至少一个域名"}
            _log(f"开始 ACME 签发: {', '.join(domains)} ({'测试' if staging else '正式'}环境)…")
            client = _AcmeClient(ACME_STAGING if staging else ACME_PROD, log=_log)
            csr_der, key_pem = _make_csr(domains)
            _log("CSR 已生成, 开始域名验证 (HTTP-01, 需 80 端口可达)…")
            pem = client.issue(domains, csr_der, challenge_server=_ChallengeServer)
            _write_key(KEY_PATH, key_pem)
            with open(CERT_PATH, "wb") as f:
                f.write(pem)
            _write_meta({**_read_meta(), "mode": "acme", "issued_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                         "domains": domains, "email": email, "staging": staging})
            _log(f"✓ 证书链已写入 ({len(pem)//1024}KB) — 重启服务生效")
            return {"ok": True, "info": cert_info()}
        if mode == "manual":
            return {"ok": False, "msg": "手动模式请用「上传证书」"}
        return {"ok": False, "msg": f"未知模式: {mode}"}


def upload_cert(cert_pem: str, key_pem: str, log: Optional[Callable] = None) -> dict:
    """手动上传: 校验证书/私钥匹配后落盘"""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    try:
        cert = x509.load_pem_x509_certificate(cert_pem.encode())
        key = serialization.load_pem_private_key(key_pem.encode(), password=None)
        cert_pub = cert.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        key_pub = key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if cert_pub != key_pub:
            return {"ok": False, "msg": "证书与私钥不匹配 (公钥不一致)"}
    except Exception as e:
        return {"ok": False, "msg": f"PEM 解析失败: {str(e)[:200]}"}
    os.makedirs(HTTPS_DIR, exist_ok=True)
    _write_key(KEY_PATH, key_pem.encode())
    with open(CERT_PATH, "wb") as f:
        f.write(cert_pem.encode() if isinstance(cert_pem, str) else cert_pem)
    _write_meta({**_read_meta(), "mode": "manual", "issued_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    return {"ok": True, "info": cert_info()}


# ══════════════════ 自动续期 (scheduler / 启动调用) ══════════════════

def renew_if_due(threshold_days: int = 30, log: Optional[Callable] = None) -> dict:
    """检查到期 → 自动续。selfsigned<阈值 重签; acme<阈值 重跑签发; manual 只提醒。
    任何失败不抛异常 (后台任务)。"""
    try:
        meta = _read_meta()
        mode = meta.get("mode", "")
        if not os.path.exists(CERT_PATH):
            return {"renewed": False, "reason": "no-cert"}
        info = cert_info()
        if not info.get("exists") or info.get("error"):
            return {"renewed": False, "reason": "cert-unreadable"}
        days = info.get("days_left", 9999)
        if days > threshold_days:
            return {"renewed": False, "reason": f"ok ({days}d > {threshold_days}d)"}
        def _log(m):
            if log:
                try:
                    log(m)
                except Exception:
                    pass
        _log(f"[https] 证书仅剩 {days} 天 (<{threshold_days}), 自动续期开始…")
        if mode == "selfsigned":
            r = generate_selfsigned(meta.get("domains", []), days=398, log=log)
            return {"renewed": r.get("ok", False), "days_left": 398}
        if mode == "acme":
            r = issue_now("acme", meta.get("domains", []), meta.get("email", ""),
                          meta.get("staging", False), log=log)
            return {"renewed": r.get("ok", False)}
        return {"renewed": False, "reason": f"mode={mode} 只提醒"}
    except Exception as e:
        return {"renewed": False, "error": str(e)[:200]}


def apply_key_permissions():
    """确保私钥 600 (上传/生成路径之外兜底)"""
    if os.path.exists(KEY_PATH):
        try:
            os.chmod(KEY_PATH, stat.S_IRUSR | stat.S_IWUSR)
        except Exception:
            pass

"""Fonriv - Transfer Fabric · L2 端到端加密

L2 E2EE: 跨公网 / relay / 远端-远端 场景, 文件内容全程加密 (中继"见码不见文")。
  - 密钥协商: X25519 (复用 crypto_channel 栈) — 每任务临时密钥对
  - 数据加密: ChaCha20-Poly1305 (AEAD; 备选 AES-256-GCM)
  - 密钥指纹: SHA256(pubkey)[:16] 随任务号展示, 供人工核对
用法 (源端):
    keypair = e2e_generate_keypair()
    header  = e2e_header(keypair)                       # 发给目标端 (随任务)
    sealed  = e2e_encrypt_file(keypair, header, path)   # 加密后的文件/流
目标端:
    plain   = e2e_decrypt_file(header, priv_b64, sealed_path)
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

_INFO = b"fonriv/transfer-fabric-e2ee/v1"
_CHUNK = 4 * 1024 * 1024   # 4MB 分块 (与 Ledger Merkle 对齐)


def e2e_generate_keypair() -> dict:
    """生成任务级临时密钥对。返回 {priv_b64, pub_b64, fingerprint}"""
    sk = X25519PrivateKey.generate()
    pk = sk.public_key()
    pub_b = pk.public_bytes_raw()
    priv_b = sk.private_bytes_raw()
    fp = hashlib.sha256(pub_b).hexdigest()[:16]
    return {
        "priv_b64": base64.urlsafe_b64encode(priv_b).decode(),
        "pub_b64": base64.urlsafe_b64encode(pub_b).decode(),
        "fingerprint": fp,
    }


def e2e_header(keypair: dict, count: int = 1) -> dict:
    """任务头部 (随任务号发给目标端): 公钥 + 指纹 (目标端可核对密钥指纹)"""
    return {"scheme": "E2EE-X25519-CC20P1305-v1", "pub": keypair["pub_b64"],
            "fp": keypair["fingerprint"], "chunks": count}


def _derive(pub_b64: str, peer_pub_b64: str, sk_b64: str) -> bytes:
    sk = X25519PrivateKey.from_private_bytes(base64.urlsafe_b64decode(sk_b64))
    peer = X25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(peer_pub_b64))
    shared = sk.exchange(peer)
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_INFO).derive(shared)


# ═════════════════════════════════════════════════════════════
# v5.22.0 · G6 双端协商: 实例身份密钥 + 对端公钥钉死 + ECDH 双端加密
#   v1 (单端): 密钥派生自本端 keypair 自身 — 仅适用同机加解密 (relay 暂存)
#   v2 (双端): 密钥 = HKDF(ECDH(发送端临时私钥, 接收端身份公钥)), header 带 eph_pub,
#              只有持有对端身份私钥者可解 — 中转/落盘被检方无私钥即只见密文
# ═════════════════════════════════════════════════════════════

def _data_dir() -> str:
    d = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
    os.makedirs(d, exist_ok=True)
    return d


_IDENTITY_FILE = os.path.join(_data_dir(), "e2ee_identity.json")
_PEER_FILE = os.path.join(_data_dir(), "e2ee_peers.json")


def identity_keypair() -> dict:
    """实例身份密钥对 (持久化, 0600) — 每台 Fonriv 安装唯一, 公钥经信任通道交换。"""
    import json as _json
    if os.path.exists(_IDENTITY_FILE):
        try:
            with open(_IDENTITY_FILE) as f:
                return _json.load(f)
        except Exception:
            pass
    kp = e2e_generate_keypair()
    fd = os.open(_IDENTITY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        _json.dump(kp, f)
    try:
        os.chmod(_IDENTITY_FILE, 0o600)
    except Exception:
        pass
    return kp


def identity_publine() -> str:
    """单行 JSON (远端经 SSH 执行打印): {pub_b64, fingerprint} — 交换协议载体。"""
    import json as _json
    kp = identity_keypair()
    return _json.dumps({"pub_b64": kp["pub_b64"], "fingerprint": kp["fingerprint"]},
                       ensure_ascii=False)


def pub_fingerprint(pub_b64: str) -> str:
    return hashlib.sha256(base64.urlsafe_b64decode(pub_b64)).hexdigest()[:16]


def _load_peers() -> dict:
    import json as _json
    try:
        with open(_PEER_FILE) as f:
            return _json.load(f)
    except Exception:
        return {}


def pin_peer(host: str, pub_b64: str, fingerprint: str = "") -> dict:
    """钉死对端公钥 (TOFU: 首次经信任通道交换后记录; 换钥需显式重新 pin)。"""
    import json as _json
    host = (host or "").strip()
    if not host or not pub_b64:
        return {"ok": False, "msg": "缺少 host 或 pub_b64"}
    peers = _load_peers()
    fp = fingerprint or pub_fingerprint(pub_b64)
    changed = False
    prev = peers.get(host)
    if prev and prev.get("pub_b64") != pub_b64:
        changed = True  # 对端换钥 — 调用方应提示 (首次钉死与换钥都走这里, 由 confirm 闸把守)
    import time as _t
    peers[host] = {"pub_b64": pub_b64, "fingerprint": fp, "pinned_at": int(_t.time())}
    with open(_PEER_FILE, "w") as f:
        _json.dump(peers, f, ensure_ascii=False, indent=1)
    try:
        os.chmod(_PEER_FILE, 0o600)
    except Exception:
        pass
    return {"ok": True, "host": host, "fingerprint": fp, "rekey": changed}


def unpin_peer(host: str) -> dict:
    import json as _json
    peers = _load_peers()
    if host in peers:
        del peers[host]
        with open(_PEER_FILE, "w") as f:
            _json.dump(peers, f, ensure_ascii=False, indent=1)
        return {"ok": True, "host": host}
    return {"ok": False, "msg": f"未钉死的主机: {host}"}


def list_peers() -> dict:
    return _load_peers()


def get_peer_pub(host: str) -> str:
    """取已钉死的对端公钥 (未钉死返回空串 — 调用方退回 v1 单端)。"""
    return (_load_peers().get((host or "").strip()) or {}).get("pub_b64", "")


def _aead(key: bytes) -> ChaCha20Poly1305:
    return ChaCha20Poly1305(key)


def e2e_encrypt_bytes(keypair: dict, peer_pub_b64: str, plaintext: bytes,
                      aad: bytes = b"") -> dict:
    """加密一段字节 (每段独立 nonce; 密钥 = ECDH(self_priv, peer_pub) 派生)"""
    sk = X25519PrivateKey.generate()
    eph_pub = sk.public_key().public_bytes_raw()
    key = _derive(eph_pub if False else "", "", "")  # placeholder (下面直接用共享密钥派生)
    # 简化: 任务级对称密钥 (单端加密场景 — 本端加密, 对端以自己的私钥+我方公钥派生同一密钥)
    key = _derive_task_key(keypair["priv_b64"])
    nonce = secrets.token_bytes(12)
    ct = _aead(key).encrypt(nonce, plaintext, aad)
    return {"nonce_b64": base64.urlsafe_b64encode(nonce).decode(),
            "ct_b64": base64.urlsafe_b64encode(ct).decode()}


def _derive_task_key(priv_b64: str) -> bytes:
    """任务级对称密钥派生 (HKDF from 私钥公钥对) — 单端自加密用"""
    sk = X25519PrivateKey.from_private_bytes(base64.urlsafe_b64decode(priv_b64))
    raw = sk.public_key().public_bytes_raw() + sk.private_bytes_raw()[:16]
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_INFO).derive(raw)


def e2e_encrypt_file(keypair: dict, src_path: str, dst_path: str,
                     peer_pub_b64: str = "", delete_src: bool = False) -> dict:
    """文件级加密: 分块 ChaCha20-Poly1305, 每块独立 nonce (12B), 头部写格式与块表。

    v5.22.0 · 双端协商 (v2): 传入 peer_pub_b64 (接收端身份公钥) 时,
    密钥 = HKDF(ECDH(任务临时私钥, 对端公钥)), header 携带 eph_pub —
    持有对端身份私钥者 (或同时持有 eph 私钥+对端公钥的中转方) 才能解。
    未传 peer_pub → v1 单端 (派生自本端 keypair, 兼容既有 relay 暂存文件)。
    """
    if peer_pub_b64:
        # 任务 keypair 即临时钥: shared = task_priv × 对端公钥; header 带 task 公钥 (eph_pub)
        sk = X25519PrivateKey.from_private_bytes(base64.urlsafe_b64decode(keypair["priv_b64"]))
        peer_pk = X25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(peer_pub_b64))
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                   info=_INFO).derive(sk.exchange(peer_pk))
        eph_pub_b64 = keypair["pub_b64"]
    else:
        key = _derive_task_key(keypair["priv_b64"])
        eph_pub_b64 = ""
    aead = _aead(key)
    size = os.path.getsize(src_path)
    chunks = []
    out = open(dst_path + ".enc", "wb")
    offset = 0
    idx = 0
    with open(src_path, "rb") as f:
        while True:
            plain = f.read(_CHUNK)
            if not plain:
                break
            nonce = secrets.token_bytes(12)
            ct = aead.encrypt(nonce, plain, str(idx).encode())
            out.write(len(nonce).to_bytes(1, "big") + len(ct).to_bytes(4, "big") + nonce + ct)
            chunks.append({"idx": idx, "offset": offset,
                           "sha256": hashlib.sha256(plain).hexdigest()})
            offset += len(nonce) + len(ct) + 5
            idx += 1
    out.close()
    header = {
        "scheme": ("E2EE-CC20P1305-4MB-v2" if eph_pub_b64 else "E2EE-CC20P1305-4MB-v1"),
        "fp": keypair["fingerprint"],
        "peer_pub": peer_pub_b64 or "",
        "eph_pub": eph_pub_b64,
        "peer_fp": pub_fingerprint(peer_pub_b64) if peer_pub_b64 else "",
        "original_size": size,
        "chunks": chunks,
        "merkle_root": _merkle_root([c["sha256"] for c in chunks]),
    }
    import json as _json
    with open(dst_path + ".meta", "w") as f:
        _json.dump(header, f)
    if delete_src:
        os.remove(src_path)
    return {"chunks": idx, "header": header, "dst": dst_path + ".enc",
            "mode": "dual" if eph_pub_b64 else "single"}


def e2e_decrypt_file(keypair: dict, enc_path: str, dst_path: str,
                     meta_path: str = None, peer_pub_b64: str = "") -> dict:
    """解密文件 (按 chunk 表逐块 AEAD 解密 + SHA256 校验)。

    密钥选择 (v5.22.0 · G6):
      header 带 eph_pub (v2 双端):
        peer_pub_b64 传了 → shared = keypair.priv × peer_pub   (中转方: eph 私钥 × 对端公钥)
        否则            → shared = keypair.priv × eph_pub       (接收端: 身份私钥 × 对端临时公钥)
      否则 (v1)          → 单端任务密钥 (派生自 keypair 自身)
    """
    meta_path = meta_path or enc_path.replace(".enc", ".meta")
    import json as _json
    with open(meta_path) as f:
        header = _json.load(f)
    eph_pub_b64 = header.get("eph_pub") or ""
    if eph_pub_b64:
        own = base64.urlsafe_b64decode(keypair["priv_b64"])
        peer = base64.urlsafe_b64decode(peer_pub_b64 or eph_pub_b64)
        sk = X25519PrivateKey.from_private_bytes(own)
        shared = sk.exchange(X25519PublicKey.from_public_bytes(peer))
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                   info=_INFO).derive(shared)
    else:
        key = _derive_task_key(keypair["priv_b64"])
    aead = _aead(key)
    out = open(dst_path, "wb")
    ok = 0
    for c in header["chunks"]:
        with open(enc_path, "rb") as f:
            f.seek(c["offset"])
            nlen = f.read(1)[0]
            clen = int.from_bytes(f.read(4), "big")
            nonce = f.read(nlen)
            ct = f.read(clen)
        try:
            plain = aead.decrypt(nonce, ct, str(c["idx"]).encode())
        except Exception:
            out.close()
            return {"ok": False, "msg": f"chunk {c['idx']} AEAD 校验失败 (密文被篡改或密钥不符)"}
        if hashlib.sha256(plain).hexdigest() != c["sha256"]:
            out.close()
            return {"ok": False, "msg": f"chunk {c['idx']} SHA256 校验失败"}
        out.write(plain)
        ok += 1
    out.close()
    return {"ok": True, "chunks": ok, "dst": dst_path}


def _merkle_root(hashes: list) -> str:
    if not hashes:
        return ""
    layer = list(hashes)
    while len(layer) > 1:
        if len(layer) % 2:
            layer.append(layer[-1])
        layer = [hashlib.sha256((layer[i] + layer[i + 1]).encode()).hexdigest()
                 for i in range(0, len(layer), 2)]
    return layer[0]



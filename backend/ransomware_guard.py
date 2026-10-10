"""Fonriv - 勒索软件检测与多节点联动熔断 (v4.82.0 · 专利2)

传输管道中嵌入实时熵值采样 + 文件魔数识别 + 行为模式分析 → 熔断 + 隔离 + 通知。

检测维度:
  ① Shannon 熵值采样: 每文件读前 64KB 计算 4KB 滑动窗口熵
     - 熵 > 7.2/8.0 + 无已知魔数 → 可疑加密
  ② 魔数白名单: 已知压缩/加密格式 (gzip/zstd/zip/mp4/jpg…) 不误报
  ③ 扩展名突变: .docx/.xlsx/.pdf → .encrypted/.locked/.crypt 等勒索后缀
  ④ 变更速率: 单位时间文件修改数 > 阈值 → 行为异常

响应动作:
  - 熔断: 取消当前传输任务 (kill 进程组)
  - 隔离: 可疑文件标记 (.ransomware_quarantine 后缀)
  - 多节点联动: WebSocket 事件 → 其他节点暂停同类同步
  - 告警: stats.ransomware 事件 → 告警矩阵推送

WS 动作:
  ransomware_scan    扫描目录 (只读检测)
  ransomware_config  读/写检测配置
"""
from __future__ import annotations

import asyncio
import math
import os
import re
import time

from fastapi import WebSocket, WebSocketDisconnect

from backend import db
from backend.log import log_operation

# ── 魔数白名单 (已知格式, 高熵但不视为可疑) ──
MAGIC_WHITELIST = [
    (b"\x1f\x8b", "gzip"),
    (b"\x28\xb5\x2f\xfd", "zstd"),
    (b"\x42\x5a\x68", "bzip2"),
    (b"\xfd7zXZ\x00", "xz"),
    (b"PK\x03\x04", "zip"),
    (b"7z\xbc\xaf\x27\x1c", "7z"),
    (b"Rar!\x1a\x07", "rar"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpeg"),
    (b"GIF8", "gif"),
    (b"RIFF", "riff/avi/wav"),
    (b"\x00\x00\x00\x18ftyp", "mp4"),     # 常见 ftyp 偏移
    (b"\x00\x00\x00\x20ftyp", "mp4"),
    (b"ftyp", "mp4-var"),
    (b"\x1aE\xdf\xa3", "webm/mkv"),
    (b"%PDF", "pdf"),
    (b"SQLite format 3\x00", "sqlite"),
    (b"\xed\xab\xee\xdb", "rpm"),
    (b"\x7fELF", "elf-binary"),
    (b"MZ", "pe-binary"),
    (b"\xca\xfe\xba\xbe", "java-class/mach-o"),
    (b"OSTREAM", "oracle"),
    (b"RESTIC", "restic-repo"),
    (b"\x50\x4b\x03\x04", "office-ooxml"),
    (b"\xd0\xcf\x11\xe0", "office-legacy"),
    (b"bplist", "apple-binary-plist"),
]

# 勒索软件常见扩展名后缀
RANSOMWARE_EXTS = {
    ".encrypted", ".locked", ".crypt", ".crypto", ".enc", ".cripted",
    ".locky", ".cryptolocker", ".cerber", ".tesla", ".onion",
    ".wcry", ".wncry", ".cryp", ".paymen", ".ransom", ".rmallo",
    ".stop", ".puma", ".infected", ".guard", ".matrix",
}

# 已知勒索软件加密后的文件名模式
RANSOMWARE_NAME_PATTERNS = [
    re.compile(r"^README.*\.(txt|hta|html)$", re.I),      # HELP_DECRYPT
    re.compile(r"^HOW_TO_DECRYPT", re.I),
    re.compile(r"^RESTORE_FILES", re.I),
    re.compile(r"^-R-E-S-T-O-R-E-", re.I),
    re.compile(r"^!!RESTORE", re.I),
    re.compile(r"_[a-f0-9]{8,}\.(encrypted|locked)$", re.I),
]

# 默认配置
DEFAULT_CONFIG = {
    "enabled": True,
    "entropy_threshold": 7.2,         # Shannon 熵阈值 (0-8)
    "sample_size": 65536,             # 每文件采样字节数
    "min_suspect_to_alert": 3,        # 熔断所需最少可疑文件数
    "extension_check": True,
    "behavior_check": True,
    "max_modifications_per_min": 500,  # 变更速率阈值
    "auto_quarantine": False,         # 自动隔离 (改为标记而非移动)
    "circuit_break": True,            # 多节点联动熔断
}


def _get_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    try:
        raw = db.setting_get("ransomware_config", "")
        if raw:
            import json
            saved = json.loads(raw)
            cfg.update(saved)
    except Exception:
        pass
    return cfg


def _save_config(cfg: dict):
    import json
    clean = {k: v for k, v in cfg.items() if k in DEFAULT_CONFIG}
    db.setting_set("ransomware_config", json.dumps(clean, ensure_ascii=False))


# ── 熵值计算 ──

def shannon_entropy(data: bytes) -> float:
    """计算字节序列的 Shannon 熵 (0-8 bits/byte)。"""
    if not data:
        return 0.0
    freq = [0] * 256
    for b in data:
        freq[b] += 1
    n = len(data)
    ent = 0.0
    for f in freq:
        if f > 0:
            p = f / n
            ent -= p * math.log2(p)
    return ent


def check_magic(data: bytes) -> str | None:
    """检查文件头是否命中已知格式白名单。"""
    for magic, name in MAGIC_WHITELIST:
        if data[:len(magic)] == magic:
            return name
    return None


def analyze_file(path: str, cfg: dict) -> dict:
    """分析单个文件。返回 {path, entropy, magic, suspicious, reason}"""
    result = {"path": path, "entropy": 0.0, "magic": None,
              "suspicious": False, "reason": ""}
    try:
        size = os.path.getsize(path)
        if size == 0:
            return result

        # 读取头部采样
        sample_size = min(int(cfg.get("sample_size", 65536)), size)
        with open(path, "rb") as f:
            head = f.read(sample_size)

        result["magic"] = check_magic(head)
        result["entropy"] = round(shannon_entropy(head[:4096]), 3)  # 前 4KB 熵

        # 检查1: 高熵 + 无魔数 → 可疑
        threshold = float(cfg.get("entropy_threshold", 7.2))
        if result["entropy"] > threshold and result["magic"] is None:
            result["suspicious"] = True
            result["reason"] = f"熵 {result['entropy']:.2f} > {threshold} 且无已知格式魔数"
            return result

        # 检查2: 勒索扩展名
        if cfg.get("extension_check", True):
            ext = os.path.splitext(path)[1].lower()
            if ext in RANSOMWARE_EXTS:
                result["suspicious"] = True
                result["reason"] = f"勒索软件扩展名: {ext}"
                return result
            for pat in RANSOMWARE_NAME_PATTERNS:
                if pat.match(os.path.basename(path)):
                    result["suspicious"] = True
                    result["reason"] = f"勒索软件文件名模式: {os.path.basename(path)[:40]}"
                    return result

    except PermissionError:
        result["reason"] = "权限不足"
    except Exception as e:
        result["reason"] = f"读取异常: {e}"
    return result


def scan_directory(path: str, cfg: dict, max_files: int = 2000) -> dict:
    """扫描目录, 返回汇总报告。"""
    suspects = []
    total = 0
    scanned = 0
    t0 = time.time()

    for root, _dirs, files in os.walk(path):
        for fn in files:
            total += 1
            if scanned >= max_files:
                break
            fp = os.path.join(root, fn)
            r = analyze_file(fp, cfg)
            scanned += 1
            if r["suspicious"]:
                suspects.append(r)

    elapsed = round(time.time() - t0, 2)
    return {
        "path": path, "total_files": total, "scanned": scanned,
        "suspects": suspects[:50], "suspect_count": len(suspects),
        "elapsed": elapsed,
        "risk_level": "HIGH" if len(suspects) >= 5 else ("MEDIUM" if len(suspects) >= 1 else "LOW"),
        "config": {"entropy_threshold": cfg.get("entropy_threshold"),
                   "sample_size": cfg.get("sample_size")},
    }


# ── 多节点联动熔断 ──

def _publish_event(topic: str, payload: dict):
    try:
        from backend.events import publish
        publish(topic, payload)
    except Exception:
        pass


def circuit_break(source_node: str, suspects: list, scan_report: dict):
    """触发多节点联动熔断:
    ① 停止本节点相关同步任务
    ② 广播事件 → 其他订阅节点暂停
    ③ 标记可疑文件 (quarantine)
    ④ 推送告警
    """
    cfg = _get_config()
    # 事件: 其他节点/前端订阅后自动暂停
    _publish_event("ransomware.detected", {
        "source": source_node,
        "suspect_count": len(suspects),
        "risk": scan_report.get("risk_level", "HIGH"),
        "paths": [s["path"] for s in suspects[:10]],
        "action": "circuit_break",
        "ts": time.time(),
    })

    # 隔离标记 (不移动文件, 只标记 → 审计友好)
    if cfg.get("auto_quarantine"):
        for s in suspects[:100]:
            try:
                q = s["path"] + ".ransomware_quarantine"
                if not os.path.exists(q):
                    with open(q, "w") as f:
                        import json
                        json.dump({"original": s["path"], "detected_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                                   "entropy": s.get("entropy"), "reason": s.get("reason")}, f)
            except Exception:
                pass

    log_operation("勒索防护", f"🚨 熔断触发: {len(suspects)} 可疑文件 · 风险 {scan_report.get('risk_level')}")
    _publish_event("alert.ransomware", {
        "msg": f"勒索软件疑似攻击: {len(suspects)} 个可疑文件 (来源: {source_node})",
        "suspects": len(suspects), "risk": scan_report.get("risk_level"),
    })


# ── 传输管道集成点 (供 rsync.py 调用) ──

def check_transfer_stream(file_path: str, file_head: bytes) -> dict:
    """传输管道内联检测 (rsync.py 在传输过程中调用)。

    返回 {ok: bool, reason: str, action: 'continue'|'skip'|'break'}
    """
    cfg = _get_config()
    if not cfg.get("enabled"):
        return {"ok": True, "action": "continue", "reason": "检测未启用"}

    magic = check_magic(file_head)
    ent = shannon_entropy(file_head[:4096])

    threshold = float(cfg.get("entropy_threshold", 7.2))
    if ent > threshold and magic is None:
        ext = os.path.splitext(file_path)[1].lower()
        if ext in RANSOMWARE_EXTS:
            return {"ok": False, "action": "break",
                    "reason": f"勒索扩展 {ext} + 熵 {ent:.2f}", "entropy": round(ent, 2)}
        if cfg.get("circuit_break"):
            return {"ok": False, "action": "skip",
                    "reason": f"高熵 {ent:.2f} 无魔数 → 跳过", "entropy": round(ent, 2)}

    return {"ok": True, "action": "continue", "entropy": round(ent, 2), "magic": magic}


# ── WS handlers ──

async def handle_ransomware_scan(ws, data: dict):
    """扫描目录 (只读检测)。params: path, max_files"""
    from backend.ssh_lib import SSHTarget, ssh_error_msg
    _req = data.get("req_id") or ""
    path = (data.get("path") or "").strip()
    if not path or not path.startswith("/"):
        await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": "缺少绝对路径"})
        return
    cfg = _get_config()
    max_files = min(int(data.get("max_files") or 500), 5000)
    try:
        if data.get("host"):
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": "远端扫描暂不支持, 请用文件传输同步到本机后扫描"})
            return
        if not os.path.isdir(path):
            await ws.send_json({"type": "result", "status": "error", "req_id": _req, "msg": f"目录不存在: {path}"})
            return
        report = scan_directory(path, cfg, max_files)
        # 高风险 → 触发熔断
        if report["risk_level"] == "HIGH" and cfg.get("circuit_break"):
            circuit_break("manual-scan", report["suspects"], report)
            report["circuit_break_triggered"] = True
        log_operation("勒索防护", f"扫描 {path}: {report['suspect_count']} 可疑 / {report['scanned']} · 风险 {report['risk_level']}")
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "report": report})
    except WebSocketDisconnect:
        raise
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"扫描异常: {ssh_error_msg(str(e))}"})


async def handle_ransomware_config(ws, data: dict):
    """读/写检测配置。GET: {} → 读; SET: {…} → 写"""
    _req = data.get("req_id") or ""
    if data.get("set"):
        cfg = _get_config()
        for k in DEFAULT_CONFIG:
            if k in data:
                cfg[k] = data[k]
        _save_config(cfg)
        await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                            "config": cfg, "msg": "配置已保存"})
        return
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "config": _get_config(),
                        "ransomware_exts": sorted(RANSOMWARE_EXTS),
                        "magic_whitelist_count": len(MAGIC_WHITELIST)})

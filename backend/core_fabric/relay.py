"""Fonriv - Transfer Fabric P5 · Relay 中转方向 (正式接线)

场景: 源端点与目标端点无法直连 (隔离网段/双NAT/无固定IP), 但**双方都能连到本控制面所在机器**。
数据通路: src --pull--> 本机临时区 --push--> dst

动作:
  relay_transfer  { src: Endpoint描述符, dst: Endpoint描述符, selection?, ... }
    → 两段 TransferSpec (pull + push) 依次执行, 每段走对应 Provider
  relay_status    { relay_id }   → 查询中转状态/账本

数据结构: /tmp/transfer_fabric_relay/<relay_id>/ 为中转暂存区
"""
from __future__ import annotations

import asyncio
import os
import shlex
import time
import uuid

from fastapi import WebSocket

from backend.log import log_operation

_RELAY_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "data", "relay_staging")  # v5.11.0 · 数据盘 (tmpfs 太小)


def _relay_dir(relay_id: str) -> str:
    d = os.path.join(_RELAY_ROOT, relay_id)
    os.makedirs(d, exist_ok=True)
    return d


# ── 端点描述符 → SSH 凭据字段 (复用 ws data 的 SSHTarget 通路) ──

def _relay_e2ee_encrypt(stage_root: str, peer_pub_b64: str = "") -> dict:
    """v5.14.0 · P4.5: 暂存区静态加密 — pull 完成后逐文件 e2ee 加密 (ChaCha20-Poly1305
    分块 + Merkle), 原文即删。push 前再解密。中转机崩溃/落盘被检时只见密文。
    v5.22.0 · G6 双端协商: 传入已钉死的对端 (接收端) 身份公钥 → v2 ECDH 派生,
    接收端凭自己身份私钥即可解; 未交换 → v1 单端 (本机 task keypair)。"""
    from backend.core_fabric import e2ee as _e2
    kp = _e2.e2e_generate_keypair()
    n = 0
    for r, _dirs, fs in os.walk(stage_root):
        for fn in fs:
            if fn.endswith(".enc") or fn.endswith(".meta"):
                continue
            fp = os.path.join(r, fn)
            _e2.e2e_encrypt_file(kp, fp, fp, peer_pub_b64=peer_pub_b64, delete_src=True)
            n += 1
    return {"files": n, "fingerprint": kp["fingerprint"], "keypair": kp,
            "mode": "dual" if peer_pub_b64 else "single", "peer_pub": peer_pub_b64}


def _relay_e2ee_decrypt(keypair: dict, stage_root: str, plain_root: str,
                        peer_pub_b64: str = "") -> dict:
    """push 前: 镜像解密 stage → plain (逐块 AEAD+SHA256 校验, 一块失败即整体失败)。
    v2 双端文件: 中转方以 (task 私钥 × 对端公钥) 派生同一 shared secret。"""
    from backend.core_fabric import e2ee as _e2
    n = 0
    for r, _dirs, fs in os.walk(stage_root):
        for fn in fs:
            if not fn.endswith(".enc"):
                continue
            fp = os.path.join(r, fn)
            rel = os.path.relpath(fp, stage_root)[:-len(".enc")]
            out = os.path.join(plain_root, rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            res = _e2.e2e_decrypt_file(keypair, fp, out, peer_pub_b64=peer_pub_b64)
            if not res.get("ok"):
                return {"ok": False, "msg": res.get("msg", ""), "files": n}
            n += 1
    return {"ok": True, "files": n}


def _ep_ssh_fields(ep: dict) -> dict:
    """从端点描述符提取 SSH 字段 (host 为本机回环 → 返回 {} = 本机通路)"""
    host = (ep.get("host") or "").strip()
    low = host.lower()
    if not host or low in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
        return {}
    return {"host": host, "port": str(ep.get("port") or 22),
            "user": ep.get("user") or "root", "auth_type": ep.get("auth_type") or "pass",
            "password": ep.get("password") or "", "key": ep.get("key") or "",
            "passphrase": ep.get("passphrase") or ""}


async def _rsync_run(src: str, dst: str, ssh_fields: dict, side: str,
                      flags: list, task_id: str) -> dict:
    """执行一段 rsync。side='src' 表示从 src 机 pull; 'dst' 表示向 dst 机 push。本机侧直接 argv。"""
    from backend.ssh_lib import SSHTarget
    from backend.ssh_lib.runner import SSHRunner

    if not ssh_fields:
        argv = ["rsync"] + flags + [src, dst]
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        out, _ = await proc.communicate()
        return {"rc": proc.returncode or 0, "out": out.decode("utf-8", "replace")[-2000:]}

    target = SSHTarget.from_ws_data(ssh_fields)
    if side == "src":
        # src 在远端 → pull 到本机
        runner = target.runner()
        argv, _ = runner.build_rsync_argv("down", src, dst, flags)
    else:
        # dst 在远端 → push 到远端
        # v5.20.1 · FIX: 参数顺序。build_rsync_argv(direction, src, dst) 的约定是
        #   "up" → src=本地、dst=远端(会拼成 user@host:dst)。此处原本写成 ("up", dst, src),
        #   把远端路径当成了本地源、把本地暂存目录拼成了远端目标, 于是第二段必然失败
        #   (实测报 change_dir "<暂存目录>" failed: No such file or directory)。
        #   这是 relay 两段式中转一直跑不通的直接原因, 也连带让依赖它的跨机传输失效。
        runner = target.runner()
        argv, _ = runner.build_rsync_argv("up", src, dst, flags)
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        env=runner._base_env())
    out, _ = await proc.communicate()
    return {"rc": proc.returncode or 0, "out": out.decode("utf-8", "replace")[-2000:]}


async def handle_relay_transfer(ws, data: dict):
    """relay 中转传输 (两端均无法直连时)。
    params:
      src: {host?, path, port?, user?, auth_type?, password?, key?, passphrase?}
      dst: {host?, path, port?, user?, auth_type?, password?, key?, passphrase?}
      exclude?: 逗号分隔
    流程: relay_id → pull(src→本机) → push(本机→dst) → 清理 → 对账
    """
    _req = data.get("req_id") or ""
    src_ep = data.get("src") or {}
    dst_ep = data.get("dst") or {}
    src_path = (src_ep.get("path") or "").strip().rstrip("/")
    dst_path = (dst_ep.get("path") or "").strip().rstrip("/")
    if not src_path or not dst_path:
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": "缺少 src.path 或 dst.path (不允许为空, 防止误中转整盘)"})
        return

    relay_id = "relay_" + str(int(time.time())) + "_" + uuid.uuid4().hex[:6]
    relay_dir = _relay_dir(relay_id)
    flags = ["-a", "--partial", "--info=progress2"]
    if data.get("exclude"):
        for pat in str(data["exclude"]).split(","):
            if pat.strip():
                flags += ["--exclude", pat.strip()]

    from backend.core_fabric import runlog
    run_id = "relay_" + uuid.uuid4().hex[:8]
    runlog.start_run(run_id, "relay", label=f"relay {src_path} → {dst_path}",
                     src=src_path, dst=dst_path, engine="relay_2hop")

    src_fields = _ep_ssh_fields(src_ep)
    dst_fields = _ep_ssh_fields(dst_ep)

    log_operation("中转传输", f"开始 {relay_id}: {src_path} → {dst_path}")

    # 第 1 段: pull src → 本机 (src 有 host → SSH pull; 本机 → 直接 cp/rsync local)
    pull_dst = os.path.join(relay_dir, "stage")
    # v5.20.1 · FIX: 暂存目录必须先建出来。否则单个文件源 pull 到不存在的 "stage" 时,
    #   rsync 会把它落成一个**名为 stage 的文件**(而非目录), 后续
    #   "暂存区加密 N 文件" 得到 0、push 又拿到文件路径 → 第二段必然失败。
    os.makedirs(pull_dst, exist_ok=True)
    if src_fields:
        pull = await _rsync_run(src_path, pull_dst, src_fields, "src", flags, relay_id)
    else:
        pull = await _rsync_run(src_path, pull_dst, {}, "src", flags, relay_id)

    if pull["rc"] != 0:
        import shutil as _shc
        _shc.rmtree(relay_dir, ignore_errors=True)   # v5.11.0 · 失败也清理暂存
        runlog.update_run(run_id, status="failed", finished=True,
                          stats={"error": pull["out"][-200:], "stage": "pull"})
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"第 1 段 (pull) 失败: {pull['out'][-200:]}"})
        return

    # v5.19.4 · L2 接线: 由 Planner 决策 (中转路径 → 强制 L2), 也可显式 e2ee=true 覆盖
    _kp = None
    _use_l2 = bool(data.get("e2ee"))
    _l2_reason = "请求方显式 e2ee=true" if _use_l2 else ""
    if not _use_l2:
        try:
            from backend.core_fabric.planner import Planner
            from backend.core_fabric.providers import TransferSpec
            from backend.core_fabric.endpoint import endpoint_from_ws as _epw
            _spec = TransferSpec(src=src_path, dst=dst_path, direction="cross",
                                 engine="rsync", via_relay=True,
                                 src_remote=bool(src_fields), dst_remote=bool(dst_fields))
            _plan = Planner(_epw(src_ep), _epw(dst_ep)).plan(_spec)
            for _rr in _plan.reasons:
                runlog.append_detail(run_id, "info", "plan", _rr)
            from backend.core_fabric.planner import needs_l2 as _needs_l2
            if _needs_l2(_plan):
                _use_l2 = True
                _l2_reason = next((r for r in _plan.reasons if "L2" in r), "Plan 判定为 L2")
        except Exception as _pe:
            # 决策失败不阻断传输, 但必须在链路里留痕 (此前只 print, 用户无从发现)
            _msg = f"Planner 决策失败 (退回显式判定): {type(_pe).__name__}: {_pe}"
            print(f"[relay] {_msg}")
            try:
                runlog.append_detail(run_id, "warn", "plan_error", _msg)
            except Exception:
                pass
    if _use_l2:
        runlog.append_detail(run_id, "info", "l2_decision", _l2_reason)
        await ws.send_json({"type": "log", "level": "info",
                            "msg": f"🔐 L2 端到端加密已启用 — {_l2_reason}"})
    if _use_l2:
        try:
            # v5.22.0 · G6: 已钉死对端 (接收端) 身份公钥 → 升级 v2 双端协商; 否则 v1 单端
            from backend.core_fabric import e2ee as _e2m
            _dst_pub = _e2m.get_peer_pub(dst_ep.get("host") or "")
            _enc = await asyncio.to_thread(_relay_e2ee_encrypt, pull_dst, _dst_pub)
            _kp = _enc["keypair"]
            _l2_mode = _enc.get("mode", "single")
            runlog.append_detail(run_id, "info", "e2ee_encrypt",
                                 f"暂存区静态加密 {_enc['files']} 文件 · 模式 {_l2_mode} · "
                                 f"指纹 {_enc['fingerprint']}"
                                 + (f" · 对端指纹 {_e2m.pub_fingerprint(_dst_pub)}" if _dst_pub else ""))
            await ws.send_json({"type": "log", "level": "info",
                                "msg": ("🔒 e2ee: 暂存区已静态加密 {} 文件 (双端协商 · 对端 {} · 任务指纹 {}…)"
                                        if _l2_mode == "dual" else
                                        "🔒 e2ee: 暂存区已静态加密 {} 文件 (单端 · 密钥指纹 {}…)")
                                       .format(_enc['files'],
                                               (dst_ep.get("host") or "") if _l2_mode == "dual" else "",
                                               _enc['fingerprint'][:16] if _l2_mode == "dual" else _enc['fingerprint'])})
        except Exception as _ee:
            import shutil as _shc
            _shc.rmtree(relay_dir, ignore_errors=True)
            runlog.update_run(run_id, status="failed", finished=True,
                              stats={"error": str(_ee)[:200], "stage": "e2ee_encrypt"})
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": f"e2ee 暂存加密失败: {_ee}"})
            return

    # 第 2 段: push 本机 → dst
    push_flags = flags + ["--remove-source-files"]
    _bn = os.path.basename(src_path.rstrip("/"))
    # v5.20.1 · FIX 单文件源落位: pull 后按**实际形态**分派。
    #   旧实现一律拼 stage/<basename>/ 尾斜杠, 单文件源 isdir 不成立就回退推整个
    #   stage 根 —— 目标端落成错误结构 (目录嵌套/多余文件)。L2 路径同理 (见下)。
    _pulled = os.path.join(pull_dst, _bn)
    # ⚠ 判定必须兼容 .enc 形态: L2 加密是原地转 .enc 并删除原文 (delete_src=True),
    #   若在加密之后才判定, 原文件已不存在 → 恒判为目录 → 又回退推整个解密根 (实测复现)。
    _src_is_file = os.path.isfile(_pulled) or os.path.isfile(_pulled + ".enc")
    if _src_is_file:
        _stage_content = _pulled                       # 文件 → 文件对文件推送
    else:
        _stage_content = _pulled.rstrip("/") + "/"     # 目录 → 只推内容
        if not os.path.isdir(_stage_content):
            _stage_content = pull_dst                  # 兜底: 无嵌套则推整个 stage
    if _kp is not None:
        # e2ee: 解密到 plain/ (镜像结构), 推 plain 目录
        _plain_root = os.path.join(relay_dir, "plain")
        _dec = await asyncio.to_thread(_relay_e2ee_decrypt, _kp, pull_dst, _plain_root,
                                       _dst_pub if _use_l2 else "")
        if not _dec.get("ok"):
            import shutil as _shc
            _shc.rmtree(relay_dir, ignore_errors=True)
            runlog.update_run(run_id, status="failed", finished=True,
                              stats={"error": _dec.get("msg", "")[:200], "stage": "e2ee_decrypt"})
            await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                                "msg": f"e2ee 解密失败 (密文校验不过): {_dec.get('msg')}"})
            return
        runlog.append_detail(run_id, "info", "e2ee_decrypt", f"解密 {_dec['files']} 文件待推")
        # v5.20.1 · L2 路径同样按形态分派 (单文件推文件, 不再退回推整个解密根)
        _dec_item = os.path.join(_plain_root, _bn)
        if _src_is_file and (os.path.isfile(_dec_item) or not os.path.exists(_dec_item)):
            # _src_is_file 且解密产物缺失 → 视为文件 (推送时 rsync 会明确报错而非落错位)
            _stage_content = _dec_item
        else:
            _stage_content = _dec_item.rstrip("/") + "/"
            if not os.path.isdir(_stage_content):
                _stage_content = _plain_root
    if dst_fields:
        push = await _rsync_run(_stage_content, dst_path, dst_fields, "dst", push_flags, relay_id)
    else:
        push = await _rsync_run(_stage_content, dst_path, {}, "dst", push_flags, relay_id)
    stage_ok = push["rc"] == 0
    if stage_ok:
        # v5.11.0 · 修正: pull 时 rsync 把 basename 建在中转目录 (relay_dir/stage/<basename>),
        #   push 后目标端会多一层 <basename>/。把内容上移一层对齐"直接落到 dst_path"的预期。
        import shutil as _sh2
        _bn = os.path.basename(src_path.rstrip("/"))
        _nested = os.path.join(dst_path.rstrip("/"), _bn)
        if os.path.isdir(_nested):
            for _item in os.listdir(_nested):
                _s2 = os.path.join(_nested, _item)
                _d2 = os.path.join(dst_path.rstrip("/"), _item)
                if os.path.isdir(_s2) and os.path.isdir(_d2):
                    for _root2, _dirs2, _files2 in os.walk(_s2):
                        _rel2 = os.path.relpath(_root2, _s2)
                        _tgt2 = os.path.join(_d2, _rel2)
                        os.makedirs(_tgt2, exist_ok=True)
                        for _f2 in _files2:
                            _sh2.move(os.path.join(_root2, _f2), os.path.join(_tgt2, _f2))
                else:
                    _sh2.move(_s2, _d2)
            os.rmdir(_nested)

    stage_ok = push["rc"] == 0
    if not stage_ok:
        runlog.update_run(run_id, status="failed", finished=True,
                          stats={"error": push["out"][-200:], "stage": "push"})
        await ws.send_json({"type": "result", "status": "error", "req_id": _req,
                            "msg": f"第 2 段 (push) 失败: {push['out'][-200:]}"})
        return

    # 清理中转暂存
    import shutil as _sh
    _sh.rmtree(relay_dir, ignore_errors=True)

    runlog.update_run(run_id, status="ok", finished=True,
                      stats={"relay_id": relay_id, "stages": 2})
    log_operation("中转传输", f"完成 {relay_id}")

    await ws.send_json({"type": "result", "status": "ok", "req_id": _req,
                        "run_id": run_id, "relay_id": relay_id,
                        "msg": f"✓ 中转传输完成: {src_path} → (本机{', e2ee 静态加密' if _kp is not None else ''}) → {dst_path}",
                        "run_id": run_id})


async def handle_relay_status(ws, data: dict):
    """查询中转暂存区状态 (未完成的 relay_id 列表)"""
    _req = data.get("req_id") or ""
    rows = []
    try:
        for d in os.listdir(_RELAY_ROOT):
            fp = os.path.join(_RELAY_ROOT, d)
            if os.path.isdir(fp):
                rows.append({"relay_id": d, "size": sum(
                    os.path.getsize(os.path.join(r, f))
                    for r, _, fs in os.walk(fp) for f in fs), "age_min":
                    round((time.time() - os.path.getmtime(fp)) / 60, 1)})
    except FileNotFoundError:
        pass
    await ws.send_json({"type": "result", "status": "ok", "req_id": _req, "relays": rows})

"""Fonriv - 文件传输处理器 (Stage 3: 迁移到 SSHRunner)"""

import os
import re
import shlex
import uuid
import datetime
import shutil
import asyncio
import subprocess

from backend.ssh_lib import SSHTarget, sanitize_output, ssh_error_msg, active_tasks
from backend.db import sync_conflicts as scdb  # v4.63.0 · 冲突中心


class _ProcGroup:
    """v4.53.0 · 并行分片进程组: 兼容 kill_process 的单 proc 接口 (kill/wait/returncode)"""
    def __init__(self, procs):
        self.procs = procs
        self.returncode = None

    def kill(self):
        for p in self.procs:
            try:
                p.kill()
            except Exception:
                pass

    async def wait(self):
        try:
            await asyncio.gather(*[p.wait() for p in self.procs])
        except Exception:
            pass
        self.returncode = 0 if all(p.returncode == 0 for p in self.procs) else 1
from backend.ssh_lib.auth import KeyAuth, KeyPassphraseAuth
from backend.error_hint import hint as _err_hint  # v5.22.1 · FIX: 失败路径 NameError (v5.20.3 漏 import)
from backend import db


def _pwd(target) -> str:
    return getattr(target.auth, "password", "") or ""


def _key(target) -> str:
    return getattr(target.auth, "key", "") or ""


async def handle_test_conn(ws, data: dict):
    host = (data.get("host") or "").strip()
    if not host:
        await ws.send_json({"type": "result", "status": "error", "msg": "请输入主机地址"})
        return
    # v4.15.13 · 同步诊断
    try:
        _at = data.get("auth_type", "")
        _kv = data.get("key", "") or ""
        _pp = data.get("passphrase", "") or ""
        print(f"[test_conn] auth_type={_at} key_len={len(_kv)} key_prefix={_kv[:16]!r} pp_len={len(_pp)}")
    except Exception as _e:
        print(f"[test_conn] diag fail: {_e}")
    target = SSHTarget.from_ws_data(data)
    print(f"[test_conn] auth_class={type(target.auth).__name__} "
          f"key_path={getattr(target.auth,'key_path','')} "
          f"key_exists={os.path.isfile(getattr(target.auth,'expanded_key','')) if hasattr(target.auth,'expanded_key') else 'n/a'}")
    try:
        async with target.runner() as run:
            code, out, err = await run.exec("echo CONNECTED_OK", timeout=15, merge_stderr=True)
            if code == 0 and "CONNECTED_OK" in out:
                await ws.send_json({
                    "type": "result", "status": "ok",
                    "msg": f"SSH 连接成功 ({target.endpoint()}:{target.port})",
                })
            else:
                # 提取密码/密钥字符串用于脱敏（只有 auth 对象内部知道）
                safe = sanitize_output(out.strip(), _pwd(target), _key(target))
                friendly = ssh_error_msg(safe, target.host, target.port)
                await ws.send_json({"type": "result", "status": "error", "msg": friendly})
    except FileNotFoundError:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": "系统未找到 ssh 命令，请确认 SSH 客户端已安装"})
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "result", "status": "error", "msg": safe})


def _pwd(target) -> str:
    return getattr(target.auth, "password", "") or ""


def _key(target) -> str:
    return getattr(target.auth, "key_path", "") or ""


async def _record_transfer_stats(ws, *, kind: str, target_key: str, log_tail: str,
                                 src_path: str, dst_path: str):
    """v4.67.0 · E1/E2: 传输完成统计入库 + 3σ 异常检测。

    从 rsync 输出解析文件数/体积/速率 (--stats 或 -v 的汇总行) 并落 run_stats,
    偏离基线 ≥3σ 时告警 (日志 + stats.anomaly 事件 → 可被通知矩阵消费)。
    """
    try:
        from backend import stats as _st
        _sum = _st.parse_rsync_summary(log_tail or "")
        if not (_sum.get("files") or _sum.get("bytes")):
            return
        _st.record_run(kind, target=target_key, files=_sum.get("files", 0),
                       bytes_=_sum.get("bytes", 0), speed_bps=_sum.get("speed_bps", 0),
                       note=f"{src_path} → {dst_path}")
        _an = _st.check_anomaly(kind, _sum.get("files", 0), _sum.get("bytes", 0), target_key)
        if _an.get("anomaly"):
            await ws.send_json({"type": "log",
                                "level": "warn" if _an["level"] == "warn" else "info",
                                "msg": "📈 统计异常检测: " + _an["msg"]})
            if _an["level"] == "warn":
                try:
                    from backend.events import publish as _pub
                    _pub("stats.anomaly", {"kind": kind, "msg": _an["msg"],
                                           "files": _sum.get("files", 0),
                                           "bytes": _sum.get("bytes", 0)})
                except Exception:
                    pass
    except Exception as _e:
        print(f"[rsync] stats hook fail: {_e}")


def _local_verify_targets(src_path: str, dst_path: str) -> tuple:
    """v5.14.0 · P3.5: 按 rsync 落地语义推算对账根 (src_root, dst_root)。
    dir+尾斜杠 → 内容落 dst 本身; dir 无尾斜杠 → dst 已存在则落 dst/<basename>,
    不存在则 dst 即根; file 源 → 落 dst 目录下同名 (或 dst 即文件名)。"""
    src = src_path.rstrip("/")
    dst = dst_path.rstrip("/")
    if os.path.isdir(src):
        if src_path.endswith("/"):
            return src, dst
        if os.path.isdir(dst):
            return src, os.path.join(dst, os.path.basename(src))
        return src, dst
    parent = dst if os.path.isdir(dst) else os.path.dirname(dst) or "."
    return src, parent


async def handle_rsync(ws, data: dict, task_id):
    # v4.41.0 P3-2 · req_id 透传: rsync 异步派发后 _current_req_id 会被后续消息(kill)覆盖,
    #   finish 必须带原始 req_id, 前端 send() 回调才能正确收尾
    _req_id = data.get("req_id") or ""
    target = SSHTarget.from_ws_data(data)
    direction = data.get("direction", "up")
    src_path = (data.get("src") or "").strip()
    dst_path = (data.get("dst") or "").strip()
    # v5.20.0 · `-z` 移出默认 (前端亦已改): 实测不可压缩数据下慢 8.1 倍。压缩改由
    #   planner.decide_compress() 按"源可压缩性 + 是否公网链路"动态决定, 见下方接线。
    flags = data.get("flags", ["-a", "-v", "--progress", "--partial"])
    bwlimit = data.get("bwlimit", "0")
    exclude_str = data.get("exclude", "")

    # v4.59.0 · QoS 带宽时间表: 启用且命中时段 → 规则限速覆盖手动值 (跨 rclone/rsync/分片 三分支)
    try:
        from backend.qos import resolve_bwlimit as _qos_resolve
        bwlimit, _qos_note = _qos_resolve(bwlimit)
        if _qos_note:
            await ws.send_json({"type": "log", "level": "info", "msg": "⏱ " + _qos_note})
    except Exception:
        pass

    # v4.91.0 · F4 流量配额闸门: 启用且日/月超限 → 拒绝发起
    try:
        from backend import quota as _quota
        _ok, _why = _quota.gate_ws(ws)
        if not _ok:
            await ws.send_json({"type": "finish", "status": "error", "req_id": _req_id, "msg": _why})
            return
    except Exception:
        pass

    # v4.50.0 · 传输引擎: auto|rsync|rclone (系统设置; rclone 仅 up/down, 其余退回 rsync)
    _engine = (db.setting_get("transfer_engine", "auto") or "auto").strip().lower()
    use_rclone = (_engine == "rclone" and direction in ("up", "down"))
    if _engine == "rclone" and direction not in ("up", "down"):
        await ws.send_json({"type": "log", "level": "warn",
                            "msg": f"rclone 引擎不支持 {direction} 方向 (v1 仅支持 up/down), 本次退回 rsync"})
    # v4.51.0 · 自动档智能化 (原: 总量 ≥ 阈值 → rclone)
    # v5.20.0 · **默认反转**: 实测 rclone(sftp) 在 SSH 端点上全面慢于 rsync, 旧的
    #   "大文件并行更快" 假设不成立。1GB 单文件本机→9.22 实测:
    #     rsync 128.1 MB/s | rclone(sftp, transfers=4) 111.8 MB/s  → rsync 快 13%
    #     1 万×4KB: rsync 3787 files/s | rclone 215 files/s        → rsync 快 17.6 倍
    #   详见 docs/性能基线实测报告_v5.20.md。handlers/rsync.py 里的 rclone 仅走 :sftp
    #   (云端 S3/OSS 走 backend/remotes 另一条路), 故此处 auto 一律选 rsync。
    #   如需恢复旧行为 (例如万兆+多核环境 rclone 反超): 置 transfer_engine_auto_rclone=1
    if _engine == "auto" and direction in ("up", "down") and (direction == "up" or (target and target.host)):
        import shlex as _shlex_auto
        _auto_threshold = int(db.setting_get("transfer_engine_auto_mb", "1024") or 1024) * 1024 * 1024
        _auto_rclone_opt_in = (db.setting_get("transfer_engine_auto_rclone", "0") or "0") == "1"
        _src_total, _src_files = 0, 0
        try:
            if direction == "up":
                _src_root = src_path.rstrip("/") or src_path
                for _root, _dirs, _files in os.walk(_src_root):
                    for _fn in _files:
                        try:
                            _src_total += os.path.getsize(os.path.join(_root, _fn))
                            _src_files += 1
                        except OSError:
                            pass
                    if _src_total > _auto_threshold * 4:
                        break  # 已远超阈值, 提前止损
            else:  # down: 源在远端, SSH du 一次
                async with target.runner() as run_d:
                    code_d, out_d, _e = await run_d.exec(
                        f"du -sb {_shlex_auto.quote(src_path.rstrip('/'))} 2>/dev/null", timeout=30)
                if code_d == 0 and out_d.strip():
                    _src_total = int(out_d.strip().split()[0])
        except Exception as _ae:
            print(f"[rsync] auto engine probe fail: {_ae}")

        if _auto_rclone_opt_in and _src_total >= _auto_threshold:
            use_rclone = True
            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"自动策略: 源总量 {_src_total // (1024*1024)}MB / {_src_files} 文件 ≥ 阈值({_auto_threshold // (1024*1024)}MB) "
                                       f"且已开启 transfer_engine_auto_rclone → 选用 rclone"})
        else:
            _why = ("已开启 auto_rclone 但未达阈值" if _auto_rclone_opt_in
                    else "实测 SSH 端点 rsync 更快, auto 默认选 rsync")
            await ws.send_json({"type": "log", "level": "info",
                                "msg": f"自动策略: 源总量 {_src_total // (1024*1024)}MB / {_src_files} 文件 → rsync ({_why})"})

    if not src_path or not dst_path:
        await ws.send_json({"type": "finish", "status": "error", "req_id": _req_id,
                            "msg": "源路径和目标路径不能为空"})
        return

    # v5.20.0 · OS 引擎门禁: Windows 原生无 rsync; macOS 自带 rsync 是 2.6.9/openrsync,
    #   与我们自编的 3.5.0 协议握手存疑。这两种情况继续走 rsync 会得到一个难懂的
    #   握手/命令错误, 不如提前拦住并明确改成 rclone sftp。
    if direction in ("up", "down") and target and target.host and use_rclone is False:
        try:
            _oprof = await target.os_profile()
            _fam = _oprof.family.value
            if _fam in ("windows", "macos"):
                _hint, _why = _oprof.engine_hint()
                if _hint == "rclone":
                    use_rclone = True
                    await ws.send_json({"type": "log", "level": "warn",
                                        "msg": f"探测到远端为 {_oprof.label}: {_why} — "
                                               f"已自动切换到 rclone(sftp) 传输"})
        except Exception as _oe:
            print(f"[rsync] OS 门禁检查失败 (不阻断): {_oe}")


    # v4.38.41 · local 方向 (双本机): src/dst 都是本机路径, 不走 SSH
    #   前端判定 srcSrv/dstSrv/srcHost/dstHost 都空 -> direction='local'
    #   后端直接 rsync src dst (无 -e ssh, 无 host), 避免 ssh_askpass 错误
    is_local = (direction == "local")
    if is_local:
        target = None  # 不需要 SSH target

    if not is_local and (not target.host):
        await ws.send_json({"type": "finish", "status": "error", "req_id": _req_id,
                            "msg": "远端主机地址不能为空"})
        return

    # v4.38.38 · cross(双远端) 方向: 两端都远端 -> SSH 到远端执行本地 rsync
    #   前端 cross -> 后端 direction='cross', src/dst 都是远端真实路径(无 host 前缀)
    #   后端通过 SSH 到 target.host 执行: rsync -e ssh <flags> src dst
    is_cross = (direction == "cross")

    # v4.38.38 · 只读挂载点写入检测: dst 在 /var/lib/fonriv_mounts/ 下且只读 -> 明确报错
    #   避免模糊的"退出码 11 file IO error"
    # v1.0.0 · 本发行版不含远端磁盘管理模块 (handlers/disk) -> 挂载根视为空, 检测整体跳过
    try:
        from backend.handlers.disk import MOUNT_ROOT as _DM_MOUNT_ROOT
    except ImportError:
        _DM_MOUNT_ROOT = ""
    _DM_MOUNT_ROOT = (_DM_MOUNT_ROOT or "").rstrip("/")
    def _check_ro_mount(p):
        """若 p 位于 DM 只读挂载点下，返回 (mount_point, is_ro)；否则 (None, False)。"""
        try:
            import subprocess as _sp
            # findmnt -T 对不存在的文件无法定位挂载点, 逐级向上找已存在的祖先路径
            probe = p.rstrip("/")
            tried = []
            while probe and probe != "/":
                tried.append(probe)
                import os as _os
                if _os.path.exists(probe):
                    break
                probe = _os.path.dirname(probe)
            if not probe or probe == "/":
                return None, False
            r = _sp.run(["findmnt", "-T", probe, "-no", "TARGET,OPTIONS"],
                        capture_output=True, text=True, timeout=3)
            for line in (r.stdout or "").splitlines():
                parts = line.split(maxsplit=1)
                if len(parts) < 2:
                    continue
                tgt, opts = parts[0], parts[1]
                # p 在 tgt 之下 或 p 就是 tgt
                if p.rstrip("/") == tgt or p.startswith(tgt.rstrip("/") + "/"):
                    if "ro" in (opts or "").split(","):
                        return tgt, True
            return None, False
        except Exception:
            return None, False

    # down/cross/local 方向 dst 是本地路径时检测只读
    if direction in ("down", "cross", "local") and dst_path.startswith("/"):
        # cross 后续走远端执行, 跳过本机检测; 但若 dst 是本机挂载点路径仍要检测
        if is_cross and not (_DM_MOUNT_ROOT and dst_path.startswith(_DM_MOUNT_ROOT + "/")):
            pass  # cross + dst 非本机挂载点 -> 远端执行, 不检测
        else:
            mnt, is_ro = _check_ro_mount(dst_path)
            # v4.40.0 · 网络共享挂载点: mount option 可能是 rw 但服务器端实际只读
            #   借 share handler 挂载时的真实写入探测缓存 (_active_share_mounts)
            if not is_ro and dst_path.startswith("/var/lib/fonriv_mounts/shares/"):
                try:
                    from backend.handlers.share import _active_share_mounts as _sm
                    for _uid, _st in (_sm or {}).items():
                        _m = (_st or {}).get("mnt", "")
                        if _m and (dst_path == _m or dst_path.startswith(_m.rstrip("/") + "/")):
                            if _st.get("rw") == "ro":
                                mnt, is_ro = _m, True
                            break
                except Exception:
                    pass
            if is_ro:
                await ws.send_json({"type": "finish", "status": "error",
                                    "msg": f"目标路径 {dst_path} 位于只读挂载点 {mnt}，无法写入。请选择可写目录，或用远端原始路径通过 SSH 传输。"})
                return

    db.task_create(task_id, f"rsync: {src_path} → {dst_path}", "rsync",
                   command=f"{direction} {src_path} → {dst_path}")

    # 组装 rsync flags（排除 --bwlimit / --exclude，稍后单独处理）
    rsync_flags = [f for f in flags if f not in ("--bwlimit", "--exclude")]

    # v5.20.0 · 压缩决策接线 (up/down 主路径此前完全没走 Planner, `-z` 一直由前端默认开着)
    #   实测: 不可压缩数据 + -z → 128.1 掉到 15.8 MB/s (慢 8.1 倍)。
    #   规则: 默认关; 仅"源可压缩 且 目标是公网"时开。local 方向在下方单独接。
    #   注: 用户若在前端显式勾了 -z, 遵从用户选择 (仅做提示)
    _user_forced_z = "-z" in rsync_flags
    if not is_local:
        try:
            from backend.core_fabric.planner import decide_compress as _dc
            _c_on, _c_why = _dc(src_path, direction, (target.host if target else "") or "")
            rsync_flags = [f for f in rsync_flags if f != "-z"]
            if _c_on:
                rsync_flags.append("-z")
            elif _user_forced_z:
                await ws.send_json({"type": "log", "level": "warn",
                                    "msg": f"🗜 已按你的勾选保留 -z, 但注意: {_c_why}"})
            await ws.send_json({"type": "log", "level": "info", "msg": f"🗜 压缩策略: {_c_why}"})
        except Exception as _ce:
            print(f"[rsync] 压缩决策失败 (保持原 flags): {_ce}")

    # v5.22.1 · 网络共享挂载点路径: -a 的 chmod/utimes 在 OMV (fruit/streams_xattr VFS) 上
    #   会让 rsync 永久卡在收尾 setattr (实测复现)。挂载本身已强制 uid/gid 映射,
    #   权限/属主/时间戳保留在共享路径上既无意义又有害 — 自动降级并留痕。
    _SHARE_ROOT = "/var/lib/fonriv_mounts/shares/"
    if (dst_path.startswith(_SHARE_ROOT) or src_path.startswith(_SHARE_ROOT)) and not is_cross:
        _NOA = ["--no-perms", "--no-times", "--no-owner", "--no-group"]
        if not all(f in rsync_flags for f in _NOA):
            rsync_flags = [f for f in rsync_flags if f not in _NOA] + _NOA
            await ws.send_json({"type": "log", "level": "info",
                                "msg": "🔗 共享挂载点路径: 已自动降级 -a 的权限/时间戳保留 "
                                       "(--no-perms/--no-times/--no-owner/--no-group), 避免 OMV 等 VFS 的 setattr 卡死"})

    # v4.59.0 · QoS 命中时段的限速不依赖手动勾选 --bwlimit
    if bwlimit and bwlimit != "0":
        rsync_flags.append("--bwlimit=" + str(bwlimit))
    if "--exclude" in flags and exclude_str:
        for pat in exclude_str.split(","):
            p = pat.strip()
            if p:
                rsync_flags.extend(["--exclude", p])

    # 下载方向 -> 自动创建本地目标目录
    # v4.38.36 · bug C 套娃根治: dst 是文件路径时 (无尾斜杠+src是文件), makedirs(dst)
    #   会把 f2.txt 建成目录, rsync 再把文件拷进去 -> f2.txt/f2.txt 套娃。
    #   只建父目录; dst 是目录 (尾斜杠) 时保持原 makedirs(dst) 行为。
    # v4.38.38 · cross(双远端) 不在本机建目录 (dst 是远端路径, SSH 执行时远端 rsync 自建)
    if direction in ("down", "sync", "local") and not is_cross:
        try:
            if dst_path.endswith("/"):
                os.makedirs(dst_path, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(dst_path) or ".", exist_ok=True)
        except Exception:
            pass  # 让 rsync 自行报错

    # sync 模式当前简化为 up
    dir_norm = "down" if direction == "down" else "up"

    progress_re = re.compile(r"\((\d+\.?\d*)%\)")
    speed_re = re.compile(r"(\d+\.?\d*\s*[A-Za-z]+/s)")
    size_re = re.compile(r"(\d+\.?\d*\s*[A-Za-z]+)\s+transfer")

    try:
        import shlex as _shlex
        # ═══ v4.50.0 · rclone 引擎分支 (up/down; 本机 rclone SFTP 到远端, 远端零依赖) ═══
        if use_rclone:
            if shutil.which("rclone") is None:
                await ws.send_json({"type": "finish", "status": "error", "req_id": _req_id,
                                    "msg": "本机未安装 rclone · 请到『系统设置 → 传输引擎』点「检测/安装」"})
                return
            # v4.94.0 · B3 按协议独立并发: SFTP 走 conc_sftp, 缺省回退旧全局 rclone_transfers
            transfers = max(1, min(16, int(db.setting_get("conc_sftp",
                            db.setting_get("rclone_transfers", "4") or "4") or 4)))
            # 认证 → rclone :sftp 连接串 (密码走 obscure; key 走 key_file)
            auth_bits = [f"host={target.host}", f"user={target.user or 'root'}",
                         f"port={target.port or '22'}"]
            auth = target.auth
            if getattr(auth, "password", None):
                ob = subprocess.run(["rclone", "obscure", auth.password],
                                    capture_output=True, text=True, timeout=10)
                if ob.returncode != 0:
                    await ws.send_json({"type": "finish", "status": "error", "req_id": _req_id,
                                        "msg": "rclone obscure 失败: " + (ob.stderr or "")[:120]})
                    return
                auth_bits.append("pass=" + ob.stdout.strip())
            elif getattr(auth, "key", None):
                auth_bits.append("key_file=" + os.path.expanduser(auth.key.strip()))
            remote_base = ":sftp," + ",".join(auth_bits)
            # 路径语义对齐 rsync: 目录尾斜杠=内容; 不带斜杠=目录本身 → dst 拼 basename
            def _is_dir(p):
                return os.path.isdir(p) if (direction == "up" and os.path.exists(p)) \
                    else p.endswith("/")
            src_is_file = os.path.isfile(src_path) if direction in ("up", "local") \
                else (direction == "down" and not src_path.endswith("/"))
            if direction == "up":
                if src_is_file:
                    remote = remote_base + ":" + dst_path.rstrip("/")
                    argv = ["rclone", "copyto", src_path, remote]
                elif src_path.endswith("/"):
                    remote = remote_base + ":" + dst_path.rstrip("/")
                    argv = ["rclone", "copy", src_path, remote]
                else:
                    base = os.path.basename(src_path.rstrip("/"))
                    remote = remote_base + ":" + (dst_path.rstrip("/") + "/" + base)
                    argv = ["rclone", "copy", src_path, remote]
            else:  # down: 远端 src → 本地 dst
                if src_path.endswith("/"):
                    argv = ["rclone", "copy", remote_base + ":" + src_path, dst_path]
                else:
                    argv = ["rclone", "copyto", remote_base + ":" + src_path, dst_path]
            argv += ["--transfers", str(transfers), "--checkers", str(transfers * 2),
                     "--stats-one-line", "--stats", "1s", "-P", "-v"]
            if bwlimit and bwlimit != "0":
                argv.append("--bwlimit=" + str(bwlimit))
            if "--exclude" in flags and exclude_str:
                for pat in exclude_str.split(","):
                    if pat.strip():
                        argv += ["--exclude", pat.strip()]
            if bwlimit and bwlimit != "0":
                pass  # 已处理
            await ws.send_json({"type": "log", "level": "info",
                                "msg": "⚠ rclone 模式不保留属主/ACL 权限信息 (v1)"})
            await ws.send_json({"type": "log", "level": "info",
                                "msg": "执行命令: " + " ".join(
                                    a if not a.startswith(":sftp") and "pass=" not in a else a.split("pass=")[0] + "pass=***"
                                    for a in argv)})
            from backend import log_buffers as _lb
            log_buf = []
            proc = await asyncio.create_subprocess_exec(
                *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            from backend.ssh_lib.runner import active_tasks as _at
            _at[task_id] = proc
            stats_re = re.compile(r"Transferred:\s+(\d+[^/]*|[^,]*)/\s*([^,]*),\s*(\d+)%,\s*([^,]*),\s*ETA\s*([^\s]+)")
            # v4.51.1 · rclone 非 tty 下 --stats-one-line 无 "Transferred:" 前缀,
            #   行格式直接是 "175 MiB / 300 MiB, 59%, 182 MiB/s, ETA 0s" —— 兼容两种
            stats_re2 = re.compile(
                r"(\d+(?:\.\d+)?\s*[KMGTPE]?i?B)\s*/\s*(\d+(?:\.\d+)?\s*[KMGTPE]?i?B)"
                r",\s*(\d+)%,\s*([^,]*),\s*ETA\s*(\S+)")
            cur_file = ""
            while True:
                lb = await proc.stdout.readline()
                if not lb:
                    break
                line_str = lb.decode("utf-8", "replace").rstrip("\n")
                if not line_str:
                    continue
                log_buf.append(line_str)
                _lb.append(task_id, line_str)
                if len(log_buf) > 400:
                    log_buf = log_buf[-400:]
                m = stats_re.search(line_str) or stats_re2.search(line_str)
                if m:
                    await ws.send_json({"type": "progress", "pct": float(m.group(3)),
                                        "speed": m.group(4).strip(),
                                        "file": cur_file,
                                        "transferred": (m.group(1).strip() + " / " + m.group(2).strip())})
                # v4.51.1 · 排除 rclone stats 行 (含 ETA) 被误当文件名
                elif "ETA" not in line_str and line_str.startswith(" ") is False and ":" not in line_str[:1] and not line_str.startswith("*") and "/" in line_str:
                    cur_file = line_str.strip()
                    await ws.send_json({"type": "log", "level": "info", "msg": line_str})
                else:
                    await ws.send_json({"type": "log", "level": "info", "msg": line_str})
            await proc.wait()
            rc = proc.returncode
            try:
                _at.pop(task_id, None)
            except Exception:
                pass
            _log_tail = "\n".join(log_buf)[-32768:]
            db.task_update(task_id, status='completed' if rc == 0 else 'failed',
                           log_output=_log_tail)
            _lb.finalize(task_id)
            if rc == 0:
                await ws.send_json({"type": "finish", "status": "success", "req_id": _req_id,
                                    "msg": "传输成功完成 (rclone)"})
            else:
                await ws.send_json({"type": "finish", "status": "error", "req_id": _req_id,
                                    "msg": _err_hint(f"rclone 退出码 {rc}", "transfer")})
            try:
                from backend import events as _events
                _events.publish("task.finished", {
                    "task_id": task_id, "type": "rsync",
                    "status": "success" if rc == 0 else "failed",
                    "returncode": rc, "engine": "rclone",
                })
            except Exception as _e:
                print(f"[rsync] publish task.finished fail: {_e}")
            return

        # ═══ v4.53.0 · rsync 并行分片 (up/local + 源为目录 + 文件数≥500) ═══
        #   把文件清单均分 N 片并发跑 N 个 rsync (--files-from), 万级小文件吞吐提升数倍。
        #   进度按完成文件数聚合; 中止经 _ProcGroup 全片同杀; down/sync/cross 退回单流。
        if direction in ("up", "local") and os.path.isdir(src_path.rstrip("/") or src_path):
            src_root = src_path if src_path.endswith("/") else src_path + "/"
            rel_files = []
            try:
                for _root, _dirs, _files in os.walk(src_root):
                    _dirs.sort()
                    rel_base = os.path.relpath(_root, src_root).replace(os.sep, "/")
                    rel_dir = "" if rel_base == "." else rel_base + "/"
                    for fn in _files:
                        rel_files.append(rel_dir + fn)
            except Exception as _e:
                print(f"[rsync] 分片清单扫描失败退回单流: {_e}")
                rel_files = []
            # v4.54.0 · 并行分片可由系统设置开关/阈值控制 (默认 开启/500 文件)
            _shards_on = (db.setting_get("transfer_rsync_shards_enable", "1") or "1") == "1"
            _min_files = int(db.setting_get("transfer_rsync_shards_min_files", "500") or 500)
            # v5.20.0 · 远端 (up/down) 分片收益实测仅 +2.6% (本机对拷为 2.8×), 阈值放大。
            #   原因: 多条 SSH 连接抢目标机 CPU 核 (实测传输中 2 核 VM load 10 / 0% idle)。
            if direction in ("up", "down"):
                _rf = int(db.setting_get("transfer_rsync_shards_remote_factor", "10") or 10)
                if _rf > 1:
                    _min_files *= _rf
                    await ws.send_json({"type": "log", "level": "info",
                                        "msg": f"分片阈值按远端通道放大 {_rf} 倍 → 需 ≥{_min_files} 个文件 "
                                               f"(实测 SSH 分片仅提速 2.6%)"})
            if _shards_on and len(rel_files) >= _min_files:
                import tempfile as _tempfile
                # v4.94.0 · B3: 分片并发数可按引擎配 (conc_rsync, 1-16 默认4)
                _conc_rsync = max(1, min(16, int(db.setting_get("conc_rsync", "4") or 4)))
                shards_n = min(_conc_rsync, max(2, len(rel_files) // 250))
                shard_dir = _tempfile.mkdtemp(prefix="fonriv_shards_")
                per = (len(rel_files) + shards_n - 1) // shards_n
                list_files = []
                for si in range(shards_n):
                    lf = os.path.join(shard_dir, f"shard{si}.txt")
                    with open(lf, "w", encoding="utf-8") as f:
                        f.write("\n".join(rel_files[si * per:(si + 1) * per]))
                    list_files.append(lf)
                # 目标目录预建
                try:
                    if direction == "up":
                        async with target.runner() as run_m:
                            await run_m.exec(f"mkdir -p {shlex.quote(dst_path)}", timeout=30)
                    else:
                        os.makedirs(dst_path, exist_ok=True)
                except Exception as _me:
                    print(f"[rsync] 并行分片建目录失败: {_me}")
                # 每片 argv
                shard_argvs = []
                for lf in list_files:
                    ff = "--files-from=" + lf
                    sflags = rsync_flags + ["-i"]  # itemize 供文件完成计数
                    if direction == "up":
                        rsync_ssh = " ".join(target.rsync_ssh_parts())
                        argv_s = ["rsync"] + sflags + [ff, "-e", rsync_ssh, src_root,
                                                       f"{target.endpoint()}:{dst_path}"]
                        env_s = dict(os.environ)
                        # v4.53.0 rev · 密码认证必须 sshpass 包装 (漏加=Permission denied)
                        if getattr(target.auth, "password", None):
                            argv_s = ["sshpass", "-e"] + argv_s
                            env_s["SSHPASS"] = target.auth.password
                    else:
                        argv_s = ["rsync"] + sflags + [ff, src_root, dst_path]
                        env_s = None
                    shard_argvs.append((argv_s, env_s))
                from backend import log_buffers as _lb
                log_buf = []
                procs = []
                total_files = len(rel_files)
                done_files = 0
                await ws.send_json({"type": "log", "level": "info",
                                    "msg": f"⚡ 并行分片: {total_files} 个文件 → {shards_n} 片并发 (≥500 自动启用)"})
                for si, (argv_s, env_s) in enumerate(shard_argvs):
                    _first = f"[片{si + 1}/{shards_n}] " + " ".join(argv_s)
                    log_buf.append(_first)
                    _lb.append(task_id, _first)
                    await ws.send_json({"type": "log", "level": "dim", "msg": _first})
                queue: asyncio.Queue = asyncio.Queue()
                async def _pump(si, proc):
                    while True:
                        lb = await proc.stdout.readline()
                        if not lb:
                            await queue.put((si, None))
                            return
                        await queue.put((si, lb.decode("utf-8", "replace").rstrip("\n")))
                for si, (argv_s, env_s) in enumerate(shard_argvs):
                    proc = await asyncio.create_subprocess_exec(
                        *argv_s, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                        env=env_s, start_new_session=True)
                    procs.append(proc)
                    asyncio.create_task(_pump(si, proc))
                active_tasks[task_id] = _ProcGroup(procs)
                file_done_re = re.compile(r"^[<>]f")  # <f=推送 >f=拉取
                # v4.53.0 rev · 退出条件=全部分片流读毕 (不依赖计数, 防计数失配死锁)
                finished_pumps = 0
                while finished_pumps < shards_n:
                    si, line_str = await queue.get()
                    if line_str is None:
                        finished_pumps += 1
                        continue
                    log_buf.append(line_str)
                    _lb.append(task_id, line_str)
                    if len(log_buf) > 400:
                        log_buf = log_buf[-400:]
                    if file_done_re.match(line_str):
                        done_files += 1
                        await ws.send_json({"type": "progress",
                                            "pct": min(100.0, round(done_files * 100 / total_files, 1)),
                                            "file": line_str.split()[-1][:80],
                                            "transferred": f"{min(done_files, total_files)}/{total_files} 文件"})
                    else:
                        await ws.send_json({"type": "log", "level": "info", "msg": line_str})
                for p in procs:
                    try:
                        await p.wait()
                    except Exception:
                        pass
                active_tasks.pop(task_id, None)
                for lf in list_files:
                    try:
                        os.remove(lf)
                    except OSError:
                        pass
                os.rmdir(shard_dir)
                all_rc = 0 if all(p.returncode == 0 for p in procs) else 1
                _log_tail = "\n".join(log_buf)[-32768:]
                db.task_update(task_id, status='completed' if all_rc == 0 else 'failed',
                               log_output=_log_tail)
                _lb.finalize(task_id)
                if all_rc == 0:
                    await ws.send_json({"type": "finish", "status": "success", "req_id": _req_id,
                                        "msg": f"并行分片传输成功 ({shards_n} 片 × {total_files // shards_n} 文件)"})
                else:
                    await ws.send_json({"type": "finish", "status": "error", "req_id": _req_id,
                                        "msg": "并行分片传输部分失败 (详见日志)"})
                try:
                    from backend import events as _events
                    _events.publish("task.finished", {
                        "task_id": task_id, "type": "rsync",
                        "status": "success" if all_rc == 0 else "failed",
                        "returncode": all_rc, "engine": "rsync-shards",
                    })
                except Exception as _e:
                    print(f"[rsync] publish task.finished fail: {_e}")
                return

        # v4.38.41 · local 方向 (双本机): 直接 rsync src dst, 不开 SSH runner
        if is_local:
            # v5.14.0 · P3.5: Planner 决策接线 (本地方向) — 压缩决策真实消费 + 理由入日志
            _run_id = ""
            try:
                from backend.core_fabric.planner import Planner as _Planner
                from backend.core_fabric.providers import TransferSpec as _TSpec
                from backend.core_fabric.endpoint import endpoint_from_ws as _epw
                _spec = _TSpec(src=src_path, dst=dst_path, direction="local",
                               engine="rsync", flags=list(rsync_flags))
                _plan = _Planner(_epw({}), _epw({})).plan(_spec)
                rsync_flags = _spec.flags
                for _r in _plan.reasons:
                    await ws.send_json({"type": "log", "level": "info", "msg": f"🧭 Planner: {_r}"})
                from backend.core_fabric import runlog as _rl
                _run_id = "rs_" + uuid.uuid4().hex[:12]
                _rl.start_run(_run_id, "rsync", label=f"local {src_path} → {dst_path}",
                              src=src_path, dst=dst_path, engine="rsync_local")
                _rl.append_detail(_run_id, "info", "plan",
                                  "; ".join(_plan.reasons), compress=_plan.compress,
                                  encrypt=_plan.encrypt_level)
            except Exception as _pe:
                print(f"[rsync] Planner 决策失败 (不阻断): {_pe}")

            argv = ["rsync"] + rsync_flags + [src_path, dst_path]
            await ws.send_json({"type": "log", "level": "info",
                                "msg": "执行命令: " + " ".join(argv)})
            from backend import log_buffers as _lb
            log_buf = []
            _first = "执行命令: " + " ".join(argv)
            log_buf.append(_first)
            _lb.append(task_id, _first)
            current_file = ""
            returncode = None
            proc = await asyncio.create_subprocess_exec(
                *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            # v4.41.0 P3-2 · local 分支也注册 active_tasks, 支持 ⏹ 中止
            from backend.ssh_lib.runner import active_tasks as _at
            _at[task_id] = proc
            while True:
                line_bytes = await proc.stdout.readline()
                if not line_bytes:
                    break
                line_str = line_bytes.decode("utf-8", "replace").rstrip("\n")
                if line_str.startswith("__DONE__|"):
                    returncode = int(line_str.split("|", 1)[1])
                    _lb.append(task_id, f"__DONE__ rc={returncode}")
                    continue
                if not line_str:
                    continue
                log_buf.append(line_str)
                _lb.append(task_id, line_str)
                if len(log_buf) > 400:
                    log_buf = log_buf[-400:]
                if not line_str.startswith("(") and "%" not in line_str and not line_str.startswith("*"):
                    name_m = re.search(r"(.+?)(?:\s+\(.+%\))?$", line_str)
                    if name_m and not name_m.group(1).startswith("rsync"):
                        current_file = name_m.group(1).strip()
                if "%" in line_str:
                    pct_m = progress_re.search(line_str)
                    speed_m = speed_re.search(line_str)
                    size_m = size_re.search(line_str)
                    payload = {"type": "progress", "pct": 0, "file": current_file}
                    if pct_m: payload["pct"] = float(pct_m.group(1))
                    if speed_m: payload["speed"] = speed_m.group(1).strip()
                    if size_m: payload["transferred"] = size_m.group(1).strip()
                    await ws.send_json(payload)
                else:
                    await ws.send_json({"type": "log", "level": "info", "msg": line_str})
            await proc.wait()
            returncode = proc.returncode if returncode is None else returncode
            # v4.41.0 P3-2 · 传输结束清理 active_tasks
            try:
                _at.pop(task_id, None)
            except Exception:
                pass
            _lb.append(task_id, f"__DONE__ rc={returncode}")
            _log_tail = "\n".join(log_buf)[-32768:]
            db.task_update(task_id, status='completed' if returncode == 0 else 'failed',
                           log_output=_log_tail)
            _lb.finalize(task_id)
            # v5.14.0 · P3.5: 传输后对账 (Ledger.verify_transfer, 后台线程 + 60s 上限不阻塞收尾)
            _verify_note = ""
            if returncode == 0:
                try:
                    from backend.core_fabric.planner import verify_transfer as _vt
                    _vs, _vd = _local_verify_targets(src_path, dst_path)
                    _vr = await asyncio.wait_for(asyncio.to_thread(_vt, _vs, _vd), timeout=60)
                    if _vr.get("ok"):
                        _verify_note = f" · 对账 ✓ {_vr['verified']}/{_vr['total']}"
                        await ws.send_json({"type": "log", "level": "info",
                                            "msg": f"🔍 传输对账: {_vr['verified']}/{_vr['total']} 个文件 size+sha256 校验一致"})
                    else:
                        _verify_note = f" · 对账 ✗ 差异 {len(_vr['missing']) + len(_vr['size_mismatch']) + len(_vr['hash_mismatch'])}"
                        await ws.send_json({"type": "log", "level": "warn",
                                            "msg": f"🔍 传输对账发现差异: 缺失 {len(_vr['missing'])} · 大小不符 {len(_vr['size_mismatch'])} · 哈希不符 {len(_vr['hash_mismatch'])} (详见统一日志)"})
                    if _run_id:
                        from backend.core_fabric import runlog as _rl
                        _rl.append_detail(_run_id, "info" if _vr.get("ok") else "warn",
                                          "verify", _verify_note.strip(" ·"), result=_vr)
                except asyncio.TimeoutError:
                    await ws.send_json({"type": "log", "level": "info",
                                        "msg": "🔍 传输对账超时 (目录过大), 本次跳过校验"})
                except Exception as _ve:
                    print(f"[rsync] verify_transfer 失败 (不阻断): {_ve}")
            if _run_id:
                try:
                    from backend.core_fabric import runlog as _rl
                    _rl.update_run(_run_id, status="success" if returncode == 0 else "failed",
                                   finished=True)
                except Exception:
                    pass
            # v4.67.0 · E1/E2 统计 (本机直传分支)
            if returncode == 0:
                await _record_transfer_stats(ws, kind="transfer_local", target_key="local",
                                             log_tail=_log_tail, src_path=src_path, dst_path=dst_path)
            if returncode == 0:
                await ws.send_json({"type": "finish", "status": "success", "req_id": _req_id,
                                    "msg": "传输成功完成" + _verify_note})
            else:
                await ws.send_json({"type": "finish", "status": "error", "req_id": _req_id,
                                    "msg": _err_hint(f"rsync 退出码 {returncode}", "transfer")})
            try:
                from backend import events as _events
                _events.publish("task.finished", {
                    "task_id": task_id, "type": "rsync",
                    "status": "success" if returncode == 0 else "failed",
                    "returncode": returncode,
                })
            except Exception as _e:
                print(f"[rsync] publish task.finished fail: {_e}")
            return
        async with target.runner() as run:
            # ═══ v4.51.0 · 真双向同步 (direction='sync') ═══
            #   语义: 本地(src)↔远端(dst) 两侧新增/修改的文件互相同步。
            #   实现: rsync -a -u 两轮 (→远端 一轮 + ←本地 一轮), -u 跳过比目标旧的
            #   文件 → 同名冲突"较新者胜"; 删除不传播(安全默认)。
            #   此前 sync 被 dir_norm 归一为 up, 实为单向推送的假实现。
            if direction == "sync":
                from backend import log_buffers as _lb
                log_buf = []
                total_rc = 0

                # ═══ v4.63.0 · B2 冲突检测 (快照对比法) ═══
                #   上次同步完成时存了清单快照; 本次同步前对比两侧改动, 交集=冲突。
                _policy = (data.get("conflict_policy") or "keep-both").strip().lower()
                _sc_host = target.host if (target and target.host) else ""
                _sc_conn = db.get_conn()
                _sc_old = scdb.snapshot_get(_sc_conn, src_path, dst_path, _sc_host)
                _sc_local = None
                _sc_remote = None
                from backend.sync_conflicts import (
                    _local_manifest as _sc_lm, _remote_manifest_async as _sc_rm,
                    detect_conflicts as _sc_detect,
                )
                _sc_local = _sc_lm(src_path)
                if _sc_old is not None:
                    if target and target.host:
                        _sc_remote = await _sc_rm(target, dst_path)
                    if _sc_local is not None and _sc_remote is not None:
                        _conflicts = _sc_detect(_sc_old, _sc_local, _sc_remote)
                        if _conflicts:
                            _n_kept = 0
                            for _rel in _conflicts[:200]:
                                _li = _sc_local.get(_rel) or [0, 0]
                                _ri = _sc_remote.get(_rel) or [0, 0]
                                scdb.conflict_add(_sc_conn, _rel, src_path, dst_path, _sc_host,
                                                  local_mtime=str(_li[1]), remote_mtime=str(_ri[1]),
                                                  size=_li[0])
                            try:
                                from backend.events import publish as _sc_pub
                                _sc_pub("sync.conflict", {"count": len(_conflicts),
                                                          "src": src_path, "dst": dst_path,
                                                          "policy": _policy})
                            except Exception:
                                pass
                            await ws.send_json({"type": "log", "level": "warn",
                                                "msg": f"⚔ 检测到 {len(_conflicts)} 个双向冲突文件 (策略: {_policy}), 已记录到冲突中心"})
                            if _policy == "keep-both":
                                _ts_cp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                                # 隔离"较旧的输家"版本 (mtime 比较两侧): rsync -u 较新者胜后,
                                # 输家原文件会被覆盖, 先 cp 留底 → 同步后经另一轮带回两侧, 数据零丢失
                                for _rel in _conflicts[:100]:
                                    _li = _sc_local.get(_rel) or [0, 0]
                                    _ri = _sc_remote.get(_rel) or [0, 0]
                                    _local_wins = _li[1] >= _ri[1]
                                    if _local_wins:
                                        # 远端输 → 远端 cp (down 轮带回本地)
                                        _base = f"{dst_path.rstrip('/')}/{_rel}"
                                        _cmd_cp = (f"cp -a {shlex.quote(_base)} "
                                                   f"{shlex.quote(_base + '.conflict_' + _ts_cp)} 2>&1")
                                        _cc, _co, _ce = await run.exec(_cmd_cp, timeout=30)
                                    else:
                                        # 本地输 → 本地 cp
                                        _base = f"{src_path.rstrip('/')}/{_rel}"
                                        _cmd_cp = (f"cp -a {shlex.quote(_base)} "
                                                   f"{shlex.quote(_base + '.conflict_' + _ts_cp)}")
                                        _cc = 0 if os.system(_cmd_cp) == 0 else 1
                                    if _cc == 0:
                                        _n_kept += 1
                                await ws.send_json({"type": "log", "level": "info",
                                                    "msg": f"🛟 已隔离输家版本 {_n_kept}/{len(_conflicts[:100])} 个 (副本后缀 .conflict_{_ts_cp}, 两版都保)"})
                            elif _policy == "keep-local":
                                for _rel in _conflicts[:100]:
                                    _rc = f"{dst_path.rstrip('/')}/{_rel}"
                                    await run.exec(f"rm -f {shlex.quote(_rc)}", timeout=15)
                            elif _policy == "keep-remote":
                                for _rel in _conflicts[:100]:
                                    _lp = f"{src_path.rstrip('/')}/{_rel}"
                                    try:
                                        os.remove(_lp)
                                    except OSError:
                                        pass
                        # keep-newer: 不做隔离, rsync -u 较新者胜 + 记录在案
                # v1.0.0 · FIX(实测: 双向同步报 "destination must be a directory when copying
                #   more than 1 file" → rsync code 3): 旧实现在"← 本地"轮把**文件路径** src_path
                #   直接当目标, 而远端目录里不止一个文件 → 目标必须是目录。
                #   按源形态分派: 目录 → 两轮都按"目录内容"同步(尾斜杠); 文件 → 两轮都精确定位到该文件。
                try:
                    _src_is_dir = os.path.isdir(src_path)
                except Exception:
                    _src_is_dir = False
                _bn_sync = "" if _src_is_dir else os.path.basename(src_path.rstrip("/"))
                for phase, pdir in (("→ 远端", "up"), ("← 本地", "down")):
                    sflags = list(rsync_flags)
                    if "-u" not in sflags:
                        sflags.append("-u")  # --update: 较新者胜
                    # v4.51.0 · 关键: down 语义是 (远端路径, 本地路径), 而 sync 的
                    #   src=本地 dst=远端 → down 轮必须互换 src/dst 传参
                    _up_src = (src_path.rstrip("/") + "/") if _src_is_dir else src_path
                    _up_dst = dst_path.rstrip("/") + "/"
                    _dn_dst = (src_path.rstrip("/") + "/") if _src_is_dir else src_path
                    _dn_src = (dst_path.rstrip("/") + "/") if not _bn_sync else (dst_path.rstrip("/") + "/" + _bn_sync)
                    _lg_src, _lg_dst = (_up_src, _up_dst) if pdir == "up" else (_dn_src, _dn_dst)
                    argv, _ = run.build_rsync_argv(pdir, _lg_src, _lg_dst, sflags)
                    _first = f"[双向 {phase}] " + " ".join(argv)
                    log_buf.append(_first)
                    _lb.append(task_id, _first)
                    await ws.send_json({"type": "log", "level": "info", "msg": _first})
                    # rsync_stream 与 argv 用同一组路径(按源形态分派后)
                    streamer = run.rsync_stream(pdir, _lg_src, _lg_dst,
                                                flags=sflags, task_id=task_id)
                    async for line_str in streamer:
                        if line_str.startswith("__DONE__|"):
                            total_rc |= int(line_str.split("|", 1)[1])
                            continue
                        if not line_str:
                            continue
                        log_buf.append(line_str)
                        _lb.append(task_id, line_str)
                        if len(log_buf) > 400:
                            log_buf = log_buf[-400:]
                        if "%" in line_str:
                            pct_m = progress_re.search(line_str)
                            speed_m = speed_re.search(line_str)
                            payload = {"type": "progress", "pct": 0}
                            if pct_m: payload["pct"] = float(pct_m.group(1))
                            if speed_m: payload["speed"] = speed_m.group(1).strip()
                            await ws.send_json(payload)
                        else:
                            await ws.send_json({"type": "log", "level": "dim", "msg": line_str})
                _log_tail = "\n".join(log_buf)[-32768:]
                db.task_update(task_id, status='completed' if total_rc == 0 else 'failed',
                               log_output=_log_tail)
                _lb.finalize(task_id)
                # v4.63.0 · 同步完成 → 存本轮快照 (供下次冲突对比)
                try:
                    _sc_now = _sc_lm(src_path)
                    if _sc_now is not None:
                        scdb.snapshot_put(_sc_conn, src_path, dst_path, _sc_host, _sc_now)
                except Exception as _sc_e:
                    print(f"[sync] snapshot save fail: {_sc_e}")
                if total_rc == 0:
                    await ws.send_json({"type": "finish", "status": "success", "req_id": _req_id,
                                        "msg": "双向同步完成 (→远端 + ←本地 两轮 · 冲突快照对比 · 删除不传播)"})
                else:
                    await ws.send_json({"type": "finish", "status": "error", "req_id": _req_id,
                                        "msg": f"双向同步异常终止 (退出码: {total_rc})"})
                try:
                    from backend import events as _events
                    _events.publish("task.finished", {
                        "task_id": task_id, "type": "rsync",
                        "status": "success" if total_rc == 0 else "failed",
                        "returncode": total_rc, "engine": "sync",
                    })
                except Exception as _e:
                    print(f"[rsync] publish task.finished fail: {_e}")
                return
            # v5.20.1 · cross(双远端) 正式接 relay 两段式中转。
            #   历史坑位 (都已修, 留注释防复发):
            #   ① 原实现把 cross 当 "up" 处理 (dir_norm 只有 up/down) → SSH 到源机后
            #      内层 rsync 再嵌套一跳, 无主机密钥策略/凭据 → 必然 255;
            #   ② relay _rsync_run push 分支参数顺序反 → 第二段必败 (已修);
            #   ③ relay stage 目录未建 → 单文件落成同名文件 (已修);
            #   ④ relay 单文件经 L2 落成目录 → 按文件/目录形态分派 push (已修)。
            if is_cross:
                _m = re.match(r"^(?:(?P<u>[^@]+)@)?(?P<h>[^:]+):(?P<p>.*)$", dst_path)
                if not _m:
                    await ws.send_json({"type": "finish", "status": "error", "req_id": _req_id,
                        "msg": f"跨机传输的目标需写成 user@主机:/路径 形式 (收到: {dst_path[:60]})"})
                    return
                _d_user = _m.group("u") or (data.get("dst_user") or data.get("dstUser") or "root")
                _d_host = _m.group("h")
                _d_path = _m.group("p")
                _d_port = str(data.get("dst_port") or data.get("dstPort") or "22")
                _d_pw = (data.get("dst_password") or data.get("dstPassword")
                         or data.get("password") or "")
                if not (data.get("dst_password") or data.get("dstPassword")):
                    await ws.send_json({"type": "log", "level": "info",
                        "msg": "跨机传输: 未单独提供目标端密码, 暂用源端同密码 (两端不同请补 dst_password)"})
                await ws.send_json({"type": "log", "level": "info",
                    "msg": f"🧭 跨机传输走 Relay 两段式中转: {_d_host} ← 控制面 ← {target.host}"
                           f" (两跳均为控制面首跳连接, 无需第二跳凭据; 暂存区强制 L2)"})
                from backend.core_fabric.relay import handle_relay_transfer as _relay
                await _relay(ws, {
                    "req_id": _req_id,
                    "src": {"host": target.host, "port": str(target.port),
                            "user": target.user, "auth_type": data.get("auth_type", "pass"),
                            "password": data.get("password", ""), "key": data.get("key", ""),
                            "passphrase": data.get("passphrase", ""), "path": src_path},
                    "dst": {"host": _d_host, "port": _d_port, "user": _d_user,
                            "auth_type": "pass", "password": _d_pw, "path": _d_path},
                    "exclude": exclude_str,
                    "e2ee": data.get("e2ee"),
                })
                return
            else:
                argv, _ = run.build_rsync_argv(dir_norm, src_path, dst_path, rsync_flags)
            await ws.send_json({"type": "log", "level": "info",
                                "msg": "执行命令: " + " ".join(argv)})

            # v4.26.0 · 累积日志尾（供事件抽屉/task_log_tail 查询）
            # v4.27.0 · 同时写入进程级 log_buffers 供订阅者 tail -f
            from backend import log_buffers as _lb
            log_buf = []  # 最新 400 行滚动
            _first = "执行命令: " + " ".join(argv)
            log_buf.append(_first)
            _lb.append(task_id, _first)

            current_file = ""
            returncode = None
            if is_cross:
                streamer = run.stream_lines("rsync " + " ".join(rsync_flags) + " " + _shlex.quote(src_path) + " " + _shlex.quote(dst_path), task_id=task_id)
            else:
                streamer = run.rsync_stream(dir_norm, src_path, dst_path,
                                            flags=rsync_flags, task_id=task_id)
            async for line_str in streamer:
                if line_str.startswith("__DONE__|"):
                    returncode = int(line_str.split("|", 1)[1])
                    _done_line = f"__DONE__ rc={returncode}"
                    log_buf.append(_done_line)
                    _lb.append(task_id, _done_line)
                    continue
                if not line_str:
                    continue
                # 每行都进日志尾（progress 行也保留，用于排障）
                log_buf.append(line_str)
                _lb.append(task_id, line_str)
                if len(log_buf) > 400:
                    log_buf = log_buf[-400:]

                if not line_str.startswith("(") and "%" not in line_str and not line_str.startswith("*"):
                    name_m = re.search(r"(.+?)(?:\s+\(.+%\))?$", line_str)
                    if name_m and not name_m.group(1).startswith("rsync"):
                        current_file = name_m.group(1).strip()

                if "%" in line_str:
                    pct_m = progress_re.search(line_str)
                    speed_m = speed_re.search(line_str)
                    size_m = size_re.search(line_str)
                    payload = {"type": "progress", "pct": 0, "file": current_file}
                    if pct_m:
                        payload["pct"] = float(pct_m.group(1))
                    if speed_m:
                        payload["speed"] = speed_m.group(1).strip()
                    if size_m:
                        payload["transferred"] = size_m.group(1).strip()
                    await ws.send_json(payload)
                else:
                    await ws.send_json({"type": "log", "level": "dim", "msg": line_str})

            # v4.26.0 · 落盘 log_output（限制 32KB）
            _log_tail = "\n".join(log_buf)[-32768:]
            db.task_update(task_id, status='completed' if returncode == 0 else 'failed',
                           log_output=_log_tail)
            _lb.finalize(task_id)
            # v4.67.0 · E1/E2 统计入库 + 3σ 异常检测
            if returncode == 0:
                await _record_transfer_stats(
                    ws, kind=("sync" if direction == "sync" else "transfer_" + str(direction)),
                    target_key=(target.host if (target and target.host) else "local"),
                    log_tail=_log_tail, src_path=src_path, dst_path=dst_path)
            if returncode == 0:
                await ws.send_json({"type": "finish", "status": "success", "req_id": _req_id,
                                    "msg": "传输成功完成"})
            else:
                await ws.send_json({"type": "finish", "status": "error", "req_id": _req_id,
                                    "msg": _err_hint(f"rsync 退出码 {returncode}", "transfer")})
            # v4.19.2 · publish task.finished 供事件流跨标签联动
            try:
                from backend import events as _events
                _events.publish("task.finished", {
                    "task_id": task_id, "type": "rsync",
                    "status": "success" if returncode == 0 else "failed",
                    "returncode": returncode,
                })
            except Exception as _e:
                print(f"[rsync] publish task.finished fail: {_e}")

    except FileNotFoundError as e:
        tool_missing = "rsync" if is_local else ("sshpass" if _pwd(target) else "rsync")
        db.task_update(task_id, status='failed', log_output=f"{tool_missing} 命令未找到")
        active_tasks.pop(task_id, None)
        error_detail = f"底层运行环境未找到 {tool_missing} 命令！({e})"
        if not is_local and _pwd(target) and os.name == "nt":
            error_detail += "\n\n⚠ Windows 系统原生不支持 sshpass 密码验证，请切换为 SSH 密钥认证。"
        await ws.send_json({"type": "finish", "status": "error", "msg": error_detail})
    except Exception as e:
        db.task_update(task_id, status='failed')
        active_tasks.pop(task_id, None)
        _safe_pwd = "" if is_local else _pwd(target)
        _safe_key = "" if is_local else _key(target)
        safe = sanitize_output(str(e), _safe_pwd, _safe_key)
        await ws.send_json({"type": "finish", "status": "error", "msg": f"执行错误: {safe}"})


async def handle_scan_local(ws, data: dict):
    """Scan local backup directory for qcow2/vma/tar files."""
    local_dir = (data.get("local_dir") or "").strip()
    if not local_dir or not os.path.isdir(local_dir):
        await ws.send_json({"type": "local_result", "status": "error",
                            "msg": "目录不存在: " + (local_dir or "(空)")})
        return

    files = []
    try:
        for entry in os.scandir(local_dir):
            if not entry.is_file():
                continue
            name = entry.name.lower()
            if not (name.endswith(".qcow2") or name.endswith(".raw") or
                    name.endswith(".img") or ".vma" in name or
                    name.endswith(".tar") or name.endswith(".vma.zst") or
                    name.endswith(".tar.zst") or name.endswith(".tar.gz")):
                continue
            stat = entry.stat()
            icon = "\U0001f4bf"  # 💿
            if ".vma" in name:
                icon = "\U0001f4e6"  # 📦
            elif ".tar" in name:
                icon = "\U0001f4c2"  # 📂

            size_bytes = stat.st_size
            for unit in ("B", "KB", "MB", "GB", "TB"):
                if size_bytes < 1024:
                    size_str = f"{size_bytes:.1f} {unit}"
                    break
                size_bytes /= 1024
            else:
                size_str = f"{size_bytes:.1f} PB"

            import time
            date_str = time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime))

            files.append({
                "name": icon + " " + entry.name,
                "raw_name": entry.name,
                "path": entry.path,
                "size": size_str,
                "date": date_str,
            })
    except Exception as e:
        await ws.send_json({"type": "local_result", "status": "error",
                            "msg": "扫描失败: " + str(e)})
        return

    files.sort(key=lambda x: x.get("date", ""), reverse=True)
    await ws.send_json({"type": "local_result", "status": "ok", "files": files})


async def handle_list_dir(ws, data: dict):
    """List local directory contents for browse button."""
    path = (data.get("path") or "/").strip()
    if not path:
        path = "/"
    req_id = data.get("req_id")  # v4.38.23 · 透传 req_id，避免前端多 pane 互相劫持响应
    # v5.5.0 · 不再"静默上溯到最近存在的祖先目录":
    #   旧行为会把不存在的路径(未挂载共享/云端 key/远端路径)静默变成祖先目录并成功返回,
    #   前端又把返回的 path 写回 cwd → 用户顺着点就得到 /etc → /home/... 这类错乱路径。
    if not os.path.isdir(path):
        await ws.send_json({"type": "dir_result", "status": "error", "req_id": req_id,
                            "msg": f"目录不存在或不可访问: {path}"})
        return
    entries = []
    try:
        if path != "/":
            _pp = os.path.dirname(path.rstrip("/")) or "/"
            entries.append({"name": "..", "path": _pp, "type": "dir", "size": 0, "mtime": ""})
        from datetime import datetime as _dt
        for entry in sorted(os.scandir(path), key=lambda e: (not e.is_dir(), e.name.lower())):
            # v5.5.0 · 不过滤隐藏文件 (与 SSH `ls -lA` / df 通路保持一致; 旧实现过滤 → 同机两栏不一致)
            _sz, _mt = 0, ""
            try:
                st = entry.stat()
                _sz = 0 if entry.is_dir() else int(st.st_size)
                _mt = _dt.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")
            except OSError:
                pass
            entries.append({
                "name": entry.name,
                "path": entry.path,
                "type": "dir" if entry.is_dir() else "file",
                "is_dir": entry.is_dir(),
                "size": _sz,
                "mtime": _mt,
            })
    except PermissionError:
        await ws.send_json({"type": "dir_result", "status": "error", "msg": "权限不足", "req_id": req_id})
        return

    await ws.send_json({"type": "dir_result", "status": "ok", "path": path, "entries": entries, "req_id": req_id})


async def handle_mkdir(ws, data: dict):
    """v4.24.0 · 在目录浏览器里新建本地目录。"""
    parent = (data.get("parent") or "/").strip() or "/"
    name = (data.get("name") or "").strip()
    if not name or "/" in name or name in (".", ".."):
        await ws.send_json({"type": "mkdir_result", "status": "error",
                            "msg": "非法目录名（不能含 / · . · ..）"})
        return
    if not os.path.isdir(parent):
        await ws.send_json({"type": "mkdir_result", "status": "error",
                            "msg": f"父目录不存在: {parent}"})
        return
    target_path = os.path.join(parent, name)
    if os.path.exists(target_path):
        await ws.send_json({"type": "mkdir_result", "status": "error",
                            "msg": "同名文件/目录已存在"})
        return
    try:
        os.makedirs(target_path, mode=0o755, exist_ok=False)
    except PermissionError:
        await ws.send_json({"type": "mkdir_result", "status": "error", "msg": "权限不足"})
        return
    except OSError as e:
        await ws.send_json({"type": "mkdir_result", "status": "error", "msg": str(e)})
        return
    await ws.send_json({"type": "mkdir_result", "status": "ok",
                        "path": target_path, "parent": parent})


async def handle_mkdir_remote(ws, data: dict):
    """v4.24.0 · 在远端 SSH 目标上新建目录。"""
    parent = (data.get("parent") or "/").strip() or "/"
    name = (data.get("name") or "").strip()
    if not name or "/" in name or name in (".", ".."):
        await ws.send_json({"type": "mkdir_result", "status": "error",
                            "msg": "非法目录名（不能含 / · . · ..）"})
        return
    target = SSHTarget.from_ws_data(data)
    # v5.20.0 · OS 感知: 按远端 OS 拼命令 (Windows 走 PowerShell, 无 POSIX 路径语义)
    _prof = await target.os_profile()
    full = _prof.join(parent, name)
    try:
        async with target.runner() as run:
            code, out, _ = await run.exec(_prof.mkdir_cmd(full), timeout=15, merge_stderr=True)
    except Exception as e:
        await ws.send_json({"type": "mkdir_result", "status": "error",
                            "msg": f"远端连接失败: {e}"})
        return
    _o = (out or "")
    if code != 0 or "RP_FAIL" in _o:
        await ws.send_json({"type": "mkdir_result", "status": "error",
                            "msg": _o.strip() or "远端 mkdir 失败",
                            "os_family": _prof.family.value})
        return
    if "RP_EXISTS" in _o or "EXISTS" in _o:
        await ws.send_json({"type": "mkdir_result", "status": "error",
                            "msg": "同名文件/目录已存在"})
        return
    await ws.send_json({"type": "mkdir_result", "status": "ok",
                        "path": full, "parent": parent, "os_family": _prof.family.value})


async def handle_list_remote_dir(ws, data: dict):
    """List remote directory via SSH for browse button."""
    # v4.15.13 · 诊断：密钥形态 & auth_type
    try:
        _at = data.get("auth_type", "")
        _kv = data.get("key", "") or ""
        _pp = data.get("passphrase", "") or ""
        print(f"[list_remote_dir] auth_type={_at} key_len={len(_kv)} key_prefix={_kv[:16]!r} pp_len={len(_pp)}")
    except Exception as _e:
        print(f"[list_remote_dir] diag fail: {_e}")
    target = SSHTarget.from_ws_data(data)
    # v5.87.0 · 服务端凭据补齐: 前端档案源不下发密码 → 空凭据 SSH 必 Permission denied
    #   (用户报: 文件传输/文件预览点档案列目录报 publickey 拒绝)。按 host+port 查
    #   server_profiles / 活跃会话, 服务端解密补齐, 覆盖所有前端调用点。
    _cred_resolved = False
    if not ((data.get("password") or "").strip() or (data.get("key") or "").strip()):
        try:
            from backend.handlers.server_profile import resolve_ssh_creds
            _cr = resolve_ssh_creds(ws, data.get("host") or "", data.get("port") or 22,
                                    data.get("user") or "")
            if _cr:
                data = dict(data)
                data["user"] = _cr.get("user") or data.get("user") or "root"
                data["auth_type"] = _cr.get("auth_type") or data.get("auth_type") or "pass"
                data["password"] = _cr.get("password") or ""
                data["key"] = _cr.get("key") or ""
                data["passphrase"] = _cr.get("passphrase") or ""
                target = SSHTarget.from_ws_data(data)
                _cred_resolved = True
                print(f"[list_remote_dir] 空凭据已由档案补齐 (auth={data['auth_type']})")
        except Exception as _e:
            print(f"[list_remote_dir] resolve_ssh_creds fail: {_e}")
    # v4.15.13 · 打印实际 auth 类
    print(f"[list_remote_dir] auth_class={type(target.auth).__name__} "
          f"key_path={getattr(target.auth,'key_path','')} "
          f"key_exists={os.path.isfile(getattr(target.auth,'expanded_key','')) if hasattr(target.auth,'expanded_key') else 'n/a'}")
    path = (data.get("path") or "/").strip()
    if not path:
        path = "/"
    req_id = data.get("req_id")  # v4.38.23 · 透传 req_id

    try:
        # v5.20.0 · OS 感知: 不再硬编码 `ls -lA --time-style` ——
        #   `--time-style` 是 GNU 扩展, **BSD(macOS) ls 会直接报非法选项**,
        #   而 Windows 连 ls 都没有。改由 osprofile 按远端 OS 构造命令与解析。
        _prof = await target.os_profile()
        async with target.runner() as run:
            code, out, _ = await run.exec(_prof.list_dir_cmd(path),
                                          timeout=15, merge_stderr=True)
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "dir_result", "status": "error",
                            "msg": f"无法读取远端目录: {safe}", "req_id": req_id})
        return

    # 非 Linux 时把识别结果告诉前端 (前端可据此调整文案/隐藏 POSIX 专属按钮)
    _fam = _prof.family.value

    if code != 0 or not out.strip():
        safe = sanitize_output(out, _pwd(target), _key(target))
        # v4.15.13 · 常见错误 → 中文可读提示
        hint = ""
        if "Permission denied" in safe and "publickey" in safe:
            if isinstance(target.auth, KeyAuth) and not isinstance(target.auth, KeyPassphraseAuth):
                hint = "（该密钥可能受密码短语保护，请在浏览窗口内嵌『🔐 认证』栏填入短语后点『应用重连』）"
            elif not _cred_resolved and not ((data.get("password") or "").strip() or (data.get("key") or "").strip()):
                # v5.87.0 · 空凭据且档案里也没存 → 给可行动的指引(旧文案误导用户去看 authorized_keys)
                hint = "（未找到该服务器的已保存密码：请在「连接中心」编辑档案并勾选记住密码，或用「✚ 临时」输入密码后连接）"
            else:
                hint = "（密码或密钥被远端拒绝：请核对档案里的凭据是否正确）"
        elif "ssh_askpass" in safe or "ssh-askpass" in safe:
            hint = "（密钥需要密码短语但未提供，请在浏览窗口内嵌『🔐 认证』栏填入短语）"
        elif _fam == "windows":
            hint = "（远端识别为 Windows: 请确认 SSH 服务已启用且该盘符路径存在, 如 C:\\Users）"
        await ws.send_json({"type": "dir_result", "status": "error",
                            "msg": "无法读取远端目录: " + safe + hint, "req_id": req_id,
                            "os_family": _fam})
        return

    entries = []
    if path != "/" and _fam != "windows":
        entries.append({"name": "..", "path": _prof.parent(path), "type": "dir"})
    elif _fam == "windows" and not re.match(r"^[A-Za-z]:\\?$", _prof.normalize(path)):
        entries.append({"name": "..", "path": _prof.parent(path), "type": "dir"})
    for it in _prof.parse_list_dir(out):
        _nm = it.get("name") or ""
        if not _nm or _nm in (".", ".."):
            continue
        entry_type = "dir" if it.get("is_dir") else "file"
        entries.append({
            "name": _nm,
            "path": _prof.join(path, _nm),
            "type": entry_type,
            "is_dir": (entry_type == "dir"),
            "size": int(it.get("size") or 0),
            "mtime": it.get("mtime") or "",
        })

    await ws.send_json({"type": "dir_result", "status": "ok", "path": path,
                        "entries": entries, "req_id": req_id, "os_family": _fam})


# ---------------------------------------------------------------------------
# v4.38.23 · 本机同步工具检测 (无需 SSH)
# ---------------------------------------------------------------------------
async def handle_check_sync_tools(ws, data: dict):
    """检测本机是否安装了 rsync / sshpass / ssh 等同步工具。
    返回 {status, tools:{rsync,sshpass,ssh,scp,qemu_img,vzdump}, missing:[...], fix:'apt install...',
          has_sudo, is_root, sudo_fix}"""
    import shutil as _shutil

    def _check(cmd):
        return _shutil.which(cmd) is not None

    tools = {
        "rsync":     _check("rsync"),
        "sshpass":   _check("sshpass"),
        "ssh":       _check("ssh"),
        "scp":       _check("scp"),
        "qemu-img":  _check("qemu-img"),
        "vzdump":    _check("vzdump"),
        "rclone":    _check("rclone"),  # v4.55.1 · 传输引擎 rclone 档依赖 (仅本机需要)
        "inotifywait": _check("inotifywait"),  # v4.59.0 · 实时同步守护依赖 (inotify-tools)
        "restic":    _check("restic"),  # v4.68.0 · 去重加密备份引擎 (C1)
    }
    missing = [k for k, v in tools.items() if not v]
    pkg_map = {
        "rsync": "rsync", "sshpass": "sshpass", "ssh": "openssh-client",
        "scp": "openssh-client", "qemu-img": "qemu-utils", "vzdump": "proxmox-backup",
        "rclone": "rclone", "proxmox-backup": "proxmox-backup",
        "inotifywait": "inotify-tools",  # v4.59.0
        "restic": "restic",  # v4.68.0
    }
    pkgs = [pkg_map[k] for k in missing if k in pkg_map]
    if pkgs:
        fix = "apt-get install -y " + " ".join(pkgs) + "   # Debian/Ubuntu"
    else:
        fix = ""
    rsync_ver = ""
    if tools["rsync"]:
        try:
            out = subprocess.run(["rsync", "--version"], capture_output=True, text=True, timeout=3).stdout
            rsync_ver = (out or "").split("\n", 1)[0].strip() if out else ""
        except Exception:
            pass
    # v4.38.24 · sudo 探测 + 二次确认弹窗依据
    is_root = False
    has_sudo = False
    sudo_fix = ""
    try:
        is_root = (os.geteuid() == 0)
    except Exception:
        is_root = False
    if not is_root:
        try:
            r = subprocess.run(["sudo", "-n", "true"], capture_output=True, timeout=3)
            has_sudo = (r.returncode == 0)
        except Exception:
            has_sudo = False
    if not is_root and not has_sudo:
        sudo_fix = "需要 root 权限或 sudo 免密：\n  方法 A: visudo 追加 'username ALL=(ALL) NOPASSWD: ALL'\n  方法 B: 用 root 账号直接跑"

    await ws.send_json({
        "type": "sync_tools_result",
        "status": "ok",
        "tools": tools,
        "missing": missing,
        "fix": fix,
        "rsync_ver": rsync_ver,
        "is_root": is_root,
        "has_sudo": has_sudo,
        "sudo_fix": sudo_fix,
    })


# v4.38.24 · 本机一键安装缺失的同步工具（基于 sudo 探测 + apt/yum 探测 + 白名单校验）
async def handle_install_local_tools(ws, data: dict):
    """安装 data.packages 列表里允许的工具。返回每行 stdout/stderr 实时推送。
    data = { packages: ['sshpass','rsync',...]  可选 confirm: true（前端二次确认已点）
    返回 {type:'install_local_log'/'install_local_result', ...} 流式消息
    """
    import shutil as _shutil

    # 白名单（防注入 · 严格小写字母+短横线）
    ALLOWED = {"rsync", "sshpass", "openssh-client", "openssh-server", "qemu-utils", "proxmox-backup", "rclone", "inotify-tools", "restic",
               # v4.69.0 · 归档工具 (rar/7z/xz/zstd 解压与压缩)
               "p7zip-full", "p7zip", "unrar-free", "unrar", "unar", "zip", "unzip", "bzip2", "xz-utils", "zstd", "lz4", "tar"}
    pkg_map = {
        "rsync": "rsync", "sshpass": "sshpass", "ssh": "openssh-client",
        "scp": "openssh-client", "qemu-img": "qemu-utils", "vzdump": "proxmox-backup",
        "rclone": "rclone", "proxmox-backup": "proxmox-backup",
        "inotifywait": "inotify-tools",  # v4.59.0
        "restic": "restic",  # v4.68.0
    }
    pkgs_req = data.get("packages") or []
    pkgs = []
    for p in pkgs_req:
        if not isinstance(p, str):
            continue
        p = p.strip().lower()
        if not p:
            continue
        if not re.match(r"^[a-z0-9][a-z0-9\-\.]{0,40}$", p):
            await ws.send_json({"type": "install_local_log", "level": "error",
                                "msg": f"非法包名: {p!r}（仅允许小写字母数字+短横线+点）"})
            continue
        # 工具名转 apt 包名
        real = pkg_map.get(p, p)
        if real not in ALLOWED:
            await ws.send_json({"type": "install_local_log", "level": "error",
                                "msg": f"包 {real!r} 不在白名单（允许: {', '.join(sorted(ALLOWED))}）"})
            continue
        pkgs.append(real)
    pkgs = list(dict.fromkeys(pkgs))   # 去重保序
    if not pkgs:
        await ws.send_json({"type": "install_local_result", "status": "error",
                            "msg": "没有可安装的包（白名单外或空列表）"})
        return

    # 探测 sudo 权限
    is_root = False
    has_sudo = False
    try:
        is_root = (os.geteuid() == 0)
    except Exception:
        is_root = False
    if not is_root:
        try:
            r = subprocess.run(["sudo", "-n", "true"], capture_output=True, timeout=3)
            has_sudo = (r.returncode == 0)
        except Exception:
            has_sudo = False
    if not is_root and not has_sudo:
        await ws.send_json({"type": "install_local_result", "status": "error",
                            "msg": "无 root 权限且 sudo 不可用，请用 root 账号或配置 sudo 免密"})
        return

    # 探测包管理器
    pkg_mgr = "apt" if _shutil.which("apt-get") else ("yum" if _shutil.which("yum") else ("apk" if _shutil.which("apk") else None))
    if not pkg_mgr:
        await ws.send_json({"type": "install_local_result", "status": "error",
                            "msg": "未找到 apt-get/yum/apk，暂不支持本系统"})
        return

    # 构造安装命令（白名单已校验，相对安全）
    if pkg_mgr == "apt":
        cmd = ["sudo", "-n", "apt-get", "install", "-y"] + pkgs if not is_root else ["apt-get", "install", "-y"] + pkgs
    elif pkg_mgr == "yum":
        cmd = ["sudo", "-n", "yum", "install", "-y"] + pkgs if not is_root else ["yum", "install", "-y"] + pkgs
    else:  # apk
        cmd = ["sudo", "-n", "apk", "add"] + pkgs if not is_root else ["apk", "add"] + pkgs

    # 二次确认（前端已点 confirm=true，但服务端也再验一次）
    if not data.get("confirm"):
        await ws.send_json({"type": "install_local_result", "status": "error",
                            "msg": "需要前端二次确认（confirm=true）才执行安装"})
        return

    await ws.send_json({"type": "install_local_log", "level": "info",
                        "msg": f"▶ 开始安装 [{pkg_mgr}]: {' '.join(pkgs)}"})
    await ws.send_json({"type": "install_local_log", "level": "info",
                        "msg": f"  命令: {' '.join(cmd)}"})

    # 同步执行（apt-get 通常 5-30s），流式推送 stdout/stderr
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        deadline = 180   # 3 分钟超时
        import time as _t
        start = _t.time()
        last_flush = 0
        # 用 Popen 异步读
        loop = asyncio.get_event_loop()
        def _read():
            if proc.stdout is None:
                return None
            line = proc.stdout.readline()
            return line if line else None
        while True:
            if _t.time() - start > deadline:
                proc.kill()
                await ws.send_json({"type": "install_local_log", "level": "error", "msg": "✗ 安装超时（180s）已终止"})
                await ws.send_json({"type": "install_local_result", "status": "error", "msg": "timeout"})
                return
            line = await loop.run_in_executor(None, _read)
            if not line:
                if proc.poll() is not None:
                    break
                await asyncio.sleep(0.2)
                continue
            await ws.send_json({"type": "install_local_log", "level": "info", "msg": line.rstrip()})
        rc = proc.returncode
    except Exception as e:
        await ws.send_json({"type": "install_local_log", "level": "error", "msg": f"✗ 异常: {e}"})
        await ws.send_json({"type": "install_local_result", "status": "error", "msg": str(e)})
        return

    # v5.91.1 · 装后复核: 包管理器返回 0 不等于工具真可用(依赖冲突/被 hold/装到了别的路径),
    #   逐个 command -v 验一遍再报结果 —— 这正是用户说的"直接报成功, 其实没装上"。
    _bin_of = {"rsync": "rsync", "sshpass": "sshpass", "openssh-client": "ssh", "openssh-server": "sshd",
               "qemu-utils": "qemu-img", "rclone": "rclone", "restic": "restic",
               "inotify-tools": "inotifywait", "p7zip-full": "7z", "p7zip": "7z", "unrar-free": "unrar",
               "unrar": "unrar", "unar": "unar", "zip": "zip", "unzip": "unzip", "bzip2": "bzip2",
               "xz-utils": "xz", "zstd": "zstd", "lz4": "lz4", "tar": "tar"}
    _verified, _still_missing = [], []
    for _p in pkgs:
        _b = _bin_of.get(_p, _p)
        if _shutil.which(_b) or os.path.exists("/usr/sbin/" + _b) or os.path.exists("/sbin/" + _b):
            _verified.append(_p)
        else:
            _still_missing.append("%s(缺命令 %s)" % (_p, _b))
    await ws.send_json({"type": "install_local_log", "level": "info",
                        "msg": "复核: 可用 %s%s" % (", ".join(_verified) or "无",
                                                  ("; 仍缺失 " + ", ".join(_still_missing)) if _still_missing else "")})
    if rc == 0 and not _still_missing:
        await ws.send_json({"type": "install_local_log", "level": "ok", "msg": f"✅ 安装并复核通过 rc={rc}"})
        await ws.send_json({"type": "install_local_result", "status": "ok", "msg": "ok", "packages": pkgs})
    else:
        _m = ("装后复核仍缺失: " + ", ".join(_still_missing)) if _still_missing else ("包管理器退出码 %s" % rc)
        await ws.send_json({"type": "install_local_log", "level": "error", "msg": "✗ " + _m})
        await ws.send_json({"type": "install_local_result", "status": "error", "msg": _m, "packages": pkgs})


async def handle_check_rsync_plugins(ws, data: dict):
    """检测远端服务器上 rsync / sshpass 等同步所需工具的安装状态。"""
    target = SSHTarget.from_ws_data(data)
    try:
        async with target.runner() as run:
            script = (
                "hash -r 2>/dev/null || true ; "
                "echo OS:$(. /etc/os-release 2>/dev/null && echo $ID) ; "
                "echo rsync-which:$(command -v rsync 2>/dev/null || echo MISSING) ; "
                "echo rsync-dpkg:$(dpkg -s rsync 2>/dev/null | awk -F': ' '/^Status:/{print $2}' | head -1 || true) ; "
                "echo sshpass-which:$(command -v sshpass 2>/dev/null || echo MISSING) ; "
                "echo sshpass-dpkg:$(dpkg -s sshpass 2>/dev/null | awk -F': ' '/^Status:/{print $2}' | head -1 || true) ; "
                "echo rsync-ver:$(rsync --version 2>/dev/null | head -1 || echo MISSING) ; "
                "echo pkg-mgr:$(command -v apt >/dev/null && echo apt || (command -v yum >/dev/null && echo yum || echo unknown))"
            )
            code, out, _ = await run.exec(script, timeout=20, merge_stderr=True)
            info = {}
            for line in (out or "").strip().split("\n"):
                if ":" in line:
                    k, v = line.split(":", 1)
                    info[k.strip()] = v.strip()
            os_id = info.get("OS", "unknown").lower()

            def _installed(dpkg_key: str, which_key: str) -> bool:
                dpkg_v = info.get(dpkg_key, "") or ""
                if "install ok installed" in dpkg_v:
                    return True
                which_v = info.get(which_key, "MISSING") or "MISSING"
                return which_v != "MISSING" and which_v.strip() != ""

            pkg_mgr = info.get("pkg-mgr", "apt")

            def _mk(name, dpkg_k, which_k, desc, install_apt, install_yum=None):
                inst = _installed(dpkg_k, which_k)
                if pkg_mgr == "yum":
                    cmd = install_yum or install_apt.replace("apt install", "yum install")
                else:
                    cmd = install_apt
                return {"name": name, "installed": inst, "install_cmd": cmd, "description": desc}

            plugins = [
                _mk("rsync (核心)", "rsync-dpkg", "rsync-which",
                    "远程同步工具（必需）", "sudo apt install -y rsync"),
                _mk("sshpass", "sshpass-dpkg", "sshpass-which",
                    "SSH 密码认证工具（推荐）", "sudo apt install -y sshpass"),
            ]
            ver = info.get("rsync-ver", "")

            missing = [p["name"] for p in plugins if not p["installed"]]
            summary = (f"同步工具检测：{os_id} · {pkg_mgr} · 已装 "
                       f"{sum(1 for p in plugins if p['installed'])}/{len(plugins)}"
                       + (f"，缺失：{', '.join(missing)}" if missing else "，全部就绪 ✓"))
            await ws.send_json({"type": "log", "level": "info", "msg": summary})
            await ws.send_json({"type": "rsync_plugins_result", "status": "ok",
                                "os": os_id, "pkg_manager": pkg_mgr, "plugins": plugins,
                                "version": ver})
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "log", "level": "error", "msg": "同步工具检测失败：" + safe})
        await ws.send_json({"type": "rsync_plugins_result", "status": "error", "msg": safe})


async def handle_install_rsync_plugin(ws, data: dict):
    """一键在远端服务器上安装 rsync / sshpass。"""
    target = SSHTarget.from_ws_data(data)
    install_cmd = (data.get("install_cmd") or "").strip()
    if not install_cmd:
        await ws.send_json({"type": "rsync_install_result", "status": "error", "msg": "缺少安装命令"})
        return
    if not re.match(r'^(sudo )?(apt|apt-get|yum|dnf) install -y [a-z0-9\-\._ ]+$', install_cmd):
        await ws.send_json({"type": "rsync_install_result", "status": "error",
                            "msg": "拒绝执行不安全的命令：" + install_cmd})
        return
    try:
        async with target.runner() as run:
            await ws.send_json({"type": "rsync_install_log", "level": "info", "msg": f"▶ 开始安装：{install_cmd}"})
            uc, uo, _ = await run.exec(
                "sudo apt-get update 2>&1 | tail -5 || sudo yum makecache 2>&1 | tail -5 || true",
                timeout=90, merge_stderr=True)
            if uo:
                await ws.send_json({"type": "rsync_install_log", "level": "info",
                                    "msg": "apt update: " + (uo.strip().splitlines()[-1] if uo.strip() else "")})
            full = "DEBIAN_FRONTEND=noninteractive " + install_cmd + " 2>&1 | tail -30"
            code, out, _ = await run.exec(full, timeout=240, merge_stderr=True)
            recheck_script = (
                "hash -r 2>/dev/null || true ; "
                "echo rsync:$(command -v rsync 2>/dev/null || echo MISSING) ; "
                "echo sshpass:$(command -v sshpass 2>/dev/null || echo MISSING)"
            )
            rc, ro, _ = await run.exec(recheck_script, timeout=10, merge_stderr=True)
            await ws.send_json({"type": "rsync_install_log", "level": "info", "msg": "安装输出：" + out.strip()[-300:].replace("\n", " | ")})
            # v5.91.1 · FIX(用户报"点一下就报成功, 其实没装上"): 旧实现无论成败都回 status=ok,
            #   安装命令 exit≠0 或装完 command -v 仍 MISSING 时, 界面照样显示成功。
            #   现在以「安装进程退出码 + 装后复查」双条件判定, 失败时把真实报错尾部带回去。
            _ro = ro or ""
            _wanted = []
            if "rsync" in install_cmd:
                _wanted.append("rsync")
            if "sshpass" in install_cmd:
                _wanted.append("sshpass")
            if not _wanted:
                _wanted = ["rsync", "sshpass"]
            _missing = [w for w in _wanted if (w + ":MISSING") in _ro.replace(" ", "")]
            _ok = (code == 0) and not _missing
            if _ok:
                _msg = "✓ 安装完成并复查通过: " + " · ".join(l.strip() for l in _ro.splitlines() if l.strip())
                await ws.send_json({"type": "rsync_install_log", "level": "ok", "msg": _msg})
            else:
                _tail = " | ".join([l.strip() for l in (out or "").strip().splitlines()[-3:] if l.strip()])
                _msg = "✗ 安装未成功 (exit=%s%s): %s ｜ 复查: %s" % (
                    code, (", 仍缺失 " + ",".join(_missing)) if _missing else "", _tail or "(无输出)", _ro.strip() or "(无复查输出)")
                await ws.send_json({"type": "rsync_install_log", "level": "error", "msg": _msg})
            await ws.send_json({"type": "rsync_install_result", "status": "ok" if _ok else "error",
                                "msg": _msg, "recheck": _ro, "exit": code})
    except Exception as e:
        safe = sanitize_output(str(e), _pwd(target), _key(target))
        await ws.send_json({"type": "rsync_install_result", "status": "error", "msg": safe})


# ---------------------------------------------------------------------------
# v4.40.2 P2 · 传输审计 (transfer_audit)
#   rsync --dry-run --itemize-changes 对比 src/dst, 返回差异清单:
#   {type:'transfer_audit_result', req_id, status, summary:{new,update,delete,skip,total_bytes},
#    changes:[{action:'new|update|delete|skip', path, size, mtime}]}
#   direction: up/down/local/cross 同 handle_rsync
# v4.41.0 P3-4 · cloud 支持: src_cloud_rid/dst_cloud_rid (remote_id) + src_cloud_path/dst_cloud_path
#   任一侧为云 -> 走 _audit_cloud (递归列两侧按 name/size/mtime 对比, 不跑 rsync)
# v4.41.0 P3-7 · sync 双向审计: direction=sync 时跑 up+down 两遍, 返回 bidirectional 视图
#   {summary_up, summary_down, changes_up, changes_down, conflicts}
# ---------------------------------------------------------------------------
async def handle_transfer_audit(ws, data: dict):
    """dry-run 审计: 列出 src->dst 将发生的变更, 不实际传输。"""
    # v4.41.5 · req_id 可能是 int (脚本/第三方 WS 客户端), 直接 .strip() 会 AttributeError
    # 崩掉整个 handler 断开连接; 统一 str 归一化
    req_id = str(data.get("req_id") or "").strip()
    direction = data.get("direction", "up")
    src_path = (data.get("src") or "").strip()
    dst_path = (data.get("dst") or "").strip()
    is_local = (direction == "local")

    def _reply(status, msg, **kw):
        payload = {"type": "transfer_audit_result", "req_id": req_id,
                   "status": status, "msg": msg}
        payload.update(kw)
        return ws.send_json(payload)

    if not src_path or not dst_path:
        await _reply("error", "源路径和目标路径不能为空")
        return

    # v4.41.0 P3-4 · ☁ 云审计: 任一侧带 remote_id -> 走云对比 (不依赖 rsync)
    src_rid = int(data.get("src_cloud_rid") or 0)
    dst_rid = int(data.get("dst_cloud_rid") or 0)
    if src_rid or dst_rid:
        if direction == "sync":
            # P3-7 · sync 双向云审计: 两遍对比 (up: src->dst, down: dst->src), 冲突 = 两侧都变
            up = await _audit_cloud_pair(ws, src_rid, dst_rid, src_path, dst_path)
            if up is None:
                return
            down = await _audit_cloud_pair(ws, dst_rid, src_rid, dst_path, src_path)
            if down is None:
                return
            await _reply_sync_audit(_reply, up, down)
            return
        res = await _audit_cloud_pair(ws, src_rid, dst_rid, src_path, dst_path)
        if res is None:
            return
        await _reply("ok", f"☁ 审计完成: 新增 {res['summary']['new']} / 更新 {res['summary']['update']} / 跳过 {res['summary']['skip']}",
                     summary=res["summary"], changes=res["changes"][:500], raw="")
        return

    # v4.41.0 P3-7 · sync 双向审计: 先跑 up 审计 (本端视角), 再跑 down 审计 (对端视角)
    #   sync 模式的 src/dst 均为本机路径 (前端对 local 不反转) -> 两遍都强制 local
    if direction == "sync":
        up_payload = dict(data)
        up_payload["direction"] = "local"
        res_up = await _rsync_audit_once(ws, up_payload, req_id)
        if res_up is None:
            return
        down_payload = dict(data)
        down_payload["direction"] = "local"
        down_payload["src"], down_payload["dst"] = dst_path, src_path
        res_down = await _rsync_audit_once(ws, down_payload, req_id)
        if res_down is None:
            return
        await _reply_sync_audit(_reply, res_up, res_down)
        return

    res = await _rsync_audit_once(ws, data, req_id)
    if res is None:
        return
    await _reply("ok", f"审计完成: 新增 {res['summary']['new']} / 更新 {res['summary']['update']} / 跳过 {res['summary']['skip']}",
                 summary=res["summary"], changes=res["changes"][:500],
                 raw=res.get("raw", "")[:4000])


def _audit_compare(src_map: dict, dst_map: dict, base: str):
    """按 relpath 对比两侧文件清单 -> (summary, changes)。
    src_map/dst_map: {relpath: {size, mtime, is_dir}}
    语义与 rsync 一致: dst 独有 -> 不算删除 (rsync 默认不删); src 与 dst 均有且
    size/mtime 相同 -> skip; 否则 update; 仅 src 有 -> new。
    """
    summary = {"new": 0, "update": 0, "delete": 0, "skip": 0, "dir": 0, "total": 0}
    changes = []
    paths = sorted(set(src_map) | set(dst_map))
    for rel in paths:
        s = src_map.get(rel)
        d = dst_map.get(rel)
        if s and s.get("is_dir"):
            summary["dir"] += 1
            changes.append({"action": "dir", "path": base + rel, "size": 0, "mtime": 0})
            continue
        if not s:
            continue  # dst 独有: rsync 不删除
        if not d:
            summary["new"] += 1
            changes.append({"action": "new", "path": base + rel, "size": s.get("size", 0), "mtime": s.get("mtime", 0)})
            continue
        same_size = (int(s.get("size") or 0) == int(d.get("size") or 0))
        same_mtime = abs(int(s.get("mtime") or 0) - int(d.get("mtime") or 0)) <= 2
        if same_size and same_mtime:
            summary["skip"] += 1
            changes.append({"action": "skip", "path": base + rel, "size": s.get("size", 0), "mtime": s.get("mtime", 0)})
        else:
            summary["update"] += 1
            changes.append({"action": "update", "path": base + rel, "size": s.get("size", 0), "mtime": s.get("mtime", 0)})
    summary["total"] = summary["new"] + summary["update"] + summary["delete"] + summary["skip"] + summary["dir"]
    return summary, changes


async def _audit_cloud_pair(ws, src_rid: int, dst_rid: int, src_path: str, dst_path: str):
    """审计一对 本机/云 侧。返回 (summary, changes) 或 None (出错已回包)。"""
    # v1.0.0 · 远端存储未包含在本发行版 → 明确报错 (不再抛 ModuleNotFoundError)
    try:
        from backend.remotes import build_from_config
    except ImportError:
        await ws.send_json({"type": "result", "status": "error", "req_id": "",
                            "msg": "云端存储未包含在本发行版中"})
        return None
    from backend import db as _db
    src_map = {}
    dst_map = {}
    try:
        if src_rid:
            cfg = _db.remote_get(src_rid, decrypt=True)
            if not cfg:
                await ws.send_json({"type": "transfer_audit_result", "status": "error",
                                    "msg": f"源 remote #{src_rid} 不存在"})
                return None
            storage = build_from_config(cfg)
            src_map = await asyncio.to_thread(_cloud_walk, storage, src_path)
        else:
            src_map = _local_walk(src_path)
        if dst_rid:
            cfg = _db.remote_get(dst_rid, decrypt=True)
            if not cfg:
                await ws.send_json({"type": "transfer_audit_result", "status": "error",
                                    "msg": f"目标 remote #{dst_rid} 不存在"})
                return None
            storage = build_from_config(cfg)
            dst_map = await asyncio.to_thread(_cloud_walk, storage, dst_path)
        else:
            dst_map = _local_walk(dst_path)
    except NotImplementedError as e:
        await ws.send_json({"type": "transfer_audit_result", "status": "error", "msg": str(e)})
        return None
    except Exception as e:
        await ws.send_json({"type": "transfer_audit_result", "status": "error",
                            "msg": f"☁ 审计失败: {type(e).__name__}: {e}"})
        return None
    # v4.41.2 · 显示路径修正: 单文件审计项 (src 是文件路径) base 用 dirname, 避免出现 "src.png/src.png"
    base = src_path if src_path.endswith("/") else src_path + "/"
    if not src_path.endswith("/") and len(src_map) == 1:
        only = next(iter(src_map))
        if only == src_path.rsplit("/", 1)[-1] and not src_map[only].get("is_dir"):
            parent = src_path.rsplit("/", 1)[0]
            base = (parent + "/") if parent else "/"
    summary, changes = _audit_compare(src_map, dst_map, base)
    return {"summary": summary, "changes": changes}


def _cloud_walk(storage, path: str) -> dict:
    """递归列出云存储目录 -> {relpath: {size, mtime, is_dir}}。

    v4.41.2 · 审计容错:
    - path 可能是完整文件路径 (单文件审计项) -> 尝试父目录列表, 命中同名文件则只返回该文件
    - 目录不存在 (Seafile dir API 404) -> 返回 {} (视为空, 审计判为全新增), 不再抛错
    """
    path = (path or "").strip().strip("/")
    out: dict = {}

    def _list_safe(prefix: str) -> list:
        try:
            return storage.list_dir(prefix)
        except Exception:
            return []  # 404/不存在 -> 空目录语义

    def _recurse(prefix: str, rel_base: str):
        entries = _list_safe(prefix)
        for e in entries:
            name = e.get("name", "")
            if not name:
                continue
            rel = (rel_base + "/" + name) if rel_base else name
            if e.get("is_dir"):
                out[rel] = {"size": 0, "mtime": 0, "is_dir": True}
                child_prefix = (prefix + "/" + name) if prefix else name
                _recurse(child_prefix, rel)
            else:
                out[rel] = {"size": int(e.get("size") or 0),
                            "mtime": int(e.get("mtime") or 0), "is_dir": False}

    entries = _list_safe(path)
    if not entries:
        # 两种可能: 目录不存在 / path 本身是文件 -> 查父目录确认
        if "/" in path:
            parent, base = path.rsplit("/", 1)
            for e in _list_safe(parent):
                if e.get("name") == base:
                    out[base] = {"size": int(e.get("size") or 0),
                                 "mtime": int(e.get("mtime") or 0), "is_dir": False}
                    return out
        _recurse(path, "")  # 空 (根/不存在) -> 递归仍空
        return out
    _recurse(path, "")
    return out


def _local_walk(path: str) -> dict:
    """递归列出本机目录 -> {relpath: {size, mtime, is_dir}}。

    v4.41.2 · 审计容错: path 是文件 -> 只返回该文件; 不存在 -> {} (全新增语义)。
    """
    path = (path or "").strip()
    out: dict = {}
    if not path:
        return out
    if os.path.isfile(path):
        try:
            st = os.stat(path)
            out[os.path.basename(path)] = {"size": st.st_size, "mtime": int(st.st_mtime), "is_dir": False}
        except Exception:
            pass
        return out
    base = path.rstrip("/")
    for root, dirs, files in os.walk(base, topdown=True, onerror=lambda _e: None):
        rel_root = os.path.relpath(root, base)
        rel_root = "" if rel_root == "." else rel_root.replace(os.sep, "/")
        for d in sorted(dirs):
            rel = (rel_root + "/" + d) if rel_root else d
            out[rel] = {"size": 0, "mtime": 0, "is_dir": True}
        for f in sorted(files):
            rel = (rel_root + "/" + f) if rel_root else f
            fp = os.path.join(root, f)
            try:
                st = os.stat(fp)
                out[rel] = {"size": st.st_size, "mtime": int(st.st_mtime), "is_dir": False}
            except Exception:
                out[rel] = {"size": 0, "mtime": 0, "is_dir": False}
    return out


async def _reply_sync_audit(_reply, up, down):
    """sync 双向审计回包: 冲突 = 两侧都存在且都改 (up 有 update 且 down 有 update 的同一 rel)。"""
    up_set = {}
    for c in up["changes"]:
        if c["action"] in ("update", "new"):
            up_set[c["path"]] = c
    down_set = {}
    for c in down["changes"]:
        if c["action"] in ("update", "new"):
            down_set[c["path"]] = c
    conflicts = []
    for p in sorted(set(up_set) & set(down_set)):
        conflicts.append({"path": p, "up": up_set[p]["action"], "down": down_set[p]["action"]})
    await _reply("ok",
                 f"⟳ 双向审计: 源→目标 新增{up['summary']['new']} 更新{up['summary']['update']} · "
                 f"目标→源 新增{down['summary']['new']} 更新{down['summary']['update']} · "
                 f"冲突 {len(conflicts)}",
                 summary=up["summary"], changes=up["changes"][:500],
                 bidirectional={
                     "summary_up": up["summary"], "summary_down": down["summary"],
                     "changes_up": up["changes"][:500], "changes_down": down["changes"][:500],
                     "conflicts": conflicts[:200],
                 })


async def _rsync_audit_once(ws, data: dict, req_id: str):
    """跑一次 rsync dry-run 审计, 返回 {summary, changes, raw} 或 None (出错已回包)。"""
    direction = data.get("direction", "up")
    src_path = (data.get("src") or "").strip()
    dst_path = (data.get("dst") or "").strip()
    is_local = (direction == "local")

    target = None
    if not is_local:
        target = SSHTarget.from_ws_data(data)
        if not target.host:
            await ws.send_json({"type": "transfer_audit_result", "req_id": req_id,
                                "status": "error", "msg": "远端主机地址不能为空"})
            return None

    audit_flags = ["-rc", "--dry-run", "--itemize-changes", "--no-human-readable"]

    if is_local or src_path.startswith("/"):
        try:
            if os.path.isdir(src_path) and not src_path.endswith("/"):
                src_path += "/"
        except Exception:
            pass

    try:
        if is_local:
            argv = ["rsync"] + audit_flags + [src_path, dst_path]
            proc = await asyncio.create_subprocess_exec(
                *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            out_b, _ = await proc.communicate()
            out = (out_b or b"").decode("utf-8", "replace")
            rc = proc.returncode
        else:
            async with target.runner() as run:
                argv, env = run.build_rsync_argv(direction, src_path, dst_path, audit_flags)
                proc = await asyncio.create_subprocess_exec(
                    *argv, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT, env=env)
                out_b, _ = await proc.communicate()
                out = (out_b or b"").decode("utf-8", "replace")
                rc = proc.returncode
    except FileNotFoundError:
        await ws.send_json({"type": "transfer_audit_result", "req_id": req_id,
                            "status": "error", "msg": "系统未找到 rsync 命令"})
        return None
    except Exception as e:
        await ws.send_json({"type": "transfer_audit_result", "req_id": req_id,
                            "status": "error", "msg": f"{type(e).__name__}: {e}"})
        return None

    if rc != 0:
        await ws.send_json({"type": "transfer_audit_result", "req_id": req_id,
                            "status": "error",
                            "msg": f"rsync dry-run 退出码 {rc}: {out.strip()[-300:]}"})
        return None

    changes = []
    itemize_re = re.compile(r"^([><ch.*][fdLDS])([cstpoguaxb.+T]{9})\s+(.+)$")
    for line in out.splitlines():
        m = itemize_re.match(line.strip())
        if not m:
            continue
        code, perms, path = m.group(1), m.group(2), m.group(3).strip()
        ftype = code[1] if len(code) > 1 else ""
        if code[0] == ".":
            continue
        if code[0] in ("<", "*"):
            continue
        if ftype == "d":
            changes.append({"action": "dir", "path": path, "size": 0, "mtime": 0})
            continue
        if code[0] == ">":
            if ftype == "f" and ("s" in perms or "t" in perms or "T" in perms or "c" in perms):
                action = "update"
            else:
                action = "new"
            changes.append({"action": action, "path": path, "size": 0, "mtime": 0})
        elif code[0] == "c":
            changes.append({"action": "update", "path": path, "size": 0, "mtime": 0})

    seen = set()
    dedup = []
    for c in changes:
        if c["path"] in seen:
            continue
        seen.add(c["path"])
        dedup.append(c)

    summary = {"new": 0, "update": 0, "delete": 0, "skip": 0, "total": len(dedup)}
    for c in dedup:
        summary[c["action"]] = summary.get(c["action"], 0) + 1

    return {"summary": summary, "changes": dedup, "raw": out}



# ---------------------------------------------------------------------------
# v4.50.0 · rclone 插件检测/一键安装 (本机; 传输引擎 rclone 档依赖)
# ---------------------------------------------------------------------------

async def handle_rclone_check(ws, data: dict):
    """检测本机 rclone: 版本 / obscure 可用性。"""
    import subprocess as _sp
    found = shutil.which("rclone")
    if not found:
        await ws.send_json({"type": "result", "status": "ok", "installed": False,
                            "msg": "本机未安装 rclone"})
        return
    try:
        v = _sp.run(["rclone", "version"], capture_output=True, text=True, timeout=8)
        ver = (v.stdout or "").strip().splitlines()[0] if (v.stdout or "").strip() else "unknown"
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": f"rclone version 失败: {e}"})
        return
    await ws.send_json({"type": "result", "status": "ok", "installed": True,
                        "path": found, "version": ver,
                        "msg": f"rclone 已安装 · {ver} · {found}"})


async def handle_rclone_install(ws, data: dict):
    """一键安装本机 rclone (系统官方源: apt/dnf/yum/zypper/pacman/apk)。"""
    import subprocess as _sp
    import asyncio as _asyncio
    from backend.auth import _require_admin
    if not await _require_admin(ws):
        return
    if shutil.which("rclone"):
        await ws.send_json({"type": "result", "status": "ok", "installed": True,
                            "msg": "本机已安装 rclone, 无需重复安装"})
        return
    # 发行版探测
    os_id, os_like = "unknown", ""
    try:
        txt = open("/etc/os-release", encoding="utf-8").read()
        m_id = re.search(r'^ID=["\']?([\w\-]+)', txt, re.M)
        m_like = re.search(r'^ID_LIKE=["\']?([\w \-]+)', txt, re.M)
        os_id = m_id.group(1) if m_id else "unknown"
        os_like = m_like.group(1) if m_like else ""
    except Exception:
        pass
    has_sudo = _sp.run(["sudo", "-n", "true"], capture_output=True, timeout=5).returncode == 0 \
        if os.geteuid() != 0 else True
    if not has_sudo:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": "安装需要 root 或免密 sudo 权限 (当前服务进程无)"})
        return
    pre = [] if os.geteuid() == 0 else ["sudo"]
    cmds = {
        "debian":  ["apt-get", "update", "-qq"],
        "ubuntu":  ["apt-get", "update", "-qq"],
        "kylin":   ["yum", "install", "-y", "rclone"],
        "centos":  ["yum", "install", "-y", "rclone"],
        "fedora":  ["dnf", "install", "-y", "rclone"],
        "rhel":    ["dnf", "install", "-y", "rclone"],
        "opensuse": ["zypper", "--non-interactive", "install", "rclone"],
        "arch":    ["pacman", "-Sy", "--noconfirm", "rclone"],
        "alpine":  ["apk", "add", "rclone"],
    }
    install_cmd = cmds.get(os_id)
    if not install_cmd:
        for fam in os_like.split():
            if fam in cmds:
                install_cmd = cmds[fam]
                break
    if not install_cmd:
        await ws.send_json({"type": "result", "status": "error",
                            "msg": f"暂不支持自动安装: {os_id} (可手动安装 rclone 后重试检测)"})
        return
    log_operation("插件", f"一键安装 rclone ({os_id})")
    try:
        if install_cmd[0] == "apt-get":
            r = _sp.run(pre + install_cmd, capture_output=True, text=True, timeout=300)
            if r.returncode != 0:
                await ws.send_json({"type": "result", "status": "error",
                                    "msg": "apt-get update 失败: " + (r.stderr or "")[-160:]})
                return
            r = _sp.run(pre + ["apt-get", "install", "-y", "rclone"],
                        capture_output=True, text=True, timeout=600)
        else:
            r = _sp.run(pre + install_cmd, capture_output=True, text=True, timeout=600)
        ok = r.returncode == 0 and shutil.which("rclone")
        tail = "\n".join((r.stdout or "").strip().splitlines()[-8:])[-1200:]
        await ws.send_json({"type": "result",
                            "status": "ok" if ok else "error",
                            "msg": (f"安装成功 · {(shutil.which('rclone') or '')}"
                                    if ok else
                                    f"安装失败 (rc={r.returncode}): {(r.stderr or r.stdout or '')[-160:]}"),
                            "output_tail": tail})
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "msg": f"安装异常: {e}"})


# ---------------------------------------------------------------------------
# v5.20.0 · 远端 OS 识别与磁盘列举 (Windows / macOS 端点支持)
# ---------------------------------------------------------------------------
async def handle_remote_os_detect(ws, data: dict):
    """探测远端操作系统。

    入参: host/port/user/auth_type/password/key/passphrase, 可选 os_type 强制声明,
          可选 probe=true 时顺带跑一次真实命令做确认
    出参: {os_family, label, has_rsync, rsync_trustworthy, posix_paths,
           engine_hint, note, detected(bool), source}
    """
    req_id = data.get("req_id") or ""
    target = SSHTarget.from_ws_data(data)
    if not target.host:
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "msg": "缺少 host"})
        return
    from backend import osprofile as _op
    declared = _op.OsFamily.parse(target.os_type)
    source = "声明"
    try:
        if declared != _op.OsFamily.UNKNOWN:
            prof = _op.profile_for(declared)
            detected = False
        else:
            # 用 OSDETECT 命令拿原始输出, 便于把原始证据回显给用户
            async with target.runner() as run:
                code, out, _e = await run.exec(_op.detect_cmd(), timeout=15, merge_stderr=True)
            fam = _op.parse_detect(out or "")
            if fam != _op.OsFamily.UNKNOWN:
                _op.remember_family(target.host, target.port, fam)
            prof = _op.profile_for(fam)
            detected = True
            source = "自动探测"
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "msg": f"探测失败: {sanitize_output(str(e), _pwd(target), _key(target))}"})
        return

    eng, eng_why = prof.engine_hint()
    payload = {
        "type": "result", "status": "ok", "req_id": req_id,
        "os_family": prof.family.value,
        "label": prof.label,
        "has_rsync": prof.has_rsync,
        "rsync_trustworthy": prof.rsync_trustworthy,
        "posix_paths": prof.posix_paths,
        "engine_hint": eng,
        "engine_reason": eng_why,
        "note": prof.note,
        "detected": detected,
        "source": source,
    }
    # 顺带列盘 (一次往返拿全, 前端少发一次请求)
    if data.get("with_disks"):
        try:
            async with target.runner() as run:
                code, out, _e = await run.exec(prof.disks_cmd(), timeout=20, merge_stderr=True)
            rows = prof.parse_disks(out or "") if code == 0 or out else []
            payload["disks"] = rows
        except Exception as _de:
            payload["disks"] = []
            payload["disks_error"] = str(_de)[:160]
    await ws.send_json(payload)


async def handle_remote_disks(ws, data: dict):
    """列举远端磁盘/卷/盘符 (Linux df / macOS df+diskutil / Windows Get-PSDrive)。"""
    req_id = data.get("req_id") or ""
    target = SSHTarget.from_ws_data(data)
    if not target.host:
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "msg": "缺少 host"})
        return
    try:
        prof = await target.os_profile()
        async with target.runner() as run:
            code, out, _e = await run.exec(prof.disks_cmd(), timeout=20, merge_stderr=True)
        rows = prof.parse_disks(out or "")
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "msg": f"列举磁盘失败: {sanitize_output(str(e), _pwd(target), _key(target))}"})
        return
    await ws.send_json({"type": "result", "status": "ok", "req_id": req_id,
                        "os_family": prof.family.value, "disks": rows,
                        "count": len(rows)})


# ---------------------------------------------------------------------------
# v5.20.0 · 本机依赖: 扫描 + 一键安装 (系统设置 → 本机依赖)
# ---------------------------------------------------------------------------
async def handle_deps_scan(ws, data: dict):
    """检测本机部署所需的全部依赖与插件状态。"""
    from backend import deps as _deps
    try:
        # 必须走 scan_async: scan() 是同步阻塞的, 直接在事件循环里跑会把
        # 同连接上的其它请求一起堵死 (实测装依赖时触发前端 30s 超时)
        r = await _deps.scan_async()
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error",
                            "req_id": data.get("req_id") or "",
                            "msg": f"依赖扫描失败: {e}"})
        return
    await ws.send_json({"type": "result", "status": "ok",
                        "req_id": data.get("req_id") or "", **r})


async def handle_deps_install(ws, data: dict, task_id=None):
    """一键安装本机依赖。

    data:
      ids:    指定依赖 id 列表; 省略则按 mode 自动挑选
      mode:   required (默认, 只装必需) | recommended (必需+推荐) | all (全部可自动安装的)
      confirm: 必须为 true (服务端二次确认, 前端弹窗后再置位)

    按依赖来源分批执行: 包管理器 (apt/yum/apk) → pip → GitHub 二进制。
    每行输出实时推送 `deps_log`, 终态推带 deps_result 标记的 result。

    ⚠ 本函数是长任务 (可能数分钟), 必须注册在 ws.py 的 ROUTE_TASK 里走
    `_spawn_bg` 异步派发。否则会被 `await handler(...)` 串行执行, 期间整条 WS
    连接被占住 —— 同连接上的其它请求 (如依赖扫描) 全部排队到前端 30s 超时。
    (ws.py 在 v4.46.0 已为同类长任务统一改过异步派发, 这里是照同一规矩来。)
    """
    import asyncio as _aio
    from backend import deps as _deps

    req_id = data.get("req_id") or ""
    if not data.get("confirm"):
        await ws.send_json({"type": "result", "deps_result": True, "status": "error", "req_id": req_id,
                            "msg": "需要二次确认 (confirm=true)"})
        return

    sc = await _deps.scan_async()
    mgr = sc["pkg_mgr"]
    if not mgr:
        await ws.send_json({"type": "result", "deps_result": True, "status": "error", "req_id": req_id,
                            "msg": "未找到 apt-get / yum / dnf / apk, 无法自动安装"})
        return
    if not sc["has_priv"]:
        await ws.send_json({"type": "result", "deps_result": True, "status": "error", "req_id": req_id,
                            "msg": f"权限不足 ({sc['priv']})。请以 root 运行服务, 或给该用户配置 sudo 免密"})
        return

    # 目标集合
    mode = (data.get("mode") or "required").strip().lower()
    ids = data.get("ids")
    if not isinstance(ids, list) or not ids:
        if mode == "all":
            ids = [i["id"] for i in sc["items"] if i["auto_installable"]]
        elif mode == "recommended":
            ids = [i["id"] for i in sc["items"]
                   if i["level"] in ("required", "recommended") and i["auto_installable"]]
        else:
            ids = [i["id"] for i in sc["items"]
                   if i["level"] == "required" and i["auto_installable"]]
    # 去掉已安装的 (只装缺的), 保留用户显式指定的
    if not data.get("ids"):
        have = {i["id"] for i in sc["items"] if i["installed"]}
        ids = [i for i in ids if i not in have]
    if not ids:
        await ws.send_json({"type": "result", "deps_result": True, "status": "ok", "req_id": req_id,
                            "msg": "所需依赖已齐备, 无需安装", "installed": [], "failed": []})
        return

    batches, unknown, skipped = _deps.plan_install(ids, mgr)

    async def _log(msg, level="info"):
        try:
            await ws.send_json({"type": "deps_log", "level": level, "msg": msg, "req_id": req_id})
        except Exception:
            pass

    await _log(f"▶ 本机依赖安装开始 · {sc['distro']} · 包管理器 {mgr} · 权限 {sc['priv']}")
    await _log(f"  目标: {', '.join(ids)}")
    for uid in unknown:
        await _log(f"  ⚠ 未登记的依赖 id, 已跳过: {uid}", "warn")
    for sid, why in skipped:
        await _log(f"  ⚠ {sid} 跳过: {why}", "warn")

    installed, failed = [], []
    if not batches:
        await _log("没有可自动执行的安装批次 (可能都需人工加源)", "warn")

    for b in batches:
        kind, label = b.get("kind"), b.get("label", "")
        await _log(f"\n▶ {label}")
        # ① apt 先刷新索引 (首次装包最常见的失败原因就是索引为空/过期)
        if b.get("refresh"):
            rargv = _deps.with_priv(b["refresh"], sc["priv"])
            await _log(f"  命令: {' '.join(rargv)}")
            try:
                # 逐行流式: apt-get update 可能 30~120s, 旧实现用 communicate() 全量缓冲,
                # 期间一条日志都不发 -> 界面看着像卡死 (实测踩过)。
                proc = await _aio.create_subprocess_exec(
                    *rargv, stdout=_aio.subprocess.PIPE, stderr=_aio.subprocess.STDOUT)
                _t0 = _aio.get_event_loop().time()
                while True:
                    try:
                        line = await _aio.wait_for(proc.stdout.readline(), 120)
                    except _aio.TimeoutExpired:
                        if _aio.get_event_loop().time() - _t0 > 600:
                            proc.kill(); await _log("  ✗ 索引刷新超时已终止", "error"); break
                        await _log("  … 索引刷新仍在进行 (源较慢或网络受限)")
                        continue
                    if not line:
                        break
                    t = line.decode("utf-8", "replace").rstrip()
                    if t:
                        await _log("    " + t)
                await proc.wait()
            except Exception as e:
                await _log(f"    ⚠ 索引刷新失败 (继续尝试安装): {e}", "warn")

        # ② GitHub 二进制走单独路径
        if kind == _deps.SRC_GITHUB:
            ok, msg = await _install_from_github(ws, b.get("spec", ""), _log)
            (installed if ok else failed).append(msg)
            continue

        argv = _deps.with_priv(b["argv"], sc["priv"])
        await _log(f"  命令: {' '.join(argv)}")
        try:
            proc = await _aio.create_subprocess_exec(
                *argv, stdout=_aio.subprocess.PIPE, stderr=_aio.subprocess.STDOUT)
            deadline = 900   # 依赖多时 apt 可能较久
            t0 = _aio.get_event_loop().time()
            while True:
                try:
                    line = await _aio.wait_for(proc.stdout.readline(), 120)
                except _aio.TimeoutExpired:
                    if _aio.get_event_loop().time() - t0 > deadline:
                        proc.kill()
                        await _log("  ✗ 安装超时已终止", "error")
                        break
                    continue
                if not line:
                    break
                txt = line.decode("utf-8", "replace").rstrip()
                if txt:
                    await _log("    " + txt)
            rc = await proc.wait()
        except Exception as e:
            await _log(f"  ✗ 执行异常: {e}", "error")
            failed.extend([x for x in ids])
            continue
        if rc == 0:
            installed.append(label)
            await _log(f"  ✅ {label} 完成")
        else:
            failed.append(f"{label} (rc={rc})")
            await _log(f"  ✗ {label} 失败 rc={rc}", "error")

    # 收尾: 复检一次, 让界面拿到真实状态 (同样走线程池)
    after = await _deps.scan_async()
    still_req = after["missing_required"]
    await ws.send_json({
        # deps_result 标记: 前端据此判定终态。**不能只靠 req_id** ——
        # ws.py 的 _send_json_with_req 会把任何不带 req_id 的推送盖上"当前请求"的
        # req_id, 安装期间并发的心跳/其它面板结果会被误判成安装完成 (实测踩过)。
        "type": "result", "deps_result": True,
        "status": "ok" if not still_req else "warn", "req_id": req_id,
        "msg": (f"安装流程结束 · 成功 {len(installed)} 项"
                + (f" · 失败 {len(failed)} 项" if failed else "")
                + (f" · 仍缺必需项: {', '.join(still_req)}" if still_req else " · 必需项已齐备")),
        "installed": installed, "failed": failed,
        "still_missing_required": still_req,
        "scan": {k: after[k] for k in ("distro", "pkg_mgr", "items",
                                       "missing_required", "missing_recommended",
                                       "installed_count", "total")},
    })


async def _install_from_github(ws, spec: str, log_fn) -> tuple:
    """从 GitHub release 取静态二进制 (croc 等 apt 没有的工具)。

    spec 形如 "owner/repo:asset_glob"。在**服务端**下载到 /usr/local/bin。
    找不到匹配资产时明确失败, 不做静默跳过。
    """
    import asyncio as _aio, re as _re, json as _json, urllib.request as _u
    if ":" not in spec:
        await log_fn(f"  ✗ GitHub 来源格式错误: {spec}", "error")
        return False, spec
    repo, glob = spec.split(":", 1)
    api = f"https://api.github.com/repos/{repo}/releases/latest"
    try:
        req = _u.Request(api, headers={"Accept": "application/vnd.github+json",
                                       "User-Agent": "fonriv-deps"})
        loop = _aio.get_event_loop()
        raw = await loop.run_in_executor(
            None, lambda: _u.urlopen(req, timeout=20).read())
        rel = _json.loads(raw)
    except Exception as e:
        await log_fn(f"  ✗ 查询 {repo} release 失败 (内网环境可手工安装): {e}", "error")
        return False, spec

    # 资产名匹配 (glob 是**子串匹配**, 不是全串匹配)。
    #   v5.20.1 · FIX: 原实现加 ^$ 做全串匹配, 而 croc 的资产名是
    #   `croc_v11.5.3_Linux-64bit.tar.gz` —— glob "Linux-64bit.tar.gz" 永远匹配不上
    #   (实测 9.22 一键安装报"未找到匹配资产")。改为 search (子串), 并显式排除
    #   非 x86_64/amd64 架构与校验和文件。
    pat = _re.compile(glob.replace("*", ".*").replace(".", r"\."), _re.I)
    asset = None
    for a in rel.get("assets") or []:
        nm = a.get("name") or ""
        low = nm.lower()
        if not pat.search(nm):
            continue
        if "arm" in low or "windows" in low or "macos" in low or "darwin" in low:
            continue
        if "386" in low or "riscv" in low:
            continue
        if low.endswith((".md5", ".sha256", ".txt", ".sig", ".sbom")) or "checksum" in low:
            continue
        asset = a
        break
    if not asset:
        names = ", ".join((a.get("name") or "") for a in (rel.get("assets") or [])[:6])
        await log_fn(f"  ✗ 未找到匹配资产 {glob} (可选: {names})", "error")
        return False, spec
    url = asset.get("browser_download_url")
    await log_fn(f"  ↓ {asset.get('name')} ({asset.get('size', 0) // 1024} KB)")
    try:
        import tempfile, tarfile, zipfile, shutil as _sh, os as _os
        tmpd = tempfile.mkdtemp(prefix="rpdeps_")
        fn = _os.path.join(tmpd, asset.get("name") or "dl")
        loop = _aio.get_event_loop()
        def _dl():
            # 3 次重试: GitHub release 下载对部分网络不稳定 (实测 9.22 首连即被远端断开),
            # 每次从头发 (release 资产不支持断点), 8.9MB 级别代价可接受。
            last = None
            for attempt in range(1, 4):
                try:
                    with _u.urlopen(_u.Request(url, headers={"User-Agent": "fonriv-deps"}),
                                    timeout=300) as r, \
                         open(fn, "wb") as f:
                        _sh.copyfileobj(r, f)
                    return
                except Exception as e:
                    last = e
                    if attempt < 3:
                        import time as _t
                        _t.sleep(3 * attempt)
            raise last
        await loop.run_in_executor(None, _dl)
        await log_fn(f"  已下载 {_os.path.getsize(fn) // 1024} KB")

        # 解包: tar.gz / zip / 裸二进制
        binpath = None
        if tarfile.is_tarfile(fn):
            with tarfile.open(fn) as tf:
                tf.extractall(tmpd)
            for root, _d, files in _os.walk(tmpd):
                for f2 in files:
                    if f2 == glob.split(".")[0] or f2.lower() in (repo.split("/")[1].lower(),):
                        binpath = _os.path.join(root, f2); break
        elif fn.endswith(".zip"):
            with zipfile.ZipFile(fn) as zf:
                zf.extractall(tmpd)
            for root, _d, files in _os.walk(tmpd):
                for f2 in files:
                    if f2.lower() == repo.split("/")[1].lower():
                        binpath = _os.path.join(root, f2); break
        else:
            binpath = fn
        if not binpath:
            await log_fn("  ✗ 解包后未找到可执行文件", "error")
            return False, spec
        _os.chmod(binpath, 0o755)
        # 安装到 /usr/local/bin (需权限; 调用方已确认 root 或 sudo 免密)
        from backend import deps as _deps
        _ok, priv = _deps.has_root_priv()
        dest = "/usr/local/bin/" + _os.path.basename(binpath)
        argv = _deps.with_priv(["/bin/cp", "-f", binpath, dest], priv)
        p = await _aio.create_subprocess_exec(*argv, stdout=_aio.subprocess.PIPE,
                                              stderr=_aio.subprocess.STDOUT)
        o, _ = await p.communicate()
        if p.returncode != 0:
            await log_fn(f"  ✗ 复制到 {dest} 失败: {(o or b'').decode()[:200]}", "error")
            return False, spec
        await log_fn(f"  ✅ 已安装 → {dest}")
        return True, dest
    except Exception as e:
        await log_fn(f"  ✗ 安装异常: {e}", "error")
        return False, spec



# ---------------------------------------------------------------------------
# v5.20.0 · 阶段 5: TrueNAS REST 控制面 + ZFS 闭环
# ---------------------------------------------------------------------------
async def handle_truenas_api(ws, data: dict):
    """TrueNAS REST 控制面统一入口 (只读为主, 写操作需 confirm)。

    action=test     连通性 + 版本
    action=pools    存储池
    action=datasets 数据集 (可按 pool 过滤)
    action=snapshots 快照 (可按 dataset 过滤)
    action=snapshot  打快照 (写; 需 confirm=true) —— ZFS 闭环的取还原点
    action=rm_snapshot 删快照 (写; 需 confirm=true)
    action=save_config  导出完整系统配置 tar (写; 需 confirm=true)

    与 PVE 集合同策略: 自签证书不校验, 因此只用于内网。
    """
    import asyncio as _aio
    from backend.platforms.truenas import TrueNASClient

    req_id = data.get("req_id") or ""
    sub = (data.get("sub") or "test").strip().lower()
    host = (data.get("host") or "").strip()
    if not host:
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "msg": "缺少 host"})
        return
    cli = TrueNASClient(
        host=host,
        token=data.get("api_key") or data.get("token") or "",
        user=data.get("user") or "",
        password=data.get("password") or "",
        port=int(data.get("port") or 443),
        use_https=(str(data.get("scheme") or "https").lower() != "http"),
    )

    # 写操作二次确认 (服务端再验一次)
    if sub in ("snapshot", "rm_snapshot", "save_config") and not data.get("confirm"):
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "msg": f"{sub} 是写操作, 需要二次确认 (confirm=true)"})
        return

    loop = _aio.get_event_loop()

    def _run():
        if sub == "test":
            ok, msg = cli.test()
            return {"ok": ok, "msg": msg}
        if sub == "pools":
            return {"pools": cli.pools()}
        if sub == "datasets":
            return {"datasets": cli.datasets(data.get("pool") or "")}
        if sub == "snapshots":
            return {"snapshots": cli.snapshots(data.get("dataset") or "")}
        if sub == "snapshot":
            return {"result": cli.snapshot_for_zfs_send(
                data.get("dataset") or "", data.get("name") or "")}
        if sub == "rm_snapshot":
            return {"result": cli.delete_snapshot(data.get("id") or "")}
        if sub == "save_config":
            return {"result": cli.save_config()}
        if sub == "jobs":
            return {"jobs": cli.jobs()}
        raise RuntimeError(f"未知 sub: {sub}")

    try:
        # REST 调用是同步 urllib → 必须走线程池, 否则堵住事件循环
        # (与 deps.scan 同一个坑: 同步 IO 放 async 上下文里会把整条 WS 拖死)
        r = await loop.run_in_executor(None, _run)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "truenas_result": True, "sub": sub,
                            "msg": f"TrueNAS 调用失败: {e}"})
        return
    await ws.send_json({"type": "result", "status": "ok", "req_id": req_id,
                        "truenas_result": True, "sub": sub, **r})


# ---------------------------------------------------------------------------
# v5.20.0 · 阶段 5: 零信任传输 (主机密钥钉死 + 短时效传输令牌)
# ---------------------------------------------------------------------------
async def handle_zerotrust(ws, data: dict):
    """零信任基础件统一入口。

    sub=status   概览 (已钉死主机数 / 令牌策略)
    sub=verify   核对某主机密钥 (可选 allow_tofu / expect_fingerprint)
    sub=trust    显式(重新)信任 → 钉死当前指纹 (写)
    sub=untrust  移除钉死记录 (写)
    sub=pins     列出全部钉死记录
    sub=issue    签发一次性传输令牌 (短时效)
    sub=check    校验令牌 (含 scope 比对)
    """
    import asyncio as _aio
    from backend.core_fabric import zerotrust as zt

    req_id = data.get("req_id") or ""
    sub = (data.get("sub") or "status").strip().lower()
    loop = _aio.get_event_loop()

    def _run():
        if sub == "status":
            return zt.status()
        if sub == "pins":
            return {"pins": zt.list_pins()}
        if sub == "verify":
            return zt.verify_host_key(data.get("host") or "", int(data.get("port") or 22),
                                      allow_tofu=bool(data.get("allow_tofu", True)),
                                      expect_fingerprint=data.get("expect_fingerprint") or "")
        if sub == "trust":
            return zt.trust(data.get("host") or "", int(data.get("port") or 22),
                            data.get("fingerprint") or "")
        if sub == "untrust":
            return zt.untrust(data.get("host") or "", int(data.get("port") or 22))
        if sub == "issue":
            tok = zt.issue_token(data.get("scope") or {}, int(data.get("ttl") or zt.TOKEN_TTL))
            return {"token": tok, "ttl": int(data.get("ttl") or zt.TOKEN_TTL)}
        if sub == "check":
            return zt.verify_token(data.get("token") or "", data.get("need_scope") or None)
        raise RuntimeError(f"未知 sub: {sub}")

    if sub in ("trust", "untrust") and not data.get("confirm"):
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "zt_result": True,
                            "msg": f"{sub} 会改变信任状态, 需要二次确认 (confirm=true)"})
        return
    try:
        # ssh-keyscan 是同步子进程 → 走线程池, 否则堵事件循环 (与 deps/truenas 同一个坑)
        r = await loop.run_in_executor(None, _run)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "zt_result": True, "sub": sub, "msg": f"零信任操作失败: {e}"})
        return
    ok = r.get("ok", True) if isinstance(r, dict) else True
    await ws.send_json({"type": "result", "status": "ok" if ok else "error",
                        "req_id": req_id, "zt_result": True, "sub": sub, **r})


# ---------------------------------------------------------------------------
# v5.20.2 · 远程桌面: VNC/端口探测 (远程桌面面板「🔎 探测」)
# ---------------------------------------------------------------------------
async def handle_remote_desk_ping(ws, data: dict):
    """探测目标 TCP 端口可达性 (VNC 5900 / guacd 4822 等)。"""
    import asyncio as _aio
    req_id = data.get("req_id") or ""
    host = (data.get("host") or "").strip()
    port = int(data.get("port") or 5900)
    if not host:
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "msg": "缺少 host"})
        return
    async def _probe():
        try:
            r, w = await _aio.wait_for(_aio.open_connection(host, port), timeout=8)
            # VNC 服务器会先发 RFB 握手串 "RFB xxx.yyy\n"
            try:
                head = await _aio.wait_for(r.read(12), timeout=5)
            except Exception:
                head = b""
            try:
                w.close()
            except Exception:
                pass
            tag = ""
            if head.startswith(b"RFB "):
                tag = f" · RFB 协议 {head[4:12].decode('ascii', 'replace').strip()} (标准 VNC ✓)"
            return {"ok": True, "msg": f"{host}:{port} 可达{tag}", "rfb": head.decode('ascii', 'replace').strip()}
        except Exception as e:
            return {"ok": False, "msg": f"{host}:{port} 不可达 — {type(e).__name__}: {e}"}
    # open_connection 本身是异步非阻塞, 直接 await 即可
    r = await _probe()
    await ws.send_json({"type": "result", "status": "ok" if r.get("ok") else "error",
                        "req_id": req_id, "rfb": r.get("rfb", ""),
                        "msg": r.get("msg", "")})


# ---------------------------------------------------------------------------
# v5.98.17 · 远程运维「连接诊断报告」(连接失败时把**真实**证据一次给全)
# ---------------------------------------------------------------------------
async def handle_remote_diag(ws, data: dict):
    """收集"为什么连不上"的可查证证据 —— 只报告本机真能查到的东西, 不猜、不回落。

    证据项: ①目标 TCP 可达性(含 VNC RFB 握手串) ②本机 guacd 端口/程序/版本
    ③本机 FreeRDP 各版本可执行文件与版本 ④该目标最近运维日志 ⑤按证据给结论。
    """
    import asyncio as _aio
    import shutil as _sh
    import subprocess as _sp
    req_id = data.get("req_id") or ""
    host = (data.get("host") or "").strip()
    port = int(data.get("port") or 0)
    proto = (data.get("proto") or "rdp").strip().lower()
    flavor = (data.get("flavor") or "").strip()
    facts = []

    def _run(cmd, t=6):
        try:
            r = _sp.run(cmd, stdout=_sp.PIPE, stderr=_sp.STDOUT, timeout=t)
            return r.returncode, (r.stdout or b"").decode("utf-8", "replace").strip()
        except Exception as e:
            return -1, "%s: %s" % (type(e).__name__, e)

    # ① 目标端口可达性 (真连一次, VNC 还能读到 RFB 握手串)
    rfb = ""
    if host and port:
        try:
            _r, _w = await _aio.wait_for(_aio.open_connection(host, port), timeout=6)
            _head = b""
            try:
                _head = await _aio.wait_for(_r.read(12), timeout=3)
            except Exception:
                pass
            try:
                _w.close()
            except Exception:
                pass
            if _head.startswith(b"RFB "):
                rfb = _head[4:].decode("ascii", "replace").strip()
            facts.append({"k": "目标 %s:%d TCP" % (host, port), "ok": True,
                          "v": "已建立" + (" · 收到 RFB %s" % rfb if rfb else "")})
        except Exception as e:
            facts.append({"k": "目标 %s:%d TCP" % (host, port), "ok": False,
                          "v": "%s: %s" % (type(e).__name__, e)})
    else:
        facts.append({"k": "目标端口", "ok": None, "v": "未提供 host/port, 跳过"})

    # ② guacd (网关后端): 端口探活 + 程序与版本
    guacd_alive = []
    for _p in (4823, 4822):
        try:
            _r, _w = await _aio.wait_for(_aio.open_connection("127.0.0.1", _p), timeout=3)
            try:
                _w.close()
            except Exception:
                pass
            guacd_alive.append(_p)
        except Exception:
            pass
    _exe = _sh.which("guacd")
    _ver = ""
    if _exe:
        _rc, _out = _run([_exe, "-v"], 5)
        _ver = _out.splitlines()[0] if _out else ""
    facts.append({"k": "本机 guacd", "ok": bool(guacd_alive),
                  "v": ("端口 %s 可连" % guacd_alive) if guacd_alive else "端口 4822/4823 均不可连 (guacd 未运行)"})
    facts.append({"k": "guacd 程序", "ok": bool(_exe), "v": (_exe + (" · " + _ver if _ver else "")) or "未找到 guacd"})

    # ③ FreeRDP (直连后端): 各候选可执行文件 + 版本
    _found = {}
    for _n in ("xfreerdp3", "xfreerdp", "freerdp3", "freerdp", "sdl-freerdp", "wlfreerdp"):
        _p2 = _sh.which(_n)
        if _p2:
            _rc, _out = _run([_p2, "--version"], 5)
            # FreeRDP 会先刷一堆 WARN 日志, 真正的版本号形如 "This is FreeRDP version 3.5.1 (3.5.1)"
            _vm = re.search(r"version\s+([0-9][0-9.]*)", _out or "")
            _found[_n] = ("v" + _vm.group(1)) if _vm else (_p2 or _n)
    facts.append({"k": "本机 FreeRDP", "ok": bool(_found),
                  "v": ("; ".join("%s: %s" % (k, v) for k, v in _found.items())) or "未找到任何 FreeRDP 可执行文件"})

    # ④ 该目标最近的运维日志 (真实文件尾部, 只取匹配行)
    _logtail = []
    try:
        from backend.log import LOG_FILE as _lf  # type: ignore
    except Exception:
        _lf = ""
    if not _lf:
        import os as _os
        for _c in ("data/fonriv_operations.log", "/opt/fonriv/data/fonriv_operations.log"):
            if _os.path.exists(_c):
                _lf = _c
                break
    if _lf and host:
        try:
            with open(_lf, "r", encoding="utf-8", errors="replace") as _f:
                _lines = _f.readlines()[-600:]
            _logtail = [l.rstrip() for l in _lines if host in l][-8:]
        except Exception as e:
            facts.append({"k": "运维日志", "ok": None, "v": "读取失败: %s" % e})
    if host:
        facts.append({"k": "该目标最近日志 (%d 条)" % len(_logtail), "ok": None,
                      "v": "\n".join(_logtail) if _logtail else "(无相关记录)"})

    # ⑤ 结论 (按证据推, 不猜)
    _tgt = facts[0]
    if not host or not port:
        verdict = "缺少目标地址/端口, 无法定位。请在连接表单里填好主机与端口后重试。"
    elif not _tgt.get("ok"):
        verdict = ("**目标不可达** —— 网络层就没通。请依次确认: ①IP/端口是否正确 ②远端服务是否在跑"
                   "(Windows 要打开「远程桌面」; VNC 要起 vncserver) ③防火墙/安全组是否放通该端口 ④本机能否 ping 通。")
    elif proto == "vnc" and not rfb:
        verdict = ("端口**能连上但没收到 VNC 握手串**(RFB)** —— 端口开着的很可能不是 VNC 服务"
                   "(比如填成了 8006/80)。请核对 VNC 端口(默认 5900 + display 号)。")
    elif not guacd_alive:
        verdict = ("目标可达, 但**本机 guacd 网关没在运行** —— 走网关方式的 RDP/SSH 一定连不上。"
                   "可点「🔁 换后端再试」改用直连后端, 或启动 guacd 后重试。")
    elif flavor and "3" in flavor and not any("3" in _k for _k in _found):
        verdict = ("你选择了 **FreeRDP 3** 但本机没装它 —— 请点「🔁 换后端再试」切到 FreeRDP 2。")
    else:
        verdict = ("本机后端与目标端口都正常 —— 失败更可能出在**认证或远端策略**(用户名/密码/域/安全模式/NLA)。"
                   "请核对凭据(注意这台机器与其他机器不要串用密码), 必要时切换「安全模式」。")
    await ws.send_json({"type": "result", "status": "ok", "req_id": req_id,
                        "facts": facts, "verdict": verdict,
                        "probe": {"host": host, "port": port, "proto": proto, "flavor": flavor}})


# ---------------------------------------------------------------------------
# v5.22.0 · G6 E2EE 双端协商: 实例身份 + 对端公钥交换 (经 SSH 信任通道, TOFU 钉死)
# ---------------------------------------------------------------------------
async def handle_e2ee(ws, data: dict):
    """端到端加密身份协商统一入口。

    sub=status   本机身份指纹 + 已钉死对端数
    sub=pubkey   本机身份公钥 (供对端钉死我们)
    sub=exchange 经 SSH 到远端 Fonriv 拉取其身份公钥 (remote_identity_cmd)
    sub=pin      钉死对端公钥 {host, pub_b64} (写, 需 confirm; 换钥同)
    sub=unpin    解除钉死 {host} (写, 需 confirm)
    sub=peers    列出全部钉死记录
    """
    import asyncio as _aio
    from backend.core_fabric import e2ee as _e2

    req_id = data.get("req_id") or ""
    sub = (data.get("sub") or "status").strip().lower()
    loop = _aio.get_event_loop()

    def _run_sync():
        if sub == "status":
            kp = _e2.identity_keypair()
            return {"ok": True, "fingerprint": kp["fingerprint"], "pub_b64": kp["pub_b64"],
                    "peers": len(_e2.list_peers())}
        if sub == "pubkey":
            kp = _e2.identity_keypair()
            return {"ok": True, "pub_b64": kp["pub_b64"], "fingerprint": kp["fingerprint"]}
        if sub == "peers":
            return {"ok": True, "peers": _e2.list_peers()}
        raise RuntimeError(f"未知 sub: {sub}")

    # 写操作: confirm 闸 (pin/unpin 改变信任状态)
    if sub in ("pin", "unpin") and not data.get("confirm"):
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "e2ee_result": True, "sub": sub,
                            "msg": f"{sub} 会改变对端信任状态, 需要二次确认 (confirm=true)"})
        return

    if sub == "pin":
        r = _e2.pin_peer(data.get("host") or "", data.get("pub_b64") or "")
        ok = r.get("ok")
        msg = ("⚠ 对端已换钥 (公钥与此前钉死记录不符) — 已按新公钥钉死, "
               "请与对端核对指纹 " + r.get("fingerprint", "")) if r.get("rekey") else \
              (f"✓ 已钉死 {data.get('host')} 指纹 {r.get('fingerprint', '')}" if ok else r.get("msg", ""))
        await ws.send_json({"type": "result", "status": "ok" if ok else "error",
                            "req_id": req_id, "e2ee_result": True, "sub": sub,
                            "rekey": r.get("rekey", False), "msg": msg, **r})
        return
    if sub == "unpin":
        r = _e2.unpin_peer(data.get("host") or "")
        await ws.send_json({"type": "result", "status": "ok" if r.get("ok") else "error",
                            "req_id": req_id, "e2ee_result": True, "sub": sub,
                            "msg": f"✓ 已解除 {data.get('host')} 的钉死" if r.get("ok") else r.get("msg", "")})
        return

    if sub == "exchange":
        # 经 SSH 信任通道 (主机密钥已被 zerotrust 钉死) 到远端执行 identity_publine
        target = SSHTarget.from_ws_data(data)
        if not target.host:
            await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                "msg": "缺少 host"})
            return
        # 部署目录: 统一 /opt/fonriv（v5.90.0 起不再兼容旧目录名）
        cmd = ("for d in /opt/fonriv; do "
               "cd \"$d\" 2>/dev/null && break; done; "
               "./venv/bin/python -c \"from backend.core_fabric.e2ee import identity_publine; "
               "print(identity_publine())\" 2>/dev/null || "
               "python3 -c \"import sys; sys.path.insert(0, '/opt/fonriv'); "
               "from backend.core_fabric.e2ee import identity_publine; print(identity_publine())\"")
        try:
            async with target.runner() as run:
                code, out, _e = await run.exec(cmd, timeout=25, merge_stderr=True)
        except Exception as e:
            await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                "msg": f"交换失败 (SSH): {e}"})
            return
        line = (out or "").strip().splitlines()
        line = next((x for x in reversed(line) if x.strip().startswith("{")), "")
        if code != 0 or not line:
            await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                "msg": "远端未返回身份公钥 — 对端 Fonriv 版本过旧 (需含 e2ee.identity_publine), "
                                       "或 /opt/fonriv 路径不符",
                                "raw": (out or "")[-200:]})
            return
        import json as _json
        try:
            info = _json.loads(line)
        except Exception:
            await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                                "msg": "远端返回无法解析 (非 JSON)"})
            return
        await ws.send_json({"type": "result", "status": "ok", "req_id": req_id,
                            "e2ee_result": True, "sub": "exchange", "host": target.host,
                            "pub_b64": info.get("pub_b64", ""),
                            "fingerprint": info.get("fingerprint", ""),
                            "msg": f"✓ 已取回 {target.host} 身份公钥 (指纹 {info.get('fingerprint', '')}) — 请核对后用 sub=pin 钉死"})
        return

    try:
        r = await loop.run_in_executor(None, _run_sync)
    except Exception as e:
        await ws.send_json({"type": "result", "status": "error", "req_id": req_id,
                            "e2ee_result": True, "sub": sub, "msg": f"e2ee 操作失败: {e}"})
        return
    await ws.send_json({"type": "result", "status": "ok", "req_id": req_id,
                        "e2ee_result": True, "sub": sub, **r})

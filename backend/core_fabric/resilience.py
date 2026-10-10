"""Fonriv - Transfer Fabric · 容错回退链 (v5.19.1)

目标: **优先保证任务完成** — 第一种方法失败自动换第二种, 再失败切引擎/换通路,
最后才回退报错, 并把每一次降级的原因与结果完整返回给调用方。

用法:
    res = await run_with_fallback([
        Attempt("标准参数",   fn1, why="首选"),
        Attempt("兼容重试",   fn2, why="方法1失败: 版本不兼容"),
        Attempt("切换引擎",   fn3, why="前两种均失败"),
    ], on_log=print)
    if not res["ok"]:  # 全部失败 → res["msg"] 已含每一次失败原因
        ...

每次尝试都会记录到 `_ATTEMPT_LOG` (供「核心运行状况」展示降级命中情况)。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional


@dataclass
class Attempt:
    label: str                                  # 这次尝试的方法名 (展示用)
    fn: Callable[..., Any]                      # 可 await 的函数; 返回 (ok:bool, payload/message)
    why: str = ""                               # 为什么走到这一步 (降级原因)
    timeout: Optional[float] = None            # 单次超时 (秒), None = 不限
    is_fallback: bool = False                   # 是否为降级路径


# 最近回退记录 (内存环形, 供核心运行状况展示)
_ATTEMPT_LOG: list = []
_MAX_LOG = 200


def _record(scope: str, label: str, ok: bool, ms: int, why: str, msg: str = ""):
    _ATTEMPT_LOG.append({
        "ts": time.strftime("%H:%M:%S"),
        "scope": scope,
        "label": label,
        "ok": bool(ok),
        "ms": ms,
        "why": (why or "")[:160],
        "msg": (msg or "")[:200],
    })
    if len(_ATTEMPT_LOG) > _MAX_LOG:
        del _ATTEMPT_LOG[:len(_ATTEMPT_LOG) - _MAX_LOG]


def recent_attempts(limit: int = 50) -> list:
    return list(reversed(_ATTEMPT_LOG[-max(1, min(200, limit)):]))


def fallback_summary() -> dict:
    """回退命中统计: 多少次任务走到了第 N 条路径"""
    total = len(_ATTEMPT_LOG)
    # 降级 = 走了非首选路径 (首次尝试的 why='首选' 不计入)
    fb = sum(1 for x in _ATTEMPT_LOG if x.get("why") and x.get("why") != "首选")
    return {
        "total_attempts": total,
        "with_fallback": fb,
        "fallback_ratio": round(100.0 * fb / total, 1) if total else 0.0,
        "recent": recent_attempts(20),
    }


async def run_with_fallback(attempts: list, *, scope: str = "",
                            on_log: Optional[Callable[[str, str], None]] = None,
                            stop_on_partial: bool = True) -> dict:
    """依次尝试; 第一个成功即返回。

    返回:
      {ok, label, attempt_index, tried:[{label,why,ok,ms,msg}], msg, scope, degraded}
      · degraded=True 表示经过了至少一次降级才成功
      · ok=False 时 msg 汇总了每一次失败原因 (便于用户定位, 不用翻日志)
    """
    tried = []
    import asyncio as _a

    def _log(level, text):
        if on_log:
            try:
                on_log(text, level)
            except Exception:
                pass

    if not attempts:
        return {"ok": False, "msg": "无可用执行方法", "tried": [], "scope": scope, "degraded": False}

    for i, at in enumerate(attempts):
        label = getattr(at, "label", f"方法{i + 1}")
        why = getattr(at, "why", "") or ("首选" if i == 0 else "前一种方法失败后降级")
        t0 = time.time()
        try:
            if getattr(at, "timeout", None):
                res = await _a.wait_for(at.fn(), at.timeout)
            else:
                res = await at.fn()
            ok, payload = (res if isinstance(res, tuple) else (bool(res), res))
        except _a.TimeoutError:
            ok, payload = False, f"超时 (>{at.timeout}s)"
        except Exception as e:
            ok, payload = False, f"{type(e).__name__}: {e}"
        ms = int((time.time() - t0) * 1000)
        msg = "" if isinstance(payload, (dict, list)) else str(payload or "")
        _record(scope, label, ok, ms, why, msg)
        tried.append({"label": label, "why": why, "ok": bool(ok), "ms": ms, "msg": msg[:200]})

        if ok:
            degraded = i > 0
            if degraded:
                _log("warn", f"↩ 降级成功: {label} (原因: {why})")
            return {"ok": True, "label": label, "attempt_index": i, "tried": tried,
                    "degraded": degraded, "scope": scope,
                    "payload": payload if isinstance(payload, (dict, list)) else None,
                    "msg": f"✓ {label} 成功" + (f" (经 {i} 次降级: {why})" if degraded else "")}
        _log("warn", f"✗ {label} 失败: {msg[:160]} — " +
             ("尝试下一方法…" if i < len(attempts) - 1 else "已无后备方法"))

    # 全部失败 → 汇总每一次原因
    lines = [f"  {k + 1}) {x['label']}: {x['msg'] or '失败'} (why: {x['why']})" for k, x in enumerate(tried)]
    full = "所有执行方法均失败:\n" + "\n".join(lines)
    return {"ok": False, "label": tried[-1]["label"], "attempt_index": len(tried) - 1,
            "tried": tried, "degraded": True, "scope": scope, "msg": full}


# ═════════════════════════════════════════════════════════════
# 卡死任务检测与处置
# ═════════════════════════════════════════════════════════════

async def kill_stalled(threshold_sec: int = 900, dry_run: bool = True) -> dict:
    """扫描并(可选)终止卡死任务: 超过阈值无输出 → 判定卡死。

    dry_run=True 只报告不处置 (默认安全); dry_run=False 才真正终止。
    """
    import os as _os
    now = time.time()
    out = {"scanned": 0, "stalled": [], "killed": [], "dry_run": bool(dry_run)}
    try:
        from backend.ssh_lib.runner import active_tasks
    except Exception:
        return out
    for tid, proc in list(active_tasks.items()):
        out["scanned"] += 1
        pid = getattr(proc, "pid", None)
        last_out = getattr(proc, "_rp_last_out", None) or getattr(proc, "_rp_started", None)
        idle = int(now - last_out) if last_out else None
        if idle is None or idle < threshold_sec:
            continue
        row = {"task_id": str(tid)[:16], "pid": pid, "idle_sec": idle}
        out["stalled"].append(row)
        if dry_run:
            continue
        try:
            if pid:
                try:
                    _os.killpg(_os.getpgid(pid), 15)   # SIGTERM 进程组
                except Exception:
                    _os.kill(pid, 15)
                await _a_sleep(2)
                try:
                    _os.killpg(_os.getpgid(pid), 9)    # SIGKILL 兜底
                except Exception:
                    pass
            else:
                proc.terminate()
            row["killed"] = True
            out["killed"].append(row)
        except Exception as e:
            row["kill_error"] = str(e)[:120]
    return out


async def _a_sleep(sec: float):
    import asyncio
    await asyncio.sleep(sec)

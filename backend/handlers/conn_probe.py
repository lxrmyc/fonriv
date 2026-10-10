"""Fonriv - 统一资源探测台账 (v5.93.0)

背景 (用户报"连接中心里 Seafile / SMB 共享不显示绿色小圆点"):
  云存储 / 网络共享这两类资源**从来没有做过健康探测** —— `hub_nodes` 对 cloud 恒下发
  `state.reachable=None`, 前端 `healthDot()` 只认 online/offline/degraded, 于是恒灰(#ccc);
  而各页面里已有的「测试连接」(`remote_test` / `share_test`) 结果只弹一个 toast, 用完即弃,
  刷新一次又回到"未探测" —— 同一台资源在不同页面看到的状态因此互相矛盾。

做法: 把已有的测试结果统一记到这里的进程内台账, 由 `hub_nodes` 下发到所有入口 ——
  **一次探测, 连接中心/多云文件管理/共享页看到同一个状态**。
纪律: 未探测就是 None(界面显式显示"未探测"), 绝不把"没探过"伪装成"正常"。

字段: status ∈ online | offline | degraded; at=探测时间戳; latency_ms; msg=人话结论。
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

_PROBE: Dict[str, Dict[str, Any]] = {}
KEEP_SEC = 86400          # 台账保留 24h (过期即清理, 防无限增长)
FRESH_SEC = 600           # 600s 内视为"新鲜"(界面上区别于历史结论)
LONG_SEC = 86400          # v5.95.0 · 长期连接类(云存储/网络共享): 结论 24h 内都算"在线"(用户明确要求:
                          #   这两类**没有超时设置**, 除手动卸载/断开外应长期保持在线的语义)


def record_probe(guid: Optional[str], ok: Optional[bool] = None, latency_ms: int = 0,
                 msg: str = "", status: Optional[str] = None,
                 long_lived: bool = False) -> Optional[dict]:
    """记录一次真实探测结论 (由 remote_test / share_test / 挂载动作调用)。

    status 显式给出时优先(如 degraded); 否则由 ok 推 online/offline。
    """
    if not guid:
        return None
    st = status or ("online" if ok else "offline")
    _PROBE[str(guid)] = {"status": st, "at": time.time(),
                         "latency_ms": int(latency_ms or 0),
                         "msg": (msg or "")[:300],
                         "long": bool(long_lived)}      # 长期连接(云/共享): 界面按"长期在线"呈现
    now = time.time()
    for k in [k for k, v in list(_PROBE.items()) if now - (v.get("at") or 0) > KEEP_SEC]:
        _PROBE.pop(k, None)
    return _PROBE[str(guid)]


def probe_state(guid: Optional[str]) -> Optional[dict]:
    """单条: 无记录返回 None(**未探测**, 不得回落成 online)。"""
    v = _PROBE.get(str(guid or ""))
    if not v:
        return None
    out = dict(v)
    out["age_sec"] = int(max(0, time.time() - (v.get("at") or 0)))
    out["fresh"] = out["age_sec"] <= (LONG_SEC if v.get("long") else FRESH_SEC)
    return out


def probe_map(guids: List[str]) -> Dict[str, dict]:
    """批量: 只返回有记录的。"""
    out: Dict[str, dict] = {}
    for g in (guids or []):
        st = probe_state(g)
        if st:
            out[str(g)] = st
    return out


def clear(guid: Optional[str] = None) -> None:
    if guid:
        _PROBE.pop(str(guid), None)
    else:
        _PROBE.clear()

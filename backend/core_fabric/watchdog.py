"""Fonriv - 核心运行状况看门狗 (v5.19.7)

周期性自检 → 发现告警 → publish 到事件总线 (topic=vitals.alert) →
既有 alerting.py 按规则路由到飞书/钉钉/企微/Slack/Webhook/Email。

设计要点:
  · 只在有告警时发布 (无告警不刷屏)
  · 同类告警自带 30 分钟冷却 (复用 alerting 的 silence + 自身 state 去重),
    避免 CPU 90% 每分钟都报一次
  · 恢复通知: 告警消失时发一条 recovery (level=ok), 方便闭环
"""
from __future__ import annotations

import asyncio
import time

_INTERVAL_SEC = 300          # 5 分钟一检
_state: dict = {}            # item -> level (上次告警级别, 用于恢复通知)
_last_run: float = 0.0


def _publish(topic: str, payload: dict):
    try:
        from backend.events import publish
        publish(topic, payload)
    except Exception as e:
        print(f"[watchdog] publish fail: {e}")


async def run_once() -> dict:
    """跑一轮自检, 把 (新出现的) 告警发布到事件总线。返回本轮摘要。"""
    global _last_run
    from backend.core_fabric import vitals
    sc = vitals.selfcheck()
    alerts = sc.get("alerts") or []
    now = time.time()
    _last_run = now

    published = []
    current = {}
    for a in alerts:
        item = str(a.get("item") or "?")
        current[item] = a
        key = item
        prev = _state.get(key)
        if prev is not None:
            continue   # 上轮已在告警中 → 静默 (避免重复刷屏; 通道侧还有 silence 兜底)
        _state[key] = a.get("level")
        payload = {"level": a.get("level"), "item": item, "msg": a.get("msg"),
                   "ts": now, "conclusion": sc.get("conclusion")}
        _publish("vitals.alert", payload)
        published.append(payload)

    # 恢复通知: 上轮有、本轮无的告警
    for item in list(_state.keys()):
        if item not in current:
            _publish("vitals.recovery", {"item": item, "level": "ok",
                                         "msg": f"[{item}] 告警已恢复", "ts": now})
            _state.pop(item, None)
            published.append({"item": item, "recovery": True})

    return {"conclusion": sc.get("conclusion"), "alerts": len(alerts),
            "published": len(published), "state_items": list(_state.keys())}


async def loop():
    """后台循环 (app startup 启动; 取消由任务取消传播)"""
    while True:
        try:
            r = await run_once()
            if r.get("published"):
                print(f"[watchdog] published {r['published']} alert(s), conclusion={r['conclusion']}")
        except Exception as e:
            print(f"[watchdog] round fail: {e}")
        await asyncio.sleep(_INTERVAL_SEC)


def start_background() -> None:
    """在既有事件循环里启动看门狗 (幂等)

    v5.98.1 · FIX: 旧实现把局部变量也叫 `loop`(`loop = asyncio.get_event_loop()`),
    而本模块的周期协程恰好叫 `loop()` → 第 87 行 `loop.create_task(loop())` 实际是
    **拿事件循环对象当函数调**, 抛 "'Loop' object is not callable"; 被 app.py 的
    except 吞成一行 `[app] watchdog start fail` → 看门狗**从未启动**(服务卡住时无人兜底)。
    现在变量改名, 并让幂等判断与创建都在同一循环下进行。
    """
    try:
        evloop = asyncio.get_event_loop()
    except RuntimeError:
        return
    tasks = [t for t in asyncio.all_tasks(evloop) if not t.done() and t.get_name() == "vitals-watchdog"]
    if tasks:
        return
    t = evloop.create_task(loop())
    try:
        t.set_name("vitals-watchdog")
    except Exception:
        pass
    print("[watchdog] started · 每 5 分钟自检, 告警经事件总线推送")

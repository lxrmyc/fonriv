"""v5.98.1 · 探测/外部命令专用「有界线程池 + 超时守卫 + 短 TTL 缓存」。

为什么要单独一个池(实测根因, 不是洁癖):

  本机服务曾**偶发数十秒整体无响应** —— HTTP 与 WS 一起卡, 期间连 `/api/websion` 都超时,
  操作日志里能看到一群慢动作: `conn_list 60.2s` · `guacd 网关状态/部署/地址保存 57.7s` ·
  `列出 remotes 26.5s` · `测试共享连通性 13.8s`, 与此同时 **本地列目录 `fonr_list` 33.5s**
  (而同样的调用单测只要 0.5s)。

  根因不是"某个动作慢", 而是**它们和交互路径共用同一个线程池**:
  `asyncio.to_thread()` / `loop.run_in_executor(None, ...)` 用的都是进程默认 executor
  (上限 `min(32, cpu+4)`)。多台不可达主机各占一个线程几十秒(长超时的 `ssh -O check`、
  TCP 连接、`rclone`/`docker` 外部命令) → 池被占满 → 连本地列目录、缩略图这类
  毫秒级任务也排在后面 → 用户侧就是"整机卡住、刷新不出列表、点了没反应"。

做法:
  · 连通性/主机可达/外部命令**探测**统一走这里的有界池(默认 6 线程), 与默认池隔离 ——
    探测再慢也压不垮交互路径;
  · 统一带超时: 超时即"探测失败/未知", 绝不让调用方无限等;
  · 同一 key 的结论可短 TTL 缓存(UI 轮询、多个页面对同一资源探测时不重复打网络)。

用法:
    from backend import probe_pool as pp
    ok = await pp.run(lambda: probe(host, port), timeout=2.0, default=False)
    r = await pp.run_cached("guacd:" + host, 10.0, lambda: probe(host, port), timeout=3.0)
"""
from __future__ import annotations

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Optional, Tuple

# 探测池: 有界(与默认池隔离)。取 6 是经验值 —— 再大也还是要跟真实网络/外部命令抢,
# 关键是"有界", 让慢探测最多占用这么多线程, 不再挤占交互任务的默认池。
PROBE_WORKERS = 6
_POOL: Optional[ThreadPoolExecutor] = None
_LOCK = threading.Lock()

_cache: Dict[str, Tuple[float, Any]] = {}      # key -> (expire_at, value)
_CACHE_LOCK = threading.Lock()
_CACHE_MAX = 512


def pool() -> ThreadPoolExecutor:
    global _POOL
    if _POOL is None:
        with _LOCK:
            if _POOL is None:
                _POOL = ThreadPoolExecutor(max_workers=PROBE_WORKERS,
                                           thread_name_prefix="fonriv-probe")
    return _POOL


def stats() -> dict:
    """可观测量: 池线程数 + 缓存条目数(排障/自检用, 不做花活)。"""
    p = _POOL
    return {"workers": PROBE_WORKERS,
            "pool_created": p is not None,
            "threads": len(getattr(p, "_threads", ())) if p is not None else 0,
            "cache_entries": len(_cache)}


async def run(fn: Callable, *args, **kw) -> Any:
    """把阻塞探测丢进**探测池**执行, 并强制执行超时。

    kw: timeout=3.0(秒) · default=<超时/异常时返回的值>
    """
    timeout = float(kw.pop("timeout", 3.0) or 3.0)
    default = kw.pop("default", None)
    if kw:
        raise TypeError("probe_pool.run 不支持参数: %s" % ",".join(kw.keys()))
    loop = asyncio.get_event_loop()
    fut = loop.run_in_executor(pool(), lambda: fn(*args))
    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        return default
    except Exception:
        return default


def _cache_get(key: str):
    now = time.time()
    with _CACHE_LOCK:
        hit = _cache.get(key)
    if not hit:
        return None
    exp, val = hit
    if exp and exp < now:
        with _CACHE_LOCK:
            _cache.pop(key, None)
        return None
    return (True, val)


def cache_put(key: str, value: Any, ttl: float) -> None:
    if not ttl or ttl <= 0:
        return
    with _CACHE_LOCK:
        if len(_cache) >= _CACHE_MAX:      # 简单容量兜底: 清掉已过期的, 仍满则整体清空
            now = time.time()
            for k in [k for k, (e, _v) in _cache.items() if e and e < now]:
                _cache.pop(k, None)
            if len(_cache) >= _CACHE_MAX:
                _cache.clear()
        _cache[key] = (time.time() + float(ttl), value)


def cache_drop(prefix: str = "") -> int:
    """作废缓存(前缀匹配; 空串=全清)。返回清除条数。"""
    with _CACHE_LOCK:
        if not prefix:
            n = len(_cache)
            _cache.clear()
            return n
        keys = [k for k in _cache if k.startswith(prefix)]
        for k in keys:
            _cache.pop(k, None)
        return len(keys)


async def run_cached(key: str, ttl: float, fn: Callable, *args, **kw) -> Any:
    """带短 TTL 缓存的探测: 同一 key 在 ttl 内直接复用结论(不再打网络)。

    语义与 run() 一致(超时/异常返回 default)。**缓存的是"探测结论"**, 所以 ttl 要短
    (秒级~十秒级), 避免让用户看到过期状态。
    """
    hit = _cache_get(key)
    if hit:
        return hit[1]
    val = await run(fn, *args, **kw)
    if val is not None:
        cache_put(key, val, ttl)
    return val


def map_bounded(items, fn: Callable, workers: int = 4, timeout: float = 8.0) -> list:
    """并发但有界地对一批元素做阻塞探测(在**当前线程里**跑, 供已在 executor 的代码调用)。

    用途: `conn_list` 里逐个 session 做 `ssh -O check` —— 旧实现串行, N 个会话 × 8s 超时
    就是 N×8s(实测 conn_list 46 次、均值 12.8s、最大 60.2s)。有界并发后总耗时 ≈ 单次超时。
    """
    items = list(items)
    if not items:
        return []
    w = max(1, min(int(workers or 1), len(items)))
    if w == 1:
        return [fn(x) for x in items]
    with ThreadPoolExecutor(max_workers=w, thread_name_prefix="fonriv-probe-map") as ex:
        futs = [ex.submit(fn, x) for x in items]
        out = []
        for f in futs:
            try:
                out.append(f.result(timeout=timeout))
            except Exception:
                out.append(None)
        return out

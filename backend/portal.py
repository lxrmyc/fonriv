"""v5.65.0 · F1 **传送门（Ctrl+G）** —— 全局快速跳转的**数据汇总 + 模糊排序**。

## 单一真源（不重查表）

本模块**不自己查任何表**，只把既有出入口的数据汇总起来：
  · 资源/主机 → `backend.handlers.hub._ssh_nodes / _cloud_nodes / _share_nodes`
    （`hub_nodes` 用的就是这三个函数 → 连接中心与传送门**永远同源**，不会出现两套列表）
  · 存储     → `VFS.storages(user_id)`（与 FonrVFS 存储列表同源）
  · 最近记录 → `db.fonr_recent_list(uid)`（与 FonrVFS「最近」同源）
  · 面板/动作 → **由前端提供**（只有前端知道自己的 NAV_TREE），用**同一套打分规则**合并；
    JS 侧等价实现见 `frontend/static/portal.js::fuzzyScore`（两处规则必须保持一致，改一处要同步另一处）

## 打分规则（两处必须一致）

对 `label`（无则 `sub`/`path`）打分，取最高分：
  · 完全相同                       +1200
  · 前缀命中                       +1000
  · 词/路径段首命中（空格 / _ - / \\ : 、 等分段）+700
  · 子串命中                       +400  （命中位置越靠前略微加分）
  · 子序列命中（字符按序出现）      +200 - 间隔惩罚；间隔过大或字符不全 → **0（不匹配）**
空查询 → 全部返回，按"最近优先 + 原顺序"。
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

_SEP = set(" _-/:\\|.、,，()[]{}<>")          # 词/路径分段符
MAX_PER_KIND = 60


def _norm(s: Any) -> str:
    return str(s or "").strip().lower()


def fuzzy_score(query: str, text: str) -> int:
    """模糊打分（0 = 不匹配）。规则与前端 JS 实现保持一致。"""
    q, t = _norm(query), _norm(text)
    if not q:
        return 1
    if not t:
        return 0
    if t == q:
        return 1200
    if t.startswith(q):
        return 1000
    # 词/路径段首命中
    for i, ch in enumerate(t):
        if i > 0 and t[i - 1] in _SEP and t.startswith(q, i):
            return 700
    pos = t.find(q)
    if pos >= 0:
        return 400 + max(0, 60 - pos)          # 命中越靠前略加分
    # 子序列
    idx, gaps = 0, 0
    last = -1
    for ch in q:
        j = t.find(ch, idx)
        if j < 0:
            return 0
        if last >= 0:
            gaps += j - last - 1
        last, idx = j, j + 1
    if gaps > len(q) * 4:                       # 间隔过大视为噪声
        return 0
    return max(50, 200 - gaps * 3)


def rank(query: str, items: List[Dict[str, Any]], *, keys=("label", "sub", "path"),
         limit: int = MAX_PER_KIND) -> List[Dict[str, Any]]:
    """按最高分排序并截断；每项返回 {**item, score}（score 便于前端合并排序）。"""
    out = []
    for it in items:
        best = 0
        for k in keys:
            if it.get(k):
                best = max(best, fuzzy_score(query, it[k]))
        if best > 0:
            d = dict(it)
            d["score"] = best
            out.append(d)
    out.sort(key=lambda x: (-int(x.get("score") or 0),
                            len(_norm(x.get("label") or x.get("path") or "")),
                            _norm(x.get("label") or x.get("path") or "")))
    return out[:limit]


# ── 数据汇总（全部复用既有出入口）────────────────────────────────────────

def collect_hosts(uid: int, admin: bool) -> List[Dict[str, Any]]:
    from backend.handlers.hub import _cloud_nodes, _share_nodes, _ssh_nodes
    out: List[Dict[str, Any]] = []
    for n in _ssh_nodes(uid, admin) or []:
        caps = n.get("caps_list") or []
        out.append({"kind": "host", "label": n.get("label") or n.get("host") or n.get("guid"),
                    "sub": "主机 · %s · %s" % (n.get("host") or n.get("sub") or "",
                                              "/".join(caps[:4])),
                    "target": {"type": "host", "guid": n.get("guid"),
                               "capabilities": caps, "conn_semantics": (n.get("caps") or {}).get("conn_semantics")}})
    for n in _cloud_nodes(uid, admin) or []:
        out.append({"kind": "storage", "label": n.get("label") or n.get("guid"),
                    "sub": "云存储 · %s" % (n.get("sub") or ""),
                    "target": {"type": "storage", "storage_id": n.get("storage_id") or ("remote:%s" % n.get("guid"))}})
    for n in _share_nodes(uid, admin) or []:
        out.append({"kind": "storage", "label": n.get("label") or n.get("guid"),
                    "sub": "网络共享 · %s" % (n.get("sub") or ""),
                    "target": {"type": "storage", "storage_id": n.get("storage_id") or ("share:%s" % n.get("guid"))}})
    return out


async def collect_storages(uid: int) -> List[Dict[str, Any]]:
    # v1.0.0 · 本发行版不含多云文件管理(backend/fonrvfs) → 无存储条目可收集
    try:
        from backend.fonrvfs.vfs import VFS
    except ImportError:
        return []
    out: List[Dict[str, Any]] = []
    try:
        rows = await VFS.storages(user_id=uid)
    except Exception as e:                       # 不静默: 记录并返回空(前端会显示"无匹配")
        log.warning("传送门: 取存储列表失败: %s", str(e)[:160])
        return out
    for s in rows or []:
        out.append({"kind": "storage", "label": s.get("label") or s.get("id"),
                    "sub": "存储 · %s" % (s.get("kind") or ""),
                    "target": {"type": "storage", "storage_id": s.get("id")}})
    return out


def collect_recent(uid: int, limit: int = 40) -> List[Dict[str, Any]]:
    from backend import db as _db
    out: List[Dict[str, Any]] = []
    try:
        rows = _db.fonr_recent_list(uid, limit=limit) or []
    except Exception as e:
        log.warning("传送门: 取最近记录失败: %s", str(e)[:160])
        return out
    for r in rows:
        sid = r.get("storage_id") or ""
        path = r.get("path") or ""
        out.append({"kind": "path", "label": r.get("name") or (path.rstrip("/").split("/")[-1] or path),
                    "sub": "最近 · %s%s" % (sid, path),
                    "path": path,
                    "target": {"type": "path", "storage_id": sid, "path": path}})
    return out


def _allowed_kinds() -> set:
    """v6.16.14 · 档位裁剪(用户要求: Ctrl+G 传送门清除非社区版功能条目):
    storage/path 源自 FonrVFS(专业档), 未授权时整体不检索不显示。"""
    try:
        from backend import license as _L
        if not _L._status_allows(_L.get_status_summary(), "fonrvfs"):
            return {"host"}
    except Exception:
        pass
    return {"host", "storage", "path"}


async def search(uid: int, admin: bool, query: str, kinds: Optional[List[str]] = None) -> Dict[str, Any]:
    """汇总 + 排序。kinds 可限定（host/storage/path），默认全给。"""
    t0 = time.time()
    want = set(kinds or ("host", "storage", "path")) & _allowed_kinds()
    items: List[Dict[str, Any]] = []
    if "host" in want or "storage" in want:
        items += collect_hosts(uid, admin)
    if "storage" in want:
        items += await collect_storages(uid)
    if "path" in want:
        items += collect_recent(uid)
    # kinds 过滤必须在**收集之后**再按 kind 落地: collect_hosts 顺带产出云/共享节点(同源于 hub),
    # 若只靠"是否调用某个收集器"来过滤, kinds=host 会混进 storage (实测抓到)。
    # v6.16.14 · 档位裁剪: 未授权 kind(storage/path=FonrVFS 专业档)无论调用方是否显式指定都剔除。
    _allow = _allowed_kinds()
    items = [it for it in items if it.get("kind") in _allow]
    if kinds:
        items = [it for it in items if it.get("kind") in want]
    ranked = rank(query, items)
    return {"query": query, "count": len(ranked), "items": ranked,
            "ms": int((time.time() - t0) * 1000),
            "sources": {"hosts": sum(1 for x in items if x["kind"] == "host"),
                        "storages": sum(1 for x in items if x["kind"] == "storage"),
                        "paths": sum(1 for x in items if x["kind"] == "path")}}


# ── WS 入口 ──────────────────────────────────────────────────────────────

async def _reply(ws, data, payload: Dict[str, Any]) -> Dict[str, Any]:
    msg = {"type": "result", "req_id": str((data or {}).get("req_id") or "")}
    msg.update(payload)
    if ws is not None:
        try:
            await ws.send_json(msg)
        except Exception as e:
            log.warning("传送门回执失败: %s", str(e)[:160])
    return payload


def _ident(ws) -> Dict[str, Any]:
    """会话身份(uid/admin) —— 与 conn_center 同口径。"""
    from backend.auth import active_sessions as _asess
    from backend.handlers.conn_center import owner_id_of
    s = _asess.get(ws) or {}
    return {"uid": owner_id_of(ws), "admin": (s.get("role") or "") == "admin"}


async def handle_portal_search(ws, data: dict, task_id=None) -> Dict[str, Any]:
    """传送门检索: 主机/存储/最近路径（前端再并入自己的面板动作）。"""
    ident = _ident(ws)
    q = (data.get("q") or "").strip()
    kinds = data.get("kinds")
    if isinstance(kinds, str):
        kinds = [k for k in kinds.split(",") if k]
    res = await search(ident["uid"], ident["admin"], q, kinds)
    return await _reply(ws, data, dict(res, status="ok"))


async def handle_portal_hit(ws, data: dict, task_id=None) -> Dict[str, Any]:
    """记录一次"用过": 路径类写 fonr_recent(与 FonrVFS 最近同源); 其它类由前端本地记录。"""
    ident = _ident(ws)
    t = data.get("target") or {}
    typ = (t.get("type") or "").strip()
    if typ == "path" and t.get("storage_id") and t.get("path"):
        try:
            from backend import db as _db
            _db.fonr_recent_touch(ident["uid"], str(t["storage_id"]), str(t["path"]),
                                  name=str(data.get("label") or ""))
            return await _reply(ws, data, {"status": "ok", "recorded": "recent"})
        except Exception as e:
            return await _reply(ws, data, {"status": "error", "code": "io", "msg": str(e)[:200]})
    return await _reply(ws, data, {"status": "ok", "recorded": "client-side",
                                   "type": typ or "unknown"})

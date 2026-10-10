"""Fonriv · v4.39.0 引用注册表(Reference Registry)

Phase 1 核心:记录所有跨表弱引用关系,提供统一删除前检查。

设计:
- entity_refs 表由 init_db() 的 _migrate_uuid_v7() 创建
- 每条记录: source_table/source_uuid/source_field -> target_table/target_uuid
- ref_kind: 'required'(必须存在,删除前阻止) | 'optional'(可选,删除时级联清空) | 'soft'(仅记录,不阻止)

使用方式:
  # 创建引用时注册
  register_ref(conn, 'schedules', sched_uuid, 'params.flow_uuid', 'backup_flows', flow_uuid, 'required')

  # 删除前检查
  refs = get_refs_to(conn, 'backup_flows', flow_uuid)
  if refs:
      # 有引用,不能直接删,需要先处理
      for r in refs:
          print(f'{r.source_table}#{r.source_uuid} 引用了 {r.target_table}#{r.target_uuid} ({r.ref_kind})')

  # safe_delete: 检查引用 -> 无引用才删
  result = safe_delete(conn, 'backup_flows', flow_uuid)
"""
from __future__ import annotations
import json
from typing import Optional


def register_ref(conn, source_table: str, source_uuid: str,
                 source_field: str, target_table: str, target_uuid: str,
                 ref_kind: str = 'soft'):
    """注册一条引用关系。幂等:相同引用不重复插入。"""
    conn.execute("""
        INSERT OR IGNORE INTO entity_refs
        (source_table, source_uuid, source_field, target_table, target_uuid, ref_kind)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (source_table, source_uuid, source_field, target_table, target_uuid, ref_kind))
    conn.commit()


def unregister_ref(conn, source_table: str, source_uuid: str, source_field: str):
    """删除引用关系(源实体删除或引用更新时调用)。"""
    conn.execute("""
        DELETE FROM entity_refs
        WHERE source_table=? AND source_uuid=? AND source_field=?
    """, (source_table, source_uuid, source_field))
    conn.commit()


def update_ref(conn, source_table: str, source_uuid: str, source_field: str,
               target_table: str, target_uuid: str, ref_kind: str = 'soft'):
    """更新引用关系(先删后插,保证一致性)。"""
    unregister_ref(conn, source_table, source_uuid, source_field)
    register_ref(conn, source_table, source_uuid, source_field,
                 target_table, target_uuid, ref_kind)


def get_refs_to(conn, target_table: str, target_uuid: str) -> list[dict]:
    """查询所有指向 target 的引用(谁引用了我?)。删除前检查用。"""
    rows = conn.execute("""
        SELECT * FROM entity_refs
        WHERE target_table=? AND target_uuid=?
        ORDER BY ref_kind, source_table
    """, (target_table, target_uuid)).fetchall()
    return [dict(r) for r in rows]


def get_refs_from(conn, source_table: str, source_uuid: str) -> list[dict]:
    """查询某个源实体发出的所有引用(我引用了谁?)。"""
    rows = conn.execute("""
        SELECT * FROM entity_refs
        WHERE source_table=? AND source_uuid=?
        ORDER BY source_field
    """, (source_table, source_uuid)).fetchall()
    return [dict(r) for r in rows]


def get_blocking_refs(conn, target_table: str, target_uuid: str) -> list[dict]:
    """查询所有 ref_kind='required' 的引用(会阻止删除的引用)。"""
    rows = conn.execute("""
        SELECT * FROM entity_refs
        WHERE target_table=? AND target_uuid=? AND ref_kind='required'
    """, (target_table, target_uuid)).fetchall()
    return [dict(r) for r in rows]


def safe_delete(conn, table: str, uuid: str, *, force: bool = False) -> dict:
    """安全删除:检查引用注册表,有 required 引用则阻止。

    返回:
      {ok: bool, blocked_by: [...], deleted: bool, cascaded: [...]}
      - ok=True, deleted=True: 删除成功
      - ok=False, blocked_by=[...]: 有 required 引用阻止,需先处理
      - ok=True, deleted=True, cascaded=[...]: force=True 时级联清理了 optional 引用
    """
    from backend.db.uuidv7 import is_valid_uuid
    if not is_valid_uuid(uuid):
        return {"ok": False, "deleted": False, "blocked_by": [],
                "error": f"invalid uuid: {uuid}"}

    # 1) 检查 required 引用
    blocking = get_blocking_refs(conn, table, uuid)
    if blocking and not force:
        return {"ok": False, "deleted": False,
                "blocked_by": blocking, "cascaded": []}

    # 2) 查出实体 id(不同表删除方式不同)
    row = conn.execute(f"SELECT id FROM {table} WHERE uuid=?", (uuid,)).fetchone()
    if not row:
        return {"ok": False, "deleted": False, "blocked_by": [],
                "error": f"{table} uuid={uuid} not found"}
    entity_id = row[0]

    # 3) 级联清理 optional 引用(将引用方的字段置空/移除)
    cascaded = []
    all_refs = get_refs_to(conn, table, uuid)
    for ref in all_refs:
        _cascade_clear_ref(conn, ref)
        cascaded.append(ref)

    # 4) 执行删除
    _do_delete(conn, table, entity_id, uuid)

    # 5) 清理该实体发出的引用(它引用别人的关系)
    conn.execute("""
        DELETE FROM entity_refs
        WHERE source_table=? AND source_uuid=?
    """, (table, uuid))

    conn.commit()
    return {"ok": True, "deleted": True, "blocked_by": [], "cascaded": cascaded}


def _cascade_clear_ref(conn, ref: dict):
    """级联清理:将引用方的字段中移除被删实体的引用。

    处理两种模式:
    - JSON 数组引用(backup_flows.backup_ids 等):从数组中移除
    - 单值引用(schedules.params_json.flow_id 等):置空/删除键
    """
    st, suuid = ref['source_table'], ref['source_uuid']
    sfield = ref['source_field']
    tuuid = ref['target_uuid']

    # 字段格式: "column.subkey" 或 "column"
    parts = sfield.split('.')
    col = parts[0]
    subkey = parts[1] if len(parts) > 1 else None

    row = conn.execute(f"SELECT {col} FROM {st} WHERE uuid=?", (suuid,)).fetchone()
    if not row:
        return
    raw = row[0]

    if not subkey:
        # 单列引用:直接置空
        conn.execute(f"UPDATE {st} SET {col}=NULL WHERE uuid=?", (suuid,))
        return

    # JSON 字段
    try:
        val = json.loads(raw) if raw else {}
    except Exception:
        val = {} if subkey else []

    if isinstance(val, list):
        # 数组引用:移除 target_uuid
        if tuuid in val:
            val.remove(tuuid)
        conn.execute(f"UPDATE {st} SET {col}=? WHERE uuid=?",
                     (json.dumps(val), suuid))
    elif isinstance(val, dict):
        # dict 引用:删除子键
        if subkey in val:
            del val[subkey]
            conn.execute(f"UPDATE {st} SET {col}=? WHERE uuid=?",
                         (json.dumps(val), suuid))


def _do_delete(conn, table: str, entity_id: int, uuid: str):
    """执行实际删除(按表分派,处理级联子表)。"""
    if table == 'configs':
        conn.execute("DELETE FROM backups WHERE config_id=?", (entity_id,))
        conn.execute("DELETE FROM configs WHERE id=?", (entity_id,))
    elif table == 'remote_configs':
        conn.execute("DELETE FROM remote_uploads WHERE remote_id=?", (entity_id,))
        conn.execute("DELETE FROM remote_configs WHERE id=?", (entity_id,))
    elif table == 'backup_flows':
        conn.execute("DELETE FROM backup_flow_runs WHERE flow_id=?", (entity_id,))
        conn.execute("DELETE FROM backup_flows WHERE id=?", (entity_id,))
    elif table == 'schedules':
        conn.execute("DELETE FROM schedule_runs WHERE schedule_id=?", (entity_id,))
        conn.execute("DELETE FROM schedules WHERE id=?", (entity_id,))
    elif table == 'backups':
        conn.execute("DELETE FROM backups WHERE id=?", (entity_id,))
    elif table == 'users':
        # 用户删除较复杂,暂不级联,留给上层
        conn.execute("DELETE FROM users WHERE id=?", (entity_id,))
    else:
        conn.execute(f"DELETE FROM {table} WHERE id=?", (entity_id,))


def graph_integrity_check(conn) -> dict:
    """一致性校验:遍历引用图,报告 orphans/dangling/healthy。

    检查两个来源:
    1. entity_refs 注册表(新格式 uuid 引用)
    2. 旧格式数字 ID 引用(schedules.params_json.flow_id/config_id,
       backup_flows.backup_ids/remote_ids)

    Returns:
      {
        total_refs: int,
        healthy: [...],     # 引用目标存在
        dangling: [...],    # 引用目标已不存在(悬空)
        orphans: [...],     # 没有被任何引用指向的实体(可能孤立)
      }
    """
    all_refs = [dict(r) for r in conn.execute("SELECT * FROM entity_refs").fetchall()]
    healthy, dangling = [], []

    for ref in all_refs:
        # 检查目标是否存在
        target = conn.execute(
            f"SELECT 1 FROM {ref['target_table']} WHERE uuid=?",
            (ref['target_uuid'],)
        ).fetchone()
        if target:
            healthy.append(ref)
        else:
            dangling.append(ref)

    # 旧格式数字 ID 引用扫描
    legacy_dangling = _scan_legacy_id_refs(conn)
    dangling.extend(legacy_dangling)

    # orphans: 没有被引用指向的实体
    # v4.39.0: 只检查"应该被引用"的中间层实体(backups/remote_configs)
    # 顶层实体(configs/schedules/backup_flows)可以独立存在,不报 orphan
    entity_tables = ['backups', 'remote_configs']
    orphans = []
    for t in entity_tables:
        # 不同表 name 列不同,统一取 uuid + id
        rows = conn.execute(f"SELECT uuid, id FROM {t}").fetchall()
        for r in rows:
            uuid_val = r[0]
            if not uuid_val:
                continue
            refs_to = get_refs_to(conn, t, uuid_val)
            if not refs_to:
                orphans.append({"table": t, "uuid": uuid_val, "id": r[1]})

    return {
        "total_refs": len(all_refs) + len(legacy_dangling),
        "healthy": healthy,
        "dangling": dangling,
        "orphans": orphans,
        "summary": {
            "healthy_count": len(healthy),
            "dangling_count": len(dangling),
            "orphan_count": len(orphans),
            "legacy_dangling_count": len(legacy_dangling),
        }
    }


def _scan_legacy_id_refs(conn) -> list[dict]:
    """扫描旧格式数字 ID 引用,检测悬空引用。

    检查:
    - schedules.params_json.{flow_id, config_id} -> backup_flows/configs
    - backup_flows.backup_ids -> backups
    - backup_flows.remote_ids -> remote_configs
    """
    import json as _json
    dangling = []

    # schedules -> flow/config (旧格式 flow_id/config_id)
    try:
        for s in conn.execute("SELECT id, uuid, params_json FROM schedules").fetchall():
            params = _json.loads(s[2] or '{}')
            fid = params.get("flow_id")
            if fid and not params.get("flow_uuid"):
                exists = conn.execute("SELECT 1 FROM backup_flows WHERE id=?", (fid,)).fetchone()
                if not exists:
                    dangling.append({
                        "source_table": "schedules", "source_uuid": s[1] or str(s[0]),
                        "source_field": "params_json.flow_id",
                        "target_table": "backup_flows", "target_uuid": str(fid),
                        "ref_kind": "legacy_required",
                    })
            cid = params.get("config_id")
            if cid and not params.get("config_uuid"):
                exists = conn.execute("SELECT 1 FROM configs WHERE id=?", (cid,)).fetchone()
                if not exists:
                    dangling.append({
                        "source_table": "schedules", "source_uuid": s[1] or str(s[0]),
                        "source_field": "params_json.config_id",
                        "target_table": "configs", "target_uuid": str(cid),
                        "ref_kind": "legacy_required",
                    })
    except Exception:
        pass

    # backup_flows -> backups/remote_configs (旧格式 backup_ids/remote_ids)
    try:
        for f in conn.execute("SELECT id, uuid, backup_ids, remote_ids FROM backup_flows").fetchall():
            fuuid = f[1] or str(f[0])
            for bid in _json.loads(f[2] or '[]'):
                exists = conn.execute("SELECT 1 FROM backups WHERE id=?", (bid,)).fetchone()
                if not exists:
                    dangling.append({
                        "source_table": "backup_flows", "source_uuid": fuuid,
                        "source_field": "backup_ids",
                        "target_table": "backups", "target_uuid": str(bid),
                        "ref_kind": "legacy_optional",
                    })
            for rid in _json.loads(f[3] or '[]'):
                exists = conn.execute("SELECT 1 FROM remote_configs WHERE id=?", (rid,)).fetchone()
                if not exists:
                    dangling.append({
                        "source_table": "backup_flows", "source_uuid": fuuid,
                        "source_field": "remote_ids",
                        "target_table": "remote_configs", "target_uuid": str(rid),
                        "ref_kind": "legacy_required",
                    })
    except Exception:
        pass

    return dangling

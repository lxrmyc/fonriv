"""v4.12.0 · 用户 UI 偏好 (主题/密度/侧栏折叠/快捷键)

WS actions:
- ui_prefs_get
- ui_prefs_set

未登录时也允许读取默认值（写入必须登录）。
v4.38.37: 新增 hide_run_log（设置页「隐藏底部运行日志」开关，所有页面生效）。
"""
import json

from backend import db as _db


DEFAULT_QUICK_ACTIONS = [
    {"id": "quickSync",       "label": "⟳ 立即同步",           "action": "js:quickSync()"},
    {"id": "auto_backup",     "label": "🔧 PVE 一键备份",       "action": "tab:auto_backup"},
    {"id": "platform_backup", "label": "🐧 通用一键备份",       "action": "tab:platform_backup"},
    {"id": "remotes",         "label": "☁️ 远端存储",            "action": "tab:remotes"},
    {"id": "disk_manager",    "label": "💽 远端磁盘管理",        "action": "tab:disk_manager"},
    {"id": "schedules",       "label": "⏰ 定时计划",            "action": "tab:schedules"},
    {"id": "jobs",            "label": "⏰ 任务管理",            "action": "tab:jobs"},
    {"id": "bandwidth",       "label": "📊 带宽监控",            "action": "js:openBandwidthMonitor()"},
]


def _current_user_id(ws) -> int:
    try:
        from backend.auth import active_sessions
        sess = active_sessions.get(ws) or {}
        return int(sess.get("user_id") or 0)
    except Exception as e:
        print(f"[ui_prefs] fallback user_id due to: {e}")
        return 0


def _row_to_prefs(row) -> dict:
    if not row:
        return {
            "theme": "light",  # v4.39.0: 默认浅色
            "density": "full",
            "sidebar_collapsed": False,
            "hide_run_log": False,
            "quick_actions": DEFAULT_QUICK_ACTIONS,
        }
    try:
        qa = json.loads(row["quick_actions_json"] or "[]")
        if not isinstance(qa, list) or not qa:
            qa = DEFAULT_QUICK_ACTIONS
    except Exception:
        qa = DEFAULT_QUICK_ACTIONS
    return {
        "theme": row["theme"] or "light",  # v4.39.0: 默认浅色
        "density": row["density"] or "full",
        "sidebar_collapsed": bool(row["sidebar_collapsed"]),
        "hide_run_log": bool(row["hide_run_log"]) if "hide_run_log" in row.keys() else False,
        "quick_actions": qa,
    }


async def handle_ui_prefs_get(ws, data):
    uid = _current_user_id(ws)
    if not uid:
        prefs = _row_to_prefs(None)
        try:
            prefs["run_log_follow"] = (open("/tmp/rp_runlog_follow", encoding="utf-8").read().strip() == "1")
        except Exception:
            prefs["run_log_follow"] = False
        await ws.send_json({"type": "result", "status": "ok", "prefs": prefs, "default": True})
        return
    conn = _db.get_conn()
    row = conn.execute(
        "SELECT theme, density, sidebar_collapsed, quick_actions_json, hide_run_log "
        "FROM user_ui_prefs WHERE user_id = ?", (uid,)
    ).fetchone()
    prefs = _row_to_prefs(row)
    try:
        prefs["run_log_follow"] = _db.setting_get("run_log_follow", "0") == "1"
    except Exception:
        prefs["run_log_follow"] = False
    await ws.send_json({"type": "result", "status": "ok", "prefs": prefs})


async def handle_ui_prefs_set(ws, data):
    uid = _current_user_id(ws)
    if not uid:
        await ws.send_json({"type": "result", "status": "error", "msg": "请先登录"})
        return
    # v4.15.8: 只更新用户提供的字段，其它保持旧值（避免首页只改 theme 把 density/quick_actions 重置）
    conn = _db.get_conn()
    old = conn.execute(
        "SELECT theme, density, sidebar_collapsed, quick_actions_json, hide_run_log "
        "FROM user_ui_prefs WHERE user_id = ?", (uid,)
    ).fetchone()
    old_prefs = _row_to_prefs(old)

    theme = data.get("theme", old_prefs["theme"]) if "theme" in data else old_prefs["theme"]
    if theme not in ("dark", "light", "auto", "neon", "quantum"):  # v6.0.0 · 新增科技双主题
        theme = "dark"
    density = data.get("density", old_prefs["density"]) if "density" in data else old_prefs["density"]
    if density not in ("full", "compact"):
        density = "full"
    if "sidebar_collapsed" in data:
        sidebar_collapsed = 1 if data.get("sidebar_collapsed") else 0
    else:
        sidebar_collapsed = 1 if old_prefs["sidebar_collapsed"] else 0
    # v4.38.37: 隐藏底部运行日志
    if "hide_run_log" in data:
        hide_run_log = 1 if data.get("hide_run_log") else 0
    else:
        hide_run_log = 1 if old_prefs["hide_run_log"] else 0
    # v4.57.0 · 运行日志显示模式跟随偏好 (全局 kv, admin 语义)
    try:
        if "run_log_follow" in data:
            import json as _json
            _db.setting_set("run_log_follow", "1" if data.get("run_log_follow") else "0")
    except Exception:
        pass

    if "quick_actions" in data:
        qa = data.get("quick_actions")
        if not isinstance(qa, list):
            qa = DEFAULT_QUICK_ACTIONS
        clean = []
        for item in qa[:32]:
            if not isinstance(item, dict):
                continue
            clean.append({
                "id": str(item.get("id") or "")[:64],
                "label": str(item.get("label") or "")[:64],
                "action": str(item.get("action") or "")[:128],
            })
        qa_json = json.dumps(clean, ensure_ascii=False)
    else:
        qa_json = json.dumps(old_prefs["quick_actions"], ensure_ascii=False)

    conn = _db.get_conn()
    conn.execute("""
        INSERT INTO user_ui_prefs (user_id, theme, density, sidebar_collapsed, quick_actions_json, hide_run_log, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
        ON CONFLICT(user_id) DO UPDATE SET
            theme=excluded.theme,
            density=excluded.density,
            sidebar_collapsed=excluded.sidebar_collapsed,
            quick_actions_json=excluded.quick_actions_json,
            hide_run_log=excluded.hide_run_log,
            updated_at=excluded.updated_at
    """, (uid, theme, density, sidebar_collapsed, qa_json, hide_run_log))
    conn.commit()

    row = conn.execute(
        "SELECT theme, density, sidebar_collapsed, quick_actions_json, hide_run_log "
        "FROM user_ui_prefs WHERE user_id = ?", (uid,)
    ).fetchone()
    await ws.send_json({"type": "result", "status": "ok", "msg": "偏好已保存", "prefs": _row_to_prefs(row)})

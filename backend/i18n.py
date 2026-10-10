"""Fonriv - 后端消息国际化 (v4.74.0)

用法:
    from backend.i18n import tr
    tr("操作成功", lang=...)      # key = 中文原文, 未收录则原样返回

语言来源优先级: 显式 lang 参数 > 用户偏好(app_settings ui_lang_<uid>) > 全局设置 ui_lang > zh
后端消息量为业务提示, 采用与前端一致的"中文作 key + 缺失回退"策略,
保证不因缺词条导致消息空白。
"""
from __future__ import annotations

from backend import db

# 常用后端消息英文词条 (按需追加; 未收录回退中文)
EN = {
    "操作成功": "Success",
    "操作失败": "Operation failed",
    "参数错误": "Invalid parameters",
    "缺少参数": "Missing parameter",
    "权限不足": "Insufficient permission",
    "请先登录": "Please sign in first",
    "用户名或密码错误": "Invalid username or password",
    "请输入用户名和密码": "Please enter username and password",
    "登录失败次数过多，请15分钟后再试": "Too many failed attempts, try again in 15 minutes",
    "无权访问此页面": "No permission for this page",
    "连接成功": "Connected",
    "连接失败": "Connection failed",
    "目标主机不能为空": "Target host is required",
    "远端主机地址不能为空": "Remote host address is required",
    "文件不存在": "File not found",
    "目录不存在": "Directory not found",
    "路径不能为空": "Path is required",
    "非法路径": "Invalid path",
    "读取失败": "Read failed",
    "写入失败": "Write failed",
    "删除成功": "Deleted",
    "删除失败": "Delete failed",
    "保存成功": "Saved",
    "保存失败": "Save failed",
    "传输成功完成": "Transfer completed",
    "传输异常终止": "Transfer aborted",
    "备份完成": "Backup finished",
    "备份失败": "Backup failed",
    "恢复完成": "Restore finished",
    "恢复失败": "Restore failed",
    "不支持的文件格式": "Unsupported file format",
    "不支持的压缩格式": "Unsupported archive format",
    "请求超时": "Request timed out",
    "任务已取消": "Task cancelled",
    "任务不存在": "Task not found",
    "仓库已存在 (无需重复初始化)": "Repository already exists",
    "仓库初始化成功": "Repository initialized",
    "该归档已加密": "This archive is encrypted",
    "请填写密码": "Please enter the password",
    "密码错误": "Wrong password",
    "保留策略已应用": "Retention policy applied",
    "未安装": "not installed",
    "已安装": "installed",
    "检测完成": "Check completed",
}


def user_lang(user_id: int | None = None) -> str:
    """解析当前语言: 用户偏好 > 全局设置 > zh"""
    try:
        if user_id:
            v = db.setting_get(f"ui_lang_{int(user_id)}", "") or ""
            if v:
                return v
    except Exception:
        pass
    try:
        v = db.setting_get("ui_lang", "") or ""
        if v:
            return v
    except Exception:
        pass
    return "zh"


def tr(msg: str, lang: str | None = None, user_id: int | None = None) -> str:
    """翻译后端消息 (未收录原样返回中文)"""
    if not msg:
        return msg
    code = (lang or "").strip() or user_lang(user_id)
    if not code or code == "zh":
        return msg
    if code == "en":
        return EN.get(msg, msg)
    return msg


def set_user_lang(user_id: int, code: str) -> None:
    try:
        db.setting_set(f"ui_lang_{int(user_id)}", code or "zh")
    except Exception:
        pass

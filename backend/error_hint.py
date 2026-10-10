"""统一错误提示助手 (v5.20.3)

目标: 用户看到的不再是裸的 rsync/ssh/HTTP 错误, 而是
  "发生了什么 + 💡 处理方案 + (可选) 系统内跳转位置"

用法 (后端 handler 里):
    from backend.error_hint import hint as _hint
    msg = _hint(raw_error_text, context="transfer")   # 返回带 💡 的完整提示
    await ws.send_json({..., "msg": msg, "error_panel": hint.panel(raw)})

跳转链接: error_panel() 返回建议前往的页面 key, 前端可据 error_panel 字段
把 toast 做成可点击跳转 (前端 toast 已支持; 未接入时文案里自带面板名也能指路)。

模式库来源: 本项目点击实测/用户反馈中真实出现过的错误 (非虚构)。
"""
from __future__ import annotations

import re

# (正则, 中文诊断, 处理建议, 建议跳转面板)
_PATTERNS = [
    (r"Permission denied \(publickey\)", "目标机拒绝了公钥认证",
     "在浏览窗口内嵌『🔐 认证』改用密码, 或把本机公钥加入目标机 authorized_keys", "transfer"),
    (r"Permission denied", "认证被拒绝 (密码/密钥不匹配)",
     "核对用户名与密码; 密码含特殊字符时注意转义; 连续错密可能触发 fail2ban 封禁", "transfer"),
    (r"Host key verification failed", "目标机主机密钥校验失败",
     "目标机可能重装过系统; 在『系统 → 安全专项』核对或重新信任该主机指纹", "settings"),
    (r"No such file or directory", "路径不存在",
     "确认源/目标路径拼写; 远端路径注意大小写与挂载点是否已挂载", "transfer"),
    (r"connection unexpectedly closed|Connection refused|Connection timed out",
     "无法建立连接 (端口不通/服务未启动/防火墙)",
     "先点『🔗 测试连接』; 核对 IP 与端口; 目标机需启用 SSH 服务", "transfer"),
    (r"Read-only file system", "目标文件系统只读",
     "磁盘管理页以只读模式挂载; 需写入请在『磁盘管理 → 高级选项』切读写 (危险)", "transfer"),
    (r"No space left on device|磁盘空间不足", "磁盘空间不足",
     "清理目标机旧备份或更换保存位置 (备份保存路径可选 df 挂载点/共享/云端)", "transfer"),
    (r"不在社区版内", "该功能不在社区版内",
     "查看『授权与许可』页了解社区版内置能力(开源版不含该模块)", "license"),
    (r"凭证解密失败|ENC\$", "已存密码解密失败 (加密密钥已轮换)",
     "打开『远端存储』编辑该配置重新保存一次密码即可", "remotes"),
    (r"HTTP 40[13]", "远端认证失败 (401/403)",
     "核对口令/App Token; Seafile 需账号密码而非下载令牌", "remotes"),
    (r"timed out|超时", "执行超时",
     "大目录首次扫描较慢; 目标机负载高时也会拖慢, 可稍后重试", None),
    (r"failed: No such file", "rsync 找不到源或目标目录",
     "确认目录已存在 (rsync 不会自动创建远端末级目录)", "transfer"),
]


def hint(raw: str, context: str = "") -> str:
    """把原始错误文本包装成 可读诊断+建议。无匹配时返回原文+通用建议。"""
    raw = str(raw or "")
    for pat, diag, advice, panel in _PATTERNS:
        if re.search(pat, raw, re.I):
            out = f"{diag} — 💡 {advice}"
            if panel:
                out += f" (可在系统内『{_PANEL_CN.get(panel, panel)}』处理)"
            return out
    # 无匹配: 截断原文 + 通用建议
    base = raw.strip().splitlines()[-1][:160] if raw.strip() else "未知错误"
    ctx = _CTX_CN.get(context, "")
    return f"{base} — 💡 请检查网络连通性与凭据; 或到『运行日志』查看完整错误上下文{ctx}"


def panel(raw: str) -> str | None:
    """返回建议跳转的页面 key (前端可据此跳转)。"""
    for pat, _d, _a, panel in _PATTERNS:
        if panel and re.search(pat, str(raw or ""), re.I):
            return panel
    return None


_PANEL_CN = {
    "transfer": "文件传输", "settings": "系统设置", "remotes": "远端存储",
    "license": "授权管理", "docker": "容器管理",
}
_CTX_CN = {"transfer": " (传输类任务的相关日志在『文件传输 → 操作日志』)",
           "backup": " (备份任务日志见『备份中心』)"}

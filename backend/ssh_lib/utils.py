"""SSH 工具函数：与认证/传输解耦的纯逻辑（Stage 1 从 backend/ssh.py 迁移）"""

import os
import re


def sanitize_output(text: str, password: str = "", key_path: str = "") -> str:
    """从输出中去除敏感信息（密码 / 密钥路径）后再发给前端。"""
    safe = text
    if password and password in safe:
        safe = safe.replace(password, "***")
    if key_path and key_path in safe:
        safe = safe.replace(key_path, "***")
    return safe


def parse_ls_output(output: str) -> list:
    """解析 ls -lh 输出为结构化列表（供归档扫描等场景使用）。"""
    disks = []
    ls_re = re.compile(
        r"^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+)$"
    )
    for line in (output or "").strip().split("\n"):
        line = line.strip()
        if not line or line.startswith("total"):
            continue
        m = ls_re.match(line)
        if m:
            perms, links, owner, group, size, month, day, time_or_year, fullpath = m.groups()
            if " -> " in fullpath:
                fullpath = fullpath.split(" -> ")[0]
            fullpath = fullpath.rstrip("/")
            if not fullpath:
                continue
            date_str = month + " " + day + " " + time_or_year
            name = os.path.basename(fullpath)
            filepath = fullpath
        else:
            parts = line.split()
            if len(parts) < 9:
                continue
            size = parts[4]
            date_str = parts[5] + " " + parts[6] + " " + parts[7]
            filepath = parts[8]
            if filepath.endswith("->"):
                filepath = parts[9] if len(parts) > 9 else filepath
            filepath = filepath.rstrip("/")
            name = os.path.basename(filepath)

        icon = "\U0001f4b5"
        if name.endswith(".iso"):
            icon = "\U0001f5a2"
        elif name.endswith(".img"):
            icon = "\U0001f4be"
        elif ".vma" in name:
            icon = "\U0001f4e6"
        elif ".tar" in name:
            icon = "\U0001f4c2"

        vmid_info = ""
        vz_re = re.search(r"vzdump-(qemu|lxc)-(\d+)-", name)
        if vz_re:
            vm_type = "VM" if vz_re.group(1) == "qemu" else "CT"
            vmid_info = " (" + vm_type + " " + vz_re.group(2) + ")"

        disks.append({
            "name": icon + " " + name + vmid_info,
            "raw_name": name,
            "path": filepath,
            "size": size,
            "date": date_str,
        })
    return disks


def ssh_error_msg(err_output, host: str = "", port: str = "") -> str:
    """将 SSH 错误输出翻译为用户友好的中文描述。

    v4.98.0 · 防御: 调用方可能误传异常对象 (如 ssh_error_msg(e)),
    旧实现对非字符串调用 .strip() 抛 AttributeError → 真实错误被掩盖
    (典型: stat 失败 → ValueError → '.strip()' 崩 → 前端只看到"服务端处理异常")。
    """
    if err_output is None:
        err_output = ""
    elif not isinstance(err_output, str):
        err_output = str(err_output)
    err = err_output.strip()
    msg = err or "SSH 连接失败"
    low = msg.lower()
    if "permission denied" in low:
        return "SSH 认证失败：密码或密钥不正确"
    if "connection refused" in low:
        return f"SSH 连接被拒绝：{host}:{port} 不可达" if host else "SSH 连接被拒绝"
    if "no route to host" in low:
        return f"网络不可达：{host}" if host else "网络不可达"
    if "timed out" in low:
        return f"SSH 连接超时：{host}:{port}" if host else "SSH 连接超时"
    if err:
        return f"SSH 连接失败：{err}"
    return msg

"""Fonriv 社区版 · 更新日志 (对外条目)"""

CHANGELOG = [
    ("1.0.0", "2026-10-10", "首次发布",
     "Fonriv 运维传输与备份管理平台 · 社区版 V1.0.0",
     ["FEAT：服务器档案与多层分组、凭据加密存储、连接状态可视化 (连接中心, 不限档案数)",
      "FEAT：文件传输 (上传/下载/双向同步/断点续传/并行分片) 与本地文件管理",
      "FEAT：Web 终端 (SSH)、定时计划、数据总览与操作审计日志",
      "FEAT：Proxmox VE 备份与 vzdump 打包、Docker 容器管理",
      "FEAT：RDP/VNC 远程控制台、告警通知 (Webhook/邮件)、QoS 分时限速、在线更新",
      "NOTE：本包为社区版开源发行 (AGPL-3.0), 永久免费; 官网 www.fonriv.com"]),
]

def get_changelog():
    return CHANGELOG

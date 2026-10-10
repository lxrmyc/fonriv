"""Fonriv - WebSocket 路由模块"""

import asyncio  # v4.41.0 P3-2 · rsync 长任务异步派发 (kill 需在主循环可到达)
import contextvars   # v5.90.3 · 异步派发的任务级 req_id (见 _WS_REQ_ID)
import logging       # v5.98.0 · 客户端断开的后台任务收尾走 debug, 不冒充异常刷屏
import time
import uuid
from datetime import datetime

from fastapi import WebSocket, WebSocketDisconnect

from backend.log import log_operation
from backend.ssh import active_tasks, kill_process
from backend.auth import active_sessions, require_auth, restore_session_by_token

# ---------------------------------------------------------------------------
# Import handlers from each module
# ---------------------------------------------------------------------------
# v5.90.3 · 当前请求 req_id 的任务级载体 (create_task 异派发后主循环会立刻清 ws._current_req_id)
_WS_REQ_ID: "contextvars.ContextVar" = contextvars.ContextVar("fonriv_ws_req_id", default=None)

from backend import license as lic  # v4.44.1 · 功能门控
from backend.handlers.rsync import (
    handle_test_conn,
    handle_rsync,
    handle_list_dir,
    handle_list_remote_dir,
    handle_remote_desk_ping,   # v5.20.2 · 远程桌面端口探测
    handle_remote_diag,        # v5.98.17 · 远程运维连接诊断报告
    handle_zerotrust,          # v5.20.0 · 阶段5 零信任 (主机密钥钉死+传输令牌)
    handle_e2ee,               # v5.22.0 · G6 E2EE 双端协商 (身份/对端公钥钉死)
    handle_truenas_api,        # v5.20.0 · 阶段5 TrueNAS REST 控制面
    handle_deps_scan,          # v5.20.0 · 本机依赖扫描
    handle_deps_install,       # v5.20.0 · 本机依赖一键安装
    handle_remote_os_detect,   # v5.20.0 · 远端 OS 识别 (Windows/macOS 端点)
    handle_remote_disks,      # v5.20.0 · 远端磁盘/盘符列举
    handle_mkdir,
    handle_mkdir_remote,
    handle_scan_local,
    handle_check_rsync_plugins,
    handle_install_rsync_plugin,
    handle_check_sync_tools,  # v4.38.23 · 本机工具检测
    handle_install_local_tools,  # v4.38.24 · 本机一键安装缺失工具（基于 sudo 探测 + 白名单 + 二次确认）
    handle_transfer_audit,  # v4.40.2 P2 · 传输审计 (dry-run 差异清单)
    handle_rclone_check,     # v4.50.0 · 传输引擎 rclone 检测
    handle_rclone_install,   # v4.50.0 · rclone 一键安装
)
try:
    # v6.16.14 · 会话录制全部 handler 收口到 vnc_rec.py(含自 server_profile 迁入的 recording_*)
    from backend.handlers.vnc_rec import (
        handle_vnc_rec_list, handle_vnc_rec_delete,
        handle_recording_list, handle_recording_convert, handle_recording_delete,
    )  # v5.23.0 · 会话录制 (旗舰档)
except ImportError:  # 旗舰包外(社区/专业)该文件已剪除 → 相关路由一律不注册
    handle_vnc_rec_list = handle_vnc_rec_delete = None
    handle_recording_list = handle_recording_convert = handle_recording_delete = None
try:
    from backend.handlers.truenas_ctl import handle_truenas_ctl  # v5.24.0 · TrueNAS REST 控制面
except ImportError:  # v6.16.20 批37 · 社区包: truenas_ctl 随 cloud 键剪除
    handle_truenas_ctl = None
from backend.handlers.pve_api import handle_pve_save_config  # v5.28.0 · PVE 连接配置保存
from backend.handlers.pve_api import handle_pve_servers      # v5.31.5 · PVE 多服务器列表
from backend.handlers.pve_api import handle_pve_console      # v5.31.5 · noVNC ticket 下发
from backend.handlers.server_profile import (  # v5.33.0 · 统一服务器档案
    handle_sp_list, handle_sp_get, handle_sp_save, handle_sp_del, handle_sp_get_by_host,
    handle_sp_probe, handle_sp_batch,            # v5.34.1 · P1 探测/批量
    handle_sg_list, handle_sg_save, handle_sg_del, handle_sg_reorder,  # 分组树
    handle_audit_query,
    handle_sp_import, handle_sp_export,      # v5.34.2 · P2 导入导出
    handle_sp_resolve,                       # v5.34.3 · P3 跨页凭据解析
    handle_cred_list, handle_cred_save, handle_cred_del,   # v5.34.6 · P6 凭据保险库
    handle_sp_wol,                                       # v5.34.6 · P6 Wake-on-LAN
    # v6.16.14 · 会话录制三动作已迁至 handlers/vnc_rec.py(随档位剪除), 不再从本模块导入
)
from backend.handlers.conn_center import (   # v5.32.0 · 连接中心
    handle_conn_open, handle_conn_close, handle_conn_list, handle_conn_renew,
)

try:
    from backend.handlers.fonrvfs import (   # v5.40.0 · FonrVFS 多云文件管理 (专业/旗舰档能力, 社区版不随包)
        handle_fonr_storages, handle_fonr_caps, handle_fonr_list, handle_fonr_stat,
        handle_fonr_preview_meta, handle_fonr_read_text, handle_fonr_read_hex,
        handle_fonr_mkdir, handle_fonr_mkfile, handle_fonr_attrs, handle_fonr_delete, handle_fonr_rename, handle_fonr_copy,
        handle_fonr_download, handle_fonr_upload_init, handle_fonr_upload_file,
        handle_fonr_upload_abort, handle_fonr_upload_sessions,
        handle_fonr_compress_cancel,   # v6.14.0 · 批14(P0): 压缩取消自动删产物
        handle_fonr_job_list, handle_fonr_job_cancel,
        handle_fonr_job_pause, handle_fonr_job_resume,
        handle_fonr_job_delete, handle_fonr_job_clear,
        handle_fonr_fav_list, handle_fonr_fav_save, handle_fonr_fav_delete,
        handle_fonr_tools_check,
        # v5.41.0 P1 · 预览矩阵 / 搜索 / 最近
        handle_fonr_stream_token, handle_fonr_thumb, handle_fonr_exif, handle_fonr_office_pdf,
        handle_fonr_archive_list, handle_fonr_archive_entry, handle_fonr_search,
        handle_fonr_recent_touch, handle_fonr_recent_list, handle_fonr_recent_delete, handle_fonr_recent_clear,
        handle_fonr_thumbs_batch,
        # v5.43.0 P2 · 回收站 / 同步对比 / 设置 / 续传
        handle_fonr_trash_list, handle_fonr_trash_restore, handle_fonr_trash_purge,
        handle_fonr_trash_empty, handle_fonr_diff, handle_fonr_apply_plan,
        handle_fonr_settings_get, handle_fonr_settings_set, handle_fonr_upload_resume,
        # v5.44.0 P2 剩余 · 压缩/解压/分享
        handle_fonr_compress, handle_fonr_extract,
        # v5.45.0 P2 剩余 · 版本历史 / 审计
        handle_fonr_versions_list, handle_fonr_audit_list, handle_fonr_audit_export,
        handle_fonr_audit_purge,
        handle_fonr_version_restore, handle_fonr_version_delete,
        # v5.47.0 P3 治理 · 存储级 ACL / 配额 / 用量
        handle_fonr_acl_list, handle_fonr_acl_set, handle_fonr_acl_delete,
        handle_fonr_presign_get, handle_fonr_presign_put, handle_fonr_transport_plan,  # v5.53.0 P2
        handle_fonr_dlp_list, handle_fonr_dlp_set, handle_fonr_dlp_delete,             # v5.54.0 P3-14
        handle_fonr_dlp_test, handle_fonr_index_scan, handle_fonr_index_search,
        handle_fonr_index_stats, handle_fonr_index_clear, handle_fonr_object_lock,
        handle_fonr_stream_stats,
        handle_fonr_quota_get, handle_fonr_quota_set, handle_fonr_usage_recalc,
        handle_fonr_share_create, handle_fonr_share_list, handle_fonr_share_revoke,
        handle_fonr_share_delete, handle_fonr_share_purge,
    )
except ImportError:  # pro 包: fonrvfs handler + backend/fonrvfs/ 一起被剪
    (handle_fonr_storages, handle_fonr_caps, handle_fonr_list, handle_fonr_stat,
     handle_fonr_preview_meta, handle_fonr_read_text, handle_fonr_read_hex,
     handle_fonr_mkdir, handle_fonr_mkfile, handle_fonr_attrs, handle_fonr_delete, handle_fonr_rename, handle_fonr_copy,
     handle_fonr_download, handle_fonr_upload_init, handle_fonr_upload_file,
     handle_fonr_upload_abort, handle_fonr_upload_sessions,
     handle_fonr_compress_cancel,   # v6.14.0 · 批14(P0): 压缩取消自动删产物
     handle_fonr_job_list, handle_fonr_job_cancel,
     handle_fonr_job_pause, handle_fonr_job_resume,
     handle_fonr_job_delete, handle_fonr_job_clear,
     handle_fonr_fav_list, handle_fonr_fav_save, handle_fonr_fav_delete,
     handle_fonr_tools_check,
     handle_fonr_stream_token, handle_fonr_thumb, handle_fonr_exif, handle_fonr_office_pdf,
     handle_fonr_archive_list, handle_fonr_archive_entry, handle_fonr_search,
     handle_fonr_recent_touch, handle_fonr_recent_list, handle_fonr_recent_delete, handle_fonr_recent_clear,
     handle_fonr_thumbs_batch,
     handle_fonr_trash_list, handle_fonr_trash_restore, handle_fonr_trash_purge,
     handle_fonr_trash_empty, handle_fonr_diff, handle_fonr_apply_plan,
     handle_fonr_settings_get, handle_fonr_settings_set, handle_fonr_upload_resume,
     handle_fonr_compress, handle_fonr_extract,
     handle_fonr_version_restore, handle_fonr_version_delete,
     handle_fonr_versions_list, handle_fonr_audit_list, handle_fonr_audit_export,
     handle_fonr_audit_purge,
     handle_fonr_acl_list, handle_fonr_acl_set, handle_fonr_acl_delete,
     handle_fonr_quota_get, handle_fonr_quota_set, handle_fonr_usage_recalc,
     handle_fonr_share_create, handle_fonr_share_list, handle_fonr_share_revoke,
     handle_fonr_share_delete, handle_fonr_share_purge,
     # v5.81.0 · 补齐此前遗漏的 13 个名字: 社区包(剪掉 backend/fonrvfs/)导入 ws 时
     #   会因这些名字未定义而 NameError(实测第一处: handle_fonr_index_scan);
     #   名单由 ast 对比 import 段与兜底段自动核出, 并有 tests/test_edition_community.py 守栏
     handle_fonr_index_scan, handle_fonr_index_search, handle_fonr_index_stats,
     handle_fonr_index_clear, handle_fonr_object_lock, handle_fonr_stream_stats,
     handle_fonr_dlp_list, handle_fonr_dlp_set, handle_fonr_dlp_delete, handle_fonr_dlp_test,
     handle_fonr_presign_get, handle_fonr_presign_put, handle_fonr_transport_plan) = (None,) * 82
    # v6.16.2 · 修复: 数量随 import 名单漂移(82≠74, v6.x 新增 handler 时只加了名字没改乘数) —
    #   完整树 import 成功永不走兜底所以从未暴露, 社区包剪枝树一解包就 ValueError;
    #   tests/test_edition_community.py 已加"乘数==目标数"静态守栏防再犯
from backend.guacd_bridge import handle_guacd_action, handle_guac_ticket_create  # v5.25.0 网关 · v6.16.2 批23 工单
from backend.security_g import handle_zt_mtls_status  # v5.24.0 · 零信任传输 mTLS
from backend.security_g import handle_sec_check, handle_sec_ports  # v5.28.5 · 安全检查+端口管理
from backend.handlers.pve import (
    handle_scan_pve,
    handle_scan_disks,
    handle_pve_backup,
    handle_pve_restore,
)
# ---------------------------------------------------------------------------
# v4.48.0 P5 · 企业专属模块条件导入 (两版本构建管线)
#   pro 发行包会物理剔除 enterprise 专属 handler (features.json prune 清单)，
#   这里 try/except 保证剔除后 ws.py 仍可加载 —— 完整版全部导入成功，零行为差异。
#   注: handlers/vzdump.py 混有通用 kill/get_logs/clear_logs，不可剪枝。
# ---------------------------------------------------------------------------
try:
    from backend.handlers.vzdump import (
        handle_vzdump,
        handle_scan_storage,
        handle_scan_archives,
        handle_download_archives,
        handle_kill,
        handle_get_logs,
        handle_clear_logs,
    )
except ImportError:  # pro 包: 模块被剪, 对应路由不注册 (license/PAGE 闸兜底)
    handle_vzdump = handle_scan_storage = handle_scan_archives = None
    handle_download_archives = handle_kill = handle_get_logs = handle_clear_logs = None
try:
    from backend.handlers.storage import (
        handle_test_lvm,
        handle_scan_lvm,
        handle_check_lvm_plugins,
        handle_install_lvm_plugin,
        handle_export_lvm,
        handle_test_pbs,
        handle_scan_pbs,
        handle_scan_pbs_detail,
        handle_restore_pbs,
        handle_test_zfs,
        handle_scan_zfs,
        handle_export_zfs,
        handle_scan_zfs_disks,
        handle_zfs_browse_files,
        handle_zfs_download_file,
        handle_zfs_upload_file,
        handle_test_rbd,
        handle_scan_rbd,
        handle_export_rbd,
        handle_check_zfs_plugins,
        handle_install_zfs_plugin,
        handle_check_rbd_plugins,
        handle_install_rbd_plugin,
    )
except ImportError:
    handle_test_lvm = handle_scan_lvm = handle_check_lvm_plugins = None
    handle_install_lvm_plugin = handle_export_lvm = None
    handle_test_pbs = handle_scan_pbs = handle_scan_pbs_detail = handle_restore_pbs = None
    handle_test_zfs = handle_scan_zfs = handle_export_zfs = None
    handle_scan_zfs_disks = handle_zfs_browse_files = None
    handle_zfs_download_file = handle_zfs_upload_file = None
    handle_test_rbd = handle_scan_rbd = handle_export_rbd = None
    handle_check_zfs_plugins = handle_install_zfs_plugin = None
    handle_check_rbd_plugins = handle_install_rbd_plugin = None
from backend.handlers.terminal import (
    handle_terminal_open,
    handle_terminal_input,
    handle_terminal_resize,
    handle_terminal_close,
    handle_terminal_attach,
    on_ws_disconnect,
)
from backend.handlers.auto_backup import (
    handle_auto_backup,
    handle_batch_backup,
    handle_auto_restore_detect,
    handle_auto_restore_compare,
    handle_auto_restore,
    handle_auto_restore_browse,
    handle_auto_restore_item,
)
from backend.handlers.platform import (
    handle_platform_list,
    handle_platform_detect,
    handle_platform_plan_backup,
    handle_platform_execute_backup,
    handle_platform_backup_history,
)
try:
    from backend.handlers.remotes import (
        handle_remote_providers,
        handle_remote_list,
        handle_remote_create,
        handle_remote_update,
        handle_remote_delete,
        handle_remote_test,
        handle_remote_upload,
    handle_remote_read_raw,
        handle_remote_upload_history,
        handle_remote_upload_clear,
        handle_remote_ls,
        handle_remote_download,
        # v4.41.0 P3-5 · ☁ 整目录传输
        handle_remote_upload_dir,
        handle_remote_download_dir,
    )
except ImportError:  # pro 包: remotes handler + backend/remotes/ provider 一起被剪
    handle_remote_providers = handle_remote_list = handle_remote_create = None
    handle_remote_update = handle_remote_delete = handle_remote_test = None
    handle_remote_upload = handle_remote_upload_history = handle_remote_upload_clear = None
    handle_remote_ls = handle_remote_download = None
    handle_remote_upload_dir = handle_remote_download_dir = None
from backend.handlers.database import (
    handle_db_task_list,
    handle_task_log_tail,
    handle_task_log_subscribe,
    handle_task_log_unsubscribe,
    handle_db_log_list,
    handle_db_backup_list,
    handle_backup_verify,
    handle_backup_verify_batch,
    handle_backup_verify_stats,
    handle_db_user_login,
    handle_db_user_list,
    handle_db_user_create,
    handle_db_user_update,
    handle_db_user_delete,
    handle_client_info_get,
    handle_db_change_password,
    handle_db_user_perms_get,
    handle_db_user_perms_set,
)
# v2.9.0: 定时计划 handlers
from backend.handlers.scheduler import (
    handle_schedule_list,
    handle_schedule_create,
    handle_schedule_update,
    handle_schedule_delete,
    handle_schedule_run_now,
    handle_schedule_runs,
    handle_schedule_timeline,
    handle_schedule_cron_preview,  # v4.47.0 P2 · cron 校验+未来 N 次预览
)
# v4.12.0
from backend.handlers.retention import (
    handle_retention_get,
    handle_retention_set,
    handle_retention_preview,
    handle_retention_apply,
    handle_retention_runs,
    handle_retention_stats,
)
# v5.98.26 · SSH 服务器硬件与资源扫描(CPU/内存/磁盘/显卡 + 占用率)
try:
    from backend.handlers.server_hw import handle_server_hw_scan
except ImportError:
    handle_server_hw_scan = None

from backend.handlers.dashboard import (
    handle_dashboard_overview,
    handle_dashboard_timeline,
    handle_dashboard_hourly,
    handle_system_stats,
    handle_graph_integrity,
    handle_dashboard_devices,       # v5.98.25 · 设备一览(SSH/共享/磁盘/云/容器)
)
from backend.handlers.license import (  # v4.42.0 · 授权
    handle_license_get,
    handle_license_install,
    handle_license_remove,
)
try:
    from backend.handlers.flows import (
        handle_flow_list,
        handle_flow_create,
        handle_flow_update,
        handle_flow_delete,
        handle_flow_abort,
        handle_flow_pause,
        handle_flow_resume,
        handle_flow_running_list,
        handle_flow_duplicate,
        handle_flow_run_now,
        handle_flow_runs,
        handle_flow_run_stats,
    )
except ImportError:  # pro 包: flows handler + flow_engine 一起被剪
    handle_flow_list = handle_flow_create = handle_flow_update = None
    handle_flow_delete = handle_flow_abort = handle_flow_pause = None
    handle_flow_resume = handle_flow_running_list = handle_flow_duplicate = None
    handle_flow_run_now = handle_flow_runs = handle_flow_run_stats = None
from backend.handlers.events import (
    handle_subscribe,
    handle_unsubscribe,
    handle_event_debug,
    handle_event_log_recent,
    handle_event_log_query,
    handle_event_log_fts_search,
)
# v4.21.0 · 告警管道
from backend.handlers.alerting import (
    handle_alert_rules_get,
    handle_alert_rules_set,
    handle_alert_test,
    handle_alert_test_email,
    handle_alert_history_query,
    handle_alert_history_purge,
    handle_alert_history_stats,
    handle_alert_rules_export,
    handle_alert_rules_import,
)
from backend.handlers.ui_prefs import (
    handle_ui_prefs_get,
    handle_ui_prefs_set,
)
from backend.handlers.key_cache import (
    handle_key_cache_fetch,   # v5.90.2 · 密钥缓存: 从服务器/云端取密钥
    handle_key_cache_put,
    handle_key_cache_list,
    handle_key_cache_clear,
)
from backend.handlers.docker import (  # v5.31.1
    handle_docker_compose_scan,
    handle_docker_compose_backup,
)
from backend.handlers.sysconf import (  # v5.19.2 · 系统配置备份/恢复 + 残留清理
    handle_sysconf_export, handle_sysconf_preview, handle_sysconf_import,
    handle_sysdb_backup, handle_sysdb_list, handle_sysdb_restore,
    handle_remote_prune_scan, handle_remote_prune_apply,
)
from backend.handlers.vitals_ws import (  # v5.19.1 · 核心运行状况
    handle_vitals_overview, handle_vitals_endpoints, handle_vitals_host,
    handle_vitals_selfcheck, handle_vitals_resilience, handle_vitals_kill_stalled,
    handle_vitals_engines, handle_vitals_security, handle_vitals_plugins,
    handle_run_trace, handle_vitals_commands, handle_trace_tree,
    handle_punch_create, handle_punch_register, handle_punch_attempt,
    handle_punch_attempt_quic,
    handle_punch_list, handle_punch_cancel, handle_punch_fallback,
)
from backend.handlers.https_mgmt import (  # v5.29.0 HTTPS/SSL 证书管理
    handle_https_get,
    handle_https_set,
    handle_https_issue,
    handle_https_upload,
)
from backend.handlers.update import (handle_update_check, handle_update_apply, handle_update_status)
from backend.handlers.settings import (  # v4.15.24
    handle_setting_get,
    handle_setting_set,
    handle_setting_delete,
    handle_web_port_get,   # v4.43.0 · WEB 端口管理
    handle_web_port_set,
    handle_transfer_engine_get,   # v4.50.0 · 传输引擎
    handle_transfer_engine_set,
    handle_preview_mode_get,
    handle_service_status,   # v5.19.0 · 服务状态
    handle_service_restart,  # v5.19.0 · 重启后台服务
    # v5.1.0 · 预览方式 (仅预览/目录浏览+预览)
    handle_preview_mode_set,
)
try:
    from backend.handlers.k8s_backup import (  # v4.58.0 · K8s/容器备份
        handle_etcd_snapshot,
        handle_docker_backup,
        handle_pv_backup,
        handle_backup_verify_sha256,
    )
except ImportError:  # v6.16.20 批37 · 社区包: k8s_backup 剪除 (专业档)
    handle_etcd_snapshot = handle_docker_backup = handle_pv_backup = None
    handle_backup_verify_sha256 = None
try:
    from backend.handlers.ai_assistant import (  # v4.58.0 · AI 运维助手
        handle_ai_config_get,
        handle_ai_config_set,
        handle_ai_chat,
        handle_ai_execute,
        handle_ai_draft_issue,   # v5.57.0 D1 · 沙盒草稿令牌
        handle_ai_intent_list,   # v5.57.0 D3 · 意图审计
    )
except ImportError:  # v6.16.20 批37 · 社区包: ai_assistant 剪除 (专业档)
    handle_ai_config_get = handle_ai_config_set = handle_ai_chat = None
    handle_ai_execute = handle_ai_draft_issue = handle_ai_intent_list = None
from backend.handlers.file_ops import (  # v4.58.0 · 文件查看/编辑/管理
    handle_file_read,
    handle_file_write,
    handle_file_delete,
    handle_file_rename,
    handle_file_mkdir,
    handle_file_mkfile,  # v5.17.0 · 新建文件
    handle_file_chmod,   # v5.90.5 · 修改权限/属主
    handle_file_compress,
    handle_file_extract,
    handle_file_stat,
    handle_file_exif,  # v5.14.0 · 图片 EXIF 摘要
    handle_file_read_raw,
    handle_file_archive_list,
    handle_file_stream_token,
    handle_file_read_range,
    handle_file_remote_stream_token,
    handle_file_tail,
    handle_file_archive_extract_one,
    handle_archive_tools_check,
    handle_archive_formats,
    handle_file_copy,
    handle_dir_size,
    handle_file_checksum,
    handle_file_write_b64,
)
from backend.handlers.qos import (  # v4.59.0 · QoS 带宽时间表
    handle_qos_get,
    handle_qos_set,
)
try:
    from backend.handlers.restic import (  # v4.68.0 · restic 去重加密备份
        handle_restic_check,
        handle_restic_init,
        handle_restic_backup,
        handle_restic_snapshots,
        handle_restic_ls,
        handle_restic_restore,
        handle_restic_forget,
        handle_restic_stats,
    )
except ImportError:  # v6.16.20 批37 · 社区包: restic 剪除 (专业档)
    handle_restic_check = handle_restic_init = handle_restic_backup = None
    handle_restic_snapshots = handle_restic_ls = handle_restic_restore = None
    handle_restic_forget = handle_restic_stats = None
try:
    from backend.worm_drill import (  # v4.83.0 · C3 WORM + C4 定时演练
        handle_worm_config,
        handle_worm_apply,
        handle_worm_release,
        handle_worm_status,
        handle_drill_run,
        handle_drill_history,
    )
except ImportError:  # v6.16.20 批37 · 社区包: worm_drill 剪除 (专业档)
    handle_worm_config = handle_worm_apply = handle_worm_release = None
    handle_worm_status = handle_drill_run = handle_drill_history = None
from backend.engine_selector import handle_engine_analyze  # v4.82.0 · 专利1
from backend.ransomware_guard import (  # v4.82.0 · 专利2
    handle_ransomware_scan,
    handle_ransomware_config,
)
from backend.distro import (  # v4.82.0 · 专利3
    handle_distro_detect,
    handle_distro_tools,
)
from backend.auto_upgrade import (  # v4.85.0 · 自动升级
    handle_upgrade_check,
    handle_upgrade_run,
    handle_upgrade_self,
    handle_upgrade_servers_get,   # v5.50.0 · 升级目标配置化 (审计 #3)
    handle_upgrade_servers_set,
)
from backend.handlers.hub import (  # v5.50.0 · P0-5 统一资源目录 + 事件总线补拉
    handle_hub_nodes,
    handle_events_replay,
    handle_events_stats,
)
from backend.enterprise import (  # v4.89.0 · F1 LDAP / F2 多租户 / F3 SIEM
    handle_ldap_config,
    handle_ldap_test,
    handle_namespace_list,
    handle_namespace_create,
    handle_namespace_delete,
    handle_siem_config,
    handle_siem_test,
)
try:
    from backend.airgap import (  # v4.90.0 · G1 Air-Gap 摆渡
        handle_ferry_export,
        handle_ferry_import,
        handle_ferry_list,
        handle_ferry_pubkey,   # v5.14.0 · RSA 公钥带外分发
        handle_ferry_trust,
    )
except ImportError:  # v6.16.22 批39 · 社区/专业包: airgap 随企业档键剪除
    handle_ferry_export = handle_ferry_import = handle_ferry_list = None
    handle_ferry_pubkey = handle_ferry_trust = None
from backend.quota import (  # v4.91.0 · F4 流量配额/成本管控
    handle_quota_config,
    handle_quota_usage,
)
from backend.security_g import (  # v4.84.0 · G 系列安全专项
    handle_g2_crypt_create,
    handle_g2_crypt_delete,
    handle_g2_crypt_update,
    handle_g2_crypt_list,
    handle_g2_crypt_test,
    handle_g3_s3_lifecycle,
    handle_g3_object_lock,  # v5.14.0 · G3.5 S3 对象锁 WORM
    handle_g5_serve_start,
    handle_g5_serve_protos,   # v5.20.0
    handle_g5_serve_stop,
    handle_g5_serve_status,
    # v6.12.0 · 批12: rclone 组件升级(解锁 s3/ftp/nfs serve)
    handle_rclone_component_status, handle_rclone_upgrade_start, handle_rclone_upgrade_status,
    handle_mfa_setup,
    handle_mfa_verify,
    handle_mfa_status,
)
from backend.handlers.pve_api import (
    handle_pve_api_test,
    handle_pve_api_nodes,
    handle_pve_api_vms,
    handle_pve_api_storages,
    handle_pve_api_snapshots,
    handle_pve_console_ready,          # v5.20.0 · VM 控制台可用性
    handle_pve_console_url,            # v5.20.0 · 生成控制台 URL
    handle_pve_api_snapshot_create,
    handle_pve_api_snapshot_rollback,
)
from backend.handlers.pve_cluster import (  # v4.86.0 · D4 (v4.92.0 修复注册缺失)
    handle_pve_api_cluster,
    handle_pve_api_migrate,
    handle_pve_api_vm_op,
)
from backend.storage_policy import handle_storage_policy_detect  # v4.92.0 · D2 存储智能识别
from backend.core_fabric.relay import (  # v5.11.0 · P5 relay 中转方向
    handle_relay_transfer,
    handle_relay_status,
)
from backend.handlers.croc import (  # v4.95.0 · H: croc 点对点 + 传输回放
    handle_croc_check,
    handle_croc_send,
    handle_croc_receive,
    handle_croc_stop,
    handle_croc_status,
    handle_stats_replay,
)
from backend.handlers.docker import (
    handle_docker_volumes,
    handle_docker_volume_backup,
    handle_docker_image_backup,       # v5.19.0 · 镜像备份
    handle_docker_container_backup,   # v5.19.0 · 容器备份
    handle_docker_images_backup_all,  # v5.19.0 · 批量镜像备份
    handle_docker_import,            # v5.89.0 · 容器/镜像导入
    handle_docker_networks,
    handle_docker_stats,
    handle_docker_prune,
    handle_docker_exec_cmd,
)
try:
    from backend.handlers.dbb import (  # v4.75.0 · 数据库备份 v2 + v4.78.0 恢复演练
        handle_dbb_check,
        handle_dbb_scan,
        handle_dbb_backup,
        handle_dbb_list,
        handle_dbb_verify,
        handle_dbb_restore,
        handle_dbb_delete,
        handle_dbb_drill,
    )
except ImportError:  # v6.16.20 批37 · 社区包: dbb 剪除 (专业档; rest_api 引用点已加护栏)
    handle_dbb_check = handle_dbb_scan = handle_dbb_backup = None
    handle_dbb_list = handle_dbb_verify = handle_dbb_restore = None
    handle_dbb_delete = handle_dbb_drill = None
from backend.handlers.i18n import (  # v4.74.0 · 界面语言偏好
    handle_ui_lang_set,
    handle_ui_lang_get,
)
from backend.handlers.stats import (  # v4.67.0 · 统计与智能分析
    handle_stats_overview,
    handle_stats_baseline,
    handle_stats_recommend,
)
from backend.handlers.dup_scan import (  # v4.62.0 · 重复文件检测
    handle_dup_scan,
    handle_dup_delete,
)
from backend.sync_conflicts import (  # v4.63.0 · 双向同步冲突中心
    handle_sync_conflict_list,
    handle_sync_conflict_resolve,
    handle_sync_conflict_delete,
)
try:
    from backend.handlers.watch import (  # v4.59.0 · 实时同步守护
        handle_watch_rule_list,
        handle_watch_rule_save,
        handle_watch_rule_delete,
        handle_watch_rule_toggle,
        handle_watch_status,
        handle_watch_events,
        handle_watch_test_run,
    )
except ImportError:  # v6.16.20 批37 · 社区包: watch 剪除 (专业档)
    handle_watch_rule_list = handle_watch_rule_save = handle_watch_rule_delete = None
    handle_watch_rule_toggle = handle_watch_status = None
    handle_watch_events = handle_watch_test_run = None
try:
    from backend.handlers.dbbackup import (  # v4.54.0 · 数据库热备份
        handle_dbbackup_run,
        handle_dbbackup_check,
        handle_dbbackup_list,
        handle_dbbackup_scan_databases,  # v4.55.0 · 扫描库列表
    )
except ImportError:  # v6.16.20 批37 · 社区包: dbbackup 剪除 (专业档; scheduler 引用点已加护栏)
    handle_dbbackup_run = handle_dbbackup_check = handle_dbbackup_list = None
    handle_dbbackup_scan_databases = None
from backend.handlers.share import (  # v4.39.0 Phase 2a · 网络共享 SMB/NFS/AFP/WebDAV
    handle_share_list,
    handle_mounts_list,   # v5.16.0 · 真实挂载点枚举 (备份保存路径选择器)
    handle_target_test,   # v5.16.0 · 备份目标可写性测试
    handle_share_save,
    handle_share_delete,
    handle_share_mount,
    handle_share_umount,
    handle_share_test,
    handle_share_plugin_check,
    handle_share_auto_remount,  # v4.39.4 · 登录自动重新挂载
)
try:
    from backend.handlers.disk import (  # v4.31.0 -> v4.35.0 · Phase 2-6 (enterprise)
        handle_disk_scan,
        handle_disk_plugin_check,
        handle_disk_mount_ro,
        handle_disk_unmount,
        handle_disk_df,
        handle_disk_plugin_install,
        handle_disk_rm,
        handle_disk_mv,
        handle_disk_cp,
        handle_disk_remount_rw,
        handle_disk_luks_open,       # v4.35.0
        handle_disk_luks_close,      # v4.35.0
        handle_disk_zfs_import,      # v4.35.0
        handle_disk_zfs_export,      # v4.35.0
        handle_disk_list_dir,        # v4.35.0
        handle_disk_ns_op,           # v4.36.0
    )
except ImportError:  # pro 包: disk handler 被剪
    handle_disk_scan = handle_disk_plugin_check = handle_disk_mount_ro = None
    handle_disk_unmount = handle_disk_df = handle_disk_plugin_install = None
    handle_disk_rm = handle_disk_mv = handle_disk_cp = handle_disk_remount_rw = None
    handle_disk_luks_open = handle_disk_luks_close = None
    handle_disk_zfs_import = handle_disk_zfs_export = handle_disk_list_dir = None
    handle_disk_ns_op = None

# v5.98.22 · 容量健康与扩容编排 (P4)
try:
    from backend.handlers.vhealth import (
        handle_vdisk_health, handle_vdisk_extend_plan, handle_vdisk_extend_apply, handle_vdisk_scrub,
    )
except ImportError:
    handle_vdisk_health = handle_vdisk_extend_plan = None
    handle_vdisk_extend_apply = handle_vdisk_scrub = None

# v5.99.2 · CloudPool V2 智能存储池 (M2b 产品接线; enterprise)
try:
    from backend.handlers.cloudpool import (
        handle_cpool_list, handle_cpool_create, handle_cpool_delete,
        handle_cpool_volume_create, handle_cpool_volume_update,
        handle_cpool_volume_delete, handle_cpool_capacity,   # v6.2.6 · §12 Volume/配额/薄置备
        handle_cpool_policy_list, handle_cpool_policy_create, handle_cpool_policy_update,
        handle_cpool_policy_delete, handle_cpool_policy_resolve, handle_cpool_policy_write,  # v6.3.0 · §29
        handle_cpool_members, handle_cpool_member_add, handle_cpool_member_remove,
        handle_cpool_member_probe, handle_cpool_member_scan,
        handle_cpool_storage_pool_hint,
        handle_cpool_member_candidates,
        handle_cpool_member_cand_bench,
        handle_cpool_member_mount_candidate,
        handle_cpool_member_persist,
        handle_cpool_view_unified, handle_cpool_view_devices, handle_cpool_view_recovery,
        handle_cpool_probe_perf, handle_cpool_bench_start, handle_cpool_bench_status,
        handle_cpool_perf_summary,
        handle_cpool_place, handle_cpool_read_route, handle_cpool_placement_history,
        handle_cpool_managed_write, handle_cpool_materialize, handle_cpool_managed_recover,
        handle_cpool_protected_write, handle_cpool_replica_check, handle_cpool_replica_repair,
        handle_cpool_conflict_resolve, handle_cpool_conflict_list,   # v6.2.2 · P6 冲突中心
        handle_cpool_ec_write, handle_cpool_ec_rebuild,
        handle_cpool_cache_purge, handle_cpool_cache_stats, handle_cpool_read_cached,
        handle_cpool_tier_move, handle_cpool_job_pause, handle_cpool_job_resume,
        handle_cpool_autopilot_eval,
        handle_cpool_gateway_plan, handle_cpool_gateway_apply, handle_cpool_gateway_revoke,
        handle_cpool_detach_plan, handle_cpool_detach,
        handle_cpool_trash_list, handle_cpool_trash_restore, handle_cpool_trash_purge,
        handle_cpool_snapshot_create, handle_cpool_snapshot_list,
        handle_cpool_health_center, handle_cpool_forecast,
        handle_cpool_drill_run, handle_cpool_drill_history,
    )
except ImportError:  # 社区/专业包: cloudpool 子系统被剪
    handle_cpool_list = handle_cpool_create = handle_cpool_delete = None
    handle_cpool_volume_create = handle_cpool_volume_update = None
    handle_cpool_volume_delete = handle_cpool_capacity = None
    handle_cpool_policy_list = handle_cpool_policy_create = handle_cpool_policy_update = None
    handle_cpool_policy_delete = handle_cpool_policy_resolve = handle_cpool_policy_write = None
    handle_cpool_members = handle_cpool_member_add = handle_cpool_member_remove = None
    handle_cpool_member_probe = handle_cpool_member_scan = None
    handle_cpool_storage_pool_hint = None
    handle_cpool_view_unified = handle_cpool_view_devices = handle_cpool_view_recovery = None
    handle_cpool_probe_perf = handle_cpool_bench_start = None
    handle_cpool_bench_status = handle_cpool_perf_summary = None
    handle_cpool_place = handle_cpool_read_route = handle_cpool_placement_history = None
    handle_cpool_managed_write = handle_cpool_materialize = handle_cpool_managed_recover = None
    handle_cpool_protected_write = handle_cpool_replica_check = None
    handle_cpool_replica_repair = handle_cpool_conflict_resolve = handle_cpool_conflict_list = None
    handle_cpool_ec_write = handle_cpool_ec_rebuild = None
    handle_cpool_gateway_plan = handle_cpool_gateway_apply = None
    handle_cpool_gateway_revoke = handle_cpool_detach_plan = handle_cpool_detach = None
    handle_cpool_trash_list = handle_cpool_trash_restore = handle_cpool_trash_purge = None
    handle_cpool_snapshot_create = handle_cpool_snapshot_list = None
    handle_cpool_health_center = handle_cpool_forecast = None
    handle_cpool_drill_run = handle_cpool_drill_history = None
    handle_cpool_gateway_plan = handle_cpool_gateway_apply = None
    handle_cpool_gateway_revoke = handle_cpool_detach_plan = handle_cpool_detach = None
    handle_cpool_trash_list = handle_cpool_trash_restore = handle_cpool_trash_purge = None
    handle_cpool_snapshot_create = handle_cpool_snapshot_list = None
    handle_cpool_health_center = handle_cpool_forecast = None
    handle_cpool_drill_run = handle_cpool_drill_history = None
    handle_cpool_cache_purge = handle_cpool_cache_stats = handle_cpool_read_cached = None
    handle_cpool_tier_move = handle_cpool_job_pause = None
    handle_cpool_job_resume = handle_cpool_autopilot_eval = None

# v5.98.20 · 虚拟盘对外分享 (P2: SMB/NFS/DLNA 导出)
try:
    from backend.handlers.vshare import (
        handle_vshare_status, handle_vshare_plan, handle_vshare_apply, handle_vshare_undo,
        handle_vshare_mount_plan, handle_vshare_mount_apply,
        handle_vshare_mount_status, handle_vshare_mount_stop,
        # v6.4.0 · 批3: 按条操作 + SMB 专用账号
        handle_vshare_entry_set, handle_vshare_entry_disable,
        handle_vshare_entry_enable, handle_vshare_entry_delete,
        handle_vshare_smb_users, handle_vshare_smb_user_create,
        handle_vshare_smb_user_passwd, handle_vshare_smb_user_delete,
        handle_vshare_dlna_install,
        # v6.7.0 · 批7: 通用服务/组件一键安装 + 进度查询
        handle_vshare_svc_install, handle_vshare_svc_install_status,
    )
except ImportError:
    handle_vshare_status = handle_vshare_plan = handle_vshare_apply = handle_vshare_undo = None
    handle_vshare_mount_plan = handle_vshare_mount_apply = None
    handle_vshare_mount_status = handle_vshare_mount_stop = None
    handle_vshare_entry_set = handle_vshare_entry_disable = None
    handle_vshare_entry_enable = handle_vshare_entry_delete = None
    handle_vshare_smb_users = handle_vshare_smb_user_create = None
    handle_vshare_smb_user_passwd = handle_vshare_smb_user_delete = None
    handle_vshare_dlna_install = None
    handle_vshare_svc_install = handle_vshare_svc_install_status = None

# v6.4.0 · 批3 · 分享管理(统一台账视图)
# v6.5.0 · 批6 · HTTP 链接管理/服务控制/文件权限(分享管理独立主菜单的三个二级页)
try:
    from backend.handlers.share_mgr import (
        handle_share_mgr_list, handle_share_mgr_stats,
        handle_share_http_list, handle_share_http_save, handle_share_http_update,
        handle_share_http_regen, handle_share_http_delete, handle_share_http_visitors,
        handle_share_svc_status, handle_share_svc_ctl,
        handle_share_fs_perm_get, handle_share_fs_perm_set,
        handle_share_clients,
    )
except ImportError:
    handle_share_mgr_list = handle_share_mgr_stats = None
    handle_share_http_list = handle_share_http_save = None
    handle_share_http_update = handle_share_http_regen = None
    handle_share_http_delete = handle_share_http_visitors = None
    handle_share_svc_status = handle_share_svc_ctl = None
    handle_share_fs_perm_get = handle_share_fs_perm_set = None
    handle_share_clients = None

# v5.98.19 · 多云虚拟存储池 (统一虚拟根 · P1 + 智能放置 P3)
try:
    from backend.handlers.vdisk import (
        handle_vdisk_storages, handle_vdisk_ls, handle_vdisk_plan,
        handle_vdisk_op, handle_vdisk_place,
    )
except ImportError:
    handle_vdisk_storages = handle_vdisk_ls = handle_vdisk_plan = None
    handle_vdisk_op = handle_vdisk_place = None

# v5.98.18 · 磁盘镜像备份/恢复 (第一梯队 1+2)
try:
    from backend.handlers.disk_image import (
        handle_disk_image_targets, handle_disk_image_create, handle_disk_image_list,
        handle_disk_image_verify, handle_disk_image_restore, handle_disk_image_delete,
        handle_disk_image_tools, handle_disk_image_dd_transfer,
    )
except ImportError:
    handle_disk_image_targets = handle_disk_image_create = handle_disk_image_list = None
    handle_disk_image_verify = handle_disk_image_restore = handle_disk_image_delete = None
    handle_disk_image_tools = None
    handle_disk_image_dd_transfer = None
try:
    from backend.handlers.docker import (  # v4.48.0 P4 · Docker/容器管理 (v4.49.0 起 pro 可用)
        handle_docker_scan,
        handle_docker_images,
        handle_docker_action,
        handle_docker_logs,
        handle_docker_check,     # v4.49.0 · 插件检测
        handle_docker_install,   # v4.49.0 · 一键安装
    )
except ImportError:  # pro 包: docker handler 被剪
    handle_docker_scan = handle_docker_images = handle_docker_action = handle_docker_logs = None
    handle_docker_check = handle_docker_install = None


# ---------------------------------------------------------------------------
# Action descriptions (category, description)
# ---------------------------------------------------------------------------
# v6.11.0 · 批11 · 轮询型只读动作: 高频但无审计价值 → 跳过操作日志(前台/终端不再被刷屏)
POLL_SILENT_ACTIONS = frozenset((
    # 事件订阅总线(event_bus 首次订阅/重连重放/断线补偿)
    "subscribe", "unsubscribe", "events_replay", "events_stats",
    # 前端定时/切换刷新拉取的只读清单
    "remote_list", "share_list", "mounts_list", "conn_list", "sp_list",
    "fonr_job_list", "system_stats", "hub_nodes", "cpool_list",
    "share_mgr_list", "share_clients", "fonr_storages", "fonr_caps",
    "fonr_recent_list", "license_get", "nav_counts", "badge_counts",
    "ui_prefs_get", "preview_mode_get", "read_ui_prefs",
))

ACTION_DESC_MAP = {
    "test_conn": ("连接测试", "测试连接"),
    "rsync": ("数据传输", "rsync传输"),
    "scan_storage": ("存储扫描", "扫描存储配置"),
    "scan_pve": ("PVE扫描", "扫描PVE虚拟机"),
    "scan_disks": ("磁盘扫描", "扫描虚拟机磁盘"),
    "pve_backup": ("PVE备份", "备份虚拟机"),
    "pve_restore": ("PVE恢复", "恢复虚拟机"),
    "scan_local": ("本地扫描", "扫描本地备份"),
    "list_dir": ("目录浏览", "浏览目录"),
    "list_remote_dir": ("远端目录", "浏览远端目录"),
    "zerotrust": ("安全", "零信任: 主机密钥钉死 + 传输令牌"),
    "e2ee": ("安全", "E2EE 双端协商: 实例身份 + 对端公钥钉死"),
    "truenas_api": ("PVE", "TrueNAS REST 控制面 (池/数据集/快照)"),
    "remote_desk_ping": ("远程桌面", "探测 VNC/guacd 端口可达性"),
    "remote_diag": ("远程桌面", "连接失败诊断报告 (目标/后端/日志/结论)"),
    "deps_scan": ("系统设置", "扫描本机依赖与插件状态"),
    "deps_install": ("系统设置", "一键安装本机依赖"),
    "remote_os_detect": ("远端目录", "识别远端操作系统 (Windows/macOS/Linux)"),
    "remote_disks": ("远端目录", "列举远端磁盘/盘符/卷"),
    "pve_console_ready": ("PVE", "VM 控制台可用性"),
    "pve_console_url": ("PVE", "生成 VM 控制台 URL"),
    "check_sync_tools": ("工具检测", "本机同步工具"),  # v4.38.23
    "install_local_tools": ("工具安装", "本机一键安装"),  # v4.38.24
    "mkdir": ("目录浏览", "新建本地目录"),
    "mkdir_remote": ("远端目录", "新建远端目录"),
    "file_read": ("文件管理", "读取文件内容"),
    "file_write": ("文件管理", "写入文件内容"),
    "file_delete": ("文件管理", "删除文件/目录"),
    "file_rename": ("文件管理", "重命名/移动"),
    "file_mkdir": ("文件管理", "新建目录"),
    "file_mkfile": ("文件管理", "新建文件"),
    "file_chmod": ("文件管理", "修改权限/属主"),
    "file_compress": ("文件管理", "压缩文件/目录"),
    "file_extract": ("文件管理", "解压压缩包"),
    "file_stat": ("文件管理", "文件属性"),
    "file_exif": ("文件管理", "图片 EXIF 摘要"),
    "file_read_raw": ("文件管理", "读取文件原始内容"),
    "file_archive_list": ("文件管理", "压缩包内容列表"),
    "watch_rule_list":   ("实时同步", "守护规则列表"),
    "watch_rule_save":   ("实时同步", "保存守护规则"),
    "watch_rule_delete": ("实时同步", "删除守护规则"),
    "watch_rule_toggle": ("实时同步", "启停守护规则"),
    "watch_status":      ("实时同步", "守护状态"),
    "watch_events":      ("实时同步", "守护事件流"),
    "watch_test_run":    ("实时同步", "手动触发一次同步"),
    "qos_get":      ("QoS限速", "读取带宽时间表"),
    "qos_set":      ("QoS限速", "保存带宽时间表"),
    "file_stream_token": ("文件管理", "签发流式预览令牌"),
    "file_read_range": ("文件管理", "分块读取文件"),
    "file_remote_stream_token": ("文件管理", "签发远端流播令牌"),
    "file_tail":    ("文件管理", "读取文件尾部"),
    "file_archive_extract_one": ("文件管理", "压缩包提取单文件"),
    "archive_tools_check": ("文件管理", "归档工具检测"),
    "archive_formats": ("文件管理", "归档格式清单"),
    "file_copy":    ("文件管理", "复制/移动"),
    "dir_size":     ("文件管理", "目录占用分析"),
    "file_checksum": ("文件管理", "文件校验"),
    "file_write_b64": ("文件管理", "上传文件(二进制)"),
    "restic_check":     ("restic", "检测 restic"),
    "restic_init":      ("restic", "初始化仓库"),
    "restic_backup":    ("restic", "去重加密备份"),
    "restic_snapshots": ("restic", "快照列表"),
    "restic_ls":        ("restic", "浏览快照文件"),
    "restic_restore":   ("restic", "恢复快照"),
    "restic_forget":    ("restic", "保留策略清理"),
    "restic_stats":     ("restic", "仓库统计"),
    "docker_volumes":       ("容器管理", "卷列表"),
    "docker_image_backup":    ("容器管理", "镜像备份"),
    "docker_container_backup": ("容器管理", "容器备份"),
    "docker_images_backup_all": ("容器管理", "批量镜像备份"),
    "docker_import":          ("容器管理", "容器/镜像导入"),
    "key_cache_fetch":        ("密钥缓存", "从服务器/云端取密钥"),
    "key_cache_put":          ("密钥缓存", "粘贴密钥内容入缓存"),
    "key_cache_list":         ("密钥缓存", "列出缓存密钥"),
    "key_cache_clear":        ("密钥缓存", "清理缓存"),
    "docker_volume_backup": ("容器管理", "卷备份"),
    "docker_networks":      ("容器管理", "网络列表"),
    "docker_stats":         ("容器管理", "资源统计"),
    "docker_prune":         ("容器管理", "清理悬空资源"),
    "docker_exec_cmd":      ("容器管理", "容器内执行命令"),
    "dbb_check":    ("数据库备份", "检测客户端工具"),
    "dbb_scan":     ("数据库备份", "扫描数据库列表"),
    "dbb_backup":   ("数据库备份", "执行备份"),
    "dbb_list":     ("数据库备份", "备份产物列表"),
    "dbb_verify":   ("数据库备份", "校验产物完整性"),
    "dbb_restore":  ("数据库备份", "恢复数据库"),
    "dbb_delete":   ("数据库备份", "删除备份产物"),
    "dbb_drill":    ("数据库备份", "恢复演练"),
    "worm_config":       ("WORM", "读/写不可变策略"),
    "worm_apply":        ("WORM", "应用不可变保护"),
    "worm_release":      ("WORM", "解锁文件"),
    "worm_status":       ("WORM", "查看不可变状态"),
    "drill_run":         ("恢复演练", "手动演练"),
    "drill_history":     ("恢复演练", "演练历史"),
    "engine_analyze":    ("智能分析", "引擎决策矩阵分析"),
    "ransomware_scan":   ("勒索防护", "扫描目录"),
    "ransomware_config": ("勒索防护", "读/写检测配置"),
    "distro_detect":     ("发行版", "探测发行版+工具+认证"),
    "distro_tools":      ("发行版", "生成工具安装命令"),
    "ldap_config":       ("LDAP", "读/写 LDAP 配置"),
    "ldap_test":         ("LDAP", "测试连接"),
    "namespace_list":    ("多租户", "Namespace 列表"),
    "namespace_create":  ("多租户", "创建 Namespace"),
    "namespace_delete":  ("多租户", "删除 Namespace"),
    "siem_config":       ("SIEM", "读/写 Syslog 配置"),
    "siem_test":         ("SIEM", "发送测试消息"),
    "upgrade_check":     ("自动升级", "检查版本"),
    "upgrade_run":       ("自动升级", "执行远程升级"),
    "upgrade_self":      ("自动升级", "本机 git pull"),
    "g2_crypt_create":   ("rclone crypt", "创建加密 remote"),
    "g2_crypt_delete":       ("安全", "删除 rclone crypt remote (仅 crypt 段)"),
    "g2_crypt_update":       ("安全", "编辑 rclone crypt remote 参数"),
    "g2_crypt_list":     ("rclone crypt", "列出 remotes"),
    "g2_crypt_delete":   ("rclone crypt", "删除加密 remote"),
    "vnc_rec_list":      ("远程桌面", "会话录制列表"),
    "vnc_rec_delete":    ("远程桌面", "删除会话录制"),
    "truenas_ctl":       ("存储", "TrueNAS REST 控制面 (池/数据集/快照/scrub)"),
    "pve_save_config":   ("远程桌面", "保存 PVE 连接配置"),
    "pve_servers":       ("PVE", "PVE 服务器列表 (增/删/查)"),
    "sec_check":         ("安全", "自动化安全检查 (端口/SSH/防火墙/权限)"),
    "https_get":         ("HTTPS", "HTTPS 配置与证书状态"),
    "https_set":         ("HTTPS", "保存 HTTPS 配置 (重启生效)"),
    "https_issue":       ("HTTPS", "立即签发/续期证书"),
    "https_upload":      ("HTTPS", "上传证书与私钥 (PEM)"),
    "sec_ports":         ("安全", "监听端口列表/防火墙规则"),
    "zt_mtls":           ("安全", "零信任传输 mTLS 证书状态/生成"),
    "guacd_status":      ("远程桌面", "guacd 网关状态/部署/地址保存"),
    "g2_crypt_update":   ("rclone crypt", "编辑加密 remote"),
    "g2_crypt_test":     ("rclone crypt", "测试连通"),
    "g3_s3_lifecycle":   ("S3 生命周期", "配置生命周期规则"),
    "g3_object_lock":    ("S3 对象锁", "WORM 对象锁查询/启用"),
    "g5_serve_start":    ("rclone serve", "启动服务"),
    "rclone_component_status": ("rclone serve", "rclone 组件状态(版本/来源/可用 serve 协议)"),
    "rclone_upgrade_start": ("rclone serve", "升级 rclone 组件(官方包→应用组件目录, confirm)"),
    "rclone_upgrade_status": ("rclone serve", "组件升级进度(轮询)"),
    "g5_serve_stop":     ("rclone serve", "停止服务"),
    "g5_serve_status":   ("rclone serve", "服务状态"),
    "serve_protos":       ("rclone serve", "探测可用服务协议 (按 rclone 实际能力)"),
    "mfa_setup":         ("MFA", "生成 TOTP secret"),
    "mfa_verify":        ("MFA", "验证 TOTP 码"),
    "ferry_export":      ("Air-Gap", "导出摆渡包"),
    "ferry_import":      ("Air-Gap", "导入摆渡包"),
    "ferry_list":        ("Air-Gap", "列出摆渡包"),
    "ferry_pubkey":      ("Air-Gap", "出示本机摆渡公钥"),
    "ferry_trust":       ("Air-Gap", "信任导出方公钥"),
    "quota_config":      ("流量配额", "配额配置读写"),
    "quota_usage":       ("流量配额", "用量/成本查询"),
    "mfa_status":        ("MFA", "MFA 状态"),
    "pve_api_test":     ("PVE API", "连通测试"),
    "pve_api_nodes":    ("PVE API", "节点列表"),
    "pve_api_vms":      ("PVE API", "VM/CT 列表"),
    "pve_api_storages": ("PVE API", "存储池列表"),
    "pve_api_snapshots": ("PVE API", "快照列表"),
    "pve_api_snapshot_create": ("PVE API", "创建快照"),
    "pve_api_snapshot_rollback": ("PVE API", "回滚快照"),
    "pve_api_cluster":  ("PVE 集群", "集群视图汇总"),
    "pve_api_migrate":  ("PVE 集群", "跨节点迁移"),
    "pve_api_vm_op":    ("PVE 集群", "VM 电源操作"),
    "storage_policy_detect": ("存储识别", "存储类型→备份通道"),
    "croc_check":        ("P2P 传输", "检测 croc"),
    "croc_send":         ("P2P 传输", "croc 发送"),
    "croc_receive":      ("P2P 传输", "croc 接收"),
    "croc_stop":         ("P2P 传输", "停止 croc 实例"),
    "croc_status":       ("P2P 传输", "croc 实例状态"),
    "stats_replay":      ("传输回放", "历史传输时间轴"),
    "ui_lang_set":  ("界面", "保存语言偏好"),
    "ui_lang_get":  ("界面", "读取语言偏好"),
    "stats_overview":  ("智能分析", "统计概览与异常"),
    "stats_baseline":  ("智能分析", "基线统计"),
    "stats_recommend": ("智能分析", "推荐执行时段"),
    "dup_scan":     ("重复检测", "扫描重复文件"),
    "dup_delete":   ("重复检测", "删除重复副本"),
    "sync_conflict_list":   ("冲突中心", "冲突列表"),
    "sync_conflict_resolve": ("冲突中心", "标记解决"),
    "sync_conflict_delete":  ("冲突中心", "删除冲突记录"),
    "vzdump": ("vzdump打包", "vzdump备份打包"),
    "scan_archives": ("归档扫描", "扫描归档文件"),
    "download_archives": ("归档下载", "下载归档"),
    "kill": ("任务取消", "取消任务"),
    "get_logs": ("日志查看", "获取操作日志"),
    "clear_logs": ("日志清除", "清除操作日志"),
    "test_lvm": ("LVM测试", "测试LVM连接"),
    "scan_lvm": ("LVM扫描", "扫描LVM磁盘"),
    "check_lvm_plugins": ("LVM插件检测", "检测LVM相关插件"),
    "install_lvm_plugin": ("LVM插件安装", "一键安装LVM插件"),
    "check_zfs_plugins": ("ZFS插件检测", "检测ZFS相关插件"),
    "install_zfs_plugin": ("ZFS插件安装", "一键安装ZFS插件"),
    "check_rbd_plugins": ("RBD插件检测", "检测RBD相关插件"),
    "install_rbd_plugin": ("RBD插件安装", "一键安装RBD插件"),
    "check_rsync_plugins": ("同步工具检测", "检测同步工具"),
    "install_rsync_plugin": ("同步工具安装", "一键安装同步工具"),
    "export_lvm": ("LVM导出", "导出LVM磁盘"),
    "test_pbs": ("PBS测试", "测试PBS连接"),
    "scan_pbs": ("PBS扫描", "扫描PBS备份"),
    "scan_pbs_detail": ("PBS扫描", "扫描PBS备份详情"),
    "restore_pbs": ("PBS恢复", "恢复PBS备份"),
    "test_zfs": ("ZFS测试", "测试ZFS连接"),
    "scan_zfs": ("ZFS扫描", "扫描ZFS存储"),
    "export_zfs": ("ZFS导出", "导出ZFS数据集"),
    "scan_zfs_disks": ("ZFS扫描", "扫描磁盘/分区/池"),
    "zfs_browse_files": ("ZFS浏览", "浏览文件"),
    "vdisk_health": ("存储池", "容量与健康: LVM/ZFS/文件系统用量 + 阈值告警"),
    "vdisk_extend_plan": ("存储池", "扩容预演: 命令与前置检查(不写盘)"),
    "vdisk_extend_apply": ("存储池", "扩容执行: 手输目标名 + 回读容量确认"),
    "vdisk_scrub": ("存储池", "启动 ZFS scrub(数据校验)"),
    "vshare_status": ("虚拟磁盘", "分享给局域网: 组件/服务/已导出检测"),
    "vshare_entry_set": ("分享管理", "按条改权(只读/白名单/Guest)"),
    "vshare_entry_disable": ("分享管理", "按条停用(配置移除, 台账保留)"),
    "vshare_entry_enable": ("分享管理", "按条启用(按台账重建)"),
    "vshare_entry_delete": ("分享管理", "按条删除(配置+台账)"),
    "vshare_smb_users": ("分享管理", "SMB 专用账号列表"),
    "vshare_smb_user_create": ("分享管理", "创建 SMB 专用账号(系统 nologin + smbpasswd)"),
    "vshare_smb_user_passwd": ("分享管理", "修改 SMB 账号密码"),
    "vshare_smb_user_delete": ("分享管理", "删除 SMB 专用账号"),
    "share_mgr_list": ("局域网分享", "全站分享统一清单(台账+实时核对)"),
    "share_http_list": ("HTTP分享", "HTTP 链接清单(含访客统计)"),
    "share_http_save": ("HTTP分享", "新建 HTTP 链接(按路径; 权限档/口令/有效期/次数/人数)"),
    "share_http_update": ("HTTP分享", "编辑链接(续期/口令/权限档/启停)"),
    "share_http_regen": ("HTTP分享", "重新生成链接(旧链接失效, 统计保留)"),
    "share_http_delete": ("HTTP分享", "删除链接(含访客台账)"),
    "share_http_visitors": ("HTTP分享", "单链接访客台账"),
    "share_svc_status": ("局域网分享", "smbd/nfsd/minidlna 服务状态"),
    "vshare_svc_install": ("局域网分享", "一键安装分享服务/组件(samba/nfs-kernel-server/minidlna, confirm)"),
    "vshare_svc_install_status": ("局域网分享", "组件安装进度查询(轮询: 里程碑/耗时/结果)"),
    "share_svc_ctl": ("局域网分享", "服务启停/重启/开机自启(confirm)"),
    "share_clients": ("局域网分享", "活跃客户端视图: SMB 会话/NFS 挂载/rclone serve 连接数(只读)"),
    "share_fs_perm_get": ("账号权限", "查看路径权限(mode/owner)"),
    "share_fs_perm_set": ("账号权限", "设置权限 chmod/chown(递归可选, confirm)"),
    "share_mgr_stats": ("分享管理", "分享访客/下载统计"),
    "vshare_plan": ("虚拟磁盘", "分享给局域网: 生成 SMB/NFS/DLNA 配置片段与客户端地址"),
    "vshare_apply": ("虚拟磁盘", "分享给局域网: 应用(备份+校验+失败回滚)"),
    "vshare_undo": ("虚拟磁盘", "分享给局域网: 撤销 fonriv 管理的共享块"),
    "vshare_mount_plan": ("虚拟磁盘", "统一挂载点: 聚合各来源(rclone union)规划"),
    "vshare_mount_apply": ("虚拟磁盘", "统一挂载点: 建立并 systemd 托管"),
    "vshare_mount_status": ("虚拟磁盘", "统一挂载点: 状态"),
    "vshare_mount_stop": ("虚拟磁盘", "统一挂载点: 停止并移除单元"),
    "vdisk_storages": ("虚拟磁盘", "多云虚拟存储池: 卷(来源)列表 + 用量"),
    "vdisk_ls": ("虚拟磁盘", "多云虚拟存储池: 列虚拟根/卷内目录"),
    "vdisk_plan": ("虚拟磁盘", "多云虚拟存储池: 操作预演(跨卷/冲突/空间)"),
    "vdisk_op": ("虚拟磁盘", "多云虚拟存储池: 复制/移动/改名/删除/新建目录"),
    "vdisk_place": ("虚拟磁盘", "多云虚拟存储池: 智能放置(按剩余空间/权重/亲和 + 门限)"),
    "disk_image_targets": ("磁盘", "镜像备份: 枚举可备份块设备 + 工具检测"),
    "disk_image_create": ("磁盘", "镜像备份: 采集整盘/分区 + 元数据 + manifest"),
    "disk_image_list": ("磁盘", "镜像备份: 列出镜像(含清单)"),
    "disk_image_verify": ("磁盘", "镜像备份: 校验 sha256"),
    "disk_image_restore": ("磁盘", "镜像恢复: 写回(不可逆, 需手输设备名)"),
    "disk_image_delete": ("磁盘", "镜像备份: 删除镜像目录"),
    "disk_image_tools": ("磁盘", "镜像备份: 工具检测"),
    "disk_image_dd_transfer": ("磁盘", "块级直传: dd/ddrescue 盘对盘/盘到文件(可断点+双端校验)"),
    "disk_scan": ("磁盘扫描", "扫描远端所有磁盘/LVM/ZFS"),
    "disk_plugin_check": ("磁盘插件", "检测磁盘管理相关依赖"),
    "disk_mount_ro": ("磁盘挂载", "只读挂载远端块设备"),
    "disk_unmount": ("磁盘卸载", "卸载远端挂载点"),
    "disk_df": ("空间查询", "df 查询挂载点/路径空间"),
    "disk_plugin_install": ("磁盘插件安装", "一键安装磁盘管理依赖"),
    "disk_rm": ("磁盘删除", "远端删除文件/目录"),
    "disk_mv": ("磁盘移动", "远端移动/重命名"),
    "disk_cp": ("磁盘复制", "远端复制文件/目录"),
    "disk_remount_rw": ("重挂读写", "只读挂载点转读写"),
    "disk_luks_open":  ("LUKS解锁", "cryptsetup 只读打开加密卷"),
    "terminal_open":  ("终端", "打开 SSH 终端"),
    "terminal_input": ("终端", "终端输入"),
    "terminal_resize":("终端", "终端大小调整"),
    "terminal_close": ("终端", "关闭终端"),
    "terminal_attach":("终端", "恢复终端会话"),
    "disk_luks_close": ("LUKS关闭", "关闭 LUKS 映射"),
    "disk_zfs_import": ("ZFS导入", "只读导入 ZFS 池"),
    "disk_zfs_export": ("ZFS导出", "导出 ZFS 池"),
    "disk_list_dir":   ("磁盘浏览", "浏览挂载点目录"),
    "disk_ns_op":      ("磁盘写入", "命名空间 mkdir/touch/rm"),
    "zfs_download_file": ("ZFS下载", "下载文件"),
    "zfs_upload_file": ("ZFS上传", "上传文件"),
    "test_rbd": ("RBD测试", "测试RBD连接"),
    "scan_rbd": ("RBD扫描", "扫描RBD映像"),
    "export_rbd": ("RBD导出", "导出RBD映像"),
    "auto_backup": ("一键备份", "一键备份"),
    "batch_backup": ("批量备份", "多节点批量备份"),
    "auto_restore_detect": ("一键恢复", "检测恢复目标"),
    "auto_restore_compare": ("一键恢复", "比较恢复差异"),
    "auto_restore": ("一键恢复", "执行自动恢复"),
    "auto_restore_browse": ("一键恢复", "浏览恢复文件"),
    "auto_restore_item": ("一键恢复", "恢复单项文件"),
    "db_task_list": ("任务管理", "列出任务"),
    "task_log_tail": ("任务管理", "拉取任务日志尾"),
    "task_log_subscribe": ("任务管理", "订阅任务日志尾 (tail -f)"),
    "task_log_unsubscribe": ("任务管理", "取消订阅任务日志尾"),
    "db_log_list": ("日志管理", "列出日志"),
    "db_backup_list": ("备份管理", "列出备份"),
    "backup_verify": ("备份验证", "SHA256 校验备份文件"),
    "backup_verify_batch": ("备份验证", "批量验证备份"),
    "backup_verify_stats": ("备份验证", "验证统计"),
    "db_user_login": ("用户管理", "用户登录"),
    "client_info_get": ("用户管理", "查询连接信息"),
    "db_user_list": ("用户管理", "列出用户"),
    "db_user_create": ("用户管理", "创建用户"),
    "db_user_update": ("用户管理", "更新用户"),
    "db_user_delete": ("用户管理", "删除用户"),
    "db_change_password": ("用户管理", "修改密码"),
    "db_user_perms_get": ("用户管理", "读取权限"),
    "db_user_perms_set": ("用户管理", "设置权限"),
    # v2.9.0: 定时计划
    "schedule_list":    ("定时计划", "列出定时任务"),
    "schedule_create":  ("定时计划", "创建定时任务"),
    "schedule_update":  ("定时计划", "更新定时任务"),
    "schedule_delete":  ("定时计划", "删除定时任务"),
    "schedule_run_now": ("定时计划", "立即执行"),
    "schedule_runs":    ("定时计划", "查看运行历史"),
    "schedule_timeline":("定时计划", "查看时间轴"),
    "schedule_cron_preview":("定时计划", "cron 表达式预览"),  # v4.47.0 P2
    # v4.12.0
    "retention_get":("保留策略", "查看"),
    "retention_set":("保留策略", "保存"),
    "retention_preview":("保留策略", "预览清理"),
    "retention_apply":("保留策略", "执行清理"),
    "retention_runs":("保留策略", "查看历史"),
    "retention_stats":("保留策略", "统计"),
    "dashboard_devices":("数据总览", "设备一览: SSH/网络共享/磁盘/云存储/容器"),
    "server_hw_scan":("数据总览", "扫描服务器 CPU/内存/磁盘/显卡 与占用率"),
    "dashboard_overview":("数据总览", "KPI"),
    "dashboard_timeline":("数据总览", "时间线"),
    "dashboard_hourly":("数据总览", "近 24h 每小时"),
    "graph_integrity":("数据总览", "引用一致性校验"),
    "flow_list":("流程", "列表"),
    "flow_create":("流程", "创建"),
    "flow_update":("流程", "更新"),
    "flow_delete":("流程", "删除"),
    "flow_run_now":("流程", "手动执行"),
    "flow_abort":  ("流程", "中止执行"),
    "flow_pause":  ("流程", "暂停执行"),
    "flow_resume": ("流程", "恢复执行"),
    "flow_running_list": ("流程", "运行中列表"),
    "flow_duplicate": ("流程", "复制"),
    "flow_runs":("流程", "运行历史"),
    "flow_run_stats":("流程", "运行统计报表"),
    # v4.16.0 · WebSocket 事件订阅
    "subscribe":      ("事件", "订阅主题"),
    "unsubscribe":    ("事件", "取消订阅"),
    "event_debug":    ("事件", "订阅拓扑调试"),
    "event_log_recent": ("事件", "获取最近事件缓冲"),
    "event_log_query": ("事件", "分页查询事件历史"),
    "event_log_fts_search": ("事件", "全文搜索 payload"),
    "alert_rules_get": ("告警", "获取告警规则"),
    "alert_rules_set": ("告警", "更新告警规则"),
    "alert_test": ("告警", "测试 Webhook"),
    "alert_test_email": ("告警", "测试 SMTP 邮件"),
    "alert_history_query": ("告警", "分页查询告警历史"),
    "alert_history_purge": ("告警", "清理告警历史"),
    "alert_history_stats": ("告警", "告警触发次数聚合"),
    "alert_rules_export":  ("告警", "导出告警规则"),
    "alert_rules_import":  ("告警", "导入告警规则"),
    "system_stats": ("系统", "系统状态快照"),
    "license_get": ("授权", "查询授权状态"),
    "license_install": ("授权", "安装 license"),
    "license_remove": ("授权", "移除 license"),
    "ui_prefs_get":("UI 偏好", "读取"),
    "ui_prefs_set":("UI 偏好", "保存"),
    "setting_get":    ("全局设置", "读取"),
    "setting_set":    ("全局设置", "保存"),
    "setting_delete": ("全局设置", "删除"),
    "web_port_get":   ("系统设置", "查询 WEB 端口"),
    "web_port_set":   ("系统设置", "修改 WEB 端口"),
    # v4.50.0 · 传输引擎
    "transfer_engine_get": ("传输引擎", "读取传输引擎配置"),
    "transfer_engine_set": ("传输引擎", "设置传输引擎 (auto/rsync/rclone)"),
    "rclone_check":   ("传输引擎", "检测本机 rclone"),
    "rclone_install": ("传输引擎", "一键安装本机 rclone"),
    # v4.0.0-alpha1: 平台适配
    "platform_list":   ("平台适配", "列出适配平台"),
    "platform_detect": ("平台适配", "探测目标平台"),
    "platform_plan_backup": ("平台适配", "预演备份计划"),
    "platform_execute_backup": ("平台适配", "执行真备份"),
    "platform_backup_history": ("平台适配", "查询平台备份历史"),
    "remote_providers":      ("远端存储", "列出支持的存储 provider"),
    "remote_list":           ("远端存储", "读取远端配置列表"),
    "remote_ls":             ("远端存储", "浏览远端存储目录"),
    "remote_download":       ("远端存储", "下载远端对象到本机"),
    # v4.41.0 P3-5 · ☁ 整目录传输
    "remote_upload_dir":     ("远端存储", "上传目录到远端"),
    "remote_download_dir":   ("远端存储", "下载远端目录到本机"),
    "remote_create":         ("远端存储", "新建远端配置"),
    "remote_update":         ("远端存储", "更新远端配置"),
    "remote_delete":         ("远端存储", "删除远端配置"),
    "remote_test":           ("远端存储", "测试远端连通性"),
    "remote_upload":         ("远端存储", "上传备份到远端"),
    "remote_read_raw":       ("远端存储", "云端文件读取(预览)"),
    "relay_transfer":        ("中转传输", "relay 中转传输"),
    "relay_status":          ("中转传输", "中转暂存区状态"),
    "remote_upload_history": ("远端存储", "查询上传历史"),
    "remote_upload_clear":   ("远端存储", "清空上传历史"),
    # v4.39.0 Phase 2a · 网络共享
    "share_list":         ("网络共享", "列出共享配置"),
    "mounts_list":        ("网络共享", "真实挂载点列表"),
    "target_test":        ("网络共享", "备份目标可写性测试"),
    "share_save":         ("网络共享", "保存共享配置"),
    "share_delete":       ("网络共享", "删除共享配置"),
    "share_mount":        ("网络共享", "挂载共享"),
    "share_umount":       ("网络共享", "卸载共享"),
    "share_test":         ("网络共享", "测试共享连通性"),
    "share_plugin_check": ("网络共享", "检测共享协议依赖"),
    "share_auto_remount": ("网络共享", "登录自动重新挂载"),  # v4.39.4
    # v4.48.0 P4 · Docker
    "docker_scan":   ("Docker", "扫描容器与镜像"),
    "docker_images": ("Docker", "刷新镜像列表"),
    "docker_action": ("Docker", "容器操作 (start/stop/restart/pause/unpause/rm)"),
    "docker_logs":   ("Docker", "拉取容器日志"),
    "docker_check":  ("Docker", "插件检测 (docker/daemon/compose)"),
    "docker_install":("Docker", "一键安装 docker"),
}


# ---------------------------------------------------------------------------
# v4.44.1 · 精细化门控映射
# ACTION_FEATURE_MAP: action -> license 功能键 (license.feature_enabled 硬闸,
#   对 admin 同样生效; 不在表内 = core 不门控)
# ACTION_PAGE_MAP: action -> 用户权限页面键 (用户管理"分配权限"对应;
#   admin 豁免; 不在表内 = 不做用户级拦截)
# v4.46.0 P1 · 功能闸映射改由 scripts/features.json 单一真源生成
#   (backend/features_gen.py · gen_features.py 产出), 修 P0-1: vzdump 4 个
#   action 此前错挂 pve 键 → pro 可 WS 直连绕过旗舰闸。
# ---------------------------------------------------------------------------
# v5.62.0 · E3 边缘传输引擎(zstd+rsync / mc 并发镜像)
# v5.65.0 · F1 传送门(Ctrl+G): 全局快速跳转 —— 数据汇总/模糊排序
# v5.67.0 · F3 存储热力图(冷=索引大小分布, 热=审计访问密度)
# v5.81.0 · 社区版发行包会把 backend/fonrvfs/ 整体剪掉 → 与上方 fonrvfs handler 同样条件导入
try:
    from backend.fonrvfs.heat import handle_fonr_heatmap  # noqa: E402
    from backend.fonrvfs.timeline import handle_fonr_timeline  # noqa: E402
    from backend.fonrvfs.intent import handle_fonr_intent  # noqa: E402
except ImportError:  # 社区包: backend/fonrvfs/ 已剪枝
    handle_fonr_heatmap = None
    handle_fonr_timeline = None
    handle_fonr_intent = None

from backend.portal import (  # noqa: E402
    handle_portal_search, handle_portal_hit)

try:  # v5.81.0 · 跨网/引擎 handler 依赖 fonrvfs.* → 社区包内不存在, 条件导入
    from backend.handlers.xfer_engine import (  # noqa: E402
        handle_xfer_engine_probe, handle_xfer_zstd_push, handle_xfer_mc_mirror,
        # v6.13.0 · 批13: 多流传输组件(aioquic)一键安装
        handle_quic_install_start, handle_quic_install_status,
        handle_xfer_quic_send, handle_xfer_frp_ctl, handle_xfer_iroh_ticket,
        handle_xfer_iroh_receive)
except ImportError:
    handle_xfer_engine_probe = handle_xfer_zstd_push = handle_xfer_mc_mirror = None
    handle_quic_install_start = handle_quic_install_status = None
    handle_xfer_quic_send = handle_xfer_frp_ctl = None
    handle_xfer_iroh_ticket = handle_xfer_iroh_receive = None

# v6.16.20 批37 · 第二批 .so: 闸真源切换 edition_gate ——
#   GATE_MAP(闸表)从明文生成物(features_gen.py)迁入 edition_gate 模块, 发行包以
#   edition_gate.abi3.so 二进制交付(明文剔除, 由 build_license_so.sh 编译)。
#   **fail-closed**: 闸模块缺失/被删 → 拒绝启动, 绝不以无闸形态运行。
#   授权事实(license 白名单/限额)仍在 license.abi3.so —— license.feature_enabled 判定不变。
try:
    from backend import edition_gate as _edition_gate
except ImportError as _eg_err:  # noqa: F811
    raise SystemExit("[FATAL] 档位闸模块缺失 (backend/edition_gate 或 edition_gate.abi3.so) — "
                     "拒绝以无闸形态启动: %r" % (_eg_err,))
ACTION_FEATURE_MAP = _edition_gate.GATE_MAP  # noqa: E402 · 兼容既有引用点(闸检查/契约守栏)

ACTION_PAGE_MAP = {}
for _a in ("rsync", "test_conn", "scan_storage", "list_dir", "list_remote_dir",
           "mkdir", "mkdir_remote", "check_sync_tools", "install_rsync_plugin",
    ):
    ACTION_PAGE_MAP[_a] = "transfer"
# v6.16.11 · test_conn 同时服务「文件传输」与「Web 终端」两页的连接测试
#   (终端测试按钮此前借 disk_scan → 社区版撞企业档授权闸, 已改挂 test_conn);
#   页闸取并集: 有 transfer 或 terminal 任一权限即可用。
ACTION_PAGE_MAP["test_conn"] = ("transfer", "terminal")
for _a in ("disk_scan", "disk_plugin_check", "disk_mount_ro", "disk_unmount", "disk_df",
           "disk_plugin_install", "disk_rm", "disk_mv", "disk_cp", "disk_remount_rw",
           "disk_luks_open", "disk_luks_close", "disk_zfs_import", "disk_zfs_export",
           "disk_list_dir", "disk_ns_op"):
    ACTION_PAGE_MAP[_a] = "disk_manager"
for _a in ("share_list", "mounts_list", "target_test", "share_save", "share_delete", "share_mount", "share_umount",
           "share_test", "share_plugin_check", "share_auto_remount"):
    ACTION_PAGE_MAP[_a] = "shares"
# v5.24.0 · TrueNAS 控制面 (挂远端存储页权限)
for _a in ("remote_list", "remote_test"):
    if _a not in ACTION_PAGE_MAP:
        ACTION_PAGE_MAP[_a] = "remotes"
ACTION_PAGE_MAP["truenas_ctl"] = "truenas"   # v5.28.0 · TrueNAS 控制面板子页
# v5.40.0 · FonrVFS 多云文件管理 (新主菜单 🗂) —— 全部 action 挂页面键 fonrvfs
for _a in ("fonr_storages", "fonr_caps", "fonr_list", "fonr_stat", "fonr_preview_meta",
           "fonr_read_text", "fonr_read_hex", "fonr_mkdir", "fonr_delete", "fonr_rename",
           "fonr_copy", "fonr_download", "fonr_upload_init", "fonr_upload_file",
           "fonr_upload_abort", "fonr_upload_sessions", "fonr_job_list", "fonr_job_cancel",
           "fonr_compress_cancel",   # v6.14.0 · 批14
           "fonr_job_pause", "fonr_job_resume", "fonr_job_delete", "fonr_job_clear",
           "fonr_fav_list", "fonr_fav_save", "fonr_fav_delete", "fonr_tools_check",
           # v5.41.0 P1 · 预览矩阵 / 搜索 / 最近
           "fonr_stream_token", "fonr_thumb", "fonr_exif", "fonr_office_pdf",
           "fonr_archive_list", "fonr_archive_entry", "fonr_search",
           "fonr_recent_touch", "fonr_recent_list", "fonr_recent_delete", "fonr_recent_clear",
           "fonr_thumbs_batch",
           # v5.43.0 P2 · 回收站 / 同步对比 / 设置 / 续传
           "fonr_trash_list", "fonr_trash_restore", "fonr_trash_purge", "fonr_trash_empty",
           "fonr_diff", "fonr_apply_plan", "fonr_settings_get", "fonr_settings_set",
           "fonr_upload_resume",
           # v5.44.0 P2 剩余
           "fonr_compress", "fonr_extract",
        # v5.45.0 版本历史 / 审计
        "fonr_versions_list", "fonr_version_restore", "fonr_version_delete",
        "fonr_audit_list", "fonr_audit_export", "fonr_audit_purge",
        # v5.47.0 治理
        "fonr_acl_list", "fonr_acl_set", "fonr_acl_delete",
        "fonr_quota_get", "fonr_quota_set", "fonr_usage_recalc",
           "fonr_share_create", "fonr_share_list", "fonr_share_revoke",
           "fonr_share_delete", "fonr_share_purge",
           # v5.53.0 · P2-10/P2-12 预签名与传输策略
           "fonr_presign_get", "fonr_presign_put", "fonr_transport_plan",
           # v5.54.0 · P3 治理/对象锁/索引
           "fonr_dlp_list", "fonr_dlp_set", "fonr_dlp_delete", "fonr_dlp_test",
           "fonr_index_scan", "fonr_index_search", "fonr_index_stats",
           "fonr_index_clear", "fonr_object_lock",
           # v5.56.0 · C1 流式流量可观测
           "fonr_stream_stats",
           # v5.62.0 · E3-1/E3-2 引擎探测(快查询; 上传/镜像在 ROUTE_TASK)
           "xfer_engine_probe", "xfer_zstd_push", "xfer_mc_mirror",
           "quic_install_start", "quic_install_status",   # v6.13.0 · 批13
           # v5.63.0 · E3-3/4/5 跨网引擎(QUIC / frp / iroh)
           "xfer_quic_send", "xfer_frp_ctl", "xfer_iroh_ticket", "xfer_iroh_receive"):
    ACTION_PAGE_MAP[_a] = "fonrvfs"
ACTION_PAGE_MAP["sec_check"] = "settings"
# v5.29.0 · HTTPS 管理挂安全中心
for _a in ("https_get", "https_set", "https_issue", "https_upload"):
    ACTION_PAGE_MAP[_a] = "security"
ACTION_PAGE_MAP["sec_ports"] = "settings"
for _a in ("zt_mtls",):
    ACTION_PAGE_MAP[_a] = "settings"
for _a in ("guacd_status", "guac_ticket_create"):
    ACTION_PAGE_MAP[_a] = "rdp_console"   # v5.28.0 · guacd 网关挂在 RDP 控制台子页
# v4.48.0 P4 · Docker 页
for _a in ("docker_scan", "docker_images", "docker_action", "docker_logs",
           "docker_check", "docker_install", "docker_import"):
    ACTION_PAGE_MAP[_a] = "docker"
for _a in ("terminal_open", "terminal_input", "terminal_resize", "terminal_close",
           "terminal_attach"):
    ACTION_PAGE_MAP[_a] = "terminal"
for _a in ("remote_providers", "remote_list", "remote_ls", "remote_download",
           "remote_upload_dir", "remote_download_dir", "remote_create", "remote_update",
           "remote_delete", "remote_test", "remote_upload", "remote_upload_history", "remote_read_raw",
           "remote_upload_clear"):
    ACTION_PAGE_MAP[_a] = "remotes"
for _a in ("scan_pve", "scan_disks", "pve_backup", "pve_restore"):
    ACTION_PAGE_MAP[_a] = "proxmox"
for _a in ("engine_analyze", "ransomware_scan", "ransomware_config",
           "distro_detect", "distro_tools",
           "worm_config", "worm_apply", "worm_release", "worm_status",
           "drill_run", "drill_history"):
    ACTION_PAGE_MAP[_a] = "settings"
for _a in ("vzdump", "scan_local", "scan_archives", "download_archives", "db_backup_list"):
    ACTION_PAGE_MAP[_a] = "vzdump"
for _a in ("test_pbs", "scan_pbs", "scan_pbs_detail", "restore_pbs"):
    ACTION_PAGE_MAP[_a] = "pbs"
for _a in ("test_lvm", "scan_lvm", "check_lvm_plugins", "install_lvm_plugin", "export_lvm"):
    ACTION_PAGE_MAP[_a] = "lvm"
for _a in ("check_zfs_plugins", "install_zfs_plugin", "test_zfs", "scan_zfs",
           "export_zfs", "scan_zfs_disks", "zfs_browse_files",
           "zfs_download_file", "zfs_upload_file"):
    ACTION_PAGE_MAP[_a] = "zfs"
for _a in ("check_rbd_plugins", "install_rbd_plugin", "test_rbd", "scan_rbd", "export_rbd"):
    ACTION_PAGE_MAP[_a] = "rbd"
for _a in ("auto_backup", "batch_backup", "auto_restore_detect", "auto_restore_compare",
           "auto_restore", "auto_restore_browse", "auto_restore_item"):
    ACTION_PAGE_MAP[_a] = "auto_backup"
for _a in ("platform_list", "platform_detect", "platform_plan_backup",
           "platform_execute_backup", "platform_backup_history"):
    ACTION_PAGE_MAP[_a] = "platform_backup"
for _a in ("schedule_list", "schedule_create", "schedule_update", "schedule_delete",
           "schedule_run_now", "schedule_runs", "schedule_timeline",
           "schedule_cron_preview",
           "retention_get", "retention_set", "retention_preview", "retention_apply",
           "retention_runs", "retention_stats"):
    ACTION_PAGE_MAP[_a] = "schedules"
for _a in ("db_task_list", "task_log_tail", "task_log_subscribe", "task_log_unsubscribe",
           "backup_verify", "backup_verify_batch", "backup_verify_stats"):
    ACTION_PAGE_MAP[_a] = "jobs"
for _a in ("get_logs", "clear_logs", "db_log_list"):
    ACTION_PAGE_MAP[_a] = "log"
for _a in ("flow_list", "flow_create", "flow_update", "flow_delete", "flow_run_now",
           "flow_abort", "flow_pause", "flow_resume", "flow_running_list",
           "flow_duplicate", "flow_runs", "flow_run_stats"):
    ACTION_PAGE_MAP[_a] = "flows"
for _a in ("dashboard_overview", "dashboard_timeline", "dashboard_hourly",
           "graph_integrity", "system_stats", "dashboard_devices", "server_hw_scan"):
    ACTION_PAGE_MAP[_a] = "dashboard"
for _a in ("cpool_list", "cpool_create", "cpool_delete", "cpool_members",
           "cpool_volume_create", "cpool_volume_update",
           "cpool_volume_delete", "cpool_capacity",
           "cpool_policy_list", "cpool_policy_create", "cpool_policy_update",
           "cpool_policy_delete", "cpool_policy_resolve", "cpool_policy_write",
           "cpool_member_add", "cpool_member_remove", "cpool_member_probe",
           "cpool_member_candidates", "cpool_member_cand_bench", "cpool_member_mount_candidate", "cpool_member_persist",
           "cpool_member_scan", "cpool_storage_pool_hint", "cpool_view_unified", "cpool_view_devices",
           "cpool_view_recovery", "cpool_probe_perf", "cpool_bench_start",
           "cpool_bench_status", "cpool_perf_summary", "cpool_place",
           "cpool_read_route", "cpool_placement_history", "cpool_managed_write",
           "cpool_materialize", "cpool_managed_recover", "cpool_protected_write",
           "cpool_replica_check", "cpool_replica_repair", "cpool_conflict_resolve", "cpool_conflict_list",
           "cpool_ec_write", "cpool_ec_rebuild", "cpool_cache_purge", "cpool_cache_stats",
           "cpool_read_cached", "cpool_tier_move", "cpool_job_pause", "cpool_job_resume",
           "cpool_autopilot_eval", "cpool_gateway_plan", "cpool_gateway_apply",
           "cpool_gateway_revoke", "cpool_detach_plan", "cpool_detach",
           "cpool_trash_list", "cpool_trash_restore", "cpool_trash_purge",
           "cpool_snapshot_create", "cpool_snapshot_list", "cpool_health_center",
           "cpool_forecast", "cpool_drill_run", "cpool_drill_history"):
    ACTION_PAGE_MAP[_a] = "cloudpool"
for _a in ("setting_get", "setting_set", "setting_delete",
           "web_port_get", "web_port_set",
           "transfer_engine_get", "transfer_engine_set",
           "web_port_get", "web_port_set",
           "transfer_engine_get", "transfer_engine_set"):
    ACTION_PAGE_MAP[_a] = "settings"
# v4.55.0 · 数据库备份独立页面闸
for _a in ("dbbackup_run", "dbbackup_check", "dbbackup_list",
           "dbbackup_scan_databases",
           "dbb_check", "dbb_scan", "dbb_backup", "dbb_list",
           "docker_volumes", "docker_volume_backup", "docker_networks",
           "docker_stats", "docker_prune", "docker_exec_cmd",
           "dbb_verify", "dbb_restore", "dbb_delete", "dbb_drill"):
    ACTION_PAGE_MAP[_a] = "dbbackup"
for _a in ("pve_api_test", "pve_api_nodes", "pve_api_vms",
           "pve_api_storages", "pve_api_snapshots",
           "pve_api_cluster", "pve_api_migrate", "pve_api_vm_op"):
    ACTION_PAGE_MAP[_a] = "proxmox"
for _a in ("ldap_config", "ldap_test", "namespace_list",
           "namespace_create", "namespace_delete",
           "siem_config", "siem_test"):
    ACTION_PAGE_MAP[_a] = "settings"
for _a in ("ferry_export", "ferry_import", "ferry_list", "ferry_pubkey", "ferry_trust"):
    ACTION_PAGE_MAP[_a] = "settings"
for _a in ("quota_config", "quota_usage"):
    ACTION_PAGE_MAP[_a] = "settings"
for _a in ("relay_transfer", "relay_status"):
    ACTION_PAGE_MAP[_a] = "transfer"
for _a in ("croc_check", "croc_send", "croc_receive", "croc_stop", "croc_status"):
    ACTION_PAGE_MAP[_a] = "transfer"   # v6.16.22 批39 · 修: croc UI 在传输页(h_extras), 页面闸原误挂 airgap 页(受限用户权限分配歧义)
for _a in ("stats_replay",):
    ACTION_PAGE_MAP[_a] = "settings"
for _a in ("upgrade_check", "upgrade_run", "upgrade_self",
           "upgrade_servers_get", "upgrade_servers_set"):
    ACTION_PAGE_MAP[_a] = "settings"
for _a in ("hub_nodes", "events_replay"):
    ACTION_PAGE_MAP[_a] = "conn_center"
ACTION_PAGE_MAP["events_stats"] = "settings"
for _a in ("g2_crypt_create", "g2_crypt_list", "g2_crypt_test",
           "g3_s3_lifecycle", "g3_object_lock", "g5_serve_start", "g5_serve_stop",
           "g5_serve_status", "mfa_setup", "mfa_verify", "mfa_status",
           "rclone_component_status", "rclone_upgrade_start", "rclone_upgrade_status"):   # v6.12.0 · 批12
    ACTION_PAGE_MAP[_a] = "settings"
for _a in ("ai_config_get", "ai_config_set", "ai_chat", "ai_execute",
           "ai_draft_issue", "ai_intent_list"):   # v5.57.0 D1/D3
    ACTION_PAGE_MAP[_a] = "ai_assistant"

# v5.20.0 · 阶段5 + 本机依赖: 补页面权限映射。
#   ⚠ 本表语义是"不在表内 = 不做用户级拦截", 漏映射等于对非 admin 开放。
#   deps_install 以 root 装包、zerotrust 改信任状态, 必须挂页面权限。
for _a in ("deps_scan", "deps_install", "zerotrust", "e2ee", "serve_protos", "remote_desk_ping"):
    ACTION_PAGE_MAP[_a] = "settings"
# v5.98.17 · 连接诊断报告: 三个连接页(RDP/VNC/PVE)任一有权限即可用 → 这里首次用**多页**取值
ACTION_PAGE_MAP["remote_diag"] = ("rdp_console", "vnc_direct", "pve_console", "remotedesk")
for _a in ("truenas_api", "pve_console_ready", "pve_console_url"):
    ACTION_PAGE_MAP[_a] = "proxmox"
for _a in ("vdisk_health", "vdisk_extend_plan", "vdisk_extend_apply", "vdisk_scrub"):
    # v6.9.0 · 批9: 容量看板与扩容编排**迁入「存储池」页**(管理员运维面, 用户拍板)
    ACTION_PAGE_MAP[_a] = "cloudpool"

for _a in ("vshare_status", "vshare_plan", "vshare_apply", "vshare_undo"):
    # v6.9.0 · 批9: vdisk 页的分享应用表单已并入「分享管理 → 局域网文件分享」向导
    ACTION_PAGE_MAP[_a] = "share_lan"
for _a in ("vshare_mount_plan", "vshare_mount_apply", "vshare_mount_status", "vshare_mount_stop"):
    ACTION_PAGE_MAP[_a] = "vdisk_cloud"      # 统一挂载点(聚合)仍在虚拟盘页(用户侧)

# v6.5.0 · 批6: 分享管理独立主菜单(局域网 share_lan / HTTP share_http / 账号权限 share_access)
for _a in ("vshare_entry_set", "vshare_entry_disable", "vshare_entry_enable",
           "vshare_entry_delete", "share_mgr_list", "share_mgr_stats",
           "share_clients"):   # v6.10.0 · 批10: 活跃客户端视图(局域网页)
    ACTION_PAGE_MAP[_a] = "share_lan"
for _a in ("vshare_dlna_install", "vshare_svc_install", "vshare_svc_install_status"):
    ACTION_PAGE_MAP[_a] = "share_lan"
for _a in ("vshare_smb_users", "vshare_smb_user_create",
           "vshare_smb_user_passwd", "vshare_smb_user_delete",
           "share_fs_perm_get", "share_fs_perm_set"):
    ACTION_PAGE_MAP[_a] = "share_access"
for _a in ("share_http_list", "share_http_save", "share_http_update",
           "share_http_regen", "share_http_delete", "share_http_visitors"):
    ACTION_PAGE_MAP[_a] = "share_http"
# vshare 原生动作(状态/计划/应用/撤销/挂载点): 向导与虚拟盘页共用 → 允许两个页面(用列表页键)
for _a in ("vshare_status", "vshare_plan", "vshare_apply", "vshare_undo",
           "vshare_mount_plan", "vshare_mount_apply", "vshare_mount_status", "vshare_mount_stop"):
    ACTION_PAGE_MAP[_a] = "share_lan"

for _a in ("vdisk_storages", "vdisk_ls", "vdisk_plan", "vdisk_op", "vdisk_place"):
    ACTION_PAGE_MAP[_a] = "vdisk_cloud"      # v5.98.19 · 多云虚拟存储池页

for _a in ("disk_image_targets", "disk_image_create", "disk_image_list", "disk_image_verify",
           "disk_image_restore", "disk_image_delete", "disk_image_tools",
           "disk_image_dd_transfer"):
    ACTION_PAGE_MAP[_a] = "disk_image"       # v6.2.1 · 磁盘镜像拆为独立二级菜单(原挂备份中心)

for _a in ("remote_os_detect", "remote_disks"):
    ACTION_PAGE_MAP[_a] = "transfer"

for _a in ("etcd_snapshot", "docker_backup", "pv_backup", "backup_verify_sha256"):
    ACTION_PAGE_MAP[_a] = "k8s_backup"
for _a in ("file_read", "file_write", "file_delete", "file_rename",
           "file_mkdir", "file_mkfile", "file_chmod", "file_compress", "file_extract", "file_stat", "file_exif",
           "file_read_raw", "file_archive_list", "file_read_range",
           "file_remote_stream_token",
           "watch_rule_list", "watch_rule_save", "watch_rule_delete",
           "watch_rule_toggle", "watch_status", "watch_events", "watch_test_run",
           "file_stream_token", "file_tail", "file_archive_extract_one",
           "archive_tools_check", "archive_formats",
           "file_copy", "dir_size", "file_checksum", "file_write_b64"):
    ACTION_PAGE_MAP[_a] = "transfer"
for _a in ("qos_get", "qos_set"):
    ACTION_PAGE_MAP[_a] = "settings"
for _a in ("stats_overview", "stats_baseline", "stats_recommend"):
    ACTION_PAGE_MAP[_a] = "settings"
for _a in ("restic_check", "restic_init", "restic_backup", "restic_snapshots",
           "restic_ls", "restic_restore", "restic_forget", "restic_stats"):
    ACTION_PAGE_MAP[_a] = "restic"
for _a in ("dup_scan", "dup_delete"):
    ACTION_PAGE_MAP[_a] = "transfer"
for _a in ("sync_conflict_list", "sync_conflict_resolve", "sync_conflict_delete"):
    ACTION_PAGE_MAP[_a] = "transfer"
for _a in ("license_get", "license_install", "license_remove"):
    ACTION_PAGE_MAP[_a] = "license"
for _a in ("db_user_list", "db_user_create", "db_user_update", "db_user_delete",
           "db_change_password", "db_user_perms_get", "db_user_perms_set"):
    ACTION_PAGE_MAP[_a] = "users"


# ---------------------------------------------------------------------------
# Route maps
# ---------------------------------------------------------------------------

ROUTE_NO_TASK = {
    "test_conn": handle_test_conn,
    "scan_storage": handle_scan_storage,
    "scan_pve": handle_scan_pve,
    "scan_disks": handle_scan_disks,
    "scan_local": handle_scan_local,
    "list_dir": handle_list_dir,
    "list_remote_dir": handle_list_remote_dir,
    "remote_desk_ping": handle_remote_desk_ping,    # v5.20.2
    "remote_diag": handle_remote_diag,              # v5.98.17
    "zerotrust": handle_zerotrust,                  # v5.20.0
    "e2ee": handle_e2ee,                            # v5.22.0 · G6
    "truenas_api": handle_truenas_api,              # v5.20.0
    "deps_scan": handle_deps_scan,                  # v5.20.0
    "remote_os_detect": handle_remote_os_detect,  # v5.20.0
    "pve_console_ready": handle_pve_console_ready,  # v5.20.0
    "pve_console_url": handle_pve_console_url,      # v5.20.0
    "remote_disks": handle_remote_disks,          # v5.20.0
    "check_sync_tools": handle_check_sync_tools,  # v4.38.23
    "install_local_tools": handle_install_local_tools,  # v4.38.24 · 本机一键安装（白名单+sudo+二次确认）
    "mkdir": handle_mkdir,
    "mkdir_remote": handle_mkdir_remote,
    "scan_archives": handle_scan_archives,
    "get_logs": handle_get_logs,
    "clear_logs": handle_clear_logs,
    # v4.48.0 P5 · storage(lvm/zfs/pbs/rbd)/disk/flows/remotes/docker 条目
    #   移至 ROUTE_NO_TASK 之后的条件注册块 (pro 包剔除后不注册)
    "check_rsync_plugins": handle_check_rsync_plugins,
    "install_rsync_plugin": handle_install_rsync_plugin,
    "terminal_input": handle_terminal_input,
    "terminal_resize": handle_terminal_resize,
    "terminal_close": handle_terminal_close,
    "terminal_attach": handle_terminal_attach,
    # Database CRUD
    "db_task_list": handle_db_task_list,
    "task_log_tail": handle_task_log_tail,
    "task_log_subscribe": handle_task_log_subscribe,
    "task_log_unsubscribe": handle_task_log_unsubscribe,
    "db_log_list": handle_db_log_list,
    "db_backup_list": handle_db_backup_list,
    "backup_verify": handle_backup_verify,
    "backup_verify_batch": handle_backup_verify_batch,
    "backup_verify_stats": handle_backup_verify_stats,
    # User auth
    "db_user_login": handle_db_user_login,
    "client_info_get": handle_client_info_get,
    "db_user_list": handle_db_user_list,
    "db_user_create": handle_db_user_create,
    "db_user_update": handle_db_user_update,
    "db_user_delete": handle_db_user_delete,
    "db_change_password": handle_db_change_password,
    "db_user_perms_get": handle_db_user_perms_get,
    "db_user_perms_set": handle_db_user_perms_set,
    # v2.9.0: 定时计划
    "schedule_list":    handle_schedule_list,
    "schedule_create":  handle_schedule_create,
    "schedule_update":  handle_schedule_update,
    "schedule_delete":  handle_schedule_delete,
    "schedule_run_now": handle_schedule_run_now,
    "schedule_runs":    handle_schedule_runs,
    "schedule_timeline":handle_schedule_timeline,
    "schedule_cron_preview": handle_schedule_cron_preview,  # v4.47.0 P2
    # v4.12.0
    "retention_get":     handle_retention_get,
    "retention_set":     handle_retention_set,
    "retention_preview": handle_retention_preview,
    "retention_apply":   handle_retention_apply,
    "retention_runs":    handle_retention_runs,
    "retention_stats":   handle_retention_stats,
    "dashboard_devices": handle_dashboard_devices,   # v5.98.25
    "server_hw_scan": handle_server_hw_scan,         # v5.98.26
    "dashboard_overview": handle_dashboard_overview,
    "dashboard_timeline": handle_dashboard_timeline,
    "dashboard_hourly": handle_dashboard_hourly,
    "graph_integrity": handle_graph_integrity,
    # v4.48.0 P5 · flow_* 条目移至条件注册块
    # v4.16.0 · 事件订阅
    "subscribe":       handle_subscribe,
    "unsubscribe":     handle_unsubscribe,
    "event_debug":     handle_event_debug,
    "event_log_recent": handle_event_log_recent,
    "event_log_query": handle_event_log_query,
    "event_log_fts_search": handle_event_log_fts_search,
    "alert_rules_get": handle_alert_rules_get,
    "alert_rules_set": handle_alert_rules_set,
    "alert_test": handle_alert_test,
    "alert_test_email": handle_alert_test_email,
    "alert_history_query": handle_alert_history_query,
    "alert_history_purge": handle_alert_history_purge,
    "alert_history_stats": handle_alert_history_stats,
    "alert_rules_export": handle_alert_rules_export,
    "alert_rules_import": handle_alert_rules_import,
    "system_stats": handle_system_stats,
    "license_get": handle_license_get,
    "license_install": handle_license_install,
    "license_remove": handle_license_remove,
    "ui_prefs_get":      handle_ui_prefs_get,
    "ui_prefs_set":      handle_ui_prefs_set,
    "setting_get":       handle_setting_get,
    "setting_set":       handle_setting_set,
    "setting_delete":    handle_setting_delete,
    "web_port_get":      handle_web_port_get,
    "web_port_set":      handle_web_port_set,
    # v4.50.0 · 传输引擎
    "transfer_engine_get": handle_transfer_engine_get,
    "preview_mode_get":  handle_preview_mode_get,
    "sysconf_export":      handle_sysconf_export,
    "sysconf_preview":     handle_sysconf_preview,
    "sysconf_import":      handle_sysconf_import,
    "sysdb_backup":        handle_sysdb_backup,
    "sysdb_list":          handle_sysdb_list,
    "sysdb_restore":       handle_sysdb_restore,
    # v5.31.1 · docker compose 配置备份
    "docker_compose_scan":   handle_docker_compose_scan,
    "docker_compose_backup": handle_docker_compose_backup,
    "remote_prune_scan":   handle_remote_prune_scan,
    "remote_prune_apply":  handle_remote_prune_apply,
    "run_trace":           handle_run_trace,
    "vitals_commands":     handle_vitals_commands,
    "trace_tree":          handle_trace_tree,
    "punch_create":        handle_punch_create,
    "punch_register":      handle_punch_register,
    "punch_attempt":       handle_punch_attempt,
    "punch_attempt_quic":  handle_punch_attempt_quic,
    "punch_list":          handle_punch_list,
    "punch_cancel":        handle_punch_cancel,
    "punch_fallback":      handle_punch_fallback,
    "vitals_engines":      handle_vitals_engines,
    "vitals_security":     handle_vitals_security,
    "vitals_plugins":      handle_vitals_plugins,
    "vitals_overview":     handle_vitals_overview,
    "vitals_endpoints":    handle_vitals_endpoints,
    "vitals_host":         handle_vitals_host,
    "vitals_resilience":   handle_vitals_resilience,
    "vitals_kill_stalled": handle_vitals_kill_stalled,
    "service_status":    handle_service_status,
    "service_restart":   handle_service_restart,
    "preview_mode_set":  handle_preview_mode_set,
    "transfer_engine_set": handle_transfer_engine_set,
    "rclone_check":   handle_rclone_check,
    "rclone_install": handle_rclone_install,
    "dbbackup_run":   handle_dbbackup_run,
    "dbbackup_check": handle_dbbackup_check,
    "dbbackup_list":  handle_dbbackup_list,
    "dbbackup_scan_databases": handle_dbbackup_scan_databases,
    "ai_config_get":  handle_ai_config_get,
    "ai_config_set":  handle_ai_config_set,
    "ai_chat":        handle_ai_chat,
    "ai_execute":     handle_ai_execute,
    "ai_draft_issue": handle_ai_draft_issue,     # v5.57.0 D1 沙盒草稿令牌
    "ai_intent_list": handle_ai_intent_list,     # v5.57.0 D3 意图审计
    "etcd_snapshot":  handle_etcd_snapshot,
    "docker_backup":  handle_docker_backup,
    "pv_backup":      handle_pv_backup,
    "backup_verify_sha256": handle_backup_verify_sha256,
    "file_read":    handle_file_read,
    "file_write":   handle_file_write,
    "file_delete":  handle_file_delete,
    "file_rename":  handle_file_rename,
    "file_mkdir":   handle_file_mkdir,
    "file_mkfile":  handle_file_mkfile,
    "file_chmod":   handle_file_chmod,
    "file_compress": handle_file_compress,
    "file_extract": handle_file_extract,
    "file_stat":    handle_file_stat,
    "file_exif":    handle_file_exif,
    "file_read_raw": handle_file_read_raw,
    "file_archive_list": handle_file_archive_list,
    # v4.59.0 · 实时同步守护
    "watch_rule_list":   handle_watch_rule_list,
    "watch_rule_save":   handle_watch_rule_save,
    "watch_rule_delete": handle_watch_rule_delete,
    "watch_rule_toggle": handle_watch_rule_toggle,
    "watch_status":      handle_watch_status,
    "watch_events":      handle_watch_events,
    "watch_test_run":    handle_watch_test_run,
    "qos_get":      handle_qos_get,
    "qos_set":      handle_qos_set,
    "file_stream_token": handle_file_stream_token,
    "file_read_range": handle_file_read_range,
    "file_remote_stream_token": handle_file_remote_stream_token,
    "file_tail":    handle_file_tail,
    "file_archive_extract_one": handle_file_archive_extract_one,
    "archive_tools_check": handle_archive_tools_check,
    "archive_formats": handle_archive_formats,
    "file_copy":    handle_file_copy,
    "dir_size":     handle_dir_size,
    "file_checksum": handle_file_checksum,
    "file_write_b64": handle_file_write_b64,
    "restic_check":     handle_restic_check,
    "restic_init":      handle_restic_init,
    "restic_backup":    handle_restic_backup,
    "restic_snapshots": handle_restic_snapshots,
    "restic_ls":        handle_restic_ls,
    "restic_restore":   handle_restic_restore,
    "restic_forget":    handle_restic_forget,
    "restic_stats":     handle_restic_stats,
    "docker_volumes":       handle_docker_volumes,
    "docker_image_backup":    handle_docker_image_backup,
    "docker_container_backup": handle_docker_container_backup,
    "docker_images_backup_all": handle_docker_images_backup_all,
    "docker_volume_backup": handle_docker_volume_backup,
    "docker_networks":      handle_docker_networks,
    "docker_stats":         handle_docker_stats,
    "docker_prune":         handle_docker_prune,
    "docker_exec_cmd":      handle_docker_exec_cmd,
    "dbb_check":    handle_dbb_check,
    "dbb_scan":     handle_dbb_scan,
    "dbb_backup":   handle_dbb_backup,
    "dbb_list":     handle_dbb_list,
    "dbb_verify":   handle_dbb_verify,
    "dbb_restore":  handle_dbb_restore,
    "dbb_delete":   handle_dbb_delete,
    "dbb_drill":    handle_dbb_drill,
    "worm_config":       handle_worm_config,
    "worm_apply":        handle_worm_apply,
    "worm_release":      handle_worm_release,
    "worm_status":       handle_worm_status,
    "drill_run":         handle_drill_run,
    "drill_history":     handle_drill_history,
    "engine_analyze":    handle_engine_analyze,
    "ransomware_scan":   handle_ransomware_scan,
    "ransomware_config": handle_ransomware_config,
    "distro_detect":     handle_distro_detect,
    "distro_tools":      handle_distro_tools,
    "ldap_config":       handle_ldap_config,
    "ldap_test":         handle_ldap_test,
    "namespace_list":    handle_namespace_list,
    "namespace_create":  handle_namespace_create,
    "namespace_delete":  handle_namespace_delete,
    "siem_config":       handle_siem_config,
    "siem_test":         handle_siem_test,
    "upgrade_check":     handle_upgrade_check,
    "upgrade_run":       handle_upgrade_run,
    "upgrade_servers_get": handle_upgrade_servers_get,   # v5.50.0
    "upgrade_servers_set": handle_upgrade_servers_set,
    "hub_nodes":         handle_hub_nodes,               # v5.50.0 · 统一资源目录
    "events_replay":     handle_events_replay,           # v5.50.0 · 事件补拉
    "events_stats":      handle_events_stats,
    "upgrade_self":      handle_upgrade_self,
    "g2_crypt_create":   handle_g2_crypt_create,
    "g2_crypt_list":     handle_g2_crypt_list,
    "g2_crypt_test":     handle_g2_crypt_test,
    "g2_crypt_delete":   handle_g2_crypt_delete,
    "truenas_ctl":       handle_truenas_ctl,
    "pve_save_config":   handle_pve_save_config,
    "pve_servers":       handle_pve_servers,      # v5.31.5 · 多服务器列表
    "pve_console":       handle_pve_console,      # v5.31.5 · 控制台 ticket
    # v5.32.0 · 连接中心 (异步短任务)
    "conn_close":        handle_conn_close,
    "conn_list":         handle_conn_list,
    "conn_renew":        handle_conn_renew,
    "sp_list":           handle_sp_list,           # v5.33.0 · 服务器档案
    "sp_get":            handle_sp_get,
    "sp_save":           handle_sp_save,
    "sp_del":            handle_sp_del,
    "sp_get_by_host":    handle_sp_get_by_host,
    "sp_batch":          handle_sp_batch,          # v5.34.1 · 批量 star/move/delete/tag
    "sg_list":           handle_sg_list,           # v5.34.1 · 分组树
    "sg_save":           handle_sg_save,
    "sg_del":            handle_sg_del,
    "sg_reorder":        handle_sg_reorder,
    "audit_query":       handle_audit_query,       # v5.34.1 · 连接审计查询
    "sp_import":         handle_sp_import,         # v5.34.2 · P2 导入
    "sp_export":         handle_sp_export,         # v5.34.2 · P2 导出
    "sp_resolve":        handle_sp_resolve,        # v5.34.3 · P3 跨页凭据解析
    "cred_list":         handle_cred_list,          # v5.34.6 · P6 保险库
    "cred_save":         handle_cred_save,
    "cred_del":          handle_cred_del,
    "sp_wol":            handle_sp_wol,             # v5.34.6 · P6 魔术包唤醒
    "sp_import":         handle_sp_import,         # v5.34.2 · P2 导入
    "sp_export":         handle_sp_export,         # v5.34.2 · P2 导出
    "sec_check":         handle_sec_check,       # v5.28.5
    # v5.29.0 · HTTPS/SSL 证书管理
    "https_get":         handle_https_get,
    "https_set":         handle_https_set,
    "https_issue":       handle_https_issue,
    "https_upload":      handle_https_upload,
    "sec_ports":         handle_sec_ports,       # v5.28.5  # v5.28.0
    "zt_mtls":           handle_zt_mtls_status,
    "guacd_status":      handle_guacd_action,   # v5.25.0 · 状态/部署/保存
    "guac_ticket_create": handle_guac_ticket_create,  # v6.16.2 批23 · 一次性控制台工单(凭据不经URL)
    "g2_crypt_update":   handle_g2_crypt_update,
    "g3_s3_lifecycle":   handle_g3_s3_lifecycle,
    "g3_object_lock":    handle_g3_object_lock,
    "g5_serve_start":    handle_g5_serve_start,
    "serve_protos":      handle_g5_serve_protos,   # v5.20.0
    "g5_serve_stop":     handle_g5_serve_stop,
    "g5_serve_status":   handle_g5_serve_status,
    "rclone_component_status": handle_rclone_component_status,   # v6.12.0 · 批12
    "rclone_upgrade_start": handle_rclone_upgrade_start,
    "rclone_upgrade_status": handle_rclone_upgrade_status,
    "mfa_setup":         handle_mfa_setup,
    "mfa_verify":        handle_mfa_verify,
    "ferry_export":      handle_ferry_export,
    "ferry_import":      handle_ferry_import,
    "ferry_list":        handle_ferry_list,
    "ferry_pubkey":      handle_ferry_pubkey,
    "ferry_trust":       handle_ferry_trust,
    "quota_config":      handle_quota_config,
    "quota_usage":       handle_quota_usage,
    "mfa_status":        handle_mfa_status,
    "pve_api_test":     handle_pve_api_test,
    "pve_api_nodes":    handle_pve_api_nodes,
    "pve_api_vms":      handle_pve_api_vms,
    "pve_api_storages": handle_pve_api_storages,
    "pve_api_snapshots": handle_pve_api_snapshots,
    "pve_api_snapshot_create": handle_pve_api_snapshot_create,
    "pve_api_snapshot_rollback": handle_pve_api_snapshot_rollback,
    "pve_api_cluster":  handle_pve_api_cluster,
    "pve_api_migrate":  handle_pve_api_migrate,
    "pve_api_vm_op":    handle_pve_api_vm_op,
    "storage_policy_detect": handle_storage_policy_detect,
    "croc_check":        handle_croc_check,
    "croc_send":         handle_croc_send,
    "croc_receive":      handle_croc_receive,
    "croc_stop":         handle_croc_stop,
    "croc_status":       handle_croc_status,
    "stats_replay":      handle_stats_replay,
    "ui_lang_set":  handle_ui_lang_set,
    "ui_lang_get":  handle_ui_lang_get,
    "stats_overview":  handle_stats_overview,
    "stats_baseline":  handle_stats_baseline,
    "stats_recommend": handle_stats_recommend,
    "dup_scan":     handle_dup_scan,
    "dup_delete":   handle_dup_delete,
    "sync_conflict_list":   handle_sync_conflict_list,
    "sync_conflict_resolve": handle_sync_conflict_resolve,
    "sync_conflict_delete":  handle_sync_conflict_delete,
    # v4.0.0-alpha1: 平台适配
    "platform_list":   handle_platform_list,
    "platform_detect": handle_platform_detect,
    "platform_plan_backup": handle_platform_plan_backup,
    "platform_execute_backup": handle_platform_execute_backup,
    "platform_backup_history": handle_platform_backup_history,
    # v4.48.0 P5 · remote_* 条目移至条件注册块
    # v4.40.2 P2 · 传输审计
    "transfer_audit":        handle_transfer_audit,
    # v4.39.0 Phase 2a · 网络共享
    "target_test":        handle_target_test,
    "share_save":         handle_share_save,
    "share_delete":       handle_share_delete,
    "share_mount":        handle_share_mount,
    "share_umount":       handle_share_umount,
    "share_test":         handle_share_test,
    "share_plugin_check": handle_share_plugin_check,
}

# 长任务路由 (基础条目; storage 企业条目已在上方条件 update)
# v6.16.14 · 会话录制路由(旗舰档; handler 被剪时不注册)
if handle_vnc_rec_list:
    ROUTE_NO_TASK.update({
        "vnc_rec_list":      handle_vnc_rec_list,
        "vnc_rec_delete":    handle_vnc_rec_delete,
        # v6.16.14 · 迁入的录制管理三动作同闸同剪
        "recording_list":    handle_recording_list,
        "recording_convert": handle_recording_convert,
        "recording_delete":  handle_recording_delete,
    })

ROUTE_TASK = {
    "fonr_index_scan": handle_fonr_index_scan,            # v5.54.0 · P3-16 索引扫描(长任务)
    # v5.62.0 · E3 传输引擎(长耗时: 真实传输, 进度走事件总线 xfer.<engine>.*)
    "xfer_zstd_push":  handle_xfer_zstd_push,
    "xfer_mc_mirror":  handle_xfer_mc_mirror,
    # v5.63.0 · E3-3/4/5 跨网引擎(长耗时: QUIC 传输 / iroh 出票与收件)
    "xfer_quic_send":     handle_xfer_quic_send,
    "xfer_iroh_ticket":   handle_xfer_iroh_ticket,
    "xfer_iroh_receive":  handle_xfer_iroh_receive,
    # v5.20.0 · deps_install 必须异步派发: 装依赖可能数分钟, 串行 await 会把整条
    #   WS 连接占住, 同连接上的扫描/其它请求全部排队 → 前端 30s 超时 (实测踩过)
    "deps_install": handle_deps_install,
    "rsync": handle_rsync,
    "vzdump": handle_vzdump,                    # vzdump.py 保留 (含通用 kill/logs)
    "download_archives": handle_download_archives,
    "pve_backup": handle_pve_backup,
    "pve_restore": handle_pve_restore,
    "auto_backup": handle_auto_backup,
    "batch_backup": handle_batch_backup,
    "auto_restore_detect": handle_auto_restore_detect,
    "auto_restore_compare": handle_auto_restore_compare,
    "auto_restore": handle_auto_restore,
    "auto_restore_browse": handle_auto_restore_browse,
    "auto_restore_item": handle_auto_restore_item,
    "terminal_open": handle_terminal_open,
    "kill": handle_kill,
    # v5.89.0 · 容器/镜像导入: 镜像归档常见 GB 级、耗时数分钟 → 必须异步派发
    #   (与 docker_*_backup 同性质; 串行 await 会占住整条 WS, 进度/其它请求全部排队)
    "docker_import": handle_docker_import,
    "key_cache_fetch": handle_key_cache_fetch,
    "key_cache_put": handle_key_cache_put,
    "key_cache_list": handle_key_cache_list,
    "key_cache_clear": handle_key_cache_clear,
    # v5.90.2 · 队头阻塞治理: 以下动作实测可跑数秒~数十秒 (8030 日志聚合: 列出共享配置
    #   12.5s / 真实挂载点列表 11.4s / 登录自动重新挂载 12.2s / vitals 10.9s / sp_probe 24s),
    #   原先都在 ROUTE_NO_TASK 里被 `await` 串行执行 —— 执行期间同一条 WS 上的其它请求
    #   (点连接/断开/列表刷新) 全部排队, 前端表现为"点了没反应"、列表慢、会话被拖断。
    #   与 v4.46.0 P0-4 同一治理: 统一 create_task 异步派发。
    "share_list":         handle_share_list,
    # v6.2.0 · 在线更新(检查走网络, 也异步派发避免堵 WS)
    "update_check":       handle_update_check,
    "update_apply":       handle_update_apply,
    "update_status":      handle_update_status,
    "mounts_list":        handle_mounts_list,
    "share_auto_remount": handle_share_auto_remount,
    "vitals_selfcheck":   handle_vitals_selfcheck,
    "sp_probe":           handle_sp_probe,
    "conn_open":          handle_conn_open,
}

# v4.48.0 P5 · 企业专属模块条件注册 (pro 包剔除文件后这些块整体跳过)
# storage (lvm/zfs/pbs/rbd)
if handle_test_lvm:
    ROUTE_NO_TASK.update({
        "test_lvm": handle_test_lvm,
        "scan_lvm": handle_scan_lvm,
        "check_lvm_plugins": handle_check_lvm_plugins,
        "install_lvm_plugin": handle_install_lvm_plugin,
        "test_pbs": handle_test_pbs,
        "scan_pbs": handle_scan_pbs,
        "scan_pbs_detail": handle_scan_pbs_detail,
        "test_zfs": handle_test_zfs,
        "scan_zfs": handle_scan_zfs,
        "scan_zfs_disks": handle_scan_zfs_disks,
        "zfs_browse_files": handle_zfs_browse_files,
        "check_zfs_plugins": handle_check_zfs_plugins,
        "install_zfs_plugin": handle_install_zfs_plugin,
        "check_rbd_plugins": handle_check_rbd_plugins,
        "install_rbd_plugin": handle_install_rbd_plugin,
        "test_rbd": handle_test_rbd,
        "scan_rbd": handle_scan_rbd,
    })
    ROUTE_TASK.update({
        "export_lvm": handle_export_lvm,
        "restore_pbs": handle_restore_pbs,
        "export_zfs": handle_export_zfs,
        "zfs_download_file": handle_zfs_download_file,
        "zfs_upload_file": handle_zfs_upload_file,
        "export_rbd": handle_export_rbd,
    })
# disk
if handle_disk_scan:
    ROUTE_NO_TASK.update({
        "vdisk_health": handle_vdisk_health,                    # v5.98.22
    "vdisk_extend_plan": handle_vdisk_extend_plan,
    "vdisk_extend_apply": handle_vdisk_extend_apply,
    "vdisk_scrub": handle_vdisk_scrub,
    "vshare_status": handle_vshare_status,                  # v5.98.20
    "vshare_entry_set": handle_vshare_entry_set,            # v6.4.0 · 批3
    "vshare_entry_disable": handle_vshare_entry_disable,
    "vshare_entry_enable": handle_vshare_entry_enable,
    "vshare_entry_delete": handle_vshare_entry_delete,
    "vshare_dlna_install": handle_vshare_dlna_install,     # v6.6.0 · DLNA 补完(现为兼容包装)
    "vshare_svc_install": handle_vshare_svc_install,       # v6.7.0 · 批7: 通用一键安装
    "vshare_svc_install_status": handle_vshare_svc_install_status,
    "vshare_smb_users": handle_vshare_smb_users,
    "vshare_smb_user_create": handle_vshare_smb_user_create,
    "vshare_smb_user_passwd": handle_vshare_smb_user_passwd,
    "vshare_smb_user_delete": handle_vshare_smb_user_delete,
    "share_mgr_list": handle_share_mgr_list,
    "share_mgr_stats": handle_share_mgr_stats,
    "share_http_list": handle_share_http_list,        # v6.5.0 · 批6
    "share_http_save": handle_share_http_save,
    "share_http_update": handle_share_http_update,
    "share_http_regen": handle_share_http_regen,
    "share_http_delete": handle_share_http_delete,
    "share_http_visitors": handle_share_http_visitors,
    "share_svc_status": handle_share_svc_status,
    "share_svc_ctl": handle_share_svc_ctl,
    "share_clients": handle_share_clients,          # v6.10.0 · 批10 活跃客户端
    "share_fs_perm_get": handle_share_fs_perm_get,
    "share_fs_perm_set": handle_share_fs_perm_set,
    "vshare_plan": handle_vshare_plan,
    "vshare_apply": handle_vshare_apply,
    "vshare_undo": handle_vshare_undo,
    "vshare_mount_plan": handle_vshare_mount_plan,          # v5.98.23
    "vshare_mount_apply": handle_vshare_mount_apply,
    "vshare_mount_status": handle_vshare_mount_status,
    "vshare_mount_stop": handle_vshare_mount_stop,
    "vdisk_storages": handle_vdisk_storages,                # v5.98.19
    "vdisk_ls": handle_vdisk_ls,
    "vdisk_plan": handle_vdisk_plan,
    "vdisk_op": handle_vdisk_op,
    "vdisk_place": handle_vdisk_place,
    "disk_image_targets": handle_disk_image_targets,        # v5.98.18
    "disk_image_create": handle_disk_image_create,
    "disk_image_list": handle_disk_image_list,
    "disk_image_verify": handle_disk_image_verify,
    "disk_image_restore": handle_disk_image_restore,
    "disk_image_delete": handle_disk_image_delete,
    "disk_image_tools": handle_disk_image_tools,
    "disk_image_dd_transfer": handle_disk_image_dd_transfer,   # v5.98.21 · 块级传输引擎
    "disk_scan": handle_disk_scan,
        "disk_plugin_check": handle_disk_plugin_check,
        "disk_mount_ro": handle_disk_mount_ro,
        "disk_unmount": handle_disk_unmount,
        "disk_df": handle_disk_df,
        "disk_plugin_install": handle_disk_plugin_install,
        "disk_rm": handle_disk_rm,
        "disk_mv": handle_disk_mv,
        "disk_cp": handle_disk_cp,
        "disk_remount_rw": handle_disk_remount_rw,
        "disk_luks_open":  handle_disk_luks_open,
        "disk_luks_close": handle_disk_luks_close,
        "disk_zfs_import": handle_disk_zfs_import,
        "disk_zfs_export": handle_disk_zfs_export,
        "disk_list_dir":   handle_disk_list_dir,
        "disk_ns_op":      handle_disk_ns_op,
    })
# cloudpool (v5.99.2 · CloudPool V2 智能存储池; enterprise)
if handle_cpool_list:
    ROUTE_NO_TASK.update({
        "cpool_list": handle_cpool_list,
        "cpool_create": handle_cpool_create,
        "cpool_delete": handle_cpool_delete,
        "cpool_members": handle_cpool_members,
        "cpool_volume_create": handle_cpool_volume_create,
        "cpool_volume_update": handle_cpool_volume_update,
        "cpool_volume_delete": handle_cpool_volume_delete,
        "cpool_capacity": handle_cpool_capacity,
        "cpool_policy_list": handle_cpool_policy_list,        # v6.3.0 · §29
        "cpool_policy_create": handle_cpool_policy_create,
        "cpool_policy_update": handle_cpool_policy_update,
        "cpool_policy_delete": handle_cpool_policy_delete,
        "cpool_policy_resolve": handle_cpool_policy_resolve,
        "cpool_member_remove": handle_cpool_member_remove,
        "cpool_view_unified": handle_cpool_view_unified,
        "cpool_view_devices": handle_cpool_view_devices,
        "cpool_view_recovery": handle_cpool_view_recovery,
        "cpool_bench_status": handle_cpool_bench_status,      # v5.99.3 · M3
        "cpool_perf_summary": handle_cpool_perf_summary,      # v5.99.3 · M3
        "cpool_place": handle_cpool_place,                    # v5.99.4 · M4
        "cpool_read_route": handle_cpool_read_route,          # v5.99.4 · M4
        "cpool_placement_history": handle_cpool_placement_history,  # v5.99.4 · M4
    })
    if handle_cpool_managed_write:   # v5.99.5 · M5(数据面长任务)
        ROUTE_TASK.update({
            "cpool_managed_write": handle_cpool_managed_write,
            "cpool_materialize": handle_cpool_materialize,
            "cpool_managed_recover": handle_cpool_managed_recover,
        })
    if handle_cpool_policy_write:    # v6.3.0 · §29(按策略写入 = 数据面长任务)
        ROUTE_TASK.update({"cpool_policy_write": handle_cpool_policy_write})
    if handle_cpool_protected_write:   # v5.99.6 · M6(受保护写/修复)
        ROUTE_TASK.update({
            "cpool_protected_write": handle_cpool_protected_write,
            "cpool_replica_repair": handle_cpool_replica_repair,
        })
        ROUTE_NO_TASK.update({
            "cpool_replica_check": handle_cpool_replica_check,
            "cpool_conflict_resolve": handle_cpool_conflict_resolve,
            "cpool_conflict_list": handle_cpool_conflict_list,   # v6.2.2 · P6 冲突中心
        })
    if handle_cpool_ec_write:   # v5.99.7 · M7(EC 写/重建)
        ROUTE_TASK.update({
            "cpool_ec_write": handle_cpool_ec_write,
            "cpool_ec_rebuild": handle_cpool_ec_rebuild,
        })
    if handle_cpool_cache_purge:   # v5.99.8 · M8(缓存/分层/Autopilot)
        ROUTE_NO_TASK.update({
            "cpool_cache_purge": handle_cpool_cache_purge,
            "cpool_cache_stats": handle_cpool_cache_stats,
            "cpool_read_cached": handle_cpool_read_cached,
            "cpool_job_pause": handle_cpool_job_pause,
            "cpool_job_resume": handle_cpool_job_resume,
            "cpool_autopilot_eval": handle_cpool_autopilot_eval,
        })
        ROUTE_TASK.update({
            "cpool_tier_move": handle_cpool_tier_move,
        })
    if handle_cpool_gateway_plan:   # v5.99.9 · M9(网关导出/卸载)
        ROUTE_NO_TASK.update({
            "cpool_gateway_plan": handle_cpool_gateway_plan,
            "cpool_gateway_revoke": handle_cpool_gateway_revoke,
            "cpool_detach_plan": handle_cpool_detach_plan,
        })
        ROUTE_TASK.update({
            "cpool_gateway_apply": handle_cpool_gateway_apply,
            "cpool_detach": handle_cpool_detach,
        })
    if handle_cpool_trash_list:   # v6.0.0 · M10(管理/恢复/审计)
        ROUTE_NO_TASK.update({
            "cpool_trash_list": handle_cpool_trash_list,
            "cpool_trash_restore": handle_cpool_trash_restore,
            "cpool_trash_purge": handle_cpool_trash_purge,
            "cpool_snapshot_create": handle_cpool_snapshot_create,
            "cpool_snapshot_list": handle_cpool_snapshot_list,
            "cpool_health_center": handle_cpool_health_center,
            "cpool_forecast": handle_cpool_forecast,
            "cpool_drill_history": handle_cpool_drill_history,
        })
        ROUTE_TASK.update({
            "cpool_drill_run": handle_cpool_drill_run,
        })
    ROUTE_TASK.update({   # 网络/扫描类长任务: 异步派发, 不阻塞 WS 心拍
        "cpool_member_add": handle_cpool_member_add,
        "cpool_member_probe": handle_cpool_member_probe,
        "cpool_member_candidates": handle_cpool_member_candidates,   # v6.0.1 · 候选发现+性能画像+推荐排名
        "cpool_member_cand_bench": handle_cpool_member_cand_bench,   # v6.0.2 · 候选读写基准(写前确认, 测完删除核验)
        "cpool_member_mount_candidate": handle_cpool_member_mount_candidate,   # v6.0.3 · 候选块设备挂载为成员(需确认)
        "cpool_member_persist": handle_cpool_member_persist,   # v6.0.4 · 挂载持久化(fstab 标记块/校验/回滚)
        "cpool_member_scan": handle_cpool_member_scan,
        "cpool_storage_pool_hint": handle_cpool_storage_pool_hint,
        "cpool_probe_perf": handle_cpool_probe_perf,          # v5.99.3 · M3
        "cpool_bench_start": handle_cpool_bench_start,        # v5.99.3 · M3
    })
# flows
if handle_flow_list:
    ROUTE_NO_TASK.update({
        "flow_list":       handle_flow_list,
        "flow_create":     handle_flow_create,
        "flow_update":     handle_flow_update,
        "flow_delete":     handle_flow_delete,
        "flow_abort":      handle_flow_abort,
        "flow_pause":      handle_flow_pause,
        "flow_resume":     handle_flow_resume,
        "flow_running_list": handle_flow_running_list,
        "flow_duplicate":  handle_flow_duplicate,
        "flow_run_now":    handle_flow_run_now,
        "flow_runs":       handle_flow_runs,
        "flow_run_stats":  handle_flow_run_stats,
    })
# remotes (cloud)
if handle_remote_list:
    ROUTE_NO_TASK.update({
        "remote_providers":      handle_remote_providers,
        "remote_list":           handle_remote_list,
        "remote_ls":             handle_remote_ls,
        "remote_download":       handle_remote_download,
        "remote_upload_dir":     handle_remote_upload_dir,
        "remote_download_dir":   handle_remote_download_dir,
        "remote_create":         handle_remote_create,
        "remote_update":         handle_remote_update,
        "remote_delete":         handle_remote_delete,
        "remote_test":           handle_remote_test,
        "remote_upload":         handle_remote_upload,
        "relay_transfer":        handle_relay_transfer,
        "relay_status":          handle_relay_status,
        "remote_read_raw":       handle_remote_read_raw,
        "remote_upload_history": handle_remote_upload_history,
        "remote_upload_clear":   handle_remote_upload_clear,
    })
# docker
if handle_docker_scan:
    ROUTE_NO_TASK.update({
        "docker_scan":   handle_docker_scan,
        "docker_images": handle_docker_images,
        "docker_action": handle_docker_action,
        "docker_logs":   handle_docker_logs,
        "docker_check":  handle_docker_check,
        "docker_install": handle_docker_install,
    })



# fonrvfs (v5.40.0 · 多云文件管理 新主菜单)
if handle_fonr_storages:
    ROUTE_NO_TASK.update({
        # v5.98.0 · 「列表/存列表拉不出来、点了没反应」治理(与 v5.90.2 同一手法):
        #   `fonr_storages`(要构建全部适配器, 实测首次 ~1s, 挂了 SSH/云时更久)与
        #   `fonr_list`(大目录实测 /tmp 1.6 万项、云端还要走网络)原在 NO_TASK 里被 `await` 串行执行,
        #   执行期间同一条 WS 上的其它请求全部排队 —— 浏览器实测: fonr_storages 未回来时,
        #   紧随其后的 fonr_settings_get/fonr_list 也拿不到响应(整个面板"没反应")。
        #   改用 create_task 异步派发(响应按 req_id 匹配, 前后端都已支持乱序)。
        "fonr_caps":           handle_fonr_caps,
        "fonr_stat":           handle_fonr_stat,
        "fonr_preview_meta":   handle_fonr_preview_meta,
        "fonr_read_text":      handle_fonr_read_text,
        "fonr_read_hex":       handle_fonr_read_hex,
        "fonr_mkdir":          handle_fonr_mkdir,
        "fonr_mkfile":         handle_fonr_mkfile,
        "fonr_attrs":          handle_fonr_attrs,
        "fonr_delete":         handle_fonr_delete,
        "fonr_rename":         handle_fonr_rename,
        "fonr_upload_sessions": handle_fonr_upload_sessions,
        "fonr_job_list":       handle_fonr_job_list,
        "fonr_job_cancel":     handle_fonr_job_cancel,
        "fonr_job_pause":      handle_fonr_job_pause,      # v6.8.0 · 批8 任务管理
        "fonr_job_resume":     handle_fonr_job_resume,
        "fonr_job_delete":     handle_fonr_job_delete,
        "fonr_job_clear":      handle_fonr_job_clear,
        "fonr_fav_list":       handle_fonr_fav_list,
        "fonr_fav_save":       handle_fonr_fav_save,
        "fonr_fav_delete":     handle_fonr_fav_delete,
        "fonr_tools_check":    handle_fonr_tools_check,
        # v5.41.0 P1
        "fonr_stream_token":   handle_fonr_stream_token,
        "fonr_recent_touch":   handle_fonr_recent_touch,
        "fonr_recent_list":    handle_fonr_recent_list,
        # v6.3.33 · FIX(全面审计): `handle_fonr_recent_delete` 早已实现且在功能表里(见 v5.41.0 段的
        #   ACTION_FEATURE_MAP), 但**漏挂到派发表** → 前端 `_send('fonr_recent_delete')`(自带云的
        #   "从最近访问删除")永远等不到回包(实测: 直连 WS 发该动作 0 回包)。审计工具因此把它标为
        #   "前端会发、后端未注册"。同类漏接线的风险: handler 与派发表是两处维护, 必须成对。
        "fonr_recent_delete":  handle_fonr_recent_delete,
        "fonr_recent_clear":   handle_fonr_recent_clear,
        # v5.43.0 P2
        "fonr_trash_list":     handle_fonr_trash_list,
        "fonr_settings_get":   handle_fonr_settings_get,
        "fonr_settings_set":   handle_fonr_settings_set,
        # v5.45.0 P2 剩余 (查询类, 秒回)
        "fonr_versions_list":  handle_fonr_versions_list,
        "fonr_audit_list":     handle_fonr_audit_list,
        "fonr_audit_export":   handle_fonr_audit_export,
        "fonr_audit_purge":    handle_fonr_audit_purge,
        # v5.47.0 P3 治理 (查询/设置类, 秒回)
        "fonr_acl_list":       handle_fonr_acl_list,
        "fonr_acl_set":        handle_fonr_acl_set,
        "fonr_presign_get":   handle_fonr_presign_get,      # v5.53.0 · P2-10 预签名直读
        "fonr_presign_put":   handle_fonr_presign_put,      # v5.53.0 · P2-10 预签名直传
        "fonr_transport_plan": handle_fonr_transport_plan,  # v5.53.0 · P2-12 传输策略
        # v5.54.0 · P3-14 治理 / P3-15 对象锁 / P3-16 索引
        "fonr_dlp_list":      handle_fonr_dlp_list,
        "fonr_dlp_set":       handle_fonr_dlp_set,
        "fonr_dlp_delete":    handle_fonr_dlp_delete,
        "fonr_dlp_test":      handle_fonr_dlp_test,
        "fonr_index_search":  handle_fonr_index_search,
        "fonr_index_stats":   handle_fonr_index_stats,
        "fonr_index_clear":   handle_fonr_index_clear,
        "fonr_object_lock":   handle_fonr_object_lock,
        "fonr_stream_stats":  handle_fonr_stream_stats,   # v5.56.0 C1 (快查询, 不派任务)
        # v5.62.0 E3 · 引擎探测(快查询; 真实传输 xfer_zstd_push / xfer_mc_mirror 在 ROUTE_TASK)
        "xfer_engine_probe":  handle_xfer_engine_probe,
        "quic_install_start": handle_quic_install_start,   # v6.13.0 · 批13
        "quic_install_status": handle_quic_install_status,
        # v5.65.0 F1 · 传送门(快查询: 汇总主机/存储/最近路径 + 模糊排序; 无许可证门控 = core)
        # v5.67.0 F3 · 存储热力图(快查询)
        "fonr_heatmap":       handle_fonr_heatmap,
        "fonr_timeline":      handle_fonr_timeline,   # v5.68.0 F4 时间线(快查询)
        "fonr_intent":        handle_fonr_intent,     # v5.71.0 F7 意图栏(只产草稿)
        "portal_search":      handle_portal_search,
        "portal_hit":         handle_portal_hit,
        # v5.63.0 E3-3/4/5 · frp 控制(启停/状态/探测, 秒回)
        "xfer_frp_ctl":       handle_xfer_frp_ctl,
        "fonr_acl_delete":     handle_fonr_acl_delete,
        "fonr_quota_get":      handle_fonr_quota_get,
        "fonr_quota_set":      handle_fonr_quota_set,
        # v5.44.0 P2 剩余
        "fonr_share_create":   handle_fonr_share_create,
        "fonr_share_list":     handle_fonr_share_list,
        "fonr_share_revoke":   handle_fonr_share_revoke,
        # v5.99.0 · 分享管理: 硬删除单条 / 清空(删除+清空, 用户要求)
        "fonr_share_delete":   handle_fonr_share_delete,
        "fonr_share_purge":    handle_fonr_share_purge,
    })
    ROUTE_TASK.update({
        # v5.98.0 · 从 NO_TASK 挪进来: 二者都可能跑上秒级, 会把同一条 WS 的其它请求全堵在后面
        "fonr_storages":       handle_fonr_storages,
        "fonr_list":           handle_fonr_list,
        "fonr_upload_init":    handle_fonr_upload_init,
        "fonr_upload_file":    handle_fonr_upload_file,
        "fonr_upload_abort":   handle_fonr_upload_abort,
        "fonr_compress_cancel": handle_fonr_compress_cancel,   # v6.14.0 · 批14
        "fonr_copy":           handle_fonr_copy,
        "fonr_download":       handle_fonr_download,
        # v5.41.0 P1 (暂存/转换/递归搜索耗时 → 异步派发)
        "fonr_thumb":          handle_fonr_thumb,
        "fonr_exif":           handle_fonr_exif,
        "fonr_office_pdf":     handle_fonr_office_pdf,
        "fonr_archive_list":   handle_fonr_archive_list,
        "fonr_archive_entry":  handle_fonr_archive_entry,
        "fonr_search":         handle_fonr_search,
        "fonr_thumbs_batch":   handle_fonr_thumbs_batch,
        # v5.43.0 P2 (回收站/对比/续传均为长任务)
        "fonr_trash_restore":  handle_fonr_trash_restore,
        "fonr_trash_purge":    handle_fonr_trash_purge,
        "fonr_trash_empty":    handle_fonr_trash_empty,
        "fonr_diff":           handle_fonr_diff,
        "fonr_apply_plan":     handle_fonr_apply_plan,
        "fonr_upload_resume":  handle_fonr_upload_resume,
        # v5.44.0 P2 剩余 (压缩/解压耗时 → 异步派发)
        "fonr_compress":       handle_fonr_compress,
        "fonr_extract":        handle_fonr_extract,
        # v5.45.0 P2 剩余: 版本回滚/删除为长任务 (列版本/审计查询走 NO_TASK)
        "fonr_version_restore": handle_fonr_version_restore,
        "fonr_version_delete":  handle_fonr_version_delete,
        "fonr_usage_recalc":    handle_fonr_usage_recalc,
    })

# ---------------------------------------------------------------------------
# Background task registry
# ---------------------------------------------------------------------------
# v4.46.0 P0-4 · 长任务统一异步派发的后台任务登记表:
#   - 持引用防止 pending task 被 GC
#   - done 回调记录异常 (绝不吞错)
_bg_tasks = set()


def _spawn_bg(coro):
    t = asyncio.create_task(coro)
    _bg_tasks.add(t)

    def _done(fut):
        _bg_tasks.discard(fut)
        try:
            exc = fut.exception()
        except asyncio.CancelledError:
            return
        if exc:
            # v5.98.0 · 客户端中途断开时后台任务在 send 上收尾失败, 属**正常收尾**不是缺陷:
            #   实测用户浏览器缩略图墙批量取图时断开会刷出数百行"[ws] 后台任务异常",
            #   把真正的异常淹没(排查稳定性时被它误导)。这类只记 debug, 不冒充异常。
            if type(exc).__name__ in ("WebSocketDisconnect", "WebSocketDisconnected",
                                      "ConnectionClosed", "ConnectionClosedError",
                                      "ConnectionClosedOK"):
                logging.getLogger("fonriv_ops").debug(
                    "[ws] 后台任务随连接结束(客户端已断开): %s", type(exc).__name__)
                return
            print(f"[ws] 后台任务异常: {type(exc).__name__}: {exc}")

    t.add_done_callback(_done)
    return t


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------
async def websocket_endpoint(ws: WebSocket):
    # v5.25.0 · guacd (RDP/VNC/SSH) 桥: 必须在 accept 时回声 "guacamole" 子协议,
    #   否则 guacamole-common-js 的 `new WebSocket(url,"guacamole")` 会被浏览器拒绝。
    #   故该分支放在通用 accept 之前, 由 handler 自己 accept(subprotocol=...)。
    _q0 = dict(ws.query_params)
    if _q0.get("guacd") == "1":
        from backend.guacd_bridge import handle_ws_guacd
        try:
            await handle_ws_guacd(ws, _q0)
        except WebSocketDisconnect:
            raise
        except Exception as _g_e:
            print(f"[ws] guacd 桥异常: {_g_e}")
        return
    await ws.accept()
    # v5.20.2 · VNC 桥模式: noVNC 通过特殊 query 参数进入二进制透传 (不走 JSON 分发)
    #   检测方式: URL 带 vnc=1 → 进入 raw_bridge, 处理完直接 return (不走 JSON 循环)
    try:
        _q = dict(ws.query_params)
        if _q.get("vnc") == "1":
            from backend.vnc_bridge import handle_ws_vnc_query
            await handle_ws_vnc_query(ws, _q)
            return
    except WebSocketDisconnect:
        raise
    except Exception as _vnc_e:
        print(f"[ws] VNC 桥模式异常: {_vnc_e}")
        return
    task_id = str(uuid.uuid4())
    # v5.97.0 · WS 连接生命周期记录(用户要求: 偶发断线要能事后复盘) —— 连接/断开都落操作日志,
    #   带上用户、存活时长、最后处理的 action, 便于对照前端"断开记录"两侧一起看。
    _ws_t0 = time.time()
    setattr(ws, "_ws_t0", _ws_t0)
    setattr(ws, "_ws_last_action", "")
    # v2.6.9: 请求关联 —— 每次收到消息暂存 req_id，猴补丁 send_json 自动 echo 回去，
    # 避免前端多个并发 send() 抢消息（同 WS 上先到的 type=result 被错的 handler 消费）。
    # v4.11.0: 用 setattr/getattr 走 __dict__，让 pyright 闭嘴（starlette WebSocket 无此属性）。
    setattr(ws, "_current_req_id", None)
    _orig_send_json = ws.send_json
    async def _send_json_with_req(payload, *a, **kw):
        try:
            # v5.90.3 · 任务级 req_id: ROUTE_TASK 是 create_task 异派发的, 主循环在派发后**立刻**
            #   把 ws._current_req_id 清空 → 异步 handler 的 result 响应拿不到 req_id,
            #   前端 `d.req_id !== myReqId` 直接丢弃 → 表现为"点了没反应/一直转圈"。
            #   ContextVar 随任务上下文隔离, 同一连接上并发任务互不串号。
            cur_req = _WS_REQ_ID.get() or getattr(ws, "_current_req_id", None)
            # v5.98.0 · 空 req_id 也补上(原条件 `"req_id" not in payload` 会漏掉 req_id 为空串的响应):
            #   前端 send() 的过滤是 `if (d.req_id && d.req_id !== myReqId) return;` ——
            #   **空串视为匹配**, 于是"没带 req_id 的那条错误响应"会落到**任意**一个正在等响应的请求上。
            #   实测: 复制参数不全时的 [bad_request] 错误串到了同时打开的「权限(ACL)」面板里
            #   (面板显示"缺少 src / dst"), 用户侧表现为"界面报了个不相干的错/点了没反应"。
            if isinstance(payload, dict) and cur_req and not payload.get("req_id"):
                # v6.3.6 · **只注入一次**(每个请求窗口内的第一条 result/error 帧) ——
                #   此前是"窗口内任何无 req_id 的帧都补当前 req_id", 于是**别人的推送**
                #   (如 vitals/dashboard 广播)在某个请求处理期间发出时, 会带上**该请求的**
                #   req_id → 前端按 req_id 精确匹配, 会把这条无关载荷当成自己的响应
                #   (实测: 总览 `dashboard_devices` 收到 vitals 形状载荷 → SSH 区域恒空)。
                #   现改为: 该请求已回帧后再发出的无 req_id 帧**不补**, 前端就不会误认。
                if not getattr(ws, "_rp_req_answered", False):
                    payload = dict(payload)
                    payload["req_id"] = cur_req
                    try:
                        if payload.get("type") in ("result", "error"):
                            ws._rp_req_answered = True
                    except Exception:
                        pass
            # v5.37.0 · 传输进度统一总线: 拦截所有 progress 出站消息 → 广播事件
            #   (56 处 handler 的 progress 原本只发回发起者; 广播后左侧传输监控/
            #    核心运行状况可聚合全部页面的传输会话 — 零 handler 改动)
            if isinstance(payload, dict) and payload.get("type") == "progress":
                try:
                    from backend import events as _ev
                    _ep = dict(payload)
                    _ep["action"] = getattr(ws, "_current_action", "") or ""
                    _ep["user"] = (active_sessions.get(ws) or {}).get("username") or ""
                    _ep["_ts"] = time.time()
                    _ev.publish("transfer.progress", _ep)
                except Exception:
                    pass
        except Exception as e:
            print(f"[ws] req_id inject failed: {e}")
        return await _orig_send_json(payload, *a, **kw)
    ws.send_json = _send_json_with_req  # type: ignore[method-assign]
    try:
        while True:
            try:
                data = await ws.receive_json()
            except Exception:
                break

            action = data.get("action", "")
            # 抓取前端请求携带的 req_id（若无则不注入）
            setattr(ws, "_current_req_id", data.get("req_id"))
            setattr(ws, "_rp_req_answered", False)   # v6.3.6 · 新请求窗口 → 重新允许一次注入
            setattr(ws, "_current_action", action)   # v5.37.0 · progress 广播标注来源 action
            setattr(ws, "_ws_last_action", action)   # v5.97.0 · 断开复盘用(最后处理的动作)

            # v4.40.0 · WS 心跳: ping -> pong (无需登录, 空闲保活)
            if action == "ping":
                await ws.send_json({"type": "pong", "ts": time.time()})
                setattr(ws, "_current_req_id", None)
                continue

            # v2.6.4: 处理会话恢复 —— 客户端可显式调用 db_restore_session；
            # 或在任何 action 时若无 session 且带 auth_token，自动尝试用 DB 里持久化的 token 恢复。
            if action == "db_restore_session":
                tok = data.get("token", "")
                # v5.98.2 · 会话恢复**成败都记**(此前静默: 用户报"列表刷不出来/点了没反应",
                #   但日志里查不到"到底哪次恢复失败、令牌是什么、peer 是谁" → 无法复盘)。
                #   只记 token 前 8 位, 不落全量令牌。
                _peer = "-"
                try:
                    _peer = (ws.client.host if getattr(ws, "client", None) else "-") or "-"
                except Exception:
                    _peer = "-"
                _tok_p = (tok[:8] + "…") if tok else "(空)"
                if tok and restore_session_by_token(ws, tok):
                    sess = active_sessions.get(ws) or {}
                    perms = []
                    try:
                        from backend import db as _db
                        uid = sess.get("user_id")
                        if uid is not None:
                            perms = _db.user_perms_get(int(uid))
                    except Exception as e:
                        print(f"[ws] user_perms_get failed on restore: {e}")
                    await ws.send_json({
                        "type": "result", "status": "ok",
                        "user_id": sess.get("user_id"),
                        "username": sess.get("username"),
                        "role": sess.get("role"),
                        "permissions": perms,
                        "msg": "会话已恢复",
                    })
                    try:
                        log_operation("ws", "restore",
                                      "成功 user=%s peer=%s token=%s"
                                      % ((active_sessions.get(ws) or {}).get("username") or "-",
                                         _peer, _tok_p))
                    except Exception:
                        pass
                else:
                    await ws.send_json({"type": "result", "status": "error", "msg": "会话恢复失败，请重新登录"})
                    try:
                        log_operation("ws", "restore",
                                      "失败(令牌无效/已失效) peer=%s token=%s —— 该连接将处于"
                                      "未登录状态, 其后的业务请求会被拒(前端应提示重新登录)"
                                      % (_peer, _tok_p))
                    except Exception:
                        pass
                setattr(ws, "_current_req_id", None)
                continue

            # 若无 session 但客户端带了 auth_token，透明恢复（避免每个 WS 都要显式先 restore）
            if action != "db_user_login" and ws not in active_sessions:
                tok = data.get("auth_token", "")
                if tok:
                    _restored = bool(restore_session_by_token(ws, tok))
                    # v5.97.0 · 会话透明恢复成功 → 记一条(前端也记一条, 两侧可对照)
                    if _restored and not getattr(ws, "_ws_logged_connect", False):
                        try:
                            setattr(ws, "_ws_logged_connect", True)
                            _s2 = active_sessions.get(ws) or {}
                            from backend.log import log_operation as _logop2
                            _logop2("ws", "connect",
                                    "user=%s 方式=token恢复 peer=%s"
                                    % (_s2.get("username") or _s2.get("user") or "-",
                                       getattr(ws, "client", None) and ws.client or "-"))
                        except Exception:
                            pass

            # Require auth for all actions except login
            if action != "db_user_login":
                if not await require_auth(ws):
                    # v5.95.0 · FIX(用户报"左上角经常显示断开/连接"): 此前这里是**静默 continue** ——
                    #   客户端收不到任何回应, 只能等 30s 超时, 且**分不清"会话失效"与"网络卡住"**
                    #   (实测: 会话丢失后本页所有请求集体超时, 界面像死了一样, 心跳也永远收不到 pong →
                    #    每 50s 杀一次连接重连 → 左上角反复"断开/连接")。
                    #   现在明确回一条 unauthenticated, 客户端据此**一次性恢复会话**或提示重新登录。
                    try:
                        await ws.send_json({"type": "result", "status": "error",
                                            "code": "unauthenticated",
                                            "req_id": data.get("req_id", ""),
                                            "msg": "会话已失效(未登录或已过期)"})
                    except Exception:
                        pass
                    setattr(ws, "_current_req_id", None)
                    continue

            # v4.44.1 · 双闸门控: ① license 功能硬闸 (admin 同样受限, license 是机器级)
            if action != "license_get":  # 查询自身豁免 (前端登录后要靠它做显隐)
                _feat = ACTION_FEATURE_MAP.get(action)
                # v1.0.0 · 社区版功能闸: 非社区键(pro/enterprise)一律拒绝, 文案指向社区版内置能力
                #   (原"完整性降级/反调试降级/请联系厂商"分支已随商业授权件移除)
                if _feat and not lic.feature_enabled(_feat):
                    await ws.send_json({"type": "result", "status": "error",
                                        "req_id": data.get("req_id", ""),
                                        "msg": "该功能不在社区版内 (%s)。社区版内置能力见『授权与许可』页" % _feat})
                    setattr(ws, "_current_req_id", None)
                    continue
            # ② 用户页面权限闸 (用户管理"分配权限"细粒度页面; admin 豁免)
            #   v4.44.1 · license_get 豁免用户闸: 受限用户也要靠它拉功能白名单驱动前端显隐
            _sess = active_sessions.get(ws) or {}
            if _sess.get("role") != "admin" and action != "license_get":
                _page = ACTION_PAGE_MAP.get(action)
                if _page:
                    _perms = _sess.get("_perms")
                    if _perms is None:
                        try:
                            from backend import db as _db
                            _perms = _db.user_perms_get(int(_sess.get("user_id") or 1))
                        except Exception:
                            _perms = []
                        _sess["_perms"] = _perms
                    _ok_page = (any(p in _perms for p in _page)
                                if isinstance(_page, (list, tuple)) else (_page in _perms))
                    if not _ok_page:
                        await ws.send_json({"type": "result", "status": "error",
                                            "req_id": data.get("req_id", ""),
                                            "msg": "无权访问该功能模块 (%s), 请联系管理员分配权限" % _page})
                        setattr(ws, "_current_req_id", None)
                        continue

            # v5.22.0 · G5 多租户强制点: 会话身份统一注入 (client 伪造 _uid/_role 无效)
            #   handler 层从此只认 data["_uid"]/data["_role"], 不允许 data.get("user_id") 直传
            data.pop("_uid", None)
            data.pop("_role", None)
            data["_uid"] = int(_sess.get("user_id") or 1)
            data["_role"] = _sess.get("role") or "user"

            # v5.47.0 · FonrVFS 存储级权限闸: 某存储一旦配了 ACL, 就按规则收敛
            #   (无规则 = 默认放开, 不影响升级前的行为; 管理机构豁免)
            if action.startswith("fonr_"):
                try:
                    from backend.fonrvfs import policy as _fp
                    _deny = _fp.gate(ws, action, data)
                except Exception as _pe:
                    print(f"[ws] 存储权限闸异常(放行): {_pe}")
                    _deny = None
                if _deny:
                    await ws.send_json({"type": "result", "status": "error",
                                        "req_id": data.get("req_id", ""),
                                        "code": "forbidden", "msg": _deny})
                    setattr(ws, "_current_req_id", None)
                    continue

            # Log action
            _t0 = time.monotonic()
            _cat, _desc = ACTION_DESC_MAP.get(action, (None, None))
            # v5.19.7 · 注册表归零: ACTION_DESC_MAP 缺项时兜底到 @register_job 的 page/desc
            #   (新 action 只需一个 @register_job, ws.py 零改动; 7 文件契约就此消失)
            if not _cat:
                try:
                    from backend.core_fabric.job_registry import get_job as _gj
                    _jd = _gj(action)
                    if _jd:
                        _cat = _jd.page or "其他"
                        _desc = _jd.desc or action
                except Exception:
                    pass
            if not _cat:
                _cat, _desc = "其他", action
            # v6.11.0 · 批11(用户报障: 部署后终端一直刷「读取远端配置列表」, 电脑很卡):
            #   轮询型**只读**动作不入操作日志 —— 它们由前端定时器高频触发(订阅/列表/状态快照),
            #   逐条记日志会把终端与操作日志文件刷满(实测: 最近 3000 条里订阅 1032/列表类 900+),
            #   白白制造 I/O 与终端噪声。**状态变更类动作照常记录**(审计不受影响)。
            if action not in POLL_SILENT_ACTIONS:
                log_operation(_cat, _desc)

            # Resolve handler (v5.10.0: 注册表兜底 — @register_job 的新式 action 无需改 ROUTE_*)
            handler = ROUTE_NO_TASK.get(action) or ROUTE_TASK.get(action)
            if not handler:
                try:
                    from backend.core_fabric.job_registry import get_job as _get_job
                    _jd = _get_job(action)
                    if _jd:
                        handler = _jd.handler
                except Exception:
                    pass
            if handler:
                if action in ROUTE_TASK:
                    # v4.41.0 P3-2 · rsync 是长任务: 异步派发, 主循环立即回到 receive,
                    #   否则 kill / 其他消息在 rsync 执行期间排队, ⏹ 中止永远不生效
                    # v4.46.0 P0-4 · ROUTE_TASK 全量异步派发: 此前仅 rsync, 其余 19 个
                    #   长任务 (vzdump/pve_backup/export_lvm/zfs/rbd/auto_backup/auto_restore/
                    #   terminal_open/kill 等) await 串行 —— 执行期间同一 WS 的其他消息
                    #   (含 ⏹ 中止/进度查询) 全部排队。统一 create_task 修复。
                    # v5.90.3 · 把本请求的 req_id 绑到**子任务上下文**再派发:
                    #   ContextVar 随 asyncio 任务隔离, 同连接并发任务互不串号;
                    #   否则异派发后 handler 发出的 result 响应没有 req_id, 前端关联不上。
                    # v6.3.32 · FIX(实测事故): `data` 必须像 _h/_cid/_tid 一样**用默认参数快照**,
                    #   不能留作闭包自由变量 —— `_spawn_bg(_run_task())` 只是排程, 任务真正开始执行
                    #   是在主循环 `await ws.receive_json()` 让出控制权之后; 若客户端在**同一 tick**
                    #   连发多个请求(前端 dashboard 轮询就是 share_list+mounts_list+remote_list 连发),
                    #   主循环会在任务执行前把 `data` 重新赋值 —— 于是 handler 读到的是**别人的**请求体:
                    #     · `_req = data.get("req_id")` → 回包贴上**别人**的 req_id
                    #       (实测: mounts_list 的载荷带着 remote_list 的 req_id → 前端 mounts_list 永远
                    #        等不到自己那一帧, 而 remote_list 收到两帧; 对照实验: 同 3 个请求间隔 0.6s
                    #        发送则全部正确 → 差异只在"任务执行前 data 有没有被改写")。
                    #     · 更危险的是**业务参数**也来自 data(如 share_save 的 uuid/密码) → 串到别人的写入上。
                    async def _run_task(_h=handler, _data=data, _cid=data.get("req_id"), _tid=task_id):
                        _tok = _WS_REQ_ID.set(_cid)
                        try:
                            await _h(ws, _data, _tid)
                        finally:
                            _WS_REQ_ID.reset(_tok)
                    _spawn_bg(_run_task())
                else:
                    await handler(ws, data)
            else:
                # v6.3.33 · FIX(全面审计): **未知/未注册动作必须显式回包**。
                #   此前落到这里什么都不发 → 前端 send() 只能等 30s 超时, 用户侧是"点了没反应",
                #   日志里也查不到原因(实测审计出 2 处前端/后端名字不一致: event_history_query、
                #   fonr_recent_delete —— 都是这样静默死掉的)。现在立刻回一条明确的 error 帧,
                #   前端会直接显示"未实现的动作: xxx", 同类问题从此**一眼可见**。
                _miss = data.get("req_id") or ""
                try:
                    await ws.send_json({"type": "result", "status": "error", "req_id": _miss,
                                        "msg": f"未实现的动作: {action}"})
                except Exception as _e:
                    print(f"[ws] 未知动作回包失败: {_e}")
                try:
                    print(f"[ws] 未知 action: {action!r} (已回错误帧, req_id={_miss!r})")
                    log_operation("WS", "未知动作(已回错误帧)", str(action)[:80])
                except Exception:
                    pass

            # Log slow actions
            _elapsed = time.monotonic() - _t0
            if _elapsed > 1:
                log_operation("性能", _desc, f"耗时 {_elapsed:.1f}s")
            setattr(ws, "_current_req_id", None)

    except WebSocketDisconnect:
        # 注意：不再立即 pop 会话，避免用户刷新页面或短暂断线后
        # REST 接口（/api/browse、/api/download 等）因 token 失效而 401。
        # 会话通过 auth.session_gc() 按空闲时间清理（默认 24h）。
        sess = active_sessions.get(ws)
        if sess:
            sess["disconnected_at"] = time.time()
        if task_id in active_tasks:
            await kill_process(task_id)
        # v4.38.9: 终端会话与 WS 解耦 -- 断开时保留 SSH 进程，标记 ws=None
        # 前端刷新后可用 task_id 调 terminal_attach 恢复；30 分钟无重连自动清理
        try:
            await on_ws_disconnect(ws)
        except Exception as e:
            print(f"[ws] terminal on_ws_disconnect fail: {e}")
        # v4.16.0 · 清理事件订阅
        try:
            from backend.events import unsubscribe_all
            unsubscribe_all(ws)
        except Exception as e:
            print(f"[ws] unsubscribe_all fail: {e}")
        # v4.27.0 · 清理 log_buffers 订阅
        try:
            from backend import log_buffers as _lb
            _lb.unsubscribe_all(ws)
        except Exception as e:
            print(f"[ws] log_buffers.unsubscribe_all fail: {e}")
        # v4.40.0 · 网络共享持久挂载: WS 断开不再卸载共享 (废弃 v4.39.4 会话卸载机制)
        # v5.97.0 · 断开落**操作日志**(可事后复盘: 时间/用户/存活时长/最后动作)
        try:
            _u2 = (sess or {}).get("username") or (sess or {}).get("user") or "-"
            _dur = int(time.time() - _ws_t0) if _ws_t0 else -1
            _last = getattr(ws, "_ws_last_action", "") or "-"
            from backend.log import log_operation as _logop
            _logop("ws", "disconnect",
                   "user=%s 存活=%ss 最后动作=%s 已登录=%s" % (_u2, _dur, _last, bool(sess)))
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Client disconnected "
                  f"(user={_u2} 存活={_dur}s 最后动作={_last})")
        except Exception as _le:
            print(f"[ws] disconnect 日志失败: {_le}")

    except Exception as _e:
        # v4.96.0 · 兜底: 此前只捕获 WebSocketDisconnect, 任何 action 处理器抛出的未捕获异常
        #   都会冒泡出 endpoint → FastAPI 关闭整条 WS → 前端表现「切页后连接断开/加载不出来」
        #   (用户报的 cross 右栏空白/加载卡住即由此放大)。现在记录堆栈并保持连接存活。
        import traceback as _tb
        _act = ""
        try:
            _act = str((data or {}).get("action") or "")
        except Exception:
            pass
        print(f"[ws] handler exception (action={_act}): {type(_e).__name__}: {str(_e)[:200]}")
        _tb.print_exc(limit=6)
        try:
            await ws.send_json({"type": "result", "status": "error",
                                "req_id": (data or {}).get("req_id", "") or "",
                                "msg": f"服务端处理异常({_act}): {type(_e).__name__}: {str(_e)[:160]}"})
        except Exception:
            pass
        setattr(ws, "_current_req_id", None)
ACTION_PAGE_MAP["pve_servers"] = "rdp_console"
for _a in ("conn_open", "conn_close", "conn_list", "conn_renew"):
    ACTION_PAGE_MAP[_a] = "conn_center"
ACTION_PAGE_MAP["personalize"] = "settings"
for _a in ("sp_list", "sp_get", "sp_save", "sp_del", "sp_get_by_host",
           "sp_probe", "sp_batch", "sg_list", "sg_save", "sg_del", "sg_reorder",
           "audit_query", "sp_import", "sp_export", "sp_resolve",
           "cred_list", "cred_save", "cred_del", "sp_wol",
           "recording_list", "recording_convert", "recording_delete"):
    ACTION_PAGE_MAP[_a] = "conn_center"

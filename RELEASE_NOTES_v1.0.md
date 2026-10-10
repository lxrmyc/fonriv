# Fonriv Community Edition v1.0 — Release Notes / 发布说明

**Release date / 发布日期**: 2026-10-10

Download / 下载:
- `fonriv_community_v1.0.0.tar.gz` (+ `.sha256` + `install.sh`) — universal Linux installer / 通用 Linux 安装包
- `fonriv_1.0.0_amd64.deb` — Debian 12 / Ubuntu 22.04+ (offline python wheels included / 内置离线轮子)

Install / 安装: see README / 安装见 README ([EN](README.md) · [中文](README.zh-CN.md))

---

## English

Fonriv Community Edition is the free, permanently-free edition of the Fonriv operations / transfer / backup platform for Linux servers and NAS.

**Features in this release (community tier):**

- Server profiles & Connection Center — multi-group profiles, encrypted credentials, live status (up to 8 profiles, ≤3 users)
- Network shares — mount & manage SMB / NFS shares
- File transfer — rsync upload / download / bidirectional sync / resume / parallel sharding
- Web SSH terminal, cron-style schedules
- Dashboard, persistent operation logs & audit trail
- Proxmox VE node backup + vzdump archiving
- Docker container management
- RDP / VNC remote consoles (guacamole gateway)
- Alerts (Webhook / Email), QoS time-based bandwidth limits
- Auto update via the official channel (`https://www.fonriv.com/update`), sha256-verified
- UI in 中文 / English

**Not in the community edition** (requires Pro / Enterprise): share management (LAN share wizard / HTTP links / SMB accounts & ACL), multi-cloud file manager (FonrVFS), AI assistant, restic backup, real-time sync watcher, K8s backup, DB hot backup, CloudPool federated storage, flow engine, LVM/ZFS/RBD/PBS, and related management features.

**Upgrade**: [www.fonriv.com](https://www.fonriv.com) · WeChat `lxrmyc` (include your device fingerprint from the License page).

## 中文

Fonriv 社区版是 Fonriv 运维 · 传输 · 备份管理平台的免费版本，面向 Linux 服务器与 NAS 用户，永久免费。

**本版本（社区档）包含的功能：**

- 服务器档案与连接中心——多层分组、凭据加密存储、连接状态可视化（≤8 台档案、≤3 用户）
- 网络共享——SMB / NFS 共享挂载与管理
- 文件传输——rsync 上传 / 下载 / 双向同步 / 断点续传 / 并行分片
- Web SSH 终端、定时计划
- 数据总览、持久化操作日志与审计
- Proxmox VE 节点备份 + vzdump 归档
- Docker 容器管理
- RDP / VNC 远程控制台（guacamole 网关）
- 告警通知（Webhook / 邮件）、QoS 分时限速
- 在线更新（官方通道 `https://www.fonriv.com/update`，sha256 强制校验）
- 界面支持中文 / English

**社区版不包含**（需专业版 / 旗舰版授权）：分享管理（局域网分享向导 / HTTP 链接 / SMB 账号与权限）、多云文件管理 FonrVFS、AI 助手、restic 去重备份、实时同步守护、K8s 备份、数据库热备、智能存储池 CloudPool、跨模块传输 flow、LVM/ZFS/RBD/PBS 等管理能力。

**升级购买**：[www.fonriv.com](https://www.fonriv.com) · 微信 `lxrmyc`（请附上「授权管理」页的设备指纹）。

---

**Checksums**: see the `.sha256` files attached to each download. Every release package is re-verified for sensitive files before publishing.
**校验**: 每个下载附件均配有 `.sha256`；发布前所有包都经过敏感文件复检（零泄漏才发布）。

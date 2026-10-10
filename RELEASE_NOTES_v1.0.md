# Fonriv Community Edition v1.0 — Release Notes / 发布说明

**Release date / 发布日期**: 2026-10-10 · **License 许可**: GNU AGPL-3.0

Download / 下载:
- `fonriv-community-v1.0.0-linux-amd64.tar.gz` (+ `.sha256`) — 源码 tar 包 + 一键安装脚本（`scripts/install.sh`）
- `fonriv-community_1.0.0_amd64.deb` (+ `.sha256`) — Debian 12 / Ubuntu 22.04+（内置离线 Python 轮子）

Install / 安装: see README / 安装见 README ([EN](README.md) · [中文](README.zh-CN.md))

---

## English

Fonriv Community Edition v1.0 is the open-source (AGPL-3.0), permanently-free edition of the Fonriv transfer / backup platform for Linux servers and NAS. The tarball contains the complete source code.

**Highlights:**

- Server profiles & Connection Center — multi-group profiles, encrypted credentials, live status; **unlimited profiles & users**
- File transfer — rsync upload / download / bidirectional sync / resume / parallel sharding
- Network shares (SMB / NFS), Web SSH terminal, cron-style schedules
- Dashboard, device overview, persistent operation logs & audit trail
- Proxmox VE node backup + vzdump archiving; Docker container management
- RDP / VNC remote consoles (guacamole gateway — one-click guacd install from the Dependencies panel)
- Alerts (Webhook / Email), QoS time-based bandwidth limits
- Auto update against **GitHub Releases** (self-hosted static directory also supported), sha256-verified
- UI in 中文 / English

**Not included in this open-source release**: share management (LAN share wizard / HTTP links / SMB accounts & ACL), multi-cloud file manager (FonrVFS), CloudPool federated storage, cross-module transfer flow, LVM/ZFS/RBD/PBS volume management. Their modules are not part of the open-source distribution.

**License**: GNU AGPL-3.0 — free to use, modify and redistribute; if you run a modified version as a network service, offer the corresponding source to its users.

## 中文

Fonriv 社区版 v1.0 是 Fonriv 传输 · 备份管理平台的开源（AGPL-3.0）永久免费版本，面向 Linux 服务器与 NAS 用户。tar 包内即完整源码。

**本版亮点：**

- 服务器档案与连接中心——多层分组、凭据加密存储、连接状态可视化；**档案数与用户数不限**
- 文件传输——rsync 上传 / 下载 / 双向同步 / 断点续传 / 并行分片
- 网络共享（SMB / NFS）、Web SSH 终端、定时计划
- 数据总览、设备一览、持久化操作日志与审计
- Proxmox VE 节点备份 + vzdump 归档；Docker 容器管理
- RDP / VNC 远程控制台（guacamole 网关 —— 「依赖」面板一键装 guacd）
- 告警通知（Webhook / 邮件）、QoS 分时限速
- 在线更新默认对接 **GitHub Releases**（也支持自建静态目录），sha256 强制校验
- 界面支持中文 / English

**开源发行未包含**：分享管理（局域网分享向导 / HTTP 链接 / SMB 账号与权限）、多云文件管理 FonrVFS、智能存储池 CloudPool、跨模块传输 flow、LVM/ZFS/RBD/PBS 等存储卷管理（相关模块不在开源发行中）。

**许可**：GNU AGPL-3.0 —— 可自由使用、修改与再分发；以网络服务形式提供修改版时，须按同许可证向用户提供对应源码。

---

**Checksums**: every download ships with a `.sha256` file; all packages are re-verified for sensitive files before publishing.
**校验**: 每个下载附件均配有 `.sha256`；发布前所有包都经过敏感文件复检（零泄漏才发布）。

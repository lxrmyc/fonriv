<div align="center">

# Fonriv 源流 · 社区版

**源流多云传输与备份管理平台** · V1.0

社区版永久免费，面向个人服务器、Homelab 与学习场景。

[官网](https://www.fonriv.com) · [English](README.md) · [下载](https://www.fonriv.com)

</div>

---

**Fonriv 源流** 是一款 B/S 架构的多云传输与备份管理平台，面向 Linux 服务器与 NAS 用户：文件同步与传输、网络共享、定时计划、数据总览、Proxmox VE 备份、Docker 容器管理、远程桌面控制台等能力，全部收敛在一个 Web 界面里。

> 命名源自拉丁语 *Fons*（水之源头）与 *Rivus*（川流不息）：
> **源** —— 数据的始处与根基；**流** —— 传输、分享与流转。
> Fonriv —— 从数据源头到终端的完整传输链路。

- **官网**：[www.fonriv.com](https://www.fonriv.com)
- **联系微信**：`lxrmyc`
- **界面语言**：简体中文 / English 一键切换

---

## 功能一览

| 领域 | 能力 |
|---|---|
| 服务器档案与连接中心 | 多层分组、凭据加密存储、连接状态可视化（≤ **8** 台档案，≤ **3** 用户） |
| 文件传输 | 基于 rsync 的上传 / 下载 / 双向同步 / 断点续传 / 并行分片（万级小文件优化） |
| 网络共享 | SMB / NFS 网络共享挂载与管理 |
| Web 终端 | 浏览器内完整 SSH 终端 |
| 定时计划 | Cron 式定时任务 |
| 总览与审计 | 数据总览、设备一览、持久化操作日志、审计追踪 |
| Proxmox VE | PVE 节点连接 + 一键备份、vzdump 归档 |
| Docker | 容器管理面板 |
| 远程控制台 | 浏览器内 RDP / VNC 远程桌面（guacd 网关 —— 在内置「依赖」面板一键安装即可） |
| 告警通知 | Webhook / 邮件 |
| QoS | 分时段带宽限速 |
| 在线更新 | 内置更新器对接官方通道（`https://www.fonriv.com/update`），sha256 强制校验 |
| 界面语言 | 简体中文 / English |

## 环境要求

- Linux x86_64 / arm64 —— 实测 **Ubuntu 22.04** 与 Debian 12（Proxmox VE / OMV 亦可用）
- Python **3.9+**（推荐 3.10+）、`rsync`、`sshpass`、`curl`
- 远程桌面控制台需要 **guacd** —— 在「系统 → 依赖」面板一键安装即可，无需手工配置

## 快速开始

### 方式一：tar.gz + 一键脚本

```bash
# 1. 解包
sudo mkdir -p /opt/fonriv
sudo tar xzf fonriv_community_v1.0.0.tar.gz -C /opt/fonriv
cd /opt/fonriv

# 2. 一键安装（自动建 venv、写 systemd 单元并启动服务）
sudo bash scripts/install.sh --yes

# 3. 打开 Web 界面 —— 首次访问会引导创建管理员账号
#    http://<服务器IP>:8000
```

### 方式二：deb 包（Debian 12 / Ubuntu 22.04+）

```bash
sudo apt-get install -y ./fonriv_1.0.0_amd64.deb
# 安装到 /opt/fonriv，数据在 /var/lib/fonriv，内置离线 Python 轮子，内网可装
```

服务管理：

```bash
systemctl status fonriv
systemctl restart fonriv
journalctl -u fonriv -f
```

数据（SQLite + 日志）在安装目录的 `data/` 下。**升级前请先备份 `data/`。**

## 在线更新

「关于 → 检查更新」自动对接官方通道（默认 `https://www.fonriv.com/update`）。每个升级包都经 sha256 强制校验，校验不通过自动拒绝应用。

## 版本对比

| | 社区版 | 专业版 | 旗舰版 |
|---|---|---|---|
| 价格 | **永久免费** | [详情咨询官网](https://www.fonriv.com) | [详情咨询官网](https://www.fonriv.com) |
| 定位 | 个人 / Homelab | 小团队 / 高级用户 | 中大型企业 |
| 服务器档案 / 用户数 | 8 / 3 | 60 / 20 | 不限 |
| 额外能力 | — | 分享管理（局域网分享向导 / HTTP 链接 / SMB 账号与权限）、多云文件管理 FonrVFS、AI 助手、restic 去重备份、实时同步守护、K8s 备份、数据库热备 | 智能存储池 CloudPool、跨网段直连、跨模块传输 flow、LVM/ZFS/RBD/PBS、Air-Gap 摆渡 |

**购买专业版 / 旗舰版**：访问 [www.fonriv.com](https://www.fonriv.com) 或联系微信 `lxrmyc`。
下单时请附上本机「授权管理」页显示的**设备指纹**——授权与机器绑定。

## 许可

Fonriv 社区版按专有免费软件许可发布，详见 [LICENSE](LICENSE)。版权所有 © 2026 Fonriv。

<div align="center">

# Fonriv 源流 · Community Edition

**Multi-Cloud Transfer & Backup Management Platform**
源流多云传输与备份管理平台 · V1.0

Community Edition — permanently free, for personal servers, homelab and study.

[Website 官网](https://www.fonriv.com) · [中文文档](README.zh-CN.md) · [Download 下载](https://www.fonriv.com)

</div>

---

**Fonriv** is a web-based (B/S) multi-cloud transfer and backup management platform for Linux servers and NAS: file sync & transfer, network shares, scheduling, dashboards, Proxmox VE backup, Docker management, remote desktop consoles and more — all from a single web UI.

> The name comes from Latin *Fons* (the source of water) and *Rivus* (an ever-flowing stream):
> **Source** — the origin and foundation of your data; **Flow** — transfer, sharing and seamless movement.
> *Fonriv* — the complete pipeline from data source to endpoint.

- **Official website / 官网**: [www.fonriv.com](https://www.fonriv.com)
- **WeChat / 微信**: `lxrmyc`
- **界面语言 UI**: 简体中文 / English (one-click switch)

---

## Features

| Area | What you get |
|---|---|
| Server profiles & Connection Center | Multi-group profiles, encrypted credentials, live status (up to **8** profiles, ≤ **3** users) |
| File transfer | rsync-based upload / download / bidirectional sync / resume / parallel sharding (tuned for 10k+ small-file trees) |
| Network shares | Mount & manage SMB / NFS network shares |
| Web terminal | Full SSH terminal in the browser |
| Schedules | Cron-style scheduled jobs |
| Dashboard & audit | Data overview, device overview, persistent operation logs, audit trail |
| Proxmox VE | PVE node connection + one-click backup, vzdump archiving |
| Docker | Container management panel |
| Remote consoles | RDP / VNC remote desktop in the browser (guacd gateway — install it from the built-in Dependencies panel with one click) |
| Alerts | Webhook / Email notifications |
| QoS | Time-based bandwidth limits |
| Auto update | Built-in updater on the official channel (`https://www.fonriv.com/update`), sha256-verified |
| UI language | 简体中文 / English |

## Requirements

- Linux x86_64 / arm64 — tested on **Ubuntu 22.04** and Debian 12 (Proxmox VE / OMV work too)
- Python **3.9+** (3.10+ recommended), `rsync`, `sshpass`, `curl`
- Remote desktop consoles need **guacd** — install it from **System → Dependencies** with one click, no manual setup needed

## Quick start

### Option A — tarball + one-shot script

```bash
# 1. unpack
sudo mkdir -p /opt/fonriv
sudo tar xzf fonriv_community_v1.0.0.tar.gz -C /opt/fonriv
cd /opt/fonriv

# 2. one-shot install (creates venv, writes systemd unit, starts the service)
sudo bash scripts/install.sh --yes

# 3. open the web UI — first run walks you through admin setup
#    http://<server-ip>:8000
```

### Option B — deb package (Debian 12 / Ubuntu 22.04+)

```bash
sudo apt-get install -y ./fonriv_1.0.0_amd64.deb
# installs to /opt/fonriv, data in /var/lib/fonriv, offline python wheels included
```

Manage the service:

```bash
systemctl status fonriv
systemctl restart fonriv
journalctl -u fonriv -f
```

Data (SQLite + logs) lives in `data/` under the install directory. **Back up `data/` before upgrading.**

## Updating

**About → Check for updates** checks the official channel automatically (default `https://www.fonriv.com/update`). Every package is sha256-verified before it is applied; a failed check is rejected automatically.

## Editions · 版本

| | Community 社区版 | Pro 专业版 | Enterprise 旗舰版 |
|---|---|---|---|
| Price | **Free 永久免费** | [详情咨询官网 · See official site](https://www.fonriv.com) | [详情咨询官网 · See official site](https://www.fonriv.com) |
| Target | Personal / Homelab | Small teams | Business |
| Profiles / Users | 8 / 3 | 60 | Unlimited |
| Extra features | — | Share management (LAN share wizard, HTTP links, SMB accounts & ACL), multi-cloud file manager (FonrVFS), AI assistant, restic dedup backup, real-time sync watcher, K8s backup, DB hot backup | CloudPool federated storage, cross-segment direct link, flow engine, LVM/ZFS/RBD/PBS, Air-Gap ferry |

**To purchase Pro / Enterprise**: visit [www.fonriv.com](https://www.fonriv.com) or contact WeChat `lxrmyc`.
Please include the **device fingerprint** shown on the *License* page of your installation — licenses are bound to the machine.

## License

Fonriv Community Edition is distributed under a proprietary freeware license — see [LICENSE](LICENSE).
Copyright © 2026 Fonriv. All rights reserved.

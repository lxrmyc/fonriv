<div align="center">

# Fonriv 源流 · Community Edition

**Multi-Cloud Transfer & Backup Management Platform**
源流多云传输与备份管理平台 · V1.0

Community Edition — open source (AGPL-3.0), permanently free, for personal servers, homelab and study.

[Website 官网](https://www.fonriv.com) · [中文文档](README.zh-CN.md) · [Releases 下载](../../releases)

</div>

---

**Fonriv** is a web-based (B/S) multi-cloud transfer and backup management platform for Linux servers and NAS: file sync & transfer, network shares, scheduling, dashboards, Proxmox VE backup, Docker management, remote desktop consoles and more — all from a single web UI.

> The name comes from Latin *Fons* (the source of water) and *Rivus* (an ever-flowing stream):
> **Source** — the origin and foundation of your data; **Flow** — transfer, sharing and seamless movement.
> *Fonriv* — the complete pipeline from data source to endpoint.

- **Official website / 官网**: [www.fonriv.com](https://www.fonriv.com)
- **WeChat / 微信**: `lxrmyc`
- **UI language / 界面语言**: 简体中文 / English (one-click switch)

---

## Features

| Area | What you get |
|---|---|
| Server profiles & Connection Center | Multi-group profiles, encrypted credentials, live status — **unlimited profiles & users** |
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
| Auto update | Built-in updater against **GitHub Releases** (a self-hosted static directory is also supported), sha256-verified |
| UI language | 简体中文 / English |

## Requirements

- Linux x86_64 / arm64 — tested on **Ubuntu 22.04** and Debian 12 (Proxmox VE / OMV work too)
- Python **3.9+** (3.10+ recommended), `rsync`, `sshpass`, `curl`
- Remote desktop consoles need **guacd** — install it from **System → Dependencies** with one click, no manual setup needed

## Quick start

### Option A — tarball + one-shot script (the tarball contains the full source)

```bash
# 1. unpack
sudo mkdir -p /opt/fonriv
sudo tar xzf fonriv-community-v1.0.0-linux-amd64.tar.gz -C /opt/fonriv
cd /opt/fonriv

# 2. one-shot install (creates venv, writes systemd unit, starts the service)
sudo bash scripts/install.sh --yes

# 3. open the web UI — first run walks you through admin setup
#    http://<server-ip>:8000
```

### Option B — deb package (Debian 12 / Ubuntu 22.04+)

```bash
sudo apt-get install -y ./fonriv-community_1.0.0_amd64.deb
# installs to /opt/fonriv, data in /opt/fonriv/data, offline python wheels included
```

Manage the service:

```bash
systemctl status fonriv
systemctl restart fonriv
journalctl -u fonriv -f
```

Data (SQLite + logs) lives in `data/` under the install directory. **Back up `data/` before upgrading.**

## Updating

**About → Check for updates** targets **GitHub Releases** by default (the dialog can switch to a self-hosted static directory). Every package is sha256-verified before it is applied; a failed check is rejected automatically.

## Building from source

```bash
# The source code is this repository (the tarball also contains it).
python3 -m venv venv && venv/bin/pip install -r requirements.txt
sudo bash scripts/install.sh --yes

# or build distribution packages yourself (output in dist/)
bash packaging/build_tarball.sh            # tar.gz + sha256
bash packaging/build_deb.sh                # deb (Debian 12 / Ubuntu 22.04+)
```

## License

Fonriv Community Edition is released under the **GNU AGPL-3.0** — see [LICENSE](LICENSE).
You are free to use, modify and redistribute it; if you run a modified version as a network service, you must offer the corresponding source to its users.
- **Source code**: <https://github.com/lxrmyc/fonriv/>
- **Website / 官网**: [www.fonriv.com](https://www.fonriv.com) — docs, downloads and more

Copyright © 2026 Fonriv. This program comes with ABSOLUTELY NO WARRANTY; see the license for details.

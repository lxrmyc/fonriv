# Fonriv 社区版 · 发行包构建（目标 Ubuntu 22.04 / Debian 12）

两个产物，都从**本仓库**构建：

```bash
bash packaging/build_tarball.sh     # 源码 tar.gz + sha256  → dist/fonriv-community-v<版本>-linux-<架构>.tar.gz
bash packaging/build_deb.sh         # deb 安装包 + sha256     → dist/fonriv-community_<版本>_<架构>.deb
bash packaging/build_deb.sh --arm64 # arm64（需能访问 PyPI 下载 aarch64 轮子）
```

版本号唯一真源：`backend/version.py` 的 `VERSION`。
两个脚本都会在产物落地前跑 `scripts/check_publish_clean.py` 硬闸：私钥/数据目录/日志/开发残留命中任何一类即中止并删除产物。

## 一、deb 的依赖策略：为什么是「随包轮子 + 安装时建 venv」

结论先说：**既不是"打一个预装好的 venv"，也不是"走系统 python3"，而是包里带 cp310 轮子、
安装时在 `/opt/fonriv/venv` 里离线建虚拟环境**。

| 方案 | 问题 |
|---|---|
| **走系统 python3（apt/pip 装进系统）** | ① 22.04 的 `python3-cryptography` 版本过旧，与依赖要求互相破坏；② 装进 `/usr/lib/python3/dist-packages` 会污染系统 Python —— 这类机器上往往同时跑着 OMV/PVE/其它 Python 工具，一次 pip 升级就可能弄坏系统工具；③ 依赖版本随客户的 apt 源漂移，构建机测过的版本 ≠ 客户跑的版本 |
| **打一个预建好的 venv** | ① venv 里 `pyvenv.cfg`/`bin/python` 绑定构建机的解释器与 ABI；② 体积多一份解释器；③ 客户机上 python 小版本一变就脆 |
| **随包轮子 + 安装时建 venv（本方案）** | ① 用**客户自己的 python3.10** 建 venv，ABI 天然匹配；② 全程 `--no-index --find-links`，**不联网**；③ 完全不碰系统 Python；④ 依赖版本由发行方锁定；⑤ 升级/重建只需重跑 postinst |

代价：目标机需要 `python3-venv`（写在 `Depends` 里，apt 自动装）。

## 二、构建细节

- 首次构建会 `pip download` **两组** manylinux 轮子 (cp310 供 Ubuntu 22.04 / cp311 供 Debian 12)
  到 `dist/wheels/<arch>/`（之后按 `.done-cpXXX` 标记复用缓存）；安装时 pip 按目标解释器自动挑选匹配的那套。
- `--no-wheels` 仅用于本机联网试装；发行包必须带轮子。
- `--unit-name` / `--pkg-name` / `--src` 供本机试装与自定义场景使用（默认即可）。
- 打包排除了运行期数据（`data/`、`backend/data/`）、开发残留与私有文件；`scripts/` 只白名单放入
  运行期必需的 `install.sh / apply_update.sh / features.json / build_guacd.sh`。

## 三、安装后会做什么（postinst）

1. 建 `/var/lib/fonriv`（0750）并把 `/opt/fonriv/data` 链接过去 —— **数据在包目录之外，升级不丢**。
2. `python3 -m venv /opt/fonriv/venv` → `pip install --no-index --find-links=/opt/fonriv/wheels -r requirements.txt`
   → 实际 import 复核，任一步失败即明确报错并让 apt 失败（不会"装完了但用不了"）。
3. 权限收紧：`*.pem/*.key` → 0600，`/etc/fonriv/fonriv.conf` → 0640。
4. 外部工具自检（rsync/sshpass/7z/mount.cifs/mount.nfs），缺了只提示 —— Web 界面「系统·依赖检查」可一键装。
5. `systemctl daemon-reload && enable --now fonriv`，随后检查 `systemctl is-active` 并访问 `/api/version`
   比对包版本串，不一致/无响应会打红字提示。
6. 打印访问地址，并明确写出「首次打开会引导你设置超级管理员，本系统不预置任何默认口令」。

`preinst` 会保护机器上**已存在的另一套 `fonriv.service`**：先备份到 `/var/backups/fonriv/`，
默认**中止安装**并给出两条出路，只有显式 `FONRIV_DEB_ALLOW_UNIT_OVERWRITE=1 dpkg -i …` 才覆盖。
`prerm` 停服务（升级不动）；`postrm` 默认**保留** `/var/lib/fonriv`，`purge` 时先 tar 备份再删。

## 四、包内不含什么

- **不预置任何账号/口令**：超级管理员由首次配置向导创建。
- `data/` 与 `backend/data/` 不打进包（前者由 postinst 建到 `/var/lib/`，后者为本机私钥/身份/暂存数据）。
- `packaging/`、`scripts/` 下的开发与发布工具不入 deb（源码 tar 里仍完整保留）。

## 五、安装验证清单（在 22.04 / Debian 12 上执行）

```bash
dpkg -i dist/fonriv-community_1.0.0_amd64.deb      # 观察安装输出里的访问地址与"首次配置"提示
systemctl is-active fonriv
/opt/fonriv/venv/bin/python -c "import fastapi,uvicorn,cryptography;print('deps ok')"
curl -s http://127.0.0.1:8000/api/setup/status     # 期望 {"needs_setup":true,...}
```

## 六、已知取舍

- **服务以 root 运行**：挂载/磁盘/服务管理等能力需要 root（与手工部署一致），
  Web 侧由账号 + 页面权限保护。若只要"纯文件管理"，可改用 `User=fonriv` 但会失去上述能力。
- 轮子按架构分离：`--arm64` 需要重新下载对应轮子；`i386` 不支持。
- 初始化窗口：装完到第一次访问之间 `needs_setup=true`，此时任何能访问该端口的人都可以
  创建超级管理员。内网/受限端口场景可接受；公网暴露前请先完成初始化。

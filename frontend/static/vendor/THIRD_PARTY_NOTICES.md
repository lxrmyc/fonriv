# 第三方组件声明（Bundled Third-Party Notices）

本目录（`frontend/static/vendor/`）内的文件为**第三方开源组件**，随本产品前端一同分发。
它们**不是本产品的原创代码**，版权归各自作者所有，按各自许可证分发。

> 维护约定：新增/升级本目录内任何组件时，必须同步更新本文件，并提供该组件的
> `LICENSE`（全文）与 `VERSION`（版本/来源/入库日期/许可类型）。

| 组件 | 版本 | 许可 | 许可文件 | 用途 |
|---|---|---|---|---|
| guacamole-common-js | 1.5.5 | Apache License 2.0 | `guacamole/LICENSE` | 远程桌面（RDP/VNC）客户端渲染 |
| noVNC | 1.5.0 | MPL 2.0（核心库文件级） | `novnc/LICENSE.txt` | VNC / PVE 虚拟控制台客户端 |
| pako | 随 noVNC 分发 | MIT | `novnc/vendor/pako/LICENSE` | noVNC 依赖的 zlib 解压实现 |
| xterm.js | 5.3.0 | MIT | `xterm.LICENSE` | 浏览器内终端（Web 终端）渲染 |
| Monaco Editor | 0.45.0 | MIT | `monaco.LICENSE` | 文件编辑/预览的语法高亮 |

## 各组件许可证要点（合规说明）

- **Apache-2.0（guacamole-common-js）**：允许以闭源方式分发，须保留 `LICENSE`（如上游提供 `NOTICE` 亦须保留），
  且被修改过的文件须显著标注修改。本目录内文件**未做修改**（原样入库，见 `guacamole/VERSION`）。
- **MPL-2.0（noVNC）**：**文件级** copyleft —— 仅对被修改的 MPL 文件有公开要求；本目录分发的是**未修改的源码文件**
  （非压缩形式），符合源码可得性要求，且已随附 `LICENSE.txt`。
- **MIT（pako / xterm.js / Monaco Editor）**：须在副本中保留版权声明与许可声明。三者现已各自随附 `LICENSE`；
  xterm.js 原压缩产物中不含版权行，故以同目录 `xterm.LICENSE` 补齐。

## 仅被“调用”而非分发的第三方程序

以下程序通过子进程调用使用，**不包含在本产品的发行包中**，其许可（如 rsync 的 GPL 系列）不构成本产品的衍生作品义务：
rsync · rclone · croc · restic · zstd · docker CLI · guacd · tar/7z/unrar · 数据库客户端（mysql/psql/redis-cli/mongosh）等。

> 注意：`scripts/build_guacd.sh` 在**目标机本地**从上游源码编译 guacd 服务端（含一个剥离 `-Werror` 的编译开关修正）。
> 若将来把编译产物单独打包分发，须随附上游 `LICENSE`/`NOTICE` 并注明该构建改动。

#!/usr/bin/env bash
# guacd 源码编译部署 (不依赖 docker)
#
# 为什么要有这条路: docker 部署会把"必须装 docker"变成服务器端的长期约束,
#   也增加镜像/网络/编排的管理面。guacd 本身是个几十 MB 的单进程 C 守护进程,
#   源码编译装到 /usr/local + 一个 systemd 单元即可, 无容器开销。
#
# 三种部署方式 (脚本会自动挑可行的):
#   ① apt 包     Debian/Ubuntu ≤25.04 · RHEL/EPEL 有 guacd; Ubuntu 26.04 起已移除
#   ② 源码编译   本脚本 (离线可用: 优先用 third_party/ 里的源码包, 不联网)
#   ③ docker     远程/容器化环境
#
# 用法:
#   bash scripts/build_guacd.sh              # 自动: 有源码包就不联网
#   bash scripts/build_guacd.sh --download   # 强制联网取源码包
#   bash scripts/build_guacd.sh --prefix=/opt/guacd
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 版本与 FreeRDP 代数必须匹配 (实测踩到的硬约束):
#   guacamole-server 1.5.x 只认 FreeRDP 2; 1.6.x 起支持 FreeRDP 3。
#   ⚠ 但"1.6.x + 很新的 FreeRDP 3"实测**能编出来却出不了画面**:
#     本机 Ubuntu 26.04 自带 FreeRDP 3.31 → guacd 1.6.0 握手/帧缓冲都正常,
#     就是不发 img/blob (目标 Win10 与 Linux xrdp 都一样), 而同一目标用
#     官方 docker 镜像 (1.5.5 + FreeRDP 2) 正常出画面。configure 也会警告
#     "This version of FreeRDP does not support relaxed order checks ... likely not be usable"。
#   结论: 想要"无 docker 且 RDP 真能用", 优先 **FreeRDP 2 + guacamole 1.5.5**;
#     系统只有 FreeRDP 3 且版本很新时, 建议在较老的发行版 (如 24.04) 编好后用 --pack 分发。
#   新版发行版 (Ubuntu 26.04 等) 只有 FreeRDP 3 → 必须用 1.6.x, 否则 RDP 插件静默不编译,
#   表现为 guacd 起来但 select,rdp 无响应 ("有响应但不是 guacd")。
pick_ver(){
  if [[ -n "${GUACD_VER:-}" ]]; then echo "$GUACD_VER"; return; fi
  # 优先级: FreeRDP 2 (1.5.5) > FreeRDP 3 (1.6.0)
  #   实测: FreeRDP 3.31 + guacamole 1.6.0 能编能握手但**不发图像帧** (目标无关),
  #   而 FreeRDP 2 + 1.5.5 (官方镜像同款组合) 正常 → 有 FreeRDP 2 就用它。
  if pkg-config --exists freerdp2 2>/dev/null; then echo "1.5.5"; return; fi
  if apt-cache policy freerdp2-dev 2>/dev/null | grep -q '候选\|Candidate'; then echo "1.5.5"; return; fi
  if pkg-config --exists freerdp3 2>/dev/null || apt-cache policy freerdp3-dev 2>/dev/null | grep -q '候选\|Candidate'; then echo "1.6.0"; return; fi
  for v in 1.5.5 1.6.0; do
    [[ -f "$ROOT/third_party/guacamole-server-${v}.tar.gz" ]] && { echo "$v"; return; }
  done
  echo "1.5.5"
}
VER="$(pick_ver)"
PREFIX="${GUACD_PREFIX:-/usr/local}"
TARBALL="$ROOT/third_party/guacamole-server-${VER}.tar.gz"
URL="https://dlcdn.apache.org/guacamole/${VER}/source/guacamole-server-${VER}.tar.gz"
FORCE_DL=0
PACK=0
for a in "$@"; do
  case "$a" in
    --download) FORCE_DL=1 ;;
    --prefix=*) PREFIX="${a#--prefix=}" ;;
    --pack) PACK=1 ;;
  esac
done

log(){ echo "[guacd] $*"; }
die(){ echo "[guacd][错误] $*" >&2; exit 1; }

command -v gcc >/dev/null 2>&1 || log "提示: 未检测到 gcc, 下面会尝试安装构建依赖"

# ── 1) 系统依赖 (按发行版) ──
install_deps(){
  log "安装构建依赖 (FreeRDP/VNC/SSH/PNG/WebP …)"
  if command -v apt-get >/dev/null 2>&1; then
    # FreeRDP 3 (Debian 12+/Ubuntu 24.04+/26.04) 与 FreeRDP 2 (旧版) 包名不同, 分开尝试
    apt-get update -qq 2>/dev/null || true
    apt-get install -y -qq \
      build-essential autoconf automake libtool libcairo2-dev libjpeg-turbo8-dev libpng-dev libtool-bin \
      libossp-uuid-dev libvncserver-dev libpango1.0-dev libssh2-1-dev libssl-dev \
      libtelnet-dev libwebsockets-dev libpulse-dev libwebp-dev libzstd-dev \
      libavcodec-dev libavutil-dev libswscale-dev libavformat-dev libavfilter-dev 2>&1 | tail -2
    # FreeRDP 开发包必须与 guacamole 版本匹配 (编 1.5.x 必须 FreeRDP 2, 1.6.x 才认 FreeRDP 3):
    #   1.5.x → freerdp2-dev / libfreerdp-dev      (Ubuntu 24.04 是 freerdp2-dev)
    #   1.6.x → freerdp3-dev                       (Ubuntu 26.04 只有 freerdp3-dev)
    local _cands
    if [[ "$VER" == 1.5.* ]]; then _cands="freerdp2-dev libfreerdp-dev"
                           else _cands="freerdp3-dev freerdp3-dev"; fi
    local _ok=0
    for c in $_cands; do
      if apt-get install -y -qq "$c" 2>/dev/null; then log "FreeRDP 依赖: $c (匹配 guacamole ${VER})"; _ok=1; break; fi
    done
    [[ "$_ok" == "1" ]] || log "⚠ 没装到匹配 ${VER} 的 FreeRDP 开发包 — RDP 插件不会被编译, 只能 VNC/SSH"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y gcc make cairo-devel libjpeg-turbo-devel libpng-devel \
      libtool libuuid-devel libvncserver-devel pango-devel libssh2-devel openssl-devel \
      libtelnet-devel libwebsockets-devel pulseaudio-libs-devel \
      ffmpeg-devel libwebp-devel libzstd-devel freerdp-devel 2>&1 | tail -2
  elif command -v yum >/dev/null 2>&1; then
    yum install -y gcc make cairo-devel libjpeg-turbo-devel libpng-devel libtool \
      libuuid-devel libvncserver-devel pango-devel libssh2-devel openssl-devel \
      libtelnet-devel libwebsockets-devel ffmpeg-devel libwebp-devel freerdp-devel 2>&1 | tail -2
  else
    log "未知发行版 — 请按 guacamole-server 文档装齐依赖后重跑"
  fi
}

# ── 2) 取源码 (离线优先) ──
get_src(){
  local work="$1"
  if [[ -f "$TARBALL" && "$FORCE_DL" == "0" ]]; then
    log "使用离线源码包 third_party/guacamole-server-${VER}.tar.gz (不联网)"
    cp "$TARBALL" "$work/gs.tar.gz"
  else
    log "下载源码包 $URL"
    curl -fL --retry 3 -o "$work/gs.tar.gz" "$URL" \
      || die "下载失败。可在有网络的机器上下载后放到 third_party/guacamole-server-${VER}.tar.gz"
  fi
  tar xzf "$work/gs.tar.gz" -C "$work" || die "解包失败"
  [[ -d "$work/guacamole-server-${VER}" ]] || die "源码目录不符合预期"
}

# ── 2.5) 老代码 + 新编译器: 剥掉 -Werror (必须在 configure 之前做) ──
#   guacamole 把 -Werror 硬编码进 src/libguac/Makefile.am 与 configure.ac
#   (AM_INIT_AUTOMAKE + FreeRDP 的 CPPFLAGS), GCC 13+ 的新告警会直接导致编不过 —
#   发行版打包时同样是打这个补丁。三个注意点:
#     ① 每目标 CFLAGS 覆盖全局 CFLAGS, 所以必须在 Makefile 体系里去掉;
#     ② 改过 configure.ac/acinclude.m4 会让 make 想重跑 automake/aclocal (版本还未必对得上)
#        → 改完把这些"生成物"的 mtime 调新, 让 make 认为无需重生成;
#     ③ grep 的 --include 必须写在 `--` 之前, 否则会被当成文件名。
strip_werror(){
  log "去掉源码里的 -Werror (新编译器告警兼容)"
  grep -rl --include=Makefile.am --include=Makefile.in -e '-Werror' . \
    | xargs -r sed -i 's/-Werror//g'
  sed -i 's/-Werror//g' configure.ac 2>/dev/null || true
  find . -name 'Makefile.am' -exec touch -d '4 hours ago' {} \; 2>/dev/null || true
  find . -name 'acinclude.m4' -exec touch -d '4 hours ago' {} \; 2>/dev/null || true
  find . -name '*.m4' -path '*/m4/*' -exec touch -d '4 hours ago' {} \; 2>/dev/null || true
  touch -d '3 hours ago' configure.ac 2>/dev/null || true
  touch -d '2 hours ago' aclocal.m4 2>/dev/null || true
  find . -name 'Makefile.in' -exec touch -d '1 hour ago' {} \; 2>/dev/null || true
}

# ── 3) 编译安装 ──
build(){
  local work src
  work="$(mktemp -d)"; src=""
  # work 是局部变量, EXIT 时已出作用域 → 用 ${work:-} 兜住 set -u
  trap 'rm -rf "${work:-}"' EXIT
  get_src "$work"
  src="$work/guacamole-server-${VER}"
  cd "$src" || die "进入源码目录失败"
  strip_werror
  log "configure --prefix=$PREFIX"
  # 只要 guacd 本体: 关掉文档/测试; guacenc(录像转码) 需要 ffmpeg, 有则开
  local enc="--disable-guacenc"
  pkg-config --exists libavcodec 2>/dev/null && enc="--enable-guacenc" \
    || log "提示: 未检测到 ffmpeg 开发库, 本次不编 guacenc (录像将保持 .guac 原始格式, 仍可用)"
  # 全功能: 显式打开所有可用的协议插件与工具
  EXTRA_OPTS="--with-freerdp-plugin-dir=$(pkg-config --variable=libdir freerdp3 2>/dev/null || echo /usr/lib/x86_64-linux-gnu/freerdp3)"
  ./configure --prefix="$PREFIX" --disable-docs --disable-man-pages --disable-dependency-tracking \
              --with-systemd-dir=/etc/systemd/system $enc >"$work/cfg.log" 2>&1 \
    || { tail -25 "$work/cfg.log"; die "configure 失败 (依赖不全? 见上)"; }
  log "make -j$(nproc)"
  make -j"$(nproc)" >"$work/make.log" 2>&1 || { tail -25 "$work/make.log"; die "make 失败"; }
  # 编之前先确认 RDP 插件会被编出来 (1.5.x 配 FreeRDP 3 会静默跳过 → 白装)
  if grep -q "RDP \.\{0,10\}no" "$work/cfg.log" 2>/dev/null; then
    log "⚠ configure 显示 RDP 被禁用 (FreeRDP 开发包缺失或代数不匹配)"
    log "  本次为 guacamole-server ${VER}; 若系统只有 FreeRDP 3 请用 1.6.x: bash $0  # 脚本会自动选"
  fi
  log "make install"
  make install >"$work/inst.log" 2>&1 || { tail -25 "$work/inst.log"; die "make install 失败"; }
  ldconfig 2>/dev/null || true
  # 校验: 列出全部已装组件 (全功能版应含 5 个协议插件 + guacenc + guaclog)
  local _libdir="$PREFIX/lib"
  log "已装协议插件: $(ls "$_libdir"/libguac-client-*.so 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
  for _t in guacenc guaclog; do
    if [[ -x "$PREFIX/bin/$_t" ]]; then log "✓ $_t 已装"
    else log "⚠ $_t 未装 $([[ $_t == guacenc ]] && echo '(需 ffmpeg 开发包 libavcodec-dev/libavutil-dev/libswscale-dev; 它把 .guac 录像转成 mp4)')"; fi
  done
  if ls "$_libdir"/libguac-client-rdp.so* >/dev/null 2>&1; then
    log "✓ RDP 插件已装 (Windows / Linux xrdp / macOS 远程桌面可用)"
  else
    log "⚠ 未生成 RDP 插件 — 该 guacd 只能处理 VNC/SSH!"
    log "  原因几乎总是 FreeRDP 开发包与版本不匹配: guacamole 1.5.x 只认 FreeRDP 2, 1.6.x 起支持 FreeRDP 3。"
  fi
}

# ── 4) systemd 单元 + 启动 ──
setup_service(){
  local bin="$PREFIX/sbin/guacd"
  [[ -x "$bin" ]] || bin="$(command -v guacd || true)"
  [[ -n "$bin" ]] || die "安装后仍未找到 guacd 可执行文件"
  if command -v systemctl >/dev/null 2>&1; then
    cat > /etc/systemd/system/guacd.service <<UNIT
[Unit]
Description=Guacamole proxy daemon (guacd) - Fonriv 远程桌面网关
After=network.target

[Service]
Type=simple
ExecStart=${bin} -b 0.0.0.0 -l 4822 -f
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable guacd >/dev/null 2>&1
    systemctl restart guacd
    sleep 2
    systemctl is-active guacd >/dev/null 2>&1 \
      && log "✓ guacd 已作为系统服务运行 ($bin, 端口 4822)" \
      || { systemctl status guacd --no-pager 2>&1 | tail -6; die "guacd 服务启动失败"; }
  else
    log "无 systemd — 手动启动: $bin -b 0.0.0.0 -l 4822 -f &"
  fi
  log "版本: $("$bin" -v 2>/dev/null | head -1)"
}

# ── 便携包: 编一次, 其它同架构机器免编译直接装 ──
#   适用: 目标机没有编译环境/不想装一堆 -dev 包/离线环境。
#   注意 glibc 向下兼容: 老系统上编的包能在新系统跑, 反之不行 → 在机群里**最老**的
#   那台 (如 Ubuntu 24.04) 编包, 分发给更新的机器 (如 26.04)。
make_pack(){
  local out="$ROOT/backups/guacd-${VER}-$(uname -m)-$(. /etc/os-release 2>/dev/null; echo "${VERSION_ID:-unknown}").tar.gz"
  local stage; stage="$(mktemp -d)"
  mkdir -p "$stage/guacd/lib" "$stage/guacd/bin" "$stage/guacd/sbin"
  cp -a "$PREFIX"/sbin/guacd "$stage/guacd/sbin/" 2>/dev/null || true
  cp -a "$PREFIX"/bin/guacenc "$PREFIX"/bin/guaclog "$stage/guacd/bin/" 2>/dev/null || true
  cp -a "$PREFIX"/lib/libguac*.so* "$stage/guacd/lib/" 2>/dev/null || true
  # 依赖的第三方 so 不打包 (由目标机 apt 提供), 只带 guacamole 自身产物
  cat > "$stage/guacd/install.sh" <<'INS'
#!/usr/bin/env bash
# 便携包安装: 拷贝到 /usr/local + 注册 systemd 服务 (目标机需已装运行库:
#   freerdp2/freerdp3 · libvncserver · libssh2 · libtelnet · libwebsockets · libpng · libjpeg · libwebp · libcairo · libpulse)
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${PREFIX:-/usr/local}"
install -d "$PREFIX"/{sbin,bin,lib}
cp -a "$D"/sbin/guacd "$PREFIX/sbin/" 2>/dev/null || true
cp -a "$D"/bin/. "$PREFIX/bin/" 2>/dev/null || true
cp -a "$D"/lib/. "$PREFIX/lib/" 2>/dev/null || true
ldconfig 2>/dev/null || true
if command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/guacd.service <<UNIT
[Unit]
Description=Guacamole proxy daemon (guacd) - Fonriv 远程桌面网关
After=network.target
[Service]
Type=simple
ExecStart=$PREFIX/sbin/guacd -b 0.0.0.0 -l 4822 -f
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload; systemctl enable guacd >/dev/null 2>&1; systemctl restart guacd; sleep 2
  systemctl is-active guacd >/dev/null && echo "[pack] ✓ guacd 已作为服务运行" || echo "[pack] ✗ 启动失败, 看 journalctl -u guacd"
fi
echo "[pack] 完成 · 可用 bash build_guacd.sh --pack 在别处再打包"
INS
  chmod +x "$stage/guacd/install.sh"
  { echo "guacd 便携包 · guacamole-server ${VER}"; echo "构建于: $(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME") $(uname -m) · glibc $(ldd --version | head -1 | awk '{print $NF}')"; echo "构建时间: $(date -Iseconds)"; echo "包含: $(ls "$stage/guacd/bin" 2>/dev/null | tr '\n' ' ') + sbin/guacd + $(ls "$stage/guacd/lib" | wc -l) 个库"; echo "注意: glibc 向下兼容 —— 老系统编的包可用于新系统, 反之不行。"; } > "$stage/guacd/README.txt"
  tar czf "$out" -C "$stage" guacd
  rm -rf "$stage"
  log "✓ 便携包: $out ($(du -h "$out" | cut -f1)) — 拷到目标机解包后 sudo bash guacd/install.sh"
}

main(){
  log "== guacd 源码部署 (v${VER} → ${PREFIX}) =="
  if [[ $EUID -ne 0 ]]; then
    log "需要 root (安装到 ${PREFIX} 并写 systemd 单元)。请用: sudo bash $0 $*"
    exit 1
  fi
  install_deps
  build
  setup_service
  [[ "$PACK" == "1" ]] && make_pack
  log "完成。Fonriv 的「远程桌面 → RDP 网关」里点「检测网关」应显示就绪。"
  log "卸载: systemctl disable --now guacd && rm -rf ${PREFIX}/sbin/guacd ${PREFIX}/lib/libguac* /etc/systemd/system/guacd.service"
}
main "$@"

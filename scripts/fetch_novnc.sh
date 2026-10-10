#!/usr/bin/env bash
# 获取 noVNC 静态资源 (v5.20.0)
#
# 为什么 vendor 而不是用 CDN:
#   · 客户环境多为内网/离线, CDN 不可达;
#   · 远程桌面客户端是安全敏感组件, 不应运行时从第三方拉取。
#
# 用法: bash scripts/fetch_novnc.sh [版本]   默认 1.5.0
set -euo pipefail

VER="${1:-1.5.0}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DST="${REPO}/frontend/static/vendor/novnc"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "==> 下载 noVNC v${VER} ..."
URL="https://github.com/novnc/noVNC/archive/refs/tags/v${VER}.tar.gz"
if ! curl -fsSL -o "${TMP}/novnc.tar.gz" "${URL}"; then
  echo "✗ 下载失败: ${URL}" >&2
  echo "  离线环境请在联网机器上下载后, 手动解压出 core/ vendor/ vnc_lite.html LICENSE.txt" >&2
  echo "  放到: ${DST}/" >&2
  exit 1
fi

tar -xzf "${TMP}/novnc.tar.gz" -C "${TMP}"
SRC="$(find "${TMP}" -maxdepth 1 -type d -name 'noVNC-*' | head -1)"
[[ -n "${SRC}" ]] || { echo "✗ 解压后未找到 noVNC 目录" >&2; exit 1; }

echo "==> 安装到 frontend/static/vendor/novnc ..."
rm -rf "${DST}"
mkdir -p "${DST}"
# 只取 vnc_lite.html 需要的运行集: core/ + vendor/(pako) + 许可
cp -r "${SRC}/core" "${DST}/"
cp -r "${SRC}/vendor" "${DST}/"
cp "${SRC}/vnc_lite.html" "${DST}/"
cp "${SRC}/LICENSE.txt" "${DST}/"

# 版本留痕: 便于日后核对与升级
printf 'noVNC %s\n来源: %s\n许可: MPL-2.0 (见同目录 LICENSE.txt)\n抓取时间: %s\n' \
  "${VER}" "${URL}" "$(date '+%Y-%m-%d %H:%M:%S')" > "${DST}/VERSION"

echo "✓ 完成: ${DST}"
du -sh "${DST}" 2>/dev/null | awk '{print "  体积:", $1}'
echo "  文件数: $(find "${DST}" -type f | wc -l)"

#!/usr/bin/env bash
# 抓取 guacamole-common-js 入库 (与 scripts/fetch_novnc.sh 同规矩)
#
# 为什么不走 CDN: 客户多为内网离线环境, 且远程桌面客户端属安全敏感组件,
#   不应在运行时从第三方拉取 (供应链风险)。
#
# 用法: bash scripts/fetch_guacamole.sh [版本, 默认 1.5.5]
set -euo pipefail
VER="${1:-1.5.5}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/frontend/static/vendor/guacamole"
URL="https://repo1.maven.org/maven2/org/apache/guacamole/guacamole-common-js/${VER}/guacamole-common-js-${VER}.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> 下载 guacamole-common-js ${VER}"
curl -fsSL -o "$TMP/g.zip" "$URL"
unzip -q "$TMP/g.zip" -d "$TMP/x"
SRC="$TMP/x/guacamole-common-js"
[ -f "$SRC/all.min.js" ] || { echo "错误: 包内未见 all.min.js" >&2; exit 1; }

mkdir -p "$DEST"
cp "$SRC/all.min.js" "$SRC/all.js" "$DEST/"
curl -fsSL -o "$DEST/LICENSE" "https://www.apache.org/licenses/LICENSE-2.0.txt" || true
cat > "$DEST/VERSION" <<EOT
guacamole-common-js ${VER} (Apache Guacamole 客户端 JS, Apache-2.0)
来源: ${URL}
入库文件: all.min.js (生产用) · all.js (未压缩, 便于排障) · LICENSE
抓取: $(date -Iseconds) · 脚本: scripts/fetch_guacamole.sh
刷新方式: bash scripts/fetch_guacamole.sh ${VER}
EOT
echo "==> 完成: $(du -sh "$DEST" | cut -f1) → frontend/static/vendor/guacamole/"

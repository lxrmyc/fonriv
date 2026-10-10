#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# Fonriv 社区版 · 生成源码 tar.gz 发行包 (与 README「方式一」的产物同名)
#
#   - 从本仓库打包(排除运行期数据/开发残留), 版本号取自 backend/version.py
#   - 打完后跑 scripts/check_publish_clean.py 硬闸复检, 命中即中止并删除产物
#   - 同时在 dist/ 落一份 .sha256
#
# 用法:  bash packaging/build_tarball.sh
# 产物:  dist/fonriv-community-v<版本>-linux-<架构>.tar.gz (+ .sha256)
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# v1.0.0 · 可复现构建: 归档内所有条目时间戳固定(默认 2026-10-10 12:00 +0800);
#   换日期:  SOURCE_DATE_EPOCH=$(date -d '2026-11-01 12:00 +0800' +%s) bash packaging/build_tarball.sh
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(date -d '2026-10-10 12:00:00 +0800' +%s)}"

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$HERE")
OUT="$REPO/dist"

VERSION=$(sed -n "s/^VERSION[[:space:]]*=[[:space:]]*[\"']\([^\"']*\)[\"'].*/\1/p" "$REPO/backend/version.py" | head -1)
[ -n "$VERSION" ] || { echo "✗ 取不到版本号 (backend/version.py)"; exit 1; }

ARCH=$(uname -m)
case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
esac

PKG="fonriv-community-v${VERSION}-linux-${ARCH}.tar.gz"
STAGE="$OUT/.tarball-stage"

echo "════════ Fonriv 源码 tar 打包 ════════"
echo "  版本: $VERSION    架构: $ARCH"
echo "  输出: $OUT/$PKG"

mkdir -p "$OUT"
rm -rf "$STAGE"; mkdir -p "$STAGE"

# ── 排除清单与 build_deb.sh 一致(运行期数据/开发残留一律不入包) ──
( cd "$REPO" && tar \
    --exclude='./venv' --exclude='./.venv' --exclude='./dist' --exclude='./backups' \
    --exclude='./data' --exclude='./backend/data' \
    --exclude='./.git' --exclude='./.zcode' --exclude='./.claude' \
    --exclude='__pycache__' --exclude='./.pytest_cache' --exclude='*.pyc' \
    --exclude='*.py.bak.*' --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' \
    --exclude='*.sqlite' --exclude='*.sqlite3' \
    --exclude='./*.pem' --exclude='./*.key' --exclude='./*_secret*' --exclude='./.env*' \
    --exclude='./nohup.out' --exclude='./.gitignore' --exclude='./.zcodeignore' \
    -cf - . ) | tar -xf - -C "$STAGE"

# ── 发布面硬闸: 敏感/数据/日志零命中 ──
if [ -f "$REPO/scripts/check_publish_clean.py" ]; then
    python3 "$REPO/scripts/check_publish_clean.py" "$STAGE" -v || {
        echo "✗ 源码包敏感自检未通过, 已中止"; rm -rf "$STAGE"; exit 1
    }
fi

rm -f "$OUT/$PKG" "$OUT/$PKG.sha256"
# 暂存树 mtime 对齐 + 排序归档 + gzip -n(不写 gzip 头时间戳) → 同内容多次构建字节一致
find "$STAGE" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
( cd "$STAGE" && LC_ALL=C tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \
    -cf - . | gzip -9n > "$OUT/$PKG" )
rm -rf "$STAGE"

( cd "$OUT" && sha256sum "$PKG" > "$PKG.sha256" )
touch -d "@$SOURCE_DATE_EPOCH" "$OUT/$PKG" "$OUT/$PKG.sha256"
echo "  文件数: $(tar -tzf "$OUT/$PKG" | wc -l)   大小: $(du -h "$OUT/$PKG" | cut -f1)"
echo "  时间戳: $(date -d "@$SOURCE_DATE_EPOCH" '+%Y-%m-%d %H:%M %z') (可复现; 用 SOURCE_DATE_EPOCH 覆盖)"
echo "  sha256: $(cut -d' ' -f1 < "$OUT/$PKG.sha256")"
echo "✓ 打包完成: $OUT/$PKG"

#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# Fonriv 社区版 · 生成 deb 安装包 (目标: Ubuntu 22.04 / Debian 12, 默认 amd64)
#
# 依赖策略(见 packaging/README.md 的决策说明):
#   官方依赖轮子(cp310 / manylinux)随包分发 → 安装时在 /opt/fonriv/venv 内建虚拟
#   环境并离线安装, **完全不碰系统 python3**, 也不需要联网。
#
# 用法:  bash packaging/build_deb.sh [--arm64] [--no-wheels]
# 产物:  dist/fonriv-community_<版本>_amd64.deb  (+ 敏感文件复检)
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# v1.0.0 · 可复现构建: 包内所有文件/ar 成员的时间戳统一固定(默认 2026-10-10 12:00 +0800),
#   需要换日期时用环境变量覆盖:  SOURCE_DATE_EPOCH=$(date -d '2026-11-01 12:00 +0800' +%s) bash packaging/build_deb.sh
#   dpkg >= 1.18.11 会按 SOURCE_DATE_EPOCH 写归档成员时间戳; 暂存树 mtime 也一并对齐。
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(date -d '2026-10-10 12:00:00 +0800' +%s)}"

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$HERE")
OUT="$REPO/dist"
DEB_ARCH="amd64"; PY_SHORT="310"; PYVER="3.10"; WHEEL_PLAT="manylinux2014_x86_64"
UNIT="fonriv"          # 服务单元名(默认 fonriv; 本机试装可用 --unit-name fonriv-app 避免与既有单元冲突)
WHEELS=1               # --no-wheels: 不打包内轮子(仅本机联网试装用, 发行包必须带轮子)
SRC=""                 # --src <dir>: 从指定目录树打包(默认打包本仓库)
PKG_NAME="fonriv-community"

while [ $# -gt 0 ]; do
    case "$1" in
        --arm64) DEB_ARCH="arm64"; WHEEL_PLAT="manylinux2014_aarch64"; shift ;;
        --py) PYVER="$2"; PY_SHORT="${2//./}"; shift 2 ;;
        --unit-name) UNIT="$2"; shift 2 ;;
        --no-wheels) WHEELS=0; shift ;;
        --src) SRC="$2"; shift 2 ;;
        --pkg-name) PKG_NAME="$2"; shift 2 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

APP_DIR="$REPO"
if [ -n "$SRC" ]; then
    [ -d "$SRC/backend" ] || { echo "✗ --src 目录无效 (缺 backend/): $SRC"; exit 1; }
    APP_DIR=$(cd "$SRC" && pwd)
fi

# ── 版本号唯一真源: backend/version.py (有 --src 时取剪枝树里的, 如社区版 1.0.0) ──
VERSION=$(sed -n "s/^VERSION[[:space:]]*=[[:space:]]*[\"']\([^\"']*\)[\"'].*/\1/p" "$APP_DIR/backend/version.py" | head -1)
[ -n "$VERSION" ] || { echo "✗ 取不到版本号 (backend/version.py)"; exit 1; }
PY_BIN="$REPO/venv/bin/python"; [ -x "$PY_BIN" ] || PY_BIN=$(command -v python3)

CACHE="$OUT/wheels/${DEB_ARCH}"
ROOT="$OUT/debroot"
PKG="${PKG_NAME}_${VERSION}_${DEB_ARCH}.deb"

# 目标 Python 版本集合: 默认同一 deb 内带 cp310(Ubuntu 22.04 / py3.10) + cp311(Debian 12 / py3.11)
#   两套轮子 —— 安装时 pip 按运行解释器自动挑选匹配的那套(--find-links 会忽略 tag 不匹配的轮子),
#   这样一个包同时覆盖 README 声明的两个目标系统。--py 指定单一版本时只带该版本。
PYVERS="$PYVER 3.11"
PYVERS=$(echo $PYVERS | tr ' ' '\n' | awk '!seen[$0]++' | tr '\n' ' ')

echo "════════ Fonriv deb 打包 ════════"
echo "  版本: $VERSION    架构: $DEB_ARCH    目标 Python: $PYVERS   单元: $UNIT.service"
echo "  输出: $OUT/$PKG"

# ── ① 依赖轮子(离线安装用; 按目标 Python 逐版本缓存) ────────────────────────
mkdir -p "$CACHE"
for V in $PYVERS; do
    S="${V//./}"
    MARK="$CACHE/.done-cp$S"
    if [ -f "$MARK" ]; then
        echo "→ 复用 cp$S 轮子缓存"
        continue
    fi
    if [ "$WHEELS" != "1" ]; then
        echo "→ --no-wheels: 跳过 cp$S 下载(安装时需 FONRIV_DEB_ALLOW_PIP_NETWORK=1 联网装依赖)"
        continue
    fi
    echo "→ 下载 cp$S 依赖轮子 ($WHEEL_PLAT / Python $V, 需要能访问 PyPI)"
    ( cd "$REPO" && "$PY_BIN" -m pip download --only-binary=:all: \
        --python-version "$V" --implementation cp --platform "$WHEEL_PLAT" \
        --abi "cp$S" --abi abi3 --abi none -d "$CACHE" -r requirements.txt )
    # py<3.11 的版本标记依赖补下: 构建机解释器高于目标时, pip 按**构建机**评估环境标记,
    #   `python_version < "3.11"` 的传递依赖(如 anyio→exceptiongroup)会被整条漏掉,
    #   离线安装必挂。新依赖若再带版本标记, 加进这一行即可。
    if [ "$V" = "3.9" ] || [ "$V" = "3.10" ]; then
        echo "→ 补下 py<3.11 版本标记依赖 (exceptiongroup / tomli)"
        "$PY_BIN" -m pip download --only-binary=:all: \
            --python-version "$V" --implementation cp --platform "$WHEEL_PLAT" \
            --abi "cp$S" --abi abi3 --abi none -d "$CACHE" \
            exceptiongroup tomli
    fi
    : > "$MARK"
done
echo "→ 包内轮子: $(ls "$CACHE"/*.whl 2>/dev/null | wc -l) 个 (覆盖 $PYVERS)"

# ── ② 应用目录树 ─────────────────────────────────────────────────────────────
#   guac.html 必须入包: guacamole 控制台客户端页(app.py /guac.html 直出), RDP 连 Windows 必需。
rm -rf "$ROOT"
mkdir -p "$ROOT/DEBIAN" "$ROOT/opt/fonriv" "$ROOT/usr/lib/systemd/system" \
         "$ROOT/etc/fonriv" "$ROOT/etc/logrotate.d" "$ROOT/var/lib/fonriv"
( cd "$APP_DIR" && tar \
    --exclude='./venv' --exclude='./.venv' --exclude='./dist' --exclude='./packaging' \
    --exclude='./backups' --exclude='./data' --exclude='./backend/data' \
    --exclude='./scripts' --exclude='./.git' --exclude='./.zcode' --exclude='./.claude' \
    --exclude='__pycache__' --exclude='./.pytest_cache' --exclude='*.pyc' \
    --exclude='*.py.bak.*' --exclude='*.db' --exclude='*.db-shm' --exclude='*.db-wal' \
    --exclude='*.sqlite' --exclude='*.sqlite3' \
    --exclude='./*.pem' --exclude='./*.key' --exclude='./*_secret*' --exclude='./.env*' \
    --exclude='./nohup.out' --exclude='./.gitignore' --exclude='./.zcodeignore' \
    -cf - . ) | tar -xf - -C "$ROOT/opt/fonriv"

# ── ②b scripts/ 白名单 (deb 用户只需运行期脚本; 开发/发布工具不进包) ─────────
mkdir -p "$ROOT/opt/fonriv/scripts"
for s in install.sh apply_update.sh features.json build_guacd.sh; do
    if [ -f "$APP_DIR/scripts/$s" ]; then
        install -m 0644 "$APP_DIR/scripts/$s" "$ROOT/opt/fonriv/scripts/$s"
    fi
done
[ -f "$ROOT/opt/fonriv/scripts/apply_update.sh" ] || { echo "✗ 缺少 scripts/apply_update.sh (在线更新会失效)"; exit 1; }
[ -f "$ROOT/opt/fonriv/scripts/features.json" ] || { echo "✗ 缺少 scripts/features.json (vitals 真源)"; exit 1; }

# 轮子 + 依赖清单(离线安装用)
mkdir -p "$ROOT/opt/fonriv/wheels"
cp "$CACHE"/*.whl "$ROOT/opt/fonriv/wheels/"
install -m 0644 "$APP_DIR/requirements.txt" "$ROOT/opt/fonriv/requirements.txt"

# ── ③ 服务单元 / 配置 / 日志轮转 / 维护脚本 ────────────────────────────────
install -m 0644 "$HERE/debian/fonriv.service" "$ROOT/usr/lib/systemd/system/$UNIT.service"
install -m 0640 "$HERE/debian/fonriv.conf"    "$ROOT/etc/fonriv/fonriv.conf"
install -m 0644 "$HERE/debian/logrotate"      "$ROOT/etc/logrotate.d/fonriv"
for s in preinst postinst prerm postrm; do
    sed -e "s/__VERSION__/$VERSION/" -e "s/__UNIT__/$UNIT/" "$HERE/debian/$s" > "$ROOT/DEBIAN/$s"
    chmod 0755 "$ROOT/DEBIAN/$s"
done
sed -e "s/__UNIT__/$UNIT/" "$HERE/debian/conffiles" > "$ROOT/DEBIAN/conffiles"
SIZE=$(du -sk "$ROOT" | cut -f1)
# 社区版描述模板 (与实物一致: 不含 FonrVFS/存储卷等未随包能力)
CTRL_TPL="$HERE/debian/control.community.in"
sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$DEB_ARCH/" -e "s/@SIZE@/$SIZE/" \
    -e "s/^Package: fonriv$/Package: ${PKG_NAME}/" \
    "$CTRL_TPL" > "$ROOT/DEBIAN/control"
# 改名包接管旧包: 装了旧 fonriv 的机器升级到 fonriv-community 时,
#   Replaces+Breaks 让 dpkg 自动移除旧包(文件/服务平滑过渡, /var/lib/fonriv 数据不动)
if [ "$PKG_NAME" != "fonriv" ]; then
    printf 'Replaces: fonriv\nBreaks: fonriv\nProvides: fonriv\n' >> "$ROOT/DEBIAN/control"
fi
# 维护脚本语法自检(装上去才发现写错了就晚了)
for s in preinst postinst prerm postrm; do
    bash -n "$ROOT/DEBIAN/$s" || { echo "✗ $s 语法错误"; exit 1; }
done
"$PY_BIN" -c "import ast,sys;ast.parse(open('$ROOT/opt/fonriv/server.py').read())" 2>/dev/null || true

# ── ④ 打包 (可复现: 暂存树 mtime 对齐 + SOURCE_DATE_EPOCH 固定成员时间戳) ────
mkdir -p "$OUT"; rm -f "$OUT/$PKG"
find "$ROOT" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
dpkg-deb --build --root-owner-group "$ROOT" "$OUT/$PKG" >/dev/null

# ── ⑤ 产物复检(敏感文件必须零命中) ─────────────────────────────────────────
echo "→ 复检产物"
LIST=$(dpkg-deb --contents "$OUT/$PKG")
LEAK=$(echo "$LIST" | grep -E '\.pem$|\.key$|\.crt$|/data/|\.db$|\.fernet|e2ee_identity|relay_staging|\.log(\.\d+)?$|nohup\.out$|\.gitignore|\.zcodeignore|pytest\.ini|license\.abi3\.so|edition_gate\.abi3\.so' || true)
if [ -n "$LEAK" ]; then
    echo "✗ 产物含敏感/开发文件, 已中止:"; echo "$LEAK" | head -10; rm -f "$OUT/$PKG"; exit 1
fi
# 与 release.sh 同一把尺: 内容级敏感扫描(私钥块等机密痕迹)
if [ -f "$REPO/scripts/check_publish_clean.py" ]; then
    python3 "$REPO/scripts/check_publish_clean.py" "$ROOT/opt/fonriv" || {
        echo "✗ deb 内容敏感自检未通过, 已中止"; rm -f "$OUT/$PKG"; exit 1
    }
fi
CNT=$(echo "$LIST" | wc -l)
echo "  文件数: $CNT   大小: $(du -h "$OUT/$PKG" | cut -f1)"
dpkg-deb --info "$OUT/$PKG" | sed -n '1,12p'
# 注意: 必须用 here-string 而不是 echo|grep -q —— 后者在 set -o pipefail 下会因
#   grep -q 提前退出触发 SIGPIPE(141), 把"匹配成功"误判成失败(实测踩到过)
for need in 'opt/fonriv/wheels/' 'opt/fonriv/frontend/index.html' 'opt/fonriv/server.py' \
            'opt/fonriv/backend/license.py' 'opt/fonriv/backend/edition_gate.py' \
            "usr/lib/systemd/system/$UNIT.service"; do
    grep -q "$need" <<<"$LIST" || { echo "✗ 产物缺少必需内容: $need"; exit 1; }
done
echo "  必需内容检查通过 (轮子/前端/入口/授权模块/服务单元)"
( cd "$OUT" && sha256sum "$PKG" > "$PKG.sha256" )
touch -d "@$SOURCE_DATE_EPOCH" "$OUT/$PKG" "$OUT/$PKG.sha256"
echo "  sha256: $(cut -d' ' -f1 < "$OUT/$PKG.sha256")"
echo "  时间戳: $(date -d "@$SOURCE_DATE_EPOCH" '+%Y-%m-%d %H:%M %z') (可复现; 用 SOURCE_DATE_EPOCH 覆盖)"
echo "✓ 打包完成: $OUT/$PKG"

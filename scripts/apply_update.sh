#!/bin/bash
# v6.2.0 · Fonriv 在线更新应用脚本 (由 backend/handlers/update.py 下载校验后调用)
#
# 为什么是外部脚本: 服务进程不能覆盖正在运行的自身代码 —— 本脚本在**进程外**执行:
#   ① 备份当前版本到 updates/backup-<时间戳>/ (仅代码目录, 不动 data/)
#   ② 解包新版到临时目录, 校验结构后原子替换代码
#   ③ 结束旧进程, 用相同参数重新拉起, 轮询 /api/version 确认新版本已生效
#   ④ 任一步失败 → 回滚到备份 (update.log 有完整记录)
#
# 用法: apply_update.sh <包路径.tar.gz> <版本号> [端口]
# 说明: 包内应为项目根布局(server.py/backend/frontend/... 直接在包根, 或包根含单层顶层目录)
set -uo pipefail

PKG="${1:?用法: apply_update.sh <包> <版本> [端口]}"
VER="${2:?缺少版本号}"
PORT="${3:-${FONRIV_EFFECTIVE_PORT:-${FONRIV_PORT:-8000}}}"
HOST="${4:-0.0.0.0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPD="$ROOT/updates"
LOG="$ROOT/data/update.log"
TS="$(date +%Y%m%d-%H%M%S)"
BK="$UPD/backup-$TS"
STAGE="$UPD/stage-$VER"

mkdir -p "$UPD" "$ROOT/data"
exec >>"$LOG" 2>&1

log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] [apply] $*"; }
log "===== 开始应用更新 v$VER (端口 $PORT, 根 $ROOT) ====="

fail(){
  log "✗ 失败: $1"
  if [ -d "$BK" ]; then
    log "↩ 正在回滚…"
    for d in backend frontend scripts; do
      [ -e "$BK/$d" ] && rm -rf "$ROOT/$d" && cp -a "$BK/$d" "$ROOT/$d"
    done
    for f in server.py requirements.txt; do
      [ -e "$BK/$f" ] && cp -a "$BK/$f" "$ROOT/$f"
    done
    log "↩ 回滚完成 (代码已还原到 v$OLD_VER 备份)"
  fi
  exit 1
}

# 0) 记录当前版本
OLD_VER="$(cd "$ROOT" && python3 -c "from backend.version import VERSION; print(VERSION)" 2>/dev/null || echo unknown)"
log "当前版本 v$OLD_VER"

# 1) 备份
log "① 备份代码到 $BK"
mkdir -p "$BK"
for d in backend frontend scripts; do [ -d "$ROOT/$d" ] && cp -a "$ROOT/$d" "$BK/$d"; done
for f in server.py requirements.txt; do [ -f "$ROOT/$f" ] && cp -a "$ROOT/$f" "$BK/$f"; done
[ -d "$BK/backend" ] || fail "备份未生成 backend/, 中止(不可能安全替换)"

# 2) 解包 + 结构校验
log "② 解包到 $STAGE"
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -xzf "$PKG" -C "$STAGE" || fail "解包失败"
# 兼容包根含单层目录 (fonriv-6.0.5/…)
SRC="$STAGE"
if [ ! -f "$STAGE/server.py" ] && [ -d "$STAGE" ]; then
  inner="$(find "$STAGE" -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -n "$inner" ] && [ -f "$inner/server.py" ] && SRC="$inner"
fi
[ -f "$SRC/server.py" ] || fail "包结构不对: 找不到 server.py"
[ -d "$SRC/backend" ] || fail "包结构不对: 找不到 backend/"
NEW_VER="$(cd "$SRC" && python3 -c "from backend.version import VERSION; print(VERSION)" 2>/dev/null || echo unknown)"
log "包内版本 v$NEW_VER (期望 v$VER)"
if [ "$NEW_VER" != "unknown" ] && [ "$NEW_VER" != "$VER" ]; then
  fail "包内版本($NEW_VER)与清单版本($VER)不一致, 拒绝应用"
fi

# 3) 原子替换 (先删旧再加新, 保证不会新旧混杂)
log "③ 替换代码"
for d in backend frontend scripts; do
  [ -d "$SRC/$d" ] || { log "  包内无 $d/, 跳过"; continue; }
  rm -rf "$ROOT/$d" && cp -a "$SRC/$d" "$ROOT/$d" || fail "替换 $d 失败"
done
for f in server.py requirements.txt CHANGELOG.md; do
  [ -f "$SRC/$f" ] && cp -a "$SRC/$f" "$ROOT/$f"
done
log "  代码替换完成 v$OLD_VER → v$NEW_VER"

# 4) 依赖更新 (requirements 有变化时才装)
log "④ 依赖同步"
cd "$ROOT" || fail "cd 失败"
PY="${FONRIV_PY:-}"
[ -x "$PY" ] || PY="$ROOT/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
if [ -f "$BK/requirements.txt" ] && [ -f "$ROOT/requirements.txt" ] && \
   ! cmp -s "$BK/requirements.txt" "$ROOT/requirements.txt"; then
  log "  requirements 有变化, 安装依赖…"
  "$PY" -m pip install -q -r requirements.txt || log "  ⚠ 依赖安装失败(继续, 可能不影响)"
else
  log "  requirements 无变化, 跳过"
fi

# 5) 重启服务
log "⑤ 重启服务 (端口 $PORT)"
OLD_PIDS="$(pgrep -f "server\.py.*--port[ =]$PORT" || true)"
if [ -n "$OLD_PIDS" ]; then
  log "  结束旧进程: $OLD_PIDS"
  kill $OLD_PIDS 2>/dev/null
  for i in $(seq 1 15); do
    sleep 1
    pgrep -f "server\.py.*--port[ =]$PORT" >/dev/null || break
  done
  pgrep -f "server\.py.*--port[ =]$PORT" >/dev/null && { log "  旧进程未退出, 强制结束"; kill -9 $(pgrep -f "server\.py.*--port[ =]$PORT") 2>/dev/null; sleep 1; }
else
  log "  ⚠ 未找到运行中的旧进程(可能手动启动/端口不同), 仅启动新进程"
fi
nohup "$PY" "$ROOT/server.py" --host "$HOST" --port "$PORT" >>"$ROOT/data/server.log" 2>&1 &
NEW_PID=$!
log "  新进程 PID=$NEW_PID, 等待就绪…"

# 6) 健康检查
OK=0
for i in $(seq 1 30); do
  sleep 2
  RUNNING_VER="$(curl -sL -m 3 "http://127.0.0.1:$PORT/api/version" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || true)"
  if [ -n "$RUNNING_VER" ]; then
    log "  就绪: 运行版本 v$RUNNING_VER"
    [ "$RUNNING_VER" = "$VER" ] && OK=1
    break
  fi
done
if [ "$OK" != "1" ]; then
  log "✗ 健康检查未通过(新版本未确认)"
  fail "重启后健康检查失败"
fi

log "✓ 更新完成: v$OLD_VER → v$RUNNING_VER (PID=$NEW_PID)"
log "  备份保留于: $BK (确认稳定后可手动删除)"
rm -rf "$STAGE"
exit 0

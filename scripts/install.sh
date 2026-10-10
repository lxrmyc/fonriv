#!/usr/bin/env bash
# Fonriv · 生产环境一键安装脚本
# v4.11.0
#
# 用法:
#   sudo bash scripts/install.sh                # 交互式
#   sudo bash scripts/install.sh --yes          # 全部默认 (0.0.0.0:8000 · user=root)
#   sudo bash scripts/install.sh --host 127.0.0.1 --port 9000 --user myuser --yes
#
# 会做的事:
#   1. 检测 python3 (>=3.8) / rsync / sshpass · 缺则 apt install
#   2. 创建 systemd service · 用当前 repo 目录 · venv 内 python
#   3. 生成 /etc/default/fonriv 环境变量文件 (HOST/PORT/LOG_LEVEL)
#   4. systemctl daemon-reload + enable + start
#   5. curl 探活验证
#
# 需要 root。不建议在 LXC 里同一进程既开发又生产。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

HOST="0.0.0.0"
PORT="8000"
LOG_LEVEL="info"
RUN_USER="root"          # 默认 root · 因为 rsync/vzdump/qm 通常需要 root
UNIT_NAME="fonriv.service"
ASSUME_YES=0
UNINSTALL=0

log() { echo -e "\033[1;36m[install]\033[0m $*"; }
warn(){ echo -e "\033[1;33m[warn ]\033[0m $*" >&2; }
die() { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

usage() {
  cat <<EOF
用法: sudo bash scripts/install.sh [选项]

选项:
  --host <ip>       监听地址 (默认 0.0.0.0)
  --port <n>        监听端口 (默认 8000)
  --user <name>     运行用户 (默认 root)
  --log-level <lv>  uvicorn 日志级别 (默认 info)
  --unit <name>     systemd 单元名 (默认 fonriv.service)
  --uninstall       停止并移除 systemd 单元
  --yes / -y        跳过所有交互确认
  --help / -h       打印本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --user) RUN_USER="$2"; shift 2;;
    --log-level) LOG_LEVEL="$2"; shift 2;;
    --unit) UNIT_NAME="$2"; shift 2;;
    --uninstall) UNINSTALL=1; shift;;
    -y|--yes) ASSUME_YES=1; shift;;
    -h|--help) usage; exit 0;;
    *) die "未知参数: $1 (用 --help 查看)";;
  esac
done

[[ "${EUID}" -eq 0 ]] || die "本脚本需要 root 权限 (sudo bash scripts/install.sh ...)"

UNIT_PATH="/etc/systemd/system/${UNIT_NAME}"
DEFAULT_FILE="/etc/default/fonriv"

# ---------- uninstall ----------
if [[ "${UNINSTALL}" -eq 1 ]]; then
  log "停止并移除 ${UNIT_NAME} ..."
  systemctl stop "${UNIT_NAME}" 2>/dev/null || true
  systemctl disable "${UNIT_NAME}" 2>/dev/null || true
  rm -f "${UNIT_PATH}"

  systemctl daemon-reload
  log "已卸载 (保留 ${DEFAULT_FILE} 与 repo 目录)"
  exit 0
fi

# ---------- 依赖检查 (v4.41.5 · 多发行版自动适配) ----------
log "检查系统依赖 ..."

# 发行版/包管理器探测: apt (Debian/Ubuntu) / dnf-yum (RHEL/CentOS/Rocky/Alma/Fedora) /
# pacman (Arch) / zypper (openSUSE) / apk (Alpine)
PKG=""
if command -v apt-get >/dev/null 2>&1; then
  PKG="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"
elif command -v pacman >/dev/null 2>&1; then
  PKG="pacman"
elif command -v zypper >/dev/null 2>&1; then
  PKG="zypper"
elif command -v apk >/dev/null 2>&1; then
  PKG="apk"
fi
[[ -n "${PKG}" ]] || warn "未识别包管理器 (非 apt/dnf/yum/pacman/zypper/apk)，跳过自动安装，缺包时请手动补"
log "检测到发行版包管理器: ${PKG:-unknown}"

# 各发行版包名映射: bash 关联数组 (bash 4+)
declare -A PKGS_BIN=(
  [apt]="rsync openssh-client sshpass curl"
  [dnf]="rsync openssh-clients sshpass curl"
  [yum]="rsync openssh-clients sshpass curl"
  [pacman]="rsync openssh sshpass curl"
  [zypper]="rsync openssh sshpass curl"
  [apk]="rsync openssh-client sshpass curl"
)
# python3-venv 包名 (仅 Debian/Ubuntu 需要 · Debian 12/Ubuntu 24.04 默认不带 ensurepip)
declare -A PKGS_VENV=(
  [apt]="python3-venv python3-pip"
  [dnf]="python3-pip"
  [yum]="python3-pip"
  [pacman]="python-pip"
  [zypper]="python3-pip"
  [apk]="py3-pip"
)

install_pkgs() {
  # $@ = 待装包名列表
  case "${PKG}" in
    apt)    apt-get update -y || true; apt-get install -y "$@" ;;
    dnf)    dnf install -y "$@" ;;
    yum)    yum install -y "$@" ;;
    pacman) pacman -Sy --noconfirm "$@" ;;
    zypper) zypper --non-interactive install "$@" ;;
    apk)    apk add "$@" ;;
    *)      warn "无包管理器，请手动安装: $*"; return 1 ;;
  esac
}

confirm_install() {
  # $@ = 待装包名列表; 返回 0=同意
  if [[ "${ASSUME_YES}" -eq 1 ]]; then return 0; fi
  read -r -p "自动 ${PKG} install $* ? [Y/n] " ans
  ans="${ans:-Y}"
  [[ "${ans}" =~ ^[Yy] ]]
}

missing=()
for bin in python3 rsync ssh sshpass curl; do
  command -v "${bin}" >/dev/null 2>&1 || missing+=("${bin}")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  warn "缺少命令: ${missing[*]}"
  if [[ -n "${PKG}" ]] && confirm_install "${PKGS_BIN[${PKG}]}"; then
    install_pkgs ${PKGS_BIN[${PKG}]}
  else
    die "请手动安装后重跑本脚本: ${missing[*]}"
  fi
fi

# python3 版本检查 (>=3.8)
py_ver="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo 0)"
if [[ "$(echo "${py_ver} < 3.8" | bc 2>/dev/null || echo 1)" == "1" && "${py_ver}" != "0" ]]; then
  py_ok="$(python3 - <<'PYEOF'
import sys
sys.exit(0 if sys.version_info >= (3, 8) else 1)
PYEOF
)"
  if [[ "${py_ok}" -ne 0 ]]; then
    die "python3 版本过低: ${py_ver} (需要 >=3.8)"
  fi
fi

# ---------- venv (v4.41.5 · python3-venv 自动补装) ----------
VENV_DIR="${REPO_DIR}/venv"
if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  log "创建 venv @ ${VENV_DIR}"
  # Debian/Ubuntu 的 python3 默认不带 ensurepip -> venv 创建失败且只留残壳目录
  # 注意: Debian/Ubuntu 的 venv ensurepip 报错打到 stdout (非 stderr), 必须 2>&1 合并捕获
  if ! python3 -m venv "${VENV_DIR}" >/tmp/fonriv_venv_err.log 2>&1; then
    if grep -qi "ensurepip" /tmp/fonriv_venv_err.log 2>/dev/null; then
      warn "python3 缺 ensurepip (Debian/Ubuntu 需 python3-venv 包)，尝试自动补装 ..."
      rm -rf "${VENV_DIR}"
      if [[ -n "${PKG}" ]] && confirm_install "${PKGS_VENV[${PKG}]}"; then
        install_pkgs ${PKGS_VENV[${PKG}]}
        python3 -m venv "${VENV_DIR}" || die "补装 python3-venv 后 venv 仍创建失败，请查看 /tmp/fonriv_venv_err.log"
      else
        die "缺少 python3-venv。Debian/Ubuntu: apt install python3-venv; 其他发行版安装对应 python3-pip 后重试"
      fi
    else
      cat /tmp/fonriv_venv_err.log >&2 || true
      die "venv 创建失败 (非 ensurepip 原因)"
    fi
  fi
fi
# venv 健壮性: 残壳目录 (有 bin/ 无 pip) 同样触发补装
if [[ ! -x "${VENV_DIR}/bin/pip" ]]; then
  warn "venv 缺 pip (残壳)，重建 venv ..."
  rm -rf "${VENV_DIR}"
  if ! python3 -m venv "${VENV_DIR}"; then
    if [[ -n "${PKG}" ]]; then
      install_pkgs ${PKGS_VENV[${PKG}]}
      rm -rf "${VENV_DIR}"
      python3 -m venv "${VENV_DIR}" || die "重建 venv 失败"
    else
      die "重建 venv 失败且无法自动安装依赖包"
    fi
  fi
fi
log "安装 Python 依赖 ..."
"${VENV_DIR}/bin/pip" install --upgrade pip >/dev/null
"${VENV_DIR}/bin/pip" install -r "${REPO_DIR}/requirements.txt"

# ---------- /etc/default/fonriv ----------
log "写入 ${DEFAULT_FILE}"
cat > "${DEFAULT_FILE}" <<EOF
# Fonriv 环境变量 · 由 scripts/install.sh 生成
FONRIV_HOST=${HOST}
FONRIV_PORT=${PORT}
FONRIV_LOG_LEVEL=${LOG_LEVEL}
EOF
chmod 644 "${DEFAULT_FILE}"

# ---------- systemd unit ----------
log "写入 ${UNIT_PATH}"
cat > "${UNIT_PATH}" <<EOF
[Unit]
Description=Fonriv · B/S rsync + PVE 备份管理
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${DEFAULT_FILE}
ExecStart=${VENV_DIR}/bin/python ${REPO_DIR}/server.py
Restart=on-failure
RestartSec=5
# 让子进程也能收到 SIGTERM 干净退出
KillMode=mixed
TimeoutStopSec=20
# 日志走 journald
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fonriv

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "${UNIT_PATH}"

log "systemctl daemon-reload"
systemctl daemon-reload

log "enable + restart ${UNIT_NAME}"
systemctl enable "${UNIT_NAME}"
systemctl restart "${UNIT_NAME}"

# ---------- 探活 ----------
log "等待服务就绪 ..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/"; then
    log "✓ HTTP 200 @ http://${HOST}:${PORT}/"
    break
  fi
  sleep 1
  [[ "${i}" -eq 10 ]] && warn "服务未在 10s 内响应，检查: journalctl -u ${UNIT_NAME} -e"
done

log "完成 ✓"
log "  日志:  journalctl -u ${UNIT_NAME} -f"
log "  重启:  systemctl restart ${UNIT_NAME}"
log "  停止:  systemctl stop ${UNIT_NAME}"
log "  卸载:  sudo bash scripts/install.sh --uninstall"

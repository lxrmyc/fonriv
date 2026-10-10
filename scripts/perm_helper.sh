#!/usr/bin/env bash
# Fonriv · 特权操作受控 helper (v6.16.23 批40 · 普通用户运行模式)
#
# 设计(报告"特权分离"建议的落地): 服务以普通用户 fonriv 运行时, 特权动作经本 helper
# 以 sudo 白名单方式执行 —— sudoers 只放行这一个脚本, 脚本内部做**动作白名单 + 参数校验**:
#   · mount/umount: 挂载点必须位于 /var/lib/fonriv_mounts/ 之下; 命令串禁止 ; | & ` $( 换行
#   · restart:      仅允许重启 fonriv 自身单元
#   · switch-user:  仅允许 root ↔ fonriv 双向切换(写 systemd drop-in + chown 数据 + 重启,
#                   切换失败自动回滚, 保证服务存活)
#   · deps-install: 包名白名单正则, 仅 apt 系
# 本脚本 root:root 0755 —— 非 root 用户不可写; 由「切换到普通用户」动作按需安装/更新。
set -u

MNT_ROOT="/var/lib/fonriv_mounts"
UNIT="fonriv"
DROPIN_DIR="/etc/systemd/system/${UNIT}.service.d"
DROPIN="${DROPIN_DIR}/50-runuser.conf"
APP_ROOT="/opt/fonriv"
DATA_DIR="/var/lib/fonriv"
RUN_USER="fonriv"

log() { echo "[perm-helper] $*"; }
die() { echo "[perm-helper] ✗ $*" >&2; exit 1; }

# 命令串安全校验: 禁止 shell 元字符(防注入), 挂载点前缀校验
safe_cmd() { # $1=完整命令串  $2=必须以哪个命令开头
  case "$1" in "$2 "*) ;; *) die "命令必须以 '$2' 开头";; esac
  case "$1" in *';'*|*'|'*|*'&'*|*'`'*|*'$('*|*'
'*) die "命令含被禁止的 shell 元字符";; esac
}

mnt_in_scope() { # 校验字符串里出现的挂载点路径前缀
  case "$1" in
    ${MNT_ROOT}/*|*" ${MNT_ROOT}/"*|*"-t "*|"${MNT_ROOT}") return 0;;
  esac
  echo "$1" | grep -q "${MNT_ROOT}/" || die "挂载点必须在 ${MNT_ROOT}/ 之下"
}

cmd="${1:-}"; shift || true
case "$cmd" in

  mount)
    [ $# -ge 1 ] || die "用法: perm_helper.sh mount <mount 命令参数...>"
    for a in "$@"; do
      case "$a" in *';'*|*'|'*|*'&'*|*'`'*|*'$('*) die "参数含被禁止字符";; esac
    done
    # 挂载点 = 最后一个非选项参数; 必须在共享挂载根之下
    mnt=""
    for a in "$@"; do case "$a" in -*) ;; *) mnt="$a";; esac; done
    [ -n "$mnt" ] || die "未识别到挂载点"
    case "$mnt" in ${MNT_ROOT}/*) ;; *) die "挂载点必须在 ${MNT_ROOT}/ 之下: $mnt";; esac
    exec /usr/bin/mount "$@"
    ;;

  umount)
    [ $# -ge 1 ] || die "用法: perm_helper.sh umount <挂载点> [-l]"
    for a in "$@"; do
      case "$a" in
        -l) ;;
        ${MNT_ROOT}/*) ;;
        *) die "卸载目标必须在 ${MNT_ROOT}/ 之下: $a";;
      esac
    done
    exec /usr/bin/umount "$@"
    ;;

  restart)
    # 仅允许重启 fonriv 自身 (升级/设置页重启按钮的普通用户通道)
    exec /usr/bin/systemctl restart "$UNIT"
    ;;

  switch-user)
    # $1 = fonriv | root  (双向切换; 失败自动回滚)
    target="${1:-}"; [ -n "$target" ] || die "用法: perm_helper.sh switch-user <fonriv|root>"
    mkdir -p "$DROPIN_DIR"
    backup=""
    [ -f "$DROPIN" ] && backup=$(cat "$DROPIN" 2>/dev/null || true)
    if [ "$target" = "fonriv" ]; then
      id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_USER" || die "创建用户 $RUN_USER 失败"
      printf '[Service]\nUser=%s\nGroup=%s\n' "$RUN_USER" "$RUN_USER" > "$DROPIN" || die "写 drop-in 失败"
      # v6.16.23 实测修复(两层): ① /opt/fonriv 默认 0750 root:root → 受限用户 CHDIR 失败
      #   (status=200/CHDIR); ② backend 部分文件 0600 root → PermissionError 导入即崩。
      #   统一放开**组**读权限(组=r-x 语义, other 不动), 切回 root 时还原组。
      chgrp -R "$RUN_USER" "$APP_ROOT" 2>/dev/null || true
      chmod -R g+rX "$APP_ROOT" 2>/dev/null || true
      chmod 0750 "$APP_ROOT" 2>/dev/null || true
    elif [ "$target" = "root" ]; then
      rm -f "$DROPIN"
      chgrp -R root "$APP_ROOT" 2>/dev/null || true
      chmod -R g+rX "$APP_ROOT" 2>/dev/null || true
      chmod 0750 "$APP_ROOT" 2>/dev/null || true
    else
      die "目标仅支持 fonriv | root"
    fi
    chown -R "$target:$target" "$DATA_DIR" 2>/dev/null || true
    [ -f /var/log/fonriv.log ] && chown "$target:$target" /var/log/fonriv.log 2>/dev/null || true
    systemctl daemon-reload || true
    systemctl restart "$UNIT" || true
    # v6.16.23 实测增强: restart 后立即 is-active 是瞬时假阳性(Type=simple 刚 start 即
    #   active, 进程秒崩要再等一会) → 观察期 5s 后再判, 判定含 MainPID 存活
    sleep 5
    if systemctl is-active --quiet "$UNIT" \
       && [ "$(systemctl show "$UNIT" -p MainPID --value)" != "0" ]; then
      log "✓ 已切换运行用户为 $target"
      exit 0
    fi
    # ── 回滚: 服务起不来 → 恢复原 drop-in 并重启 ──
    log "✗ 切换后服务未存活, 自动回滚…"
    if [ -n "$backup" ]; then printf '%s' "$backup" > "$DROPIN"; else rm -f "$DROPIN"; fi
    chown -R "root:root" "$DATA_DIR" 2>/dev/null || true
    systemctl daemon-reload || true
    systemctl restart "$UNIT" || true
    die "已回滚到原运行用户"
    ;;

  deps-install)
    # $@ = 包名(白名单正则), 仅 apt 系(依赖一键安装的普通用户通道)
    [ $# -ge 1 ] || die "用法: perm_helper.sh deps-install <包名...>"
    for p in "$@"; do
      echo "$p" | grep -qE '^[a-z0-9][a-z0-9.+-]*$' || die "非法包名: $p"
    done
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    exec apt-get install -y "$@"
    ;;

  *)
    die "未知动作: $cmd (支持: mount | umount | restart | switch-user | deps-install)"
    ;;
esac

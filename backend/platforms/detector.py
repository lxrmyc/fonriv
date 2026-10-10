"""SSH 探针：一次跑一批只读命令，拿回来解析成结构化 dict。

关键设计：
  - 单次 SSH 调用（用 ---SEPARATOR--- 分段），减少 round-trip。
  - 全部只读命令，绝不写盘、绝不改配置 —— 符合"OMV 不能动数据"约束。
  - 每段命令失败不影响其他段，用 `|| echo __NA__` 兜底。
"""

# 每个探针段的定义：(key, shell)
# 顺序即输出顺序；shell 要保证幂等 + 只读 + 快 (< 200ms)
_SEGMENTS = [
    ("uname",       "uname -a"),
    ("os_release",  "cat /etc/os-release 2>/dev/null || echo __NA__"),
    ("hostname",    "hostname 2>/dev/null || echo __NA__"),
    # 平台指纹（各段独立，命中一个不影响其他）
    ("pve_version_file", "[ -f /etc/pve/.version ] && echo YES || echo NO"),
    ("pveversion_cmd",   "command -v pveversion >/dev/null 2>&1 && pveversion 2>/dev/null | head -n1 || echo NO"),
    ("omv_config",       "[ -f /etc/openmediavault/config.xml ] && echo YES || echo NO"),
    ("omv_release",      "cat /etc/openmediavault/openmediavault.conf 2>/dev/null | head -n5 || echo __NA__"),
    ("syno_version",     "[ -f /etc.defaults/VERSION ] && cat /etc.defaults/VERSION 2>/dev/null | head -n8 || echo NO"),
    ("syno_synoinfo",    "[ -f /etc/synoinfo.conf ] && echo YES || echo NO"),
    # v5.20.0 · TrueNAS: CORE(FreeBSD)/SCALE(Debian) 都有核心配置库
    ("truenas_db",       "[ -f /data/freenas-v1.db ] && echo YES || echo NO"),
    ("zpool_list",       "command -v zpool >/dev/null 2>&1 && zpool list -H -o name 2>/dev/null | head -5 || echo __NA__"),
    # 通用能力探测
    ("has_qm",     "command -v qm >/dev/null 2>&1 && echo YES || echo NO"),
    ("has_pct",    "command -v pct >/dev/null 2>&1 && echo YES || echo NO"),
    ("has_docker", "command -v docker >/dev/null 2>&1 && echo YES || echo NO"),
    ("has_zfs",    "command -v zfs >/dev/null 2>&1 && echo YES || echo NO"),
    ("has_systemctl", "command -v systemctl >/dev/null 2>&1 && echo YES || echo NO"),
]

_SEP = "\n---__SEP__---\n"


def _build_probe_script() -> str:
    parts = []
    for _, cmd in _SEGMENTS:
        parts.append(f"( {cmd} ) 2>/dev/null")
        parts.append(f"printf '%s' '{_SEP.strip()}'")
    # 最后不再 append 分隔符，多一个也没关系
    return " ; ".join(parts[:-1])  # 去掉末尾 printf


def parse_probe(raw: str) -> dict:
    """把探针输出解析成 dict。"""
    result = {}
    sep = _SEP.strip()
    chunks = (raw or "").split(sep) if raw else []
    for i, (key, _) in enumerate(_SEGMENTS):
        chunks_i = chunks[i].strip() if i < len(chunks) else ""
        result[key] = chunks_i
    # 便利派生字段
    result["is_pve"] = ("YES" in result.get("pve_version_file", "")
                        or (result.get("pveversion_cmd", "NO") not in ("NO", "")))
    result["is_omv"] = "YES" in result.get("omv_config", "")
    # v5.20.0 · TrueNAS 判定: SCALE 底层是 Debian, CORE 是 FreeBSD, 但都有
    #   /data/freenas-v1.db (核心配置库) 或 truenas 专属 os-release ID。
    #   注意不能靠 "没有 omv_config" 推断 —— 那会把普通 Debian 误判成 TrueNAS。
    _osrel = (result.get("os_release", "") or "").lower()
    result["is_truenas"] = (
        "YES" in result.get("truenas_db", "")
        or "truenas" in _osrel
        or "freenas" in _osrel
    )
    result["is_syno"] = ("YES" in result.get("syno_synoinfo", "")
                         or result.get("syno_version", "NO") not in ("NO", "", "__NA__"))
    result["has_docker"] = "YES" in result.get("has_docker", "")
    result["has_qm"] = "YES" in result.get("has_qm", "")
    result["has_pct"] = "YES" in result.get("has_pct", "")
    result["has_zfs"] = "YES" in result.get("has_zfs", "")
    result["has_systemctl"] = "YES" in result.get("has_systemctl", "")

    # os_release 里挖 ID=xxx
    os_id = ""
    for line in result.get("os_release", "").splitlines():
        if line.startswith("ID="):
            os_id = line[3:].strip().strip('"').lower()
            break
    result["os_id"] = os_id
    return result


async def probe(runner) -> dict:
    """在给定 SSHRunner 上跑一次探针，返回解析后的字典。"""
    script = _build_probe_script()
    rc, out, err = await runner.exec(script, timeout=15)
    parsed = parse_probe(out or "")
    parsed["_rc"] = rc
    parsed["_stderr"] = (err or "").strip()[:300]
    return parsed

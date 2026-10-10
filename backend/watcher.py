"""Fonriv - 实时同步守护引擎 (v4.59.0)

每条启用规则一个 inotifywait 进程 (inotify-tools, 递归监控):
    inotifywait -m -r -e close_write,create,move,delete --format '%e\\t%w%f' <src>
事件按 debounce 秒防抖合并 → 整目录 rsync 增量同步 (本机→本机 / 本机→远端 SSH)。

零新 Python 依赖; inotifywait 缺失时规则标记 error 并提示一键安装。
EventBus 发布 watch.* 事件供前端实时展示。
"""
from __future__ import annotations

import asyncio
import os
import shlex
import shutil
import time

from backend import db
from backend.db import watch as wdb
from backend.log import log_operation

try:
    from backend.events import publish as _evt_publish
except Exception:
    _evt_publish = None


def _publish(topic: str, payload: dict):
    if _evt_publish:
        try:
            _evt_publish(topic, payload)
        except Exception:
            pass


class _WatchJob:
    """单规则守护: inotifywait 子进程 + 防抖 + rsync 触发"""

    def __init__(self, rule: dict):
        self.rule = rule  # 已解密
        self.proc: asyncio.subprocess.Process | None = None
        self.task: asyncio.Task | None = None
        self.pending: set[str] = set()
        self.debounce_handle: asyncio.TimerHandle | None = None
        self.syncing = False
        self.last_error = ""

    # ---- 生命周期 ----

    def start(self):
        if self.task and not self.task.done():
            return
        self.task = asyncio.create_task(self._run())

    async def stop(self):
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass
        if self.debounce_handle:
            self.debounce_handle.cancel()
            self.debounce_handle = None
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
        self.task = None
        self.proc = None

    @property
    def running(self) -> bool:
        return bool(self.task and not self.task.done())

    # ---- 主循环 ----

    async def _run(self):
        rule = self.rule
        src = rule.get("src_path") or ""
        if not os.path.isdir(src):
            self.last_error = f"源目录不存在: {src}"
            _publish("watch.error", {"rule_id": rule["id"], "msg": self.last_error})
            return
        if not shutil.which("inotifywait"):
            self.last_error = "inotifywait 未安装 (inotify-tools); 请在同步工具检测中一键安装"
            wconn = db.get_conn()
            wdb.event_add(wconn, rule["id"], src, "error", self.last_error)
            _publish("watch.error", {"rule_id": rule["id"], "msg": self.last_error})
            return
        try:
            self.proc = await asyncio.create_subprocess_exec(
                "inotifywait", "-m", "-r",
                "-e", "close_write", "-e", "create", "-e", "moved_to", "-e", "delete",
                "--format", "%e\t%w%f",
                src,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except Exception as e:
            self.last_error = f"inotifywait 启动失败: {e}"
            _publish("watch.error", {"rule_id": rule["id"], "msg": self.last_error})
            return

        excludes = [x.strip() for x in (rule.get("exclude") or "").split(",") if x.strip()]
        assert self.proc and self.proc.stdout
        async for raw in self.proc.stdout:
            try:
                line = raw.decode("utf-8", "replace").rstrip("\n")
                ev_type, _, path = line.partition("\t")
                path = path.strip()
                if not path:
                    continue
                if any(x in path for x in excludes):
                    continue
                self.pending.add(path)
                # 事件落库 (节流: pending 合并后写一次 action, 这里只记账触发)
                if not self.syncing:
                    self._arm_debounce()
            except Exception:
                continue

    def _arm_debounce(self):
        if self.debounce_handle:
            self.debounce_handle.cancel()
        delay = max(0.5, float(self.rule.get("debounce") or 2))
        loop = asyncio.get_event_loop()
        self.debounce_handle = loop.call_later(delay, lambda: asyncio.create_task(self._fire()))

    async def _fire(self):
        self.debounce_handle = None
        if self.syncing or not self.pending:
            return
        paths = list(self.pending)[:50]
        self.pending.clear()
        if self.syncing or not os.path.exists(self.rule.get("src_path") or ""):
            return
        self.syncing = True
        rule = self.rule
        rid = rule["id"]
        conn = db.get_conn()
        _publish("watch.event", {"rule_id": rid, "name": rule.get("name"),
                                 "paths": len(paths), "stage": "syncing"})
        try:
            rc, out = await self._do_sync()
            status = "ok" if rc == 0 else "error"
            msg = (out or "").strip().splitlines()
            msg = msg[-1][:180] if msg else ("同步完成" if rc == 0 else f"rsync rc={rc}")
            if rc == 0:
                for p in paths[:3]:
                    wdb.event_add(conn, rid, p, "sync", f"✓ {msg}")
                wdb.rule_touch_run(conn, rid, status, msg, synced=True)
                log_operation("实时同步", f"{rule.get('name')} · {msg}")
            else:
                wdb.event_add(conn, rid, paths[0] if paths else "", "sync", f"✗ {msg}")
                wdb.rule_touch_run(conn, rid, status, msg)
                self.last_error = msg
            _publish("watch.event", {"rule_id": rid, "name": rule.get("name"),
                                     "paths": len(paths), "stage": status, "msg": msg})
        except Exception as e:
            wdb.event_add(conn, rid, "", "error", str(e)[:180])
            wdb.rule_touch_run(conn, rid, "error", str(e)[:180])
            _publish("watch.event", {"rule_id": rid, "stage": "error", "msg": str(e)[:120]})
        finally:
            self.syncing = False
            # 防抖期间又收到事件 → 再排一次
            if self.pending:
                self._arm_debounce()
            wdb.event_prune(conn, keep=500)

    # ---- rsync 执行 ----

    async def _do_sync(self, timeout: int = 600):
        rule = self.rule
        src = (rule.get("src_path") or "").rstrip("/") + "/"
        dst = rule.get("dst_path") or ""
        host = rule.get("host") or ""
        flags = ["rsync", "-a", "--partial", "--timeout=60"]
        if rule.get("delete_extra"):
            flags.append("--delete")
        for x in (rule.get("exclude") or "").split(","):
            x = x.strip()
            if x:
                flags += ["--exclude", x]
        env = dict(os.environ)
        if host:
            port = rule.get("port") or "22"
            user = rule.get("user") or "root"
            ssh_opts = f"ssh -p {shlex.quote(str(port))} -o StrictHostKeyChecking=accept-new"
            flags += ["-e", ssh_opts]
            auth = rule.get("auth_type") or "pass"
            if auth == "pass" and rule.get("password"):
                from backend.auth import decode_password
                env["SSHPASS"] = decode_password(rule["password"])
                flags = ["sshpass", "-e"] + flags
            remote = f"{user}@{shlex.quote(host)}:{dst}"
            flags += [src, remote]
        else:
            flags += [src, dst]
        try:
            proc = await asyncio.create_subprocess_exec(
                *flags, env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                start_new_session=True)
        except Exception as e:
            return 1, str(e)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
            return proc.returncode or 0, (out or b"").decode("utf-8", "replace")
        except asyncio.TimeoutError:
            try:
                os.killpg(os.getpgid(proc.pid), 9)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            return 1, "rsync 超时"


class WatchManager:
    """规则 → job 注册表; 服务启动自拉起"""

    def __init__(self):
        self.jobs: dict[int, _WatchJob] = {}

    def start_all(self):
        conn = db.get_conn()
        for rid in wdb.rule_enabled_ids(conn):
            try:
                self.apply_rule(rid)
            except Exception as e:
                print(f"[watcher] start rule {rid} fail: {e}")

    def apply_rule(self, rule_id: int):
        """按当前 DB 状态起/停/重启对应 job"""
        conn = db.get_conn()
        row = wdb.rule_get(conn, rule_id, decrypt=True)
        old = self.jobs.pop(rule_id, None)
        if old:
            old.stop()
        if not row or not row.get("enabled"):
            return
        job = _WatchJob(row)
        self.jobs[rule_id] = job
        job.start()

    def stop_rule(self, rule_id: int):
        job = self.jobs.pop(rule_id, None)
        if job:
            job.stop()

    def stop_all(self):
        for rid in list(self.jobs.keys()):
            self.stop_rule(rid)

    def status(self) -> dict:
        conn = db.get_conn()
        out = {"inotifywait": bool(shutil.which("inotifywait")),
               "rules": [], "running": 0}
        for r in wdb.rule_list(conn):
            job = self.jobs.get(r["id"])
            r2 = dict(r)
            r2["running"] = bool(job and job.running)
            r2["last_error"] = (job.last_error if job else "")
            out["rules"].append(r2)
            if r2["running"]:
                out["running"] += 1
        return out


manager = WatchManager()

"""SSH 会话执行器：所有远程传输的统一入口。

使用模式（推荐）：
    target = SSHTarget.from_ws_data(data)
    async with target.runner() as run:
        code, out, err = await run.exec("qm list")
        async for line in run.stream_lines("tar -cf - /etc"):
            ws.send_json({"log": line})
        code = await run.rsync("up", "/local/", "/remote/")
        await run.scp_upload("/local/file", "/remote/file")

覆盖场景：
1. exec — 一次性执行，回收完整 stdout/stderr（连通性测试、简短查询）
2. stream_lines — 行级流（rsync 进度、vzdump 输出）
3. stream_bytes — 二进制块流（tar czf - 到本地文件）
4. rsync — 便捷 rsync 上传/下载
5. scp_upload / scp_download — 便捷 SCP 单文件传输
6. upload_via_stdin — 目录/大文件走 SSH stdin pipe（避 base64 argv 溢出）
7. build_ssh_argv — 兜底：拿到 argv+env 自行 create_subprocess_exec
"""
import logging

import os
import asyncio
import time
import shlex
from typing import AsyncIterator, List, Optional, Tuple


# 全局活跃任务记录（供 kill_process 使用；handler 也可以主动写入）
active_tasks = {}
def _rp_register(task_id, proc):
    """v5.19.1 · 注册活动任务并打点 (启动时间/最后输出), 供「核心运行状况」卡死检测使用"""
    try:
        if not hasattr(proc, "_rp_started"):
            proc._rp_started = time.time()
        proc._rp_last_out = time.time()
    except Exception:
        pass
    active_tasks[task_id] = proc


def _rp_touch(proc):
    """有输出时刷新最后活动时间"""
    try:
        proc._rp_last_out = time.time()
    except Exception:
        pass




async def kill_process(task_id: str):
    """按 task_id 终止任务（供 stop 按钮使用）。"""
    proc = active_tasks.pop(task_id, None)
    if proc is None:
        return
    # proc 可能是 asyncio.subprocess.Process 或普通 dict（storage 用 dict 记进度）
    if hasattr(proc, "returncode") and proc.returncode is None:
        try:
            proc.kill()
            await proc.wait()
        except Exception as _e: logging.debug("suppressed", exc_info=True)
class SSHRunner:
    """会话执行器。使用 `async with target.runner() as run:` 进入。"""

    def __init__(self, target):
        self.target = target
        self._entered = False

    async def __aenter__(self):
        # KeyPassphraseAuth 会在这里启动 ssh-agent
        await self.target.auth.__aenter__()
        self._entered = True
        return self

    async def __aexit__(self, exc_type, exc, tb):
        try:
            await self.target.auth.__aexit__(exc_type, exc, tb)
        finally:
            self._entered = False
        return False

    # ---------------- 内部辅助 ---------------- #

    def _base_env(self) -> dict:
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["LANG"] = "C.UTF-8"
        env["LC_ALL"] = "C.UTF-8"
        return self.target.auth.prepare_env(env)

    def _wrap(self, cmd: list) -> list:
        """让 auth 决定是否加 sshpass/agent 包装。"""
        return self.target.auth.wrap_cmd(cmd)

    def build_ssh_argv(self, remote_cmd: str) -> Tuple[list, dict]:
        """底层：返回 (argv, env)。远程命令通过 argv 传给 ssh。"""
        opts = self.target.ssh_opts()
        argv = ["ssh"] + opts + [self.target.endpoint(), remote_cmd]
        return self._wrap(argv), self._base_env()

    def build_scp_argv(self, src: str, dst: str,
                       recursive: bool = False,
                       preserve: bool = True) -> Tuple[list, dict]:
        """底层：SCP 命令。src/dst 支持 'path' 或 'user@host:path' 形式。
        注意：SCP 与 SSH 共享大部分 -o 选项，端口用 -P（大写）而非 -p。"""
        opts = self.target.ssh_opts()
        # 把 SSH 的 -p PORT 转为 SCP 的 -P PORT
        scp_opts = []
        i = 0
        while i < len(opts):
            if opts[i] == "-p" and i + 1 < len(opts):
                scp_opts.extend(["-P", opts[i + 1]])
                i += 2
                continue
            scp_opts.append(opts[i])
            i += 1
        argv = ["scp"]
        if recursive:
            argv.append("-r")
        if preserve:
            argv.append("-p")
        argv.extend(scp_opts)
        argv.extend([src, dst])
        return self._wrap(argv), self._base_env()

    def build_rsync_argv(self, direction: str, src: str, dst: str,
                         flags: Optional[list] = None) -> Tuple[list, dict]:
        """底层：rsync 命令。direction: 'up'/'down'。src/dst 一端是本地路径。

        v4.38.16 · src 可含多行（换行分隔），每行一个源路径，
        rsync 原生支持多源：rsync ... f1 f2 f3 dest/ 。
        下载方向多源无意义（远端->本地单目录），仅取首行。
        """
        flags = flags or ["-avz", "--progress", "--human-readable"]
        rsync_ssh = " ".join(self.target.rsync_ssh_parts())
        endpoint = self.target.endpoint()
        if direction == "up":
            # v4.38.16: 多源上传 -- src 可含多行，每行一个本地路径
            srcs = [s.strip() for s in src.split("\n") if s.strip()]
            if not srcs:
                srcs = [src]
            r_src = srcs
            r_dst = f"{endpoint}:{dst}"
        elif direction == "down":
            r_src = f"{endpoint}:{src.splitlines()[0].strip() if src.strip() else src}"
            r_dst = dst
        else:
            raise ValueError(f"未知 direction: {direction}")
        if isinstance(r_src, list):
            argv = ["rsync"] + flags + ["-e", rsync_ssh] + r_src + [r_dst]
        else:
            argv = ["rsync"] + flags + ["-e", rsync_ssh, r_src, r_dst]
        return self._wrap(argv), self._base_env()

    # ---------------- 一次性执行 ---------------- #

    async def exec(self, remote_cmd: str, timeout: int = 30,
                   merge_stderr: bool = False,
                   stdin_data: Optional[bytes] = None) -> Tuple[int, str, str]:
        """执行一条远程命令，返回 (rc, stdout, stderr)。

        merge_stderr=True 时 stderr 合并进 stdout，返回值第 3 项为空串。
        stdin_data 非空时通过 stdin 送入远端（用于密码/密钥等敏感数据）。"""
        argv, env = self.build_ssh_argv(remote_cmd)
        stderr_arg = (asyncio.subprocess.STDOUT if merge_stderr
                      else asyncio.subprocess.PIPE)
        stdin_arg = asyncio.subprocess.PIPE if stdin_data is not None else asyncio.subprocess.DEVNULL
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv, stdout=asyncio.subprocess.PIPE, stderr=stderr_arg, env=env,
                stdin=stdin_arg,
            )
        except FileNotFoundError as e:
            return -1, "", f"命令未找到: {e}"
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(input=stdin_data), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return -1, "", "命令超时"
        out_s = (out or b"").decode("utf-8", errors="replace")
        err_s = (err or b"").decode("utf-8", errors="replace") if err else ""
        return proc.returncode, out_s, err_s

    async def exec_last_line(self, remote_cmd: str, timeout: int = 10) -> str:
        """执行命令，只返回 stdout 中最后一行非空内容（避 SSH warning 干扰匹配）。"""
        rc, out, _ = await self.exec(remote_cmd, timeout=timeout, merge_stderr=True)
        for ln in reversed((out or "").splitlines()):
            if ln.strip():
                return ln.strip()
        return ""

    # ---------------- 流式执行 ---------------- #

    async def stream_lines(self, remote_cmd: str,
                           task_id: Optional[str] = None) -> AsyncIterator[str]:
        """按行流式读取远程命令输出（stderr 合并到 stdout）。

        用法：async for line in run.stream_lines("rsync ..."):
        task_id 传入时自动注册 active_tasks（供 kill_process 使用）。"""
        argv, env = self.build_ssh_argv(remote_cmd)
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env=env,
        )
        if task_id:
            _rp_register(task_id, proc)
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                _rp_touch(proc)
                yield line.decode("utf-8", errors="replace").rstrip("\n")
            await proc.wait()
            # 附加：把 returncode 作为特殊 sentinel 传出
            yield f"__DONE__|{proc.returncode}"
        finally:
            if task_id:
                active_tasks.pop(task_id, None)

    async def stream_bytes(self, remote_cmd: str,
                           chunk_size: int = 65536,
                           task_id: Optional[str] = None):
        """启动远程命令并返回 (proc, stdout_reader, stderr_reader)。
        Handler 可以直接从 stdout_reader.read(N) 拿二进制块，写到本地文件。

        使用完毕后 handler 需自行 await proc.wait() 并调用 stderr 收集。
        task_id 传入时自动注册 active_tasks。"""
        argv, env = self.build_ssh_argv(remote_cmd)
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=env,
        )
        if task_id:
            _rp_register(task_id, proc)
        return proc

    # ---------------- rsync 便捷 ---------------- #

    async def rsync_stream(self, direction: str, src: str, dst: str,
                           flags: Optional[list] = None,
                           task_id: Optional[str] = None) -> AsyncIterator[str]:
        """启动 rsync 并按行流式返回输出（供进度解析）。"""
        argv, env = self.build_rsync_argv(direction, src, dst, flags)
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env=env,
        )
        if task_id:
            _rp_register(task_id, proc)
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                _rp_touch(proc)
                yield line.decode("utf-8", errors="replace").rstrip("\n")
            await proc.wait()
            yield f"__DONE__|{proc.returncode}"
        finally:
            if task_id:
                active_tasks.pop(task_id, None)

    # ---------------- SCP 便捷 ---------------- #

    async def scp_upload(self, local: str, remote: str,
                         recursive: bool = False,
                         timeout: int = 120) -> Tuple[int, str]:
        """SCP 上传单个文件或目录（recursive=True）。返回 (rc, merged_output)。"""
        dst = f"{self.target.endpoint()}:{remote}"
        argv, env = self.build_scp_argv(local, dst, recursive=recursive)
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env=env,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return -1, "SCP 上传超时"
        return proc.returncode, (out or b"").decode("utf-8", errors="replace")

    async def scp_download(self, remote: str, local: str,
                           recursive: bool = False,
                           timeout: int = 120) -> Tuple[int, str]:
        """SCP 下载单个文件或目录。返回 (rc, merged_output)。"""
        src = f"{self.target.endpoint()}:{remote}"
        argv, env = self.build_scp_argv(src, local, recursive=recursive)
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env=env,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return -1, "SCP 下载超时"
        return proc.returncode, (out or b"").decode("utf-8", errors="replace")

    # ---------------- Stdin Pipe（避 base64 argv 溢出） ---------------- #

    async def upload_via_stdin(self, local_path: str, remote_path: str,
                               timeout: int = 300) -> Tuple[int, str, str]:
        """把本地文件或目录通过 SSH stdin pipe 传到远端。

        - 文件 → 远端 `cat > remote_path`
        - 目录 → 本地 `tar czf -`；远端 `tar xzf - -C remote_path`
        比 base64 编码到 argv 更安全，避免 shell 参数长度限制。"""
        # 准备数据
        if os.path.isdir(local_path):
            # tar 打包
            tar_proc = await asyncio.create_subprocess_exec(
                "tar", "czf", "-", "-C", local_path, ".",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            data, tar_err = await tar_proc.communicate()
            if tar_proc.returncode != 0:
                return -1, "", f"本地 tar 打包失败: {tar_err.decode(errors='replace')}"
            remote_cmd = f"mkdir -p {shlex.quote(remote_path)} && tar xzf - -C {shlex.quote(remote_path)}"
        else:
            with open(local_path, "rb") as fh:
                data = fh.read()
            remote_cmd = (f"mkdir -p $(dirname {shlex.quote(remote_path)}) && "
                          f"cat > {shlex.quote(remote_path)}")

        argv, env = self.build_ssh_argv(remote_cmd)
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(input=data), timeout=timeout
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return -1, "", "上传超时"
        return (proc.returncode,
                (out or b"").decode("utf-8", errors="replace"),
                (err or b"").decode("utf-8", errors="replace"))

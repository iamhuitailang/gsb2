"""任务调度与 FFmpeg 子进程管理。

- asyncio 队列 + N 个 worker，保证同时运行的任务不超过配置上限；
- 每个任务运行在独立临时目录，输出完成后原子移动到 outputs/，不会互相覆盖；
- 进度来自 ffmpeg -progress 的实际处理时间，而不是模拟值；
- 取消时终止整个进程组并清理临时目录；
- 服务重启后把 queued/processing 的任务重新入队。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from collections import deque
from pathlib import Path

from . import config, db, ffmpeg_ops, storage

logger = logging.getLogger("video_tool.runner")

# 终态
TERMINAL_STATUSES = {"succeeded", "failed", "canceled"}


class TaskRunner:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._workers: list[asyncio.Task] = []
        # task_id -> 运行中的子进程（仅内存态，重启后通过数据库恢复任务状态）
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        # task_id -> stderr 尾部缓冲（deque 自动限长，防止内存膨胀）
        self._stderr_bufs: dict[str, deque[str]] = {}
        # 收到取消请求的任务
        self._cancel_requested: set[str] = set()
        self._started = False

    # ---- 生命周期 ----------------------------------------------------------

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        await self._recover_on_startup()
        for i in range(config.MAX_CONCURRENT_TASKS):
            self._workers.append(
                asyncio.create_task(self._worker(i), name=f"ffmpeg-worker-{i}")
            )
        logger.info(
            "runner started with %d concurrent workers", config.MAX_CONCURRENT_TASKS
        )

    async def shutdown(self) -> None:
        if not self._started:
            return
        # 停掉所有运行中的子进程
        for proc in list(self._processes.values()):
            await self._terminate(proc)
        for w in self._workers:
            w.cancel()
        for w in self._workers:
            try:
                await w
            except asyncio.CancelledError:
                pass
        self._workers.clear()
        self._started = False

    async def _recover_on_startup(self) -> None:
        """重启恢复：未终态任务重新排队，并清理残留临时目录。

        processing 的任务是在上次进程被杀死时中断的，输出文件不完整，
        统一回到 queued 重新处理。
        """
        active = await db.active_tasks()
        for task in active:
            tid = task["id"]
            storage.remove_path(storage.temp_dir(tid))
            await db.update_task(
                tid,
                {
                    "status": "queued",
                    "progress": 0,
                    "error": "服务重启，任务已重新排队" if task["status"] == "processing" else None,
                },
            )
            await self._queue.put(tid)
        # 清理没有对应任务的孤儿临时目录
        known = {t["id"] for t in active}
        if config.TEMP_DIR.exists():
            for child in config.TEMP_DIR.iterdir():
                if child.is_dir() and child.name not in known:
                    storage.remove_path(child)
        if active:
            logger.info("re-enqueued %d task(s) after restart", len(active))

    # ---- 入队 / 取消 -------------------------------------------------------

    async def enqueue(self, task_id: str) -> None:
        await self._queue.put(task_id)

    def is_running(self, task_id: str) -> bool:
        return task_id in self._processes

    def running_task_ids(self) -> set[str]:
        """当前有 FFmpeg 进程在跑的任务 id。"""
        return set(self._processes.keys())

    async def request_cancel(self, task_id: str) -> bool:
        """请求取消任务。返回 True 表示请求已受理。

        - queued：打标记，worker 取到后直接结束；
        - processing：终止进程组，worker 观察到退出后落库为 canceled。
        """
        task = await db.get_task(task_id)
        if not task or task["status"] in TERMINAL_STATUSES:
            return False
        self._cancel_requested.add(task_id)
        proc = self._processes.get(task_id)
        if proc is not None and proc.returncode is None:
            await self._terminate(proc)
        return True

    # ---- worker 主循环 -----------------------------------------------------

    async def _worker(self, index: int) -> None:
        while True:
            task_id = await self._queue.get()
            try:
                if task_id in self._cancel_requested:
                    await self._finish_canceled(task_id)
                    continue
                await self._process_task(task_id)
            except Exception:  # noqa: BLE001 - 兜底，worker 不能死
                logger.exception("worker %d unexpected error on task %s", index, task_id)
                self._cancel_requested.discard(task_id)
                storage.remove_path(storage.temp_dir(task_id))
                await db.update_task(
                    task_id,
                    {"status": "failed", "error": "内部错误，请查看服务端日志"},
                )
            finally:
                self._queue.task_done()

    async def _process_task(self, task_id: str) -> None:
        task = await db.get_task(task_id)
        if not task:
            return
        if task["status"] in TERMINAL_STATUSES:
            return

        file_row = await db.get_file(task["file_id"])
        if not file_row:
            await db.update_task(task_id, {"status": "failed", "error": "源视频文件不存在"})
            return
        source = storage.upload_path(file_row["stored_name"])
        if not source.exists():
            await db.update_task(task_id, {"status": "failed", "error": "源视频文件已被删除"})
            return

        tdir = storage.temp_dir(task_id)
        tdir.mkdir(parents=True, exist_ok=True)
        spec = ffmpeg_ops.FORMATS[task["format"]]
        # 输出名带任务 id，从命名上杜绝跨任务覆盖
        output_name = f"{task_id}{spec['ext']}"
        temp_output = tdir / output_name

        params = ffmpeg_ops.TrimParams(
            start_ms=task["start_ms"],
            end_ms=task["end_ms"],
            format=task["format"],
            video_codec=task["video_codec"],
            audio_codec=task["audio_codec"],
            crf=task["crf"],
            preset=task["preset"],
            video_bitrate=task["video_bitrate"],
            audio_bitrate=task["audio_bitrate"],
        )
        cmd = ffmpeg_ops.build_ffmpeg_command(
            ffmpeg_bin=config.FFMPEG_BIN,
            source=str(source),
            params=params,
            output_file=str(temp_output),
        )
        await db.update_task(
            task_id,
            {
                "status": "processing",
                "progress": 0,
                "ffmpeg_cmd": json.dumps(cmd, ensure_ascii=False),
                "started_at": db.now_iso(),
                "error": None,
            },
        )

        logger.info("task %s start: %s", task_id, " ".join(cmd))
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                # 独立进程组，取消时可以整组终止（ffmpeg 可能派生子进程）
                preexec_fn=os.setsid if hasattr(os, "setsid") else None,
            )
        except FileNotFoundError:
            await self._fail(task_id, tdir, "未找到 ffmpeg 可执行文件，请检查安装与 FFMPEG_BIN 配置")
            return

        self._processes[task_id] = proc
        # 并发排空 stderr，避免管道缓冲写满后 ffmpeg 阻塞挂起；
        # 尾部内容留作失败原因展示
        stderr_buf: deque[str] = deque(maxlen=200)
        self._stderr_bufs[task_id] = stderr_buf
        drainer = asyncio.create_task(self._drain_stderr(task_id, proc, stderr_buf))
        total_us = max(1, params.duration_ms * 1000)
        try:
            await self._read_progress(task_id, proc, total_us)
        finally:
            self._processes.pop(task_id, None)
            self._stderr_bufs.pop(task_id, None)
            await drainer

        canceled = task_id in self._cancel_requested
        if canceled:
            await self._finish_canceled(task_id, tdir)
            return
        if proc.returncode != 0:
            await self._fail(
                task_id, tdir,
                f"ffmpeg 退出码 {proc.returncode}: {''.join(stderr_buf)[-800:].strip()}",
            )
            return
        if not temp_output.exists() or temp_output.stat().st_size == 0:
            await self._fail(task_id, tdir, "ffmpeg 未生成有效输出文件")
            return

        # 原子移动到 outputs；目标已存在时加序号而不是覆盖
        final_path = self._unique_output_path(output_name)
        temp_output.replace(final_path)
        storage.remove_path(tdir)

        await db.update_task(
            task_id,
            {
                "status": "succeeded",
                "progress": 100,
                "output_name": final_path.name,
                "output_size": final_path.stat().st_size,
                "finished_at": db.now_iso(),
                "error": None,
            },
        )
        logger.info("task %s succeeded -> %s", task_id, final_path.name)

    # ---- 进度读取 ----------------------------------------------------------

    async def _read_progress(
        self,
        task_id: str,
        proc: asyncio.subprocess.Process,
        total_us: int,
    ) -> None:
        """解析 ffmpeg -progress 输出的 out_time_us 计算真实进度。"""
        assert proc.stdout is not None
        last_percent = -1
        last_db_update = 0.0
        loop = asyncio.get_running_loop()

        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", "ignore").strip()
            if not text or "=" not in text:
                continue
            key, _, value = text.partition("=")
            if key != "out_time_us" and key != "out_time_ms":
                continue
            # ffmpeg 的 out_time_ms/out_time_us 均为微秒语义
            try:
                out_us = int(value)
            except ValueError:
                continue
            percent = min(99, max(0, int(out_us * 100 / total_us)))
            if percent == last_percent:
                continue
            last_percent = percent
            now = loop.time()
            # 节流：百分比变化且距上次写库超过 0.5s，避免高频刷库
            if now - last_db_update >= 0.5 or percent >= 99:
                last_db_update = now
                await db.update_task(task_id, {"progress": percent})

        await proc.wait()

    @staticmethod
    async def _drain_stderr(
        task_id: str,
        proc: asyncio.subprocess.Process,
        buf: deque[str],
    ) -> None:
        """持续读取 stderr 防止管道阻塞，最近若干行留存在 buf 中。"""
        if proc.stderr is None:
            return
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            buf.append(line.decode("utf-8", "ignore"))

    # ---- 终态处理 ----------------------------------------------------------

    async def _fail(self, task_id: str, tdir: Path, message: str) -> None:
        storage.remove_path(tdir)
        await db.update_task(
            task_id,
            {"status": "failed", "error": message, "finished_at": db.now_iso()},
        )
        logger.warning("task %s failed: %s", task_id, message)

    async def _finish_canceled(self, task_id: str, tdir: Path | None = None) -> None:
        self._cancel_requested.discard(task_id)
        if tdir is None:
            tdir = storage.temp_dir(task_id)
        storage.remove_path(tdir)
        await db.update_task(
            task_id,
            {"status": "canceled", "finished_at": db.now_iso(), "error": None},
        )
        logger.info("task %s canceled", task_id)

    # ---- 进程终止 / 文件去重 ----------------------------------------------

    @staticmethod
    async def _terminate(proc: asyncio.subprocess.Process) -> None:
        if proc.returncode is not None:
            return
        try:
            if hasattr(os, "killpg"):
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            else:  # pragma: no cover - Windows 兜底
                proc.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=3)
        except asyncio.TimeoutError:
            try:
                if hasattr(os, "killpg"):
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                else:  # pragma: no cover
                    proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()

    @staticmethod
    def _unique_output_path(name: str) -> Path:
        """目标已存在时追加序号，绝不覆盖其他任务的输出。"""
        target = config.OUTPUT_DIR / name
        if not target.exists():
            return target
        stem, suffix = Path(name).stem, Path(name).suffix
        for i in range(1, 1000):
            candidate = config.OUTPUT_DIR / f"{stem}_{i}{suffix}"
            if not candidate.exists():
                return candidate
        raise RuntimeError("无法为输出文件分配唯一名")


# 全局单例
runner = TaskRunner()

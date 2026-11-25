"""极简后台任务管理(分析 / 导出 / 生成素材), 轮询 JSON 进度。"""

from __future__ import annotations

import threading
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class Job:
    id: str
    kind: str
    status: str = "pending"          # pending | running | done | error | cancelled
    progress: float = 0.0
    message: str = ""
    result: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    _cancel: threading.Event = field(default_factory=threading.Event)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": round(self.progress, 4),
            "message": self.message,
            "result": self.result,
            "error": self.error,
        }

    def cancel(self) -> None:
        self._cancel.set()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def set_progress(self, p: float, message: str | None = None) -> None:
        if self._cancel.is_set():
            raise RuntimeError("已取消")
        self.progress = max(0.0, min(1.0, float(p)))
        if message:
            self.message = message


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def start(self, kind: str, target: Callable[[Job], dict[str, Any]]) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind)
        with self._lock:
            self._jobs[job.id] = job

        def runner() -> None:
            job.status = "running"
            try:
                def progress(p: float, msg: str = "") -> None:
                    if job.cancelled:
                        raise RuntimeError("已取消")
                    job.progress = max(0.0, min(1.0, float(p)))
                    if msg:
                        job.message = msg

                result = target(job)
                if job.cancelled:
                    job.status = "cancelled"
                else:
                    job.result = result or {}
                    job.progress = 1.0
                    if not job.message:
                        job.message = "完成"
                    job.status = "done"
            except Exception as exc:  # noqa: BLE001 - 后台任务要把错误回传前端
                if job.cancelled or str(exc) == "已取消":
                    job.status = "cancelled"
                    job.message = "已取消"
                else:
                    job.status = "error"
                    job.error = str(exc)
                    job.message = "任务失败"
                    traceback.print_exc()

        threading.Thread(target=runner, daemon=True).start()
        return job


jobs = JobManager()

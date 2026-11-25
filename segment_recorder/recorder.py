from __future__ import annotations

import os
import shutil
import signal
import threading
from pathlib import Path
from typing import Any

from .playlist import Playlist, SegmentRef, parse_playlist
from .storage import Store
from .util import now_iso, same_prefix, sha256_file


class Recorder:
    def __init__(
        self,
        root: Path | str,
        *,
        playlist_relative: str = "source/playlist.m3u8",
        interval: float = 0.6,
        verbose: bool = True,
        show_repeats: bool = True,
    ):
        self.root = Path(root)
        self.playlist_path = self.root / playlist_relative
        self.archive_dir = self.root / "archive"
        self.blob_dir = self.archive_dir / "blobs"
        self.tmp_dir = self.archive_dir / "tmp"
        self.blob_dir.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)

        self.interval = max(0.1, float(interval))
        self.verbose = verbose
        self.show_repeats = show_repeats
        self.store = Store(self.archive_dir / "recorder.sqlite3")
        self.run_id = self.store.start_run(os.getpid(), note="recorder start")
        self.stop_event = threading.Event()
        self._last_progress: dict[int, int] = {}
        self._closed = False

    def close(self, status: str = "stopped") -> None:
        if self._closed:
            return
        self._closed = True
        self.store.end_run(self.run_id, status)
        self.store.close()

    def request_stop(self, *_args: Any) -> None:
        self.stop_event.set()

    def install_signal_handlers(self) -> None:
        # CLI 主进程调用；测试中不安装，避免影响测试运行器。
        for signum in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(signum, self.request_stop)
            except (ValueError, OSError):
                pass

    def emit(
        self,
        kind: str,
        message: str,
        *,
        run_event: bool = True,
        epoch_id: str | None = None,
        sequence: int | None = None,
        sha256: str | None = None,
    ) -> None:
        line = f"[{now_iso().split('T')[1]}] {message}"
        if self.verbose:
            print(line, flush=True)
        if run_event:
            self.store.log_event(
                kind,
                message,
                run_id=self.run_id,
                epoch_id=epoch_id,
                sequence=sequence,
                sha256=sha256,
            )

    # ------------------------------------------------------------------
    # Polling
    # ------------------------------------------------------------------

    def poll_once(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "playlist_exists": self.playlist_path.exists(),
            "segments": [],
            "new": 0,
            "partial": 0,
            "saved": 0,
            "duplicates": 0,
        }
        if not self.playlist_path.exists():
            self.emit(
                "playlist-missing",
                "等待清单出现：source/playlist.m3u8",
                run_event=False,
            )
            return result

        try:
            playlist = parse_playlist(self.playlist_path)
        except OSError as exc:
            self.emit("playlist-error", f"清单暂时读不了，下轮重试：{exc}")
            return result

        previous_present = {row["id"]: row for row in self.store.previously_present()}
        current_ids: set[int] = set()

        self.emit(
            "poll",
            f"轮询清单：MEDIA-SEQUENCE={playlist.media_sequence}，"
            f"窗口内 {len(playlist.segments)} 段",
            run_event=False,
        )

        for ref in playlist.segments:
            segment_id = self._discover_ref(ref, playlist)
            current_ids.add(segment_id)
            item = self._ingest_segment(segment_id)
            result["segments"].append(item)
            status = item.get("status")
            if status == "new":
                result["new"] += 1
            elif status == "partial":
                result["partial"] += 1
            elif status == "saved":
                result["saved"] += 1
            elif status == "duplicate":
                result["duplicates"] += 1

        # 之前在窗口、这轮不在：可能已经滚动移除。已保存内容不受影响。
        for segment_id, row in previous_present.items():
            if segment_id in current_ids:
                continue
            self.store.mark_present(segment_id, False)
            label = self._label(row["epoch_id"], row["sequence"])
            if row["status"] == "saved":
                self.emit(
                    "rolled-out",
                    f"↳ {label} 已滚出源清单/窗口；归档保留：{Path(row['archive_path']).name if row['archive_path'] else ''}",
                    epoch_id=row["epoch_id"],
                    sequence=row["sequence"],
                    sha256=row["sha256"],
                )
            else:
                source_exists = bool(row["source_path"] and Path(row["source_path"]).exists())
                if not source_exists:
                    self.store.update_progress(
                        segment_id,
                        status="lost",
                        message="未完整保存就滚出窗口且源文件已删除",
                    )
                    self.emit(
                        "lost",
                        f"✗ {label} 未收完，且源文件已被轮换删除；将在说明中标为缺口",
                        epoch_id=row["epoch_id"],
                        sequence=row["sequence"],
                    )
                else:
                    self.emit(
                        "left-window",
                        f"… {label} 已离开窗口，但源文件还在；继续尝试补收",
                        epoch_id=row["epoch_id"],
                        sequence=row["sequence"],
                    )

        # 即使某段已离开当前 m3u8，只要源文件还在，也把 .part 补完。
        for row in self.store.incomplete_segments():
            if row["id"] in current_ids:
                continue
            source_path = Path(row["source_path"] or "")
            if source_path.exists():
                item = self._ingest_segment(row["id"], background=True)
                result["segments"].append(item)

        return result

    def run_forever(self, max_cycles: int | None = None) -> None:
        self.install_signal_handlers()
        cycles = 0
        self.emit("start", f"收录进程启动 pid={os.getpid()}，根目录={self.root}")
        try:
            while not self.stop_event.is_set():
                try:
                    self.poll_once()
                except Exception as exc:  # 轮询进程不能因单段异常退出
                    self.emit("poll-error", f"本轮收录出现未预期错误，将重试：{exc}")
                cycles += 1
                if max_cycles is not None and cycles >= max_cycles:
                    break
                self.stop_event.wait(self.interval)
        finally:
            status = "interrupted" if self.stop_event.is_set() else "stopped"
            self.emit("stop", f"收录进程退出（{status}），状态已持久化，可重新启动续收")
            self.close(status)

    # ------------------------------------------------------------------
    # Identity and copying
    # ------------------------------------------------------------------

    @staticmethod
    def _label(epoch_id: str | None, sequence: int | None) -> str:
        seq_text = f"#{sequence:04d}" if sequence is not None else "#????"
        return f"{epoch_id or 'default'} {seq_text}"

    def _discover_ref(self, ref: SegmentRef, playlist: Playlist) -> int:
        epoch_id = ref.epoch_id or playlist.epoch_id or "default"
        epoch_index = ref.epoch_index if ref.epoch_index is not None else playlist.epoch_index
        sequence = ref.sequence
        if sequence is None:
            # 实验清单总是写 #EXT-X-SEQUENCE。真实清单可退回 MEDIA-SEQUENCE+index；
            # 这里 parser 没有把 index 传入，因此用 URI 哈希兜底，不应在演示中发生。
            sequence = abs(hash(ref.uri)) % 1_000_000

        source_path = ref.resolved_path(self.playlist_path)
        sidecar = self._read_sidecar(source_path)
        sha256 = ref.sha256 or sidecar.get("sha256")
        expected_size = sidecar.get("size") or sidecar.get("expected_size")
        planned_at = ref.program_date_time or sidecar.get("planned_at")

        segment_id = self.store.discover(
            epoch_id=epoch_id,
            sequence=sequence,
            sha256=sha256,
            uri=ref.uri,
            source_path=str(source_path),
            stream_id=str(sidecar.get("stream_id", "local")),
            epoch_index=epoch_index,
            duration=ref.duration or float(sidecar.get("duration_sec") or 0.0),
            planned_at=planned_at,
            expected_size=int(expected_size) if expected_size else None,
        )

        row = self.store.get_segment(segment_id)
        if row is not None and row["seen_count"] == 1 and row["status"] == "discovered":
            self.emit(
                "discovered",
                f"➕ 发现 {self._label(epoch_id, sequence)}：{Path(ref.uri).name}"
                + (f"，期望大小 {expected_size} 字节" if expected_size else ""),
                epoch_id=epoch_id,
                sequence=sequence,
                sha256=sha256,
            )
        return segment_id

    @staticmethod
    def _read_sidecar(source_path: Path) -> dict[str, Any]:
        from .util import read_json

        data = read_json(Path(str(source_path) + ".json"))
        return data if isinstance(data, dict) else {}

    def _part_path_for(self, row: Any) -> Path:
        sha = row["sha256"]
        if sha and not str(sha).startswith("pending-"):
            token = sha
        else:
            import hashlib

            raw = f"{row['epoch_id']}/{row['sequence']}/{row['source_path']}".encode()
            token = "src-" + hashlib.sha256(raw).hexdigest()
        return self.tmp_dir / f"{token}.part"

    def _ingest_segment(self, segment_id: int, *, background: bool = False) -> dict[str, Any]:
        row = self.store.get_segment(segment_id)
        if row is None:
            return {"id": segment_id, "status": "missing-db-row"}

        label = self._label(row["epoch_id"], row["sequence"])
        source_path = Path(row["source_path"]) if row["source_path"] else None
        part_path = self._part_path_for(row)

        if row["status"] == "saved":
            archive_exists = row["archive_path"] and Path(row["archive_path"]).exists()
            if archive_exists:
                if self.show_repeats and not background:
                    self.emit(
                        "duplicate",
                        f"✓ {label} 已完整保存；清单第 {row['seen_count']} 次出现，跳过",
                        run_event=False,
                        epoch_id=row["epoch_id"],
                        sequence=row["sequence"],
                        sha256=row["sha256"],
                    )
                return {"id": segment_id, "status": "duplicate", "sha256": row["sha256"]}
            # 归档文件被外部误删：只要源还在就重新收。
            self.emit("archive-missing", f"⚠ {label} 数据库显示已保存但归档文件不在，尝试重收")

        if source_path is None or not source_path.exists():
            # present=0 表示这轮已不在 m3u8 窗口；本地源文件又消失，通常是轮换删除。
            missing_status = "waiting_source" if row["present"] else "lost"
            message = (
                "已在清单中，但短片文件还没出现，下轮补收"
                if missing_status == "waiting_source"
                else "未完整保存就离开窗口且源文件已删除"
            )
            self.store.update_progress(segment_id, status=missing_status, message=message)
            if not background or missing_status == "lost":
                emit_kind = "waiting" if missing_status == "waiting_source" else "lost"
                emit_mark = "…" if missing_status == "waiting_source" else "✗"
                self.emit(
                    emit_kind,
                    f"{emit_mark} {label} {message}",
                    run_event=missing_status == "lost",
                    epoch_id=row["epoch_id"],
                    sequence=row["sequence"],
                )
            return {"id": segment_id, "status": missing_status}

        source_stat = source_path.stat()
        expected_sha = row["sha256"] if row["sha256"] and not row["sha256"].startswith("pending-") else None
        expected_size = row["expected_size"]
        sidecar = self._read_sidecar(source_path)
        if not expected_sha:
            expected_sha = sidecar.get("sha256")
        if not expected_size:
            expected_size = sidecar.get("size") or sidecar.get("expected_size")

        resumed_from = 0
        if part_path.exists():
            resumed_from = part_path.stat().st_size
            if resumed_from > source_stat.st_size or not same_prefix(
                part_path, source_path, resumed_from
            ):
                self.emit(
                    "reset-part",
                    f"↺ {label} 旧 .part 前缀与当前源文件不一致（源可能被重写），重新接收",
                    epoch_id=row["epoch_id"],
                    sequence=row["sequence"],
                )
                part_path.unlink(missing_ok=True)
                resumed_from = 0
            elif resumed_from > 0:
                self.store.update_progress(segment_id, status="partial")

        before_size = part_path.stat().st_size if part_path.exists() else 0
        try:
            with source_path.open("rb") as src, part_path.open("ab") as dst:
                current_part_size = dst.tell()
                src.seek(min(current_part_size, source_stat.st_size))
                shutil.copyfileobj(src, dst, length=1024 * 1024)
                dst.flush()
                os.fsync(dst.fileno())
        except OSError as exc:
            self.emit("copy-error", f"⚠ {label} 读取源文件失败，下轮重试：{exc}")
            return {"id": segment_id, "status": "io-error", "error": str(exc)}

        archived_size = part_path.stat().st_size
        if archived_size > before_size and before_size > 0:
            self.store.update_progress(segment_id, increment_resume=True)

        digest = sha256_file(part_path)
        complete_by_hash = bool(expected_sha and digest == expected_sha)
        complete_by_size = bool(expected_size and archived_size == expected_size)
        if expected_sha:
            is_complete = complete_by_hash and (not expected_size or complete_by_size)
        else:
            # 没有预置 SHA 时，用连续两轮 size/mtime 稳定判断写入结束。
            same_signature = (
                row["source_size"] == source_stat.st_size
                and row["source_mtime_ns"] == source_stat.st_mtime_ns
                and archived_size == source_stat.st_size
                and archived_size > 0
            )
            is_complete = same_signature

        if not is_complete:
            percent = ""
            if expected_size:
                percent = f" {archived_size / expected_size * 100:5.1f}%"
            message = (
                f"部分保存{percent}（{archived_size}"
                + (f"/{expected_size}" if expected_size else "")
                + " 字节），等待文件写完后补收"
            )
            self.store.update_progress(
                segment_id,
                status="partial",
                source_size=source_stat.st_size,
                archived_size=archived_size,
                expected_size=expected_size,
                source_mtime_ns=source_stat.st_mtime_ns,
                message=message,
            )
            last_logged = self._last_progress.get(segment_id, -1)
            bucket = -1 if not expected_size else int(archived_size / max(1, expected_size) * 20)
            if bucket != last_logged or not background:
                self._last_progress[segment_id] = bucket
                resume_text = f"，从 {before_size} 字节续收" if before_size else ""
                self.emit(
                    "partial",
                    f"… {label} {message}{resume_text}",
                    run_event=bucket != last_logged,
                    epoch_id=row["epoch_id"],
                    sequence=row["sequence"],
                    sha256=expected_sha,
                )
            return {"id": segment_id, "status": "partial", "archived_size": archived_size}

        final_sha = expected_sha or digest
        suffix = source_path.suffix if source_path.suffix else ".seg"
        blob_path = self.blob_dir / f"{final_sha}{suffix}"

        if blob_path.exists():
            part_path.unlink(missing_ok=True)
        else:
            os.replace(part_path, blob_path)
            try:
                # 尽量让重命名落盘；实验环境忽略不支持的平台。
                dir_fd = os.open(self.blob_dir, os.O_RDONLY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            except OSError:
                pass

        duration = row["duration"] or None
        self.store.mark_saved(
            segment_id,
            sha256=final_sha,
            archive_path=str(blob_path),
            size=blob_path.stat().st_size,
            duration=duration,
            message="已完整保存并通过 SHA-256 校验",
        )
        resume_note = f"（其中 .part 已有 {resumed_from} 字节，重启/补写后续收）" if resumed_from else ""
        self.emit(
            "saved",
            f"✓ {label} 保存完成{resume_note} → archive/blobs/{blob_path.name}",
            epoch_id=row["epoch_id"],
            sequence=row["sequence"],
            sha256=final_sha,
        )
        return {
            "id": segment_id,
            "status": "saved",
            "sha256": final_sha,
            "archive_path": str(blob_path),
        }

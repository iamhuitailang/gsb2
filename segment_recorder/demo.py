from __future__ import annotations

import os
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

from .exporter import export_library, verify_export
from .util import format_duration
from .world import advance, init_world


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _db_path(root: Path) -> Path:
    return root / "archive" / "recorder.sqlite3"


def _wait_until(predicate: Callable[[], bool], timeout: float = 15.0, interval: float = 0.25) -> bool:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            if predicate():
                return True
        except Exception as exc:  # 数据库刚创建时可能短暂不可读
            last_error = exc
        time.sleep(interval)
    if last_error:
        print(f"[demo] 等待条件时最后一个错误：{last_error}")
    return False


def _segment_row(root: Path, epoch_id: str, sequence: int):
    db = _db_path(root)
    if not db.exists():
        return None
    with sqlite3.connect(str(db)) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM segments WHERE epoch_id=? AND sequence=? ORDER BY id DESC LIMIT 1",
            (epoch_id, sequence),
        ).fetchone()


def _wait_saved(root: Path, epoch_id: str, sequence: int, timeout: float = 15.0) -> bool:
    ok = _wait_until(
        lambda: (lambda row: row is not None and row["status"] == "saved")(
            _segment_row(root, epoch_id, sequence)
        ),
        timeout=timeout,
    )
    if not ok:
        row = _segment_row(root, epoch_id, sequence)
        print(f"[demo] 警告：等待 {epoch_id}#{sequence:04d} 保存超时，当前={dict(row) if row else None}")
    return ok


def _wait_partial_bytes(root: Path, epoch_id: str, sequence: int, timeout: float = 10.0) -> bool:
    return _wait_until(
        lambda: (lambda row: row is not None and (row["archived_size"] or 0) > 0)(
            _segment_row(root, epoch_id, sequence)
        ),
        timeout=timeout,
    )


def _start_recorder(root: Path, interval: float, show_repeats: bool = True) -> subprocess.Popen:
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(PROJECT_ROOT) + (os.pathsep + existing if existing else "")
    command = [
        sys.executable,
        "-u",
        "-m",
        "segment_recorder",
        "record",
        "--root",
        str(root),
        "--interval",
        str(interval),
    ]
    if show_repeats:
        command.append("--show-repeats")
    print("\n[demo] 启动收录子进程：" + " ".join(command), flush=True)
    return subprocess.Popen(command, cwd=str(PROJECT_ROOT), env=env)


def _stop_recorder(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    print(f"\n[demo] 中断收录进程 pid={process.pid}，发送 SIGTERM ……", flush=True)
    try:
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=6)
        print("[demo] 收录进程已优雅退出；状态和 .part 已保留。", flush=True)
    except (subprocess.TimeoutExpired, ProcessLookupError):
        print("[demo] 优雅退出超时，强制 kill。", flush=True)
        process.kill()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass


def run_demo(
    root: Path | str,
    *,
    auto: bool = True,
    tick_seconds: float = 1.2,
    recorder_interval: float = 0.45,
    fake_media: bool = False,
    force: bool = False,
    delete_source_after_export: bool = False,
    decode: bool = False,
) -> int:
    root = Path(root).resolve()
    mode = "自动" if auto else "步进（每个节拍后按 Enter）"
    print("=" * 78)
    print(f"滚动清单收录演示｜{mode}")
    print(f"目录：{root}")
    print(f"媒体：{'伪媒体（仅逻辑验证）' if fake_media else 'ffmpeg 生成真实 TS 短片'}")
    print("剧本：半截补收、迟到、窗口轮换、进程重启、序号归零/断档")
    print("=" * 78)

    init_world(root, fake_media=fake_media, force=force)

    def pause(prompt: str = "[步进] 按 Enter 推进到下一节拍；输入 q 后回车可中止演示 …… ") -> bool:
        if auto:
            time.sleep(tick_seconds)
            return True
        try:
            answer = input("\n" + prompt).strip().lower()
            return answer != "q"
        except EOFError:
            return True

    def tick(tick_number: int | None = None, expected: tuple[str, int] | None = None, timeout: float = 18.0) -> None:
        result = advance(root)
        print(f"\n[demo] ── 节拍 {result['tick']:02d} ──")
        for event in result["events"]:
            print(f"[world] {event}")
        if expected is not None:
            _wait_saved(root, expected[0], expected[1], timeout=timeout)

    recorder: subprocess.Popen | None = None
    exit_code = 0
    export_dir: Path | None = None
    try:
        recorder = _start_recorder(root, recorder_interval)
        time.sleep(0.8)

        tick(1, ("ep-0001", 0))
        pause()
        tick(2, ("ep-0001", 1))
        pause()
        tick(3)
        if not _wait_partial_bytes(root, "ep-0001", 2, timeout=10):
            print("[demo] 警告：未观察到半截 .part 字节")
        else:
            row = _segment_row(root, "ep-0001", 2)
            if row is not None:
                print(
                    f"[demo] 已观察到未完成文件：archive/tmp 中已有 "
                    f"{row['archived_size']} 字节，等待补完。"
                )
        if not pause():
            return 130

        # 关键演示：在第 2 段仍为 partial 时杀掉收录进程。
        _stop_recorder(recorder)
        recorder = None

        print("\n[demo] 收录进程已停止；源端继续推进 3 个节拍（第 2 段写完、seq3、seq5 跳过 seq4）……")
        tick(4)
        pause()
        tick(5)
        pause()
        tick(6)
        if not pause("[步进] 中断期间的节拍已推进完；按 Enter 重启收录进程 …… "):
            return 130

        recorder = _start_recorder(root, recorder_interval)
        if not _wait_saved(root, "ep-0001", 2, timeout=15):
            exit_code = 1
        _wait_saved(root, "ep-0001", 3)
        _wait_saved(root, "ep-0001", 5)
        print("[demo] 重启后的新进程已从 SQLite 和 .part 接着收录。")
        pause()

        for expected in [
            ("ep-0001", 4),
            ("ep-0001", 6),
            ("ep-0001", 8),
            None,  # tick 10 outage
            ("ep-0002", 0),
            ("ep-0002", 1),
            ("ep-0002", 2),
        ]:
            tick(expected=expected)
            if expected is not None:
                _wait_saved(root, expected[0], expected[1])
            pause()

        expected_all = [
            ("ep-0001", seq) for seq in (0, 1, 2, 3, 4, 5, 6, 8)
        ] + [("ep-0002", seq) for seq in (0, 1, 2)]
        missing = [
            item
            for item in expected_all
            if not (lambda row: row is not None and row["status"] == "saved")(
                _segment_row(root, *item)
            )
        ]
        if missing:
            print(f"[demo] 以下片段未确认保存：{missing}")
            exit_code = 1
        else:
            print("\n[demo] 所有剧本中应保存的片段均已保存；seq7 保留为标记缺口。")

        _stop_recorder(recorder)
        recorder = None

        print("\n[demo] 导出自包含离线区间、m3u8、MP4 和收录说明 ……")
        export_dir = export_library(root, make_media=not fake_media)
        report = verify_export(export_dir, decode=decode and not fake_media)
        print(f"[demo] 导出目录：{export_dir}")
        print(
            f"[demo] 校验：ok={report['ok']}，区间={report['range_count']}，"
            f"缺口={report['gap_count']}，错误={len(report['errors'])}"
        )
        for check in report["checks"]:
            print(
                f"  - {check['range']}: 清单 {check['playlist_duration']:.3f}s / "
                f"MP4 {check['mp4_duration']:.3f}s"
            )
        for error in report["errors"]:
            print(f"  ERROR: {error}")
        if not report["ok"]:
            exit_code = 1

        if delete_source_after_export:
            source_dir = root / "source"
            if source_dir.exists():
                import shutil

                shutil.rmtree(source_dir)
                print(f"[demo] 已按 --delete-source 删除原始清单目录：{source_dir}")
            report2 = verify_export(export_dir, decode=False)
            print(f"[demo] 删除原清单后再次校验：ok={report2['ok']}，错误={len(report2['errors'])}")
            if not report2["ok"]:
                exit_code = 1

        print("\n" + "=" * 78)
        print("演示完成。可打开：")
        if export_dir is not None:
            print(f"  open {export_dir / 'index.html'}")
            print(f"  less '{export_dir / '收录说明.md'}'")
            latest_mp4 = sorted(export_dir.glob("range*/preview.mp4"))
            if latest_mp4:
                print(f"  open {latest_mp4[0]}")
        print(f"  python3 -m segment_recorder status --root {root}")
        print("=" * 78)
        return exit_code
    finally:
        _stop_recorder(recorder)

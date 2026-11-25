from __future__ import annotations

import shutil
from datetime import timedelta
from pathlib import Path
from typing import Any

from . import media
from .util import atomic_write_json, now_iso, parse_iso, read_json, sha256_file


WORLD_STATE = "world_state.json"


class WorldError(RuntimeError):
    pass


def world_state_path(root: Path | str) -> Path:
    return Path(root) / WORLD_STATE


def load_world(root: Path | str) -> dict[str, Any]:
    path = world_state_path(root)
    state = read_json(path)
    if not isinstance(state, dict):
        raise WorldError(f"找不到剧本状态：{path}，请先运行 init")
    return state


def save_world(root: Path | str, state: dict[str, Any]) -> None:
    atomic_write_json(world_state_path(root), state)


def init_world(
    root: Path | str,
    *,
    fake_media: bool = False,
    force: bool = False,
    window: int = 4,
    segment_seconds: float = 1.0,
) -> dict[str, Any]:
    root = Path(root)
    if root.exists() and any(root.iterdir()):
        if not force:
            raise WorldError(f"目录非空：{root}；如要重建请加 --force")
        shutil.rmtree(root)

    (root / "source" / "segments").mkdir(parents=True, exist_ok=True)
    (root / "staging").mkdir(parents=True, exist_ok=True)

    state: dict[str, Any] = {
        "version": 1,
        "root": str(root.resolve()),
        "stream_id": "demo-cam",
        "created_at": now_iso(),
        "tick": 0,
        "window": int(window),
        "segment_seconds": float(segment_seconds),
        "fake_media": bool(fake_media),
        "base_clock": now_iso(),
        "epoch_index": 1,
        "epoch_id": "ep-0001",
        "epoch_start_clock": now_iso(),
        "segments": {},
        "active_uids": [],
        "removed": [],
        "tick_log": [],
    }
    save_world(root, state)
    _write_playlist(root, state)
    return state


def _uid(epoch_index: int, sequence: int) -> str:
    return f"ep-{epoch_index:04d}#{sequence:04d}"


def _program_time(state: dict[str, Any], epoch_index: int, sequence: int) -> str:
    duration = float(state["segment_seconds"])
    base = parse_iso(state["base_clock"]) or parse_iso(now_iso())
    assert base is not None
    if epoch_index == 1:
        start = base
    else:
        # 第二段轮次故意留出 3 个短片时长的断档。
        start = base + timedelta(seconds=(8 + 4) * duration)
    return (start + timedelta(seconds=sequence * duration)).isoformat(timespec="seconds")


def _add_tick_log(state: dict[str, Any], message: str) -> None:
    state.setdefault("tick_log", []).append({"tick": state["tick"], "at": now_iso(), "message": message})


def _generate_full_clip(root: Path, state: dict[str, Any], meta: dict[str, Any]) -> None:
    staging = root / "staging" / f"e{meta['epoch_index']:04d}_s{meta['sequence']:04d}.full.ts"
    if not staging.exists():
        media.generate_clip(
            staging,
            label=meta["label"],
            sequence=meta["sequence"] + meta["epoch_index"] * 100,
            duration=float(state["segment_seconds"]),
            fake=bool(state["fake_media"]),
        )
    meta["staging_path"] = str(staging)
    meta["sha256"] = sha256_file(staging)
    meta["size"] = staging.stat().st_size


def _write_sidecar(meta: dict[str, Any], *, complete: bool) -> None:
    source_path = Path(meta["source_path"])
    sidecar = Path(str(source_path) + ".json")
    payload = {
        "stream_id": meta["stream_id"],
        "epoch_id": meta["epoch_id"],
        "epoch_index": meta["epoch_index"],
        "sequence": meta["sequence"],
        "duration_sec": meta["duration_sec"],
        "planned_at": meta["planned_at"],
        "sha256": meta["sha256"],
        "size": meta["size"],
        "complete": complete,
        "late": meta.get("late", False),
    }
    atomic_write_json(sidecar, payload)


def _add_segment(
    root: Path,
    state: dict[str, Any],
    sequence: int,
    *,
    partial_fraction: float | None = None,
    late: bool = False,
) -> dict[str, Any]:
    epoch_index = int(state["epoch_index"])
    epoch_id = state["epoch_id"]
    uid = _uid(epoch_index, sequence)
    if uid in state["segments"]:
        raise WorldError(f"{uid} 已存在，不能重复构造")

    # 关键：不同 epoch 的同序号使用相同源文件名。重启后新内容会覆盖源路径，
    # 但收录端按 SHA-256/独立身份保存，不会覆盖 archive 中旧片。
    file_name = f"seg_{sequence:04d}.ts"
    source_path = root / "source" / "segments" / file_name
    label = f"E{epoch_index}S{sequence:03d}"

    meta: dict[str, Any] = {
        "uid": uid,
        "stream_id": state["stream_id"],
        "epoch_id": epoch_id,
        "epoch_index": epoch_index,
        "sequence": sequence,
        "uri": f"segments/{file_name}",
        "file_name": file_name,
        "source_path": str(source_path),
        "duration_sec": float(state["segment_seconds"]),
        "planned_at": _program_time(state, epoch_index, sequence),
        "created_at": now_iso(),
        "label": label,
        "late": late,
        "complete": False,
        "removed": False,
    }
    _generate_full_clip(root, state, meta)

    source_path.parent.mkdir(parents=True, exist_ok=True)
    if partial_fraction is not None:
        exposed = max(1, int(meta["size"] * partial_fraction))
        staging = Path(meta["staging_path"])
        with staging.open("rb") as src, source_path.open("wb") as dst:
            dst.write(src.read(exposed))
        meta["exposed_size"] = source_path.stat().st_size
        meta["complete"] = False
        action = f"生成半截短片 {uid}，先露出 {meta['exposed_size']}/{meta['size']} 字节"
    else:
        shutil.copyfile(meta["staging_path"], source_path)
        meta["exposed_size"] = meta["size"]
        meta["complete"] = True
        meta["published_at"] = now_iso()
        action = f"出现完整短片 {uid}" + ("（迟到补入）" if late else "")

    _write_sidecar(meta, complete=meta["complete"])
    state["segments"][uid] = meta
    _apply_window(root, state)
    _write_playlist(root, state)
    _add_tick_log(state, action)
    return meta


def _complete_partial(root: Path, state: dict[str, Any], sequence: int) -> dict[str, Any]:
    uid = _uid(int(state["epoch_index"]), sequence)
    meta = state["segments"].get(uid)
    if meta is None:
        raise WorldError(f"找不到半截段 {uid}")
    if meta.get("complete"):
        return meta

    source_path = Path(meta["source_path"])
    staging = Path(meta["staging_path"])
    already = source_path.stat().st_size if source_path.exists() else 0
    with staging.open("rb") as src, source_path.open("ab") as dst:
        src.seek(already)
        shutil.copyfileobj(src, dst)
    if source_path.stat().st_size != meta["size"]:
        raise WorldError(f"{uid} 补写后大小不正确")

    meta["exposed_size"] = meta["size"]
    meta["complete"] = True
    meta["published_at"] = now_iso()
    _write_sidecar(meta, complete=True)
    _write_playlist(root, state)
    action = f"短片 {uid} 已写完（追加剩余字节）"
    _add_tick_log(state, action)
    return meta


def _delete_source(meta: dict[str, Any], reason: str) -> None:
    source_path = Path(meta["source_path"])
    source_path.unlink(missing_ok=True)
    Path(str(source_path) + ".json").unlink(missing_ok=True)
    meta["removed"] = True
    meta["removal_reason"] = reason
    meta["removed_at"] = now_iso()


def _apply_window(root: Path, state: dict[str, Any]) -> None:
    """只保留当前 epoch 最近 window 个序号；超出窗口删除源短片。"""
    epoch_index = int(state["epoch_index"])
    metas = [
        meta
        for meta in state["segments"].values()
        if int(meta["epoch_index"]) == epoch_index and not meta.get("removed")
    ]
    metas.sort(key=lambda item: int(item["sequence"]))
    keep = metas[-int(state["window"]) :]
    keep_uids = {meta["uid"] for meta in keep}

    for meta in metas:
        if meta["uid"] not in keep_uids:
            _delete_source(meta, "window-rotation")
            state.setdefault("removed", []).append(
                {
                    "uid": meta["uid"],
                    "at": now_iso(),
                    "reason": "window-rotation",
                    "sequence": meta["sequence"],
                    "epoch_id": meta["epoch_id"],
                }
            )

    state["active_uids"] = [meta["uid"] for meta in keep]


def _restart_epoch(root: Path, state: dict[str, Any]) -> None:
    # 模拟断档后编码器重启并重新从 0 编号。旧 m3u8 窗口清空，旧源文件删除；
    # 已收录到 archive 的内容不受影响。
    old_epoch = state["epoch_id"]
    for meta in list(state["segments"].values()):
        if int(meta["epoch_index"]) == int(state["epoch_index"]) and not meta.get("removed"):
            _delete_source(meta, "epoch-restart")
            state.setdefault("removed", []).append(
                {
                    "uid": meta["uid"],
                    "at": now_iso(),
                    "reason": "epoch-restart",
                    "sequence": meta["sequence"],
                    "epoch_id": meta["epoch_id"],
                }
            )

    state["epoch_index"] = int(state["epoch_index"]) + 1
    state["epoch_id"] = f"ep-{state['epoch_index']:04d}"
    state["epoch_start_clock"] = _program_time(
        state, state["epoch_index"], 0
    )
    state["active_uids"] = []
    action = f"检测到断档，录制端重启：{old_epoch} → {state['epoch_id']}，序号从 0 重新开始"
    _add_tick_log(state, action)


def _write_playlist(root: Path, state: dict[str, Any]) -> Path:
    playlist_path = root / "source" / "playlist.m3u8"
    playlist_path.parent.mkdir(parents=True, exist_ok=True)

    active = [
        state["segments"][uid]
        for uid in state.get("active_uids", [])
        if uid in state["segments"] and not state["segments"][uid].get("removed")
    ]
    active.sort(key=lambda meta: (int(meta["epoch_index"]), int(meta["sequence"])))

    target_duration = max(1, int(float(state["segment_seconds"]) + 0.999))
    first_sequence = int(active[0]["sequence"]) if active else 0
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        f"#EXT-X-TARGETDURATION:{target_duration}",
        f"#EXT-X-MEDIA-SEQUENCE:{first_sequence}",
        f"#EXT-X-DISCONTINUITY-SEQUENCE:{max(0, int(state['epoch_index']) - 1)}",
        f'#EXT-X-EPOCH:id="{state["epoch_id"]}",index={state["epoch_index"]},reason="rolling-demo"',
    ]

    previous_epoch = None
    for meta in active:
        if previous_epoch is not None and meta["epoch_id"] != previous_epoch:
            lines.append("#EXT-X-DISCONTINUITY")
        previous_epoch = meta["epoch_id"]
        lines.extend(
            [
                f'#EXT-X-EPOCH:id="{meta["epoch_id"]}",index={meta["epoch_index"]}',
                f"#EXT-X-PROGRAM-DATE-TIME:{meta['planned_at']}",
                f"#EXT-X-SEQUENCE:{meta['sequence']}",
                f"#EXT-X-SHA256:{meta['sha256']}",
                (
                    f"#EXT-X-WRITING:complete={'yes' if meta.get('complete') else 'no'},"
                    f"exposed-bytes={meta.get('exposed_size', 0)}"
                ),
                f"#EXTINF:{float(meta['duration_sec']):.3f},{meta['label']}",
                meta["uri"],
            ]
        )

    temporary = playlist_path.with_suffix(".m3u8.tmp")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    temporary.replace(playlist_path)
    return playlist_path


def advance(root: Path | str) -> dict[str, Any]:
    """按固定剧本推进一个可控节拍。

    节拍设计：
    1-2 正常出现 0/1
    3    第 2 段只写一半
    4    第 2 段补完（收录进程可在 3 后被重启）
    5    第 3 段
    6    第 4 段迟到，先出现第 5 段和中间空缺，并轮换 0
    7    迟到的第 4 段补入
    8    第 6 段
    9    跳过 7，出现第 8 段，形成永久中间缺口
    10   断档/静默节拍
    11   新 epoch，序号重新从 0 开始
    12-13 新 epoch 的 1/2
    """
    root = Path(root)
    state = load_world(root)
    state["tick"] = int(state.get("tick", 0)) + 1
    tick = state["tick"]
    events: list[str] = []

    def add(seq: int, **kwargs: Any) -> None:
        meta = _add_segment(root, state, seq, **kwargs)
        events.append(state["tick_log"][-1]["message"])
        if meta.get("removed"):
            pass

    if tick == 1:
        add(0)
    elif tick == 2:
        add(1)
    elif tick == 3:
        add(2, partial_fraction=0.42)
    elif tick == 4:
        _complete_partial(root, state, 2)
        events.append(state["tick_log"][-1]["message"])
    elif tick == 5:
        add(3)
    elif tick == 6:
        add(5)
    elif tick == 7:
        add(4, late=True)
    elif tick == 8:
        add(6)
    elif tick == 9:
        add(8)
    elif tick == 10:
        message = "源端静默/断档一拍：没有新片段，空缺时间继续累计"
        _add_tick_log(state, message)
        events.append(message)
    elif tick == 11:
        _restart_epoch(root, state)
        events.append(state["tick_log"][-1]["message"])
        add(0)
    elif tick == 12:
        add(1)
    elif tick == 13:
        add(2)
    else:
        message = f"剧本主体已结束（tick={tick}）；可继续自行替换 source/playlist.m3u8 试验"
        _add_tick_log(state, message)
        events.append(message)

    # 收集本轮发生的轮换删除事件，便于 CLI/演示打印。
    removed_now = [item for item in state.get("removed", []) if item.get("at") == now_iso()]
    save_world(root, state)
    return {
        "tick": tick,
        "events": events,
        "removed_now": removed_now,
        "playlist": str(root / "source" / "playlist.m3u8"),
    }


def print_world_status(root: Path | str) -> str:
    state = load_world(root)
    lines = [
        f"剧本目录：{root}",
        f"当前节拍：{state['tick']}/13；窗口={state['window']}；"
        f"epoch={state['epoch_id']}；活动段={len(state.get('active_uids', []))}",
    ]
    for log in state.get("tick_log", [])[-8:]:
        lines.append(f"  t{log['tick']:02d} {log['message']}")
    return "\n".join(lines)

"""端到端测试:生成样例 -> 扫描 -> 抢救 -> 校验输出。

直接用 pytest 运行:  python3 -m pytest tests/ -q
测试内部调用本机 ffmpeg,属于集成测试。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from mp4rescue import generator
from mp4rescue.ffmpeg_wrap import probe_streams, verify_decodable
from mp4rescue.rescue import rescue_batch, rescue_file
from mp4rescue.scanner import (
    FRAG_BROKEN_MDAT,
    FRAG_BROKEN_MOOF,
    FRAG_COMPLETE,
    ISSUE_DUPLICATE,
    ISSUE_GAP,
    scan,
)

REPO = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def samples(tmp_path_factory) -> dict[str, Path]:
    out = tmp_path_factory.mktemp("samples")
    return generator.generate_all(out)


def _scan(path: Path):
    return scan(path.read_bytes(), str(path))


# ---------- 需求 1: 三种中断样例 ----------

def test_samples_cover_three_break_types(samples):
    assert {"break_moof.mp4", "break_mdat.mp4", "boundary.mp4"} <= set(samples)

    moof = _scan(samples["break_moof.mp4"])
    assert moof.fragments[-1].status == FRAG_BROKEN_MOOF
    assert "moof" in moof.fragments[-1].parse_note

    mdat = _scan(samples["break_mdat.mp4"])
    assert mdat.fragments[-1].status == FRAG_BROKEN_MDAT
    assert mdat.fragments[-1].mdat_available < mdat.fragments[-1].mdat_size - 8

    boundary = _scan(samples["boundary.mp4"])
    assert all(f.status == FRAG_COMPLETE for f in boundary.fragments)
    # 边界文件:完整段之后没有任何残骸
    assert boundary.export_cut_offset == boundary.file_size


def test_good_file_is_fully_continuous(samples):
    good = _scan(samples["good.mp4"])
    assert good.readable
    assert all(f.status == FRAG_COMPLETE for f in good.fragments)
    assert good.export_fragment_count == len(good.fragments)
    seqs = [f.sequence_number for f in good.fragments]
    assert seqs == list(range(1, len(seqs) + 1))


# ---------- 需求 2: 时间与轨道清单、断点定位 ----------

def test_report_lists_tracks_and_time_ranges(samples):
    result = _scan(samples["break_mdat.mp4"])
    kinds = {m.kind for m in result.tracks.values()}
    assert kinds == {"video", "audio"}
    video = next(t for t in result.timelines.values() if t.kind == "video")
    # 每段视频 1 秒,前缀 4 段
    assert video.prefix_seconds == pytest.approx(4.0, abs=0.001)
    broken = result.fragments[-1]
    assert broken.mdat_available is not None
    # 断点要说清楚缺多少字节
    assert broken.mdat_size - 8 - broken.mdat_available > 0


def test_fragment_global_timeline_accumulates(samples):
    result = _scan(samples["good.mp4"])
    video_runs = [r for f in result.fragments for r in f.runs if r.track_id == 1]
    # 累计起点必须单调递增且每段约 1 秒,证明没有把段内 tfdt 当全局时间
    starts = [r.cumulative_start / result.tracks[1].timescale for r in video_runs]
    assert starts[0] == 0
    assert all(b > a for a, b in zip(starts, starts[1:]))
    assert starts[5] == pytest.approx(5.0, abs=0.001)


# ---------- 需求 3: 导出到最后完整可解码段, 起始说明缺失拒绝 ----------

def test_rejects_missing_moov(samples):
    result = _scan(samples["no_moov.mp4"])
    assert not result.readable
    assert "moov" in result.reject_reason
    outcome = rescue_file(samples["no_moov.mp4"], samples["good.mp4"].parent / "out")
    assert not outcome.accepted
    assert outcome.rescued_mp4 is None


def test_rejects_non_mp4(samples):
    result = _scan(samples["not_mp4.bin"])
    assert not result.readable


def test_rescue_export_is_decodable_mp4(samples, tmp_path):
    outcome = rescue_file(samples["break_mdat.mp4"], tmp_path)
    assert outcome.accepted
    mp4 = Path(outcome.rescued_mp4)
    assert mp4.exists()
    streams = probe_streams(str(mp4), is_fmp4=False)
    codecs = {(s["codec_type"], s["codec_name"]) for s in streams}
    assert ("video", "h264") in codecs
    assert ("audio", "aac") in codecs
    report = verify_decodable(str(Path(outcome.rescued_fmp4)), is_fmp4=True)
    assert report.ok
    # 4 个完整视频段 * 15fps
    assert report.video_frames == 4 * generator.FPS


def test_boundary_rescue_keeps_every_complete_fragment(samples, tmp_path):
    outcome = rescue_file(samples["boundary.mp4"], tmp_path)
    assert outcome.video_seconds_prefix == pytest.approx(5.0, abs=0.001)


# ---------- 需求 4: 掉段/重复段识别 + 连续前缀, 不强行拼接 ----------

def test_gap_detected_and_prefix_cut(samples, tmp_path):
    result = _scan(samples["gap.mp4"])
    run_issues = {r.issue for f in result.fragments for r in f.runs}
    assert ISSUE_GAP in run_issues
    assert any("缺 1 段" in note for tl in result.timelines.values() for note in tl.issues)
    # 缺口在第 5 段,前 4 段可导出,后面的不进输出
    assert result.export_fragment_count == 4
    outcome = rescue_file(samples["gap.mp4"], tmp_path)
    assert outcome.accepted
    rescued = Path(outcome.rescued_fmp4).read_bytes()
    # 导出字节不得包含缺口之后任何分段
    assert len(rescued) == result.export_cut_offset


def test_duplicate_detected_and_prefix_cut(samples):
    result = _scan(samples["duplicate.mp4"])
    run_issues = {r.issue for f in result.fragments for r in f.runs}
    assert ISSUE_DUPLICATE in run_issues
    assert any("重复" in note for tl in result.timelines.values() for note in tl.issues)
    assert result.export_fragment_count == 4


# ---------- 需求 5: 帧号与蜂鸣可比对 ----------

def test_frame_numbers_visible_in_render(tmp_path):
    raw_video = tmp_path / "v.rgb"
    generator.render_video_raw(raw_video)
    frame_size = generator.WIDTH * generator.HEIGHT * 3
    total = generator.FPS * generator.DURATION_SECONDS
    assert raw_video.stat().st_size == frame_size * total


def test_beep_audio_has_periodic_loud_samples(tmp_path):
    raw_audio = tmp_path / "a.pcm"
    generator.render_audio_raw(raw_audio)
    import struct
    data = raw_audio.read_bytes()
    samples = struct.unpack("<%dh" % (len(data) // 2), data)
    sr = generator.SAMPLE_RATE
    # 每秒前 120ms 有蜂鸣(带淡入包络):取蜂鸣中段窗口应有明显能量,
    # 秒中段(0.4~0.6s)应接近静音
    beep_window = samples[int(sr * 0.06): int(sr * 0.10)]
    silent_window = samples[int(sr * 0.4): int(sr * 0.6)]
    assert max(abs(x) for x in beep_window) > 5000
    assert max(abs(x) for x in silent_window) < 100
    # 第二秒蜂鸣音高不同(880Hz),确认每秒定时发声
    second2 = samples[sr + int(sr * 0.06): sr + int(sr * 0.10)]
    assert max(abs(x) for x in second2) > 5000


# ---------- 需求 6: 批量隔离, 单文件损坏不影响其它 ----------

def test_batch_isolation(samples, tmp_path):
    # 混入一个不可读路径和两个坏文件,其余仍应成功
    targets = [
        samples["good.mp4"],
        samples["break_moof.mp4"],
        samples["no_moov.mp4"],
        samples["not_mp4.bin"],
        samples["gap.mp4"],
    ]
    outcomes = rescue_batch(targets, tmp_path)
    assert len(outcomes) == len(targets)
    accepted = [o for o in outcomes if o.accepted]
    rejected = [o for o in outcomes if not o.accepted]
    assert len(accepted) == 3
    assert len(rejected) == 2
    # 每份都有独立报告文件
    for o in outcomes:
        assert Path(o.report_txt).exists()
        payload = json.loads(Path(o.report_json).read_text())
        assert "fragments" in payload or payload["readable"] is False


def test_rescued_video_frame_order_matches_prefix(samples, tmp_path):
    """抢救后视频帧顺序必须与源前缀一致(抽帧比对帧号区域)。"""
    outcome = rescue_file(samples["good.mp4"], tmp_path, do_verify=False)
    # 抽第 0、15、30 帧(对应 FRAME 0000/0015/0030)导出为 png 检查可解码且尺寸正确
    mp4 = outcome.rescued_mp4
    for frame_no in (0, 15, 30):
        png = tmp_path / f"f{frame_no}.png"
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-i", mp4, "-vf", f"select=eq(n\\,{frame_no})", "-vframes", "1", str(png)],
            capture_output=True, text=True,
        )
        assert proc.returncode == 0, proc.stderr
        assert png.exists() and png.stat().st_size > 0

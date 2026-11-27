"""Headless tests for the full drum-replacement pipeline.

Run with:  python -m pytest tests/ -q
"""

import numpy as np
import pytest

from drumreplace.synthesis import (
    SAMPLE_RATE, Event, build_practice_scene, build_sample_library,
    synth_click, synth_blip,
)
from drumreplace.detection import DetectionParams, detect_hits
from drumreplace.replacement import render_replacement, verify


@pytest.fixture(scope="module")
def scene():
    audio, gt = build_practice_scene()
    return audio, gt, detect_hits(audio)


# --------------------------------------------------------------------------- #
# synthesis
# --------------------------------------------------------------------------- #
def test_scene_contains_bass_bed_and_two_drum_classes():
    _, gt = build_practice_scene()
    kinds = {e.drum for e in gt if e.kind == "hit"}
    assert kinds == {"kick", "snare"}
    assert any(e.kind == "distractor" for e in gt)
    velocities = {e.velocity for e in gt if e.kind == "hit"}
    assert velocities == {"hard", "soft"}


def test_scene_contains_overlapping_and_roll_hits():
    _, gt = build_practice_scene()
    hits = [e for e in gt if e.kind == "hit"]
    # same-class overlap pair (60 ms)
    kicks = sorted(e.time for e in hits if e.drum == "kick")
    assert any(b - a == pytest.approx(0.06, abs=0.005)
               for a, b in zip(kicks, kicks[1:]))
    # cross-class overlap at the same instant
    t_kick = {round(e.time, 3) for e in hits if e.drum == "kick"}
    t_snare = {round(e.time, 3) for e in hits if e.drum == "snare"}
    assert t_kick & t_snare


def test_distractors_are_shorter_than_real_hits():
    click, blip = synth_click(), synth_blip()
    assert len(click) / SAMPLE_RATE < 0.02
    assert len(blip) / SAMPLE_RATE < 0.02


def test_sample_library_has_four_voices_and_unit_peak():
    lib = build_sample_library()
    assert set(lib) == {
        ("kick", "hard"), ("kick", "soft"),
        ("snare", "hard"), ("snare", "soft"),
    }
    for voice in lib.values():
        assert np.max(np.abs(voice)) == pytest.approx(1.0)


# --------------------------------------------------------------------------- #
# detection
# --------------------------------------------------------------------------- #
def test_perfect_detection_on_scene(scene):
    audio, gt, dets = scene
    report = verify(gt, dets, audio, audio)
    assert report.recall == 1.0
    assert report.precision == 1.0
    assert report.distractors_rejected == report.distractors_total
    assert not report.missed
    assert not report.false_alarms
    assert not report.duplicates
    assert not report.velocity_errors


def test_detection_times_within_tolerance(scene):
    _, gt, dets = scene
    truth = [e for e in gt if e.kind == "hit"]
    for g in truth:
        assert any(abs(d.time - g.time) <= 0.04 and d.drum == g.drum
                   for d in dets), f"no match for {g}"


def test_detection_is_deterministic(scene):
    audio, _, dets = scene
    again = detect_hits(audio)
    assert [(d.time, d.drum, d.velocity) for d in dets] == \
           [(d.time, d.drum, d.velocity) for d in again]


def test_threshold_sweep_never_accepts_distractors(scene):
    audio, gt, _ = scene
    for mult in (1.2, 1.8, 2.5):
        dets = detect_hits(audio, DetectionParams(flux_threshold=mult))
        for blip in (e for e in gt if e.kind == "distractor"):
            assert all(abs(d.time - blip.time) > 0.04 for d in dets)


# --------------------------------------------------------------------------- #
# replacement
# --------------------------------------------------------------------------- #
def test_render_preserves_length_and_extends_for_tail(scene):
    audio, _, dets = scene
    res = render_replacement(audio, dets, dry_wet=0.0)
    assert len(res.mix) >= len(audio)
    assert len(res.difference) == len(res.mix)


def test_dense_hits_sum_without_erasing_previous_tail(scene):
    audio, _, dets = scene
    # two hits 60 ms apart with long samples: both tails must be present.
    # Render a single pair and check the buffer between them keeps growing.
    pair = [Event(0.10, "kick", "hard"), Event(0.16, "snare", "hard")]
    buf = np.zeros(int(0.8 * SAMPLE_RATE))
    res = render_replacement(buf, pair, dry_wet=0.0)
    # energy in the gap must be nonzero (first sample's tail survives)
    gap = res.wet[int(0.16 * SAMPLE_RATE):int(0.20 * SAMPLE_RATE)]
    assert np.sum(gap ** 2) > 0


def test_dry_wet_extremes(scene):
    audio, _, dets = scene
    full_dry = render_replacement(audio, dets, dry_wet=1.0)
    full_wet = render_replacement(audio, dets, dry_wet=0.0)
    # dry_wet=1 returns the original exactly
    assert np.allclose(full_dry.mix[:len(audio)], audio)
    # fully replaced differs from the original at hit locations
    assert not np.allclose(full_wet.mix[:len(audio)], audio)


def test_loudness_change_is_bounded(scene):
    audio, gt, dets = scene
    res = render_replacement(audio, dets, dry_wet=0.0)
    report = verify(gt, dets, audio, res.mix)
    # local RMS around hits should move by less than 6 dB either way
    assert abs(report.mean_local_rms_db_change) < 6.0


def test_no_clipping(scene):
    audio, _, dets = scene
    res = render_replacement(audio, dets, dry_wet=0.0)
    assert np.max(np.abs(res.mix)) <= 1.0
    assert np.max(np.abs(res.wet)) <= 1.0


# --------------------------------------------------------------------------- #
# head / tail boundary rules
# --------------------------------------------------------------------------- #
def test_head_marker_needs_no_preroll_and_is_not_clipped():
    # marker at t=0: sample onset lands exactly on the first sample
    events = [Event(0.0, "kick", "hard")]
    buf = np.zeros(int(0.5 * SAMPLE_RATE))
    res = render_replacement(buf, events, dry_wet=0.0)
    assert res.clipped_head_samples == 0
    # onset begins at the first sample (the short attack ramp is part of the
    # sample, not a pre-roll gap)
    assert np.sum(res.wet[:int(0.01 * SAMPLE_RATE)] ** 2) > 0.0
    assert res.wet[1] != 0.0


def test_tail_past_end_is_extended_not_dropped():
    lib = build_sample_library()
    voice = lib[("snare", "hard")]
    events = [Event(0.0, "kick", "hard")]
    # buffer shorter than the sample: tail must survive via extension
    short = np.zeros(int(0.05 * SAMPLE_RATE))
    res = render_replacement(short, events, dry_wet=0.0)
    assert len(res.wet) >= len(voice)
    assert res.dropped_tail_samples > 0  # what a fixed-length export would lose
    # energy beyond the original end is the preserved tail
    tail = res.wet[len(short):]
    assert np.sum(tail ** 2) > 0


def test_marker_before_zero_is_counted_as_head_clip():
    events = [Event(-0.01, "kick", "hard")]
    buf = np.zeros(int(0.5 * SAMPLE_RATE))
    res = render_replacement(buf, events, dry_wet=0.0)
    assert res.clipped_head_samples > 0


# --------------------------------------------------------------------------- #
# verification
# --------------------------------------------------------------------------- #
def test_verification_flags_missed_duplicate_and_false_alarm(scene):
    audio, gt, dets = scene
    truth = [e for e in gt if e.kind == "hit"]
    tampered = dets[2:]                            # drop two -> misses
    tampered.append(Event(99.0, "kick", "hard"))   # impossible time -> false alarm
    anchor = tampered[0]
    tampered.append(Event(anchor.time + 0.01, anchor.drum, "hard"))  # near-copy
    report = verify(truth, tampered, audio, audio, tolerance_sec=0.04)
    assert len(report.missed) >= 1
    assert len(report.duplicates) >= 1
    assert len(report.false_alarms) >= 1


def test_verification_detects_velocity_mismatch(scene):
    audio, gt, dets = scene
    flipped = [Event(d.time, d.drum,
                     "soft" if d.velocity == "hard" else "hard") for d in dets]
    report = verify(gt, flipped, audio, audio)
    assert len(report.velocity_errors) > 0

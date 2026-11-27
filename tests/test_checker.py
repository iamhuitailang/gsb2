from __future__ import annotations

import json
from pathlib import Path

import pytest

from sound_checker.audio import probe_audio
from sound_checker.samples import generate_sample_set
from sound_checker.storage import Library


@pytest.fixture()
def library(tmp_path: Path) -> Library:
    samples = generate_sample_set(tmp_path / "samples")
    lib = Library(tmp_path / "home")
    result = lib.add_paths([str(p) for p in samples])
    assert not result["errors"]
    return lib


def _item(report, name_a: str, name_b: str):
    for item in report["items"]:
        names = {item["file_a"]["name"], item["file_b"]["name"]}
        if name_a in names and name_b in names:
            return item
    raise AssertionError(f"missing pair {name_a} / {name_b}")


def test_generated_metadata_covers_stereo_and_mono(tmp_path: Path):
    paths = {p.name: p for p in generate_sample_set(tmp_path / "samples")}
    original = probe_audio(paths["01_original.wav"])
    resaved = probe_audio(paths["06_resaved_mono_22050.wav"])
    assert original["channels"] == 2
    assert original["sample_rate"] == 44100
    assert original["duration"] == pytest.approx(2.42, abs=0.08)
    assert resaved["channels"] == 1
    assert resaved["sample_rate"] == 22050


def test_volume_crop_and_resave_variants_are_high(library: Library):
    report = library.analyze()
    for variant in [
        "02_volume_plus7dB.wav",
        "03_volume_minus12dB.wav",
        "04_trimmed_head_tail.wav",
        "05_middle_excerpt.wav",
        "06_resaved_mono_22050.wav",
    ]:
        item = _item(report, "01_original.wav", variant)
        assert item["category"] == "high", (variant, item)
        assert item["similarity"] >= 0.90
        assert item["a_end"] > item["a_start"]
        assert item["b_end"] > item["b_start"]


def test_confusable_and_constant_tone_are_not_high(library: Library):
    report = library.analyze()
    lookalike = _item(report, "01_original.wav", "07_lookalike_same_timbre.wav")
    assert lookalike["category"] in {"uncertain", "different"}

    tone = _item(report, "08_steady_tone.wav", "09_steady_tone_quiet_trim.wav")
    assert tone["category"] != "high"
    assert tone["aligned_events"] < 3

    unrelated = _item(report, "01_original.wav", "08_steady_tone.wav")
    assert unrelated["category"] == "different"


def test_duplicate_path_does_not_create_second_index(library: Library):
    first = next(iter(library.state["files"].values()))
    result = library.add_paths([first["path"]])
    assert len(library.state["files"]) == 9
    assert result["duplicates"]
    assert not result["added"]


def test_unreadable_paths_are_separate(tmp_path: Path):
    lib = Library(tmp_path / "home")
    missing = tmp_path / "does-not-exist.wav"
    result = lib.add_paths([str(missing)])
    assert result["errors"]
    state = lib.public_state()
    assert state["unreadable_count"] == 1
    assert state["readable_count"] == 0
    assert all(f["error"] for f in state["files"])


def test_verdicts_survive_restart_add_and_delete(library: Library, tmp_path: Path):
    report = library.analyze()
    target = _item(report, "01_original.wav", "02_volume_plus7dB.wav")
    library.set_verdict(target["verdict_key"], "false_positive", "人工试听后排除")

    # Restart from the same JSON state directory.
    reopened = Library(tmp_path / "home")
    assert reopened.state["verdicts"][target["verdict_key"]]["status"] == "false_positive"

    new_sound = tmp_path / "extra.wav"
    generate_sample_set(tmp_path / "more_samples")
    extra = tmp_path / "more_samples" / "07_lookalike_same_timbre.wav"
    reopened.add_paths([str(extra)])
    reopened.analyze()

    # Delete an unrelated file; the saved mark must remain queryable.
    tone_record = next(
        r for r in reopened.state["files"].values() if r["original_name"] == "08_steady_tone.wav"
    )
    reopened.remove_file(tone_record["id"])
    report_after = reopened.analyze()
    marked = next(i for i in report_after["items"] if i["verdict"])
    assert marked["verdict"]["status"] == "false_positive"
    assert marked["verdict"]["note"] == "人工试听后排除"


def test_export_contains_parameters_ranges_and_verdicts(library: Library):
    report = library.analyze()
    target = next(i for i in report["items"] if i["category"] == "high")
    library.set_verdict(target["verdict_key"], "confirmed")

    payload = json.loads(library.export_payload("json"))
    assert payload["parameters"]["version"] == 1
    assert payload["results"]
    assert all("a_start" in x and "b_start" in x for x in payload["results"])
    assert any(v["status"] == "confirmed" for v in payload["verdicts"])

    csv_text = library.export_payload("csv")
    assert "category,score,similarity" in csv_text
    assert "verdict_key" in csv_text

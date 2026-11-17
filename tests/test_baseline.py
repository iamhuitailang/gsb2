"""基线测试: 行号平移、过期条目、消失条目与损坏基线。"""

import json
import os
import tempfile
import unittest

from secretscan.baseline import (
    BASELINE_FORMAT_VERSION,
    BaselineEntry,
    diff_against_baseline,
    load_baseline,
    write_baseline,
)
from secretscan.config import Config
from secretscan.errors import BaselineError
from secretscan.models import Finding, make_fingerprint
from secretscan.scanner import Scanner

SECRET = "Zx9Qm4Tv7Lk2Pw8Rn5Yc3Hf6Dg1Ja0Nb"
PATH = "app/settings.py"


def _scan(root: str):
    config = Config()
    scanner = Scanner(root, config, config.build_rules())
    findings, _ = scanner.run()
    return findings


def _write_baseline_file(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)


class BaselineBehaviorTest(unittest.TestCase):
    def test_line_shift_does_not_make_old_finding_new(self):
        with tempfile.TemporaryDirectory() as root:
            target = os.path.join(root, PATH)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(f'client_secret = "{SECRET}"\n')
            first = _scan(root)
            self.assertEqual(len(first), 1)

            baseline_path = os.path.join(root, "baseline.json")
            write_baseline(baseline_path, first)
            entries = load_baseline(baseline_path)

            # 在文件前面插入 5 行无关内容, 行号变化但指纹不变。
            with open(target, "w", encoding="utf-8") as handle:
                handle.write("# banner line 1\n" * 5)
                handle.write(f'client_secret = "{SECRET}"\n')
            second = _scan(root)
            self.assertEqual(second[0].line, 6)
            self.assertEqual(second[0].fingerprint, first[0].fingerprint)

            diff = diff_against_baseline(second, entries)
            self.assertEqual(diff.new_findings, [])
            self.assertEqual(len(diff.acknowledged), 1)

    def test_new_secret_outside_baseline_is_new(self):
        with tempfile.TemporaryDirectory() as root:
            target = os.path.join(root, PATH)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(f'client_secret = "{SECRET}"\n')
            findings = _scan(root)
            baseline_path = os.path.join(root, "baseline.json")
            write_baseline(baseline_path, findings)
            entries = load_baseline(baseline_path)

            with open(target, "a", encoding="utf-8") as handle:
                handle.write('token = "Qm7Tn3Kp8Wv2Lx5Rc9Yf4Hj6Ds1Za0Xb"\n')
            updated = _scan(root)
            diff = diff_against_baseline(updated, entries)
            self.assertEqual(len(diff.new_findings), 1)
            self.assertTrue(diff.has_new)

    def test_expired_entry_is_reported_as_new_and_listed(self):
        fingerprint = make_fingerprint(PATH, "credential.assignment", SECRET)
        entry = BaselineEntry(
            fingerprint=fingerprint,
            path=PATH,
            rule_id="credential.assignment",
            severity="high",
            reason="r",
            match_length=len(SECRET),
            first_seen="2026-01-01",
            expires_on="2026-02-01",  # 相对当前日期 2026-11-18 已过期
        )
        finding = Finding(
            path=PATH,
            line=1,
            column=18,
            rule_id="credential.assignment",
            severity="high",
            reason="r",
            match_length=len(SECRET),
            fingerprint=fingerprint,
        )
        diff = diff_against_baseline([finding], {fingerprint: entry})
        self.assertEqual(diff.new_findings, [finding])
        self.assertEqual(len(diff.expired), 1)
        self.assertEqual(diff.acknowledged, [])

    def test_missing_entries_listed_separately(self):
        fingerprint = make_fingerprint(PATH, "credential.assignment", SECRET)
        entry = BaselineEntry(
            fingerprint=fingerprint,
            path=PATH,
            rule_id="credential.assignment",
            severity="high",
            reason="r",
            match_length=len(SECRET),
            first_seen="2026-01-01",
        )
        diff = diff_against_baseline([], {fingerprint: entry})
        self.assertEqual(diff.missing, [entry])
        self.assertEqual(diff.new_findings, [])

    def test_update_preserves_first_seen_and_expiry(self):
        with tempfile.TemporaryDirectory() as root:
            target = os.path.join(root, PATH)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(f'client_secret = "{SECRET}"\n')
            findings = _scan(root)
            baseline_path = os.path.join(root, "baseline.json")
            write_baseline(baseline_path, findings)
            entries = load_baseline(baseline_path)
            fp = findings[0].fingerprint
            entries[fp] = BaselineEntry(
                **{**entries[fp].__dict__, "expires_on": "2030-01-01"}
            )
            # 再次写入: 旧字段应保留。
            write_baseline(baseline_path, findings, entries)
            reloaded = load_baseline(baseline_path)
            self.assertEqual(reloaded[fp].expires_on, "2030-01-01")
            self.assertEqual(reloaded[fp].first_seen, entries[fp].first_seen)

    def test_baseline_never_contains_secret_text(self):
        with tempfile.TemporaryDirectory() as root:
            target = os.path.join(root, PATH)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(f'client_secret = "{SECRET}"\n')
            findings = _scan(root)
            baseline_path = os.path.join(root, "baseline.json")
            write_baseline(baseline_path, findings)
            raw = open(baseline_path, encoding="utf-8").read()
            self.assertNotIn(SECRET, raw)


class CorruptBaselineTest(unittest.TestCase):
    def test_bad_json(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "b.json")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("{not json")
            with self.assertRaises(BaselineError):
                load_baseline(path)

    def test_wrong_version(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "b.json")
            _write_baseline_file(
                path, {"format_version": 99, "entries": []}
            )
            with self.assertRaises(BaselineError):
                load_baseline(path)

    def test_missing_field(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "b.json")
            _write_baseline_file(
                path,
                {
                    "format_version": BASELINE_FORMAT_VERSION,
                    "entries": [{"fingerprint": "abc"}],  # 字段不全
                },
            )
            with self.assertRaises(BaselineError):
                load_baseline(path)

    def test_duplicate_fingerprint(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "b.json")
            entry = {
                "fingerprint": "dup",
                "path": "a",
                "rule_id": "r.x",
                "severity": "low",
                "reason": "r",
                "match_length": 8,
                "first_seen": "2026-01-01",
            }
            _write_baseline_file(
                path,
                {"format_version": BASELINE_FORMAT_VERSION, "entries": [entry, entry]},
            )
            with self.assertRaises(BaselineError):
                load_baseline(path)


if __name__ == "__main__":
    unittest.main()

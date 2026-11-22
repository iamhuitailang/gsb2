"""端到端测试: 只依赖标准库 unittest。

运行:
    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from save_migrator.errors import UnknownVersionError  # noqa: E402
from save_migrator.migrate import (  # noqa: E402
    OutputConflictError,
    check_save,
    inspect_save,
    migrate_file,
    preview_save,
)
from save_migrator.rules import load_rules  # noqa: E402

SAMPLES = ROOT / "samples"
RULES = ROOT / "rules" / "default_rules.json"

V1_CROSS = SAMPLES / "save_v1_cross.json"
V2_REMOVED = SAMPLES / "save_v2_removed_item.json"
V2_BROKEN = SAMPLES / "save_v2_broken_field.json"
V3_CURRENT = SAMPLES / "save_v3_current.json"


class TempDirTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def copy_sample(self, source: Path) -> Path:
        target = self.tmp / source.name
        shutil.copyfile(source, target)
        return target

    def load(self, path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    def write_json(self, name: str, payload: object) -> Path:
        path = self.tmp / name
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return path


class CrossVersionTests(TempDirTest):
    def test_preview_lists_old_new_rule_and_source(self) -> None:
        source = self.copy_sample(V1_CROSS)
        report = preview_save(source, RULES)
        self.assertEqual(report.status, "ok", report.render_text())
        kinds = {change.kind for change in report.changes}
        self.assertIn("item-id", kinds)
        self.assertIn("coordinate", kinds)
        self.assertIn("quest-split", kinds)

        coordinate = next(change for change in report.changes if change.path == "$.location.x")
        self.assertEqual(coordinate.old, 120)
        self.assertAlmostEqual(coordinate.new, 132.0)
        self.assertIn("map_transforms[1->2]", coordinate.rule)
        self.assertEqual(coordinate.source_pointer, "$.location.x")

        item = next(change for change in report.changes if change.kind == "item-id")
        self.assertEqual((item.old, item.new), (101, 2101))
        self.assertIn("items[1->2][101]", item.rule)

        text = report.render_text()
        for label in ("原值", "新值", "规则", "来源"):
            self.assertIn(label, text)

        # 预览不写文件
        self.assertIsNone(report.output)
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), [source.name])

    def test_cross_version_source_pointer_stays_at_original_document(self) -> None:
        source = self.copy_sample(V1_CROSS)
        report = preview_save(source, RULES)
        # 第二步的物品来源仍应指向 v1 的 items 数组, 而不是 v2 的 slots。
        second_step_items = [
            change
            for change in report.changes
            if change.step == "2->3" and change.kind == "item-id"
        ]
        self.assertTrue(second_step_items)
        for change in second_step_items:
            self.assertIn("$.inventory.items[", change.source_pointer)
            self.assertIn("$.inventory.slots[", change.path)

    def test_migrate_writes_readable_save_and_keeps_source(self) -> None:
        source = self.copy_sample(V1_CROSS)
        before = source.read_bytes()
        output = self.tmp / "out" / "save_v3.json"
        report = migrate_file(source, output, RULES)
        self.assertEqual(report.status, "ok", report.render_text())
        self.assertEqual(source.read_bytes(), before, "源存档必须保持原样")

        migrated = self.load(output)
        self.assertEqual(migrated["format"], 3)
        self.assertEqual(migrated["location"]["region"], "harbor_town")
        self.assertEqual(migrated["location"]["checkpoint"], "pier_gate")
        self.assertAlmostEqual(migrated["location"]["x"], 131.86)
        self.assertAlmostEqual(migrated["location"]["y"], -45.885)
        self.assertEqual(migrated["inventory"]["slots"][0]["id"], 3101)
        self.assertEqual(migrated["player"], {"name": "林雾", "level": 12, "xp": 3400})
        completed = {q["id"]: q for q in migrated["quests"]["completed"]}
        self.assertEqual(completed["q_harbor_letters"]["status"], "complete")
        self.assertEqual(completed["q_harbor_letters"]["chapter"], 1)
        self.assertEqual(completed["q_harbor_letters"]["step"], 2)
        self.assertIn("migration", migrated)
        self.assertEqual(migrated["migration"]["source_sha256"], report.source["sha256"])

        # 输出本身能被 check 读入并检查关键进度
        check = check_save(output, RULES)
        self.assertEqual(check.status, "ok", check.render_text())
        self.assertEqual(check.progress["inventory"]["slot_count"], 5)
        self.assertEqual(check.progress["inventory"]["total_qty"], 27)
        self.assertEqual(check.progress["quests"]["completed_count"], 2)
        self.assertAlmostEqual(check.progress["location"]["x"], 131.86)
        self.assertAlmostEqual(check.progress["location"]["y"], -45.885)

    def test_rerun_is_idempotent_and_does_not_overwrite(self) -> None:
        source = self.copy_sample(V1_CROSS)
        output = self.tmp / "save_v3.json"
        first = migrate_file(source, output, RULES)
        first_bytes = output.read_bytes()
        first_sha = first.output["sha256"]

        second = migrate_file(source, output, RULES)
        self.assertEqual(second.output["mode"], "reused")
        self.assertEqual(second.output["sha256"], first_sha)
        self.assertEqual(output.read_bytes(), first_bytes)

        # 输出已存在且被外部改动时, 默认拒绝覆盖
        output.write_text("{}\n", encoding="utf-8")
        with self.assertRaises(OutputConflictError):
            migrate_file(source, output, RULES)
        self.assertEqual(output.read_text(encoding="utf-8"), "{}\n")

    def test_force_overwrites_when_explicitly_allowed(self) -> None:
        source = self.copy_sample(V1_CROSS)
        output = self.tmp / "save_v3.json"
        migrate_file(source, output, RULES)
        output.write_text("{}\n", encoding="utf-8")
        report = migrate_file(source, output, RULES, force=True)
        self.assertEqual(report.output["mode"], "overwritten")
        self.assertEqual(self.load(output)["format"], 3)

    def test_output_cannot_be_source(self) -> None:
        source = self.copy_sample(V1_CROSS)
        with self.assertRaises(OutputConflictError):
            migrate_file(source, source, RULES)


class RemovedItemTests(TempDirTest):
    def test_removed_item_warns_with_specific_content(self) -> None:
        source = self.copy_sample(V2_REMOVED)
        report = preview_save(source, RULES)
        self.assertEqual(report.status, "ok", report.render_text())
        removed = [w for w in report.warnings if w.code == "item-removed"]
        self.assertEqual(len(removed), 1)
        self.assertIn("2106", removed[0].message)
        self.assertIn("船票", removed[0].message)
        self.assertEqual(removed[0].old["qty"], 1)
        self.assertEqual(removed[0].path, "$.inventory.slots[2].id")
        self.assertEqual(removed[0].source_pointer, "$.inventory.slots[2].id")
        self.assertIsNone(removed[0].new)
        text = report.render_text()
        self.assertIn("原值", text)
        self.assertIn("来源", text)

    def test_removed_item_not_in_output(self) -> None:
        source = self.copy_sample(V2_REMOVED)
        output = self.tmp / "save_v3.json"
        report = migrate_file(source, output, RULES)
        self.assertEqual(report.status, "ok", report.render_text())
        migrated = self.load(output)
        ids = [slot["id"] for slot in migrated["inventory"]["slots"]]
        self.assertNotIn(3106, ids)
        self.assertEqual(len(ids), 3)
        self.assertEqual(sum(slot["qty"] for slot in migrated["inventory"]["slots"]), 54)
        # 警告写进了输出, 方便事后追查
        warning_codes = [w["code"] for w in migrated["migration"]["warnings"]]
        self.assertIn("item-removed", warning_codes)
        removed_warning = next(
            w for w in migrated["migration"]["warnings"] if w["code"] == "item-removed"
        )
        self.assertEqual(removed_warning["source_pointer"], "$.inventory.slots[2].id")


class BrokenFieldTests(TempDirTest):
    def test_broken_field_blocks_output(self) -> None:
        source = self.copy_sample(V2_BROKEN)
        before = source.read_bytes()
        output = self.tmp / "save_v3.json"
        report = migrate_file(source, output, RULES)
        self.assertEqual(report.status, "blocked")
        self.assertFalse(output.exists(), "校验失败时不能产生输出")
        self.assertEqual(source.read_bytes(), before)

        codes = {problem.code for problem in report.errors}
        self.assertIn("player-level-out-of-range", codes)
        self.assertIn("item-qty-invalid", codes)
        text = report.render_text()
        self.assertIn("阻断问题", text)
        self.assertIn("$.player.level", text)
        self.assertIn("750", text)

    def test_preview_of_broken_save_shows_everything(self) -> None:
        source = self.copy_sample(V2_BROKEN)
        report = preview_save(source, RULES)
        self.assertEqual(report.status, "blocked")
        self.assertIsNone(report.output)
        problems = {problem.code for problem in report.errors}
        self.assertIn("player-level-out-of-range", problems)
        self.assertIn("item-qty-invalid", problems)
        self.assertIn("output-player-level", problems)
        self.assertIn("output-qty-invalid", problems)

    def test_unknown_item_blocks_and_names_the_item(self) -> None:
        source = self.copy_sample(V2_REMOVED)
        data = json.loads(source.read_text(encoding="utf-8"))
        data["inventory"]["slots"].append({"id": 2999, "qty": 3})
        source.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        report = preview_save(source, RULES)
        self.assertEqual(report.status, "blocked")
        unmapped = [problem for problem in report.errors if problem.code == "item-unmapped"]
        self.assertEqual(len(unmapped), 1)
        self.assertIn("2999", unmapped[0].message)
        self.assertEqual(unmapped[0].path, "$.inventory.slots[4].id")
        self.assertEqual(unmapped[0].source_pointer, "$.inventory.slots[4].id")
        self.assertIn("items[2->3]", unmapped[0].rule)

    def test_duplicate_item_in_source_merges_with_warning(self) -> None:
        source = self.copy_sample(V2_REMOVED)
        data = json.loads(source.read_text(encoding="utf-8"))
        data["inventory"]["slots"].append({"id": 2101, "qty": 1})
        source.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        report = preview_save(source, RULES)
        self.assertEqual(report.status, "ok", report.render_text())
        # 两个旧格映射到同一新编号时合并, 并给出警告, 而不是写出重复物品。
        merged = [w for w in report.warnings if w.code == "item-merged"]
        self.assertEqual(len(merged), 1)
        output = self.tmp / "merged.json"
        migrate_file(source, output, RULES)
        ids = [slot["id"] for slot in self.load(output)["inventory"]["slots"]]
        self.assertEqual(len(ids), len(set(ids)))


class UnknownVersionTests(TempDirTest):
    def test_unknown_version_is_rejected_with_message(self) -> None:
        source = self.write_json("future.json", {"format": 99})
        with self.assertRaises(UnknownVersionError) as caught:
            preview_save(source, RULES)
        self.assertIn("99", caught.exception.message)
        self.assertEqual(caught.exception.found, 99)

    def test_missing_or_garbage_format_is_rejected(self) -> None:
        for index, value in enumerate((None, "2", True, 2.0)):
            payload = {"format": value} if value is not None else {}
            source = self.write_json(f"bad-{index}.json", payload)
            with self.assertRaises(UnknownVersionError):
                preview_save(source, RULES)

    def test_malformed_json_reports_position(self) -> None:
        source = self.tmp / "broken.json"
        source.write_text('{"format": 1,', encoding="utf-8")
        from save_migrator.errors import SaveReadError

        with self.assertRaises(SaveReadError) as caught:
            preview_save(source, RULES)
        self.assertIn("第", caught.exception.detail)


class RuleIterationTests(TempDirTest):
    def test_same_source_rerun_with_changed_rule(self) -> None:
        source = self.copy_sample(V1_CROSS)
        before = preview_save(source, RULES)

        rules = json.loads(RULES.read_text(encoding="utf-8"))
        rules["map_transforms"]["1->2"]["offset_x"] = 20
        changed_path = self.tmp / "changed_rules.json"
        changed_path.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")
        after = preview_save(source, str(changed_path))

        self.assertEqual(after.status, "ok", after.render_text())
        before_x = next(c for c in before.changes if c.path == "$.location.x")
        after_x = next(c for c in after.changes if c.path == "$.location.x")
        self.assertEqual(before_x.new, 132.0)
        self.assertAlmostEqual(after_x.new, 146.0)
        self.assertNotEqual(before.rules["digest"], after.rules["digest"])
        self.assertEqual(source.read_bytes(), V1_CROSS.read_bytes())

    def test_bad_rules_are_rejected_before_migration(self) -> None:
        rules = json.loads(RULES.read_text(encoding="utf-8"))
        rules["removed_items"]["1->2"]["103"] = ""
        bad_path = self.tmp / "bad_rules.json"
        bad_path.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")
        with self.assertRaises(Exception) as caught:
            load_rules(bad_path)
        self.assertIn("原因", str(caught.exception))

    def test_broken_rule_chain_rejected(self) -> None:
        rules = json.loads(RULES.read_text(encoding="utf-8"))
        # 2101 是 1->2 的映射目标; 从 2->3 删掉且不标记移除后, 链条断开。
        del rules["items"]["2->3"]["2101"]
        bad_path = self.tmp / "broken_chain.json"
        bad_path.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")
        with self.assertRaises(Exception) as caught:
            load_rules(bad_path)
        self.assertIn("2101", str(caught.exception))

    def test_duplicate_quest_stage_split_rejected(self) -> None:
        rules = json.loads(RULES.read_text(encoding="utf-8"))
        rules["quest_stage_split"]["2->3"]["1"] = {"chapter": 2, "step": 1}
        bad_path = self.tmp / "dup_rules.json"
        bad_path.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")
        with self.assertRaises(Exception) as caught:
            load_rules(bad_path)
        self.assertIn("章节/步骤重复", str(caught.exception))


class CurrentVersionTests(TempDirTest):
    def test_current_save_is_not_rewritten(self) -> None:
        source = self.copy_sample(V1_CROSS)
        output = self.tmp / "save_v3.json"
        migrate_file(source, output, RULES)
        again = migrate_file(output, self.tmp / "save_v3_again.json", RULES)
        self.assertEqual(again.status, "current")
        self.assertFalse((self.tmp / "save_v3_again.json").exists())

    def test_current_sample_checks_clean(self) -> None:
        report = check_save(V3_CURRENT, RULES)
        self.assertEqual(report.status, "ok", report.render_text())
        self.assertEqual(report.progress["inventory"]["slot_count"], 5)
        self.assertEqual(report.progress["quests"]["completed_count"], 2)
        self.assertEqual(report.progress["location"]["checkpoint"], "pier_gate")

    def test_inspect_reports_progress(self) -> None:
        report = inspect_save(V1_CROSS, RULES)
        self.assertEqual(report.progress["location"]["map"], "harbor_town")
        self.assertEqual(report.progress["inventory"]["slot_count"], 5)
        self.assertIn("背包", report.render_text())


class CliTests(TempDirTest):
    def run_cli(self, *argv: str) -> tuple[int, str]:
        import contextlib
        import io

        from save_migrator.cli import main

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            code = main(list(argv))
        return code, buffer.getvalue()

    def test_preview_migrate_check_roundtrip(self) -> None:
        source = self.copy_sample(V1_CROSS)
        code, text = self.run_cli("preview", str(source))
        self.assertEqual(code, 0, text)
        self.assertIn("原值", text)
        self.assertIn("新值", text)
        self.assertIn("规则", text)

        output = self.tmp / "out" / "save_v3.json"
        code, text = self.run_cli("migrate", str(source), "-o", str(output))
        self.assertEqual(code, 0, text)
        self.assertTrue(output.exists())

        code, text = self.run_cli("check", str(output))
        self.assertEqual(code, 0, text)
        self.assertIn("关键进度", text)

    def test_broken_save_exit_code_and_no_output(self) -> None:
        source = self.copy_sample(V2_BROKEN)
        output = self.tmp / "should_not_exist.json"
        code, text = self.run_cli("migrate", str(source), "-o", str(output))
        self.assertEqual(code, 3, text)
        self.assertFalse(output.exists())

    def test_unknown_version_exit_code(self) -> None:
        source = self.write_json("future.json", {"format": 42})
        code, text = self.run_cli("preview", str(source))
        self.assertEqual(code, 5, text)
        self.assertIn("42", text)

    def test_conflict_exit_code(self) -> None:
        source = self.copy_sample(V1_CROSS)
        output = self.tmp / "save_v3.json"
        code, _ = self.run_cli("migrate", str(source), "-o", str(output))
        self.assertEqual(code, 0)
        output.write_text("{}\n", encoding="utf-8")
        code, text = self.run_cli("migrate", str(source), "-o", str(output))
        self.assertEqual(code, 4, text)
        self.assertIn("已存在", text)

    def test_compare_reports_rule_change(self) -> None:
        source = self.copy_sample(V1_CROSS)
        before = self.tmp / "report_before.json"
        after = self.tmp / "report_after.json"
        code, text = self.run_cli("preview", str(source), "--json-report", str(before))
        self.assertEqual(code, 0, text)

        rules = json.loads(RULES.read_text(encoding="utf-8"))
        rules["map_transforms"]["1->2"]["offset_x"] = 20
        changed = self.tmp / "changed_rules.json"
        changed.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")
        code, text = self.run_cli(
            "preview", str(source), "--rules", str(changed), "--json-report", str(after)
        )
        self.assertEqual(code, 0, text)

        code, text = self.run_cli("compare", str(before), str(after))
        self.assertEqual(code, 0, text)
        self.assertIn("同一份原档: 是", text)
        self.assertIn("$.location.x", text)
        self.assertIn("结果变化", text)


if __name__ == "__main__":
    unittest.main()

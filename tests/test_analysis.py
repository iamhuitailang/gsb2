"""图分析与数据模型的单元测试。"""

import json
import os
import tempfile
import unittest

from quest_chain.analysis import (
    analyze_project,
    compare_projects,
    downstream_impact,
    find_cycles,
    reachable_from_entries,
)
from quest_chain.model import (
    Project,
    ProjectError,
    Quest,
    export_runtime,
    import_runtime,
    load_project,
    save_project,
)

SAMPLE_DEMO = os.path.join(
    os.path.dirname(__file__), "..", "samples", "quest_demo.qchain.json"
)
SAMPLE_BROKEN = os.path.join(
    os.path.dirname(__file__), "..", "samples", "quest_broken.qchain.json"
)


def make_project(quests, **kwargs):
    return Project(
        name="test",
        initial_flags=kwargs.get("initial_flags", {}),
        initial_variables=kwargs.get("initial_variables", {}),
        quests=quests,
    )


def q(qid, pre=None, ending=False, optional=False, condition="", mutex=None, rewards=None):
    return Quest(
        id=qid,
        title=qid,
        prerequisites=pre or [],
        condition=condition,
        exclusive_with=mutex or [],
        is_ending=ending,
        optional=optional,
        rewards=rewards or [],
    )


class CycleTests(unittest.TestCase):
    def test_simple_cycle(self):
        project = make_project([q("a", ["c"]), q("b", ["a"]), q("c", ["b"])])
        cycles = find_cycles(project)
        self.assertEqual(len(cycles), 1)
        self.assertEqual(set(cycles[0]), {"a", "b", "c"})

    def test_self_loop(self):
        project = make_project([q("a", ["a"])])
        cycles = find_cycles(project)
        self.assertEqual(cycles, [["a"]])

    def test_no_cycle(self):
        project = make_project([q("a"), q("b", ["a"]), q("c", ["b"])])
        self.assertEqual(find_cycles(project), [])


class ReachabilityTests(unittest.TestCase):
    def test_unreachable_orphan(self):
        project = make_project([q("a"), q("b", ["ghost"])])
        reach = reachable_from_entries(project)
        self.assertEqual(reach, {"a"})
        issues = analyze_project(project)
        codes = [i.code for i in issues]
        self.assertIn("UNREACHABLE", codes)

    def test_optional_unreachable_is_warning(self):
        project = make_project([q("a"), q("b", ["ghost"], optional=True)])
        issues = [i for i in analyze_project(project) if i.code == "UNREACHABLE"]
        self.assertEqual(issues[0].severity, "warning")

    def test_no_entry(self):
        project = make_project([q("a", ["b"]), q("b", ["a"])])
        issues = [i for i in analyze_project(project) if i.code == "NO_ENTRY"]
        self.assertTrue(issues)
        self.assertEqual(issues[0].severity, "error")

    def test_no_ending(self):
        project = make_project([q("a"), q("b", ["a"])])
        codes = [i.code for i in analyze_project(project)]
        self.assertIn("NO_ENDING", codes)

    def test_dead_end_to_ending(self):
        project = make_project(
            [q("a"), q("dead", ["a"]), q("end", ["a"], ending=True)]
        )
        issues = [i for i in analyze_project(project) if i.code == "NO_PATH_TO_ENDING"]
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].quest_ids, ["dead"])
        self.assertIn("dead", issues[0].path)

    def test_condition_ref_does_not_fake_ending_path(self):
        # 条件里引用任务不等于结构上能走到结局: 没有前置链的支线仍是死路
        project = make_project(
            [
                q("a"),
                q("side", ["a"], condition='q_meet("a")', optional=True),
                q("end", ["a"], ending=True),
            ]
        )
        issues = [i for i in analyze_project(project) if i.code == "NO_PATH_TO_ENDING"]
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].quest_ids, ["side"])
        self.assertEqual(issues[0].severity, "warning")  # 可选支线只警告

    def test_side_chain_to_ending_is_clean(self):
        # 支线通过真实前置链接到结局时不应报告
        project = make_project(
            [
                q("a"),
                q("side", ["a"], optional=True),
                q("end", ["a", "side"], ending=True),
            ]
        )
        codes = [i.code for i in analyze_project(project)]
        self.assertNotIn("NO_PATH_TO_ENDING", codes)


class MutexTests(unittest.TestCase):
    def test_mutex_dead_end(self):
        project = make_project(
            [
                q("a"),
                q("m1", ["a"], mutex=["m2"]),
                q("m2", ["a"], mutex=["m1"]),
                q("greedy", ["m1", "m2"], ending=True),
            ]
        )
        issues = [i for i in analyze_project(project) if i.code == "MUTEX_DEAD_END"]
        self.assertEqual(len(issues), 1)  # 不应重复报告
        self.assertEqual(set(issues[0].quest_ids), {"greedy", "m1", "m2"})

    def test_mutex_prerequisite_conflict(self):
        project = make_project([q("a"), q("b", ["a"], mutex=["a"])])
        codes = [i.code for i in analyze_project(project)]
        self.assertIn("MUTEX_PREREQUISITE_CONFLICT", codes)

    def test_exclusive_normalized_symmetric(self):
        project = make_project([q("a", mutex=["b"]), q("b")])
        project.normalize_exclusive()
        self.assertIn("a", project.get("b").exclusive_with)


class ConditionAnalysisTests(unittest.TestCase):
    def test_broken_quest_ref_in_condition(self):
        project = make_project([q("a", condition='q_meet("ghost")')])
        codes = [i.code for i in analyze_project(project)]
        self.assertIn("CONDITION_BROKEN_REF", codes)
        # 不应同时再出一条 CONDITION_INVALID 重复报告同一问题
        invalid = [i for i in analyze_project(project) if i.code == "CONDITION_INVALID"]
        self.assertFalse(any("ghost" in i.message for i in invalid))

    def test_syntax_error_in_condition(self):
        project = make_project([q("a", condition="var(")])
        codes = [i.code for i in analyze_project(project)]
        self.assertIn("CONDITION_INVALID", codes)


class ImpactTests(unittest.TestCase):
    def test_downstream_impact(self):
        project = make_project(
            [q("a"), q("b", ["a"]), q("c", ["b"]), q("end", ["c"], ending=True)]
        )
        impact = downstream_impact(project, "a")
        self.assertEqual(impact["direct"], ["b"])
        self.assertEqual(impact["transitive"], ["b", "c", "end"])
        self.assertEqual(impact["endings"], ["end"])

    def test_compare_projects(self):
        before = make_project([q("a"), q("b", ["a"])])
        after = make_project([q("a"), q("b", ["a"], condition='flag("x")'), q("c", ["a"])])
        result = compare_projects(before, after)
        self.assertEqual(result["added"], ["c"])
        self.assertEqual([c["quest_id"] for c in result["changed"]], ["b"])
        self.assertIn("condition", result["changed"][0]["fields"])

    def test_removal_impact(self):
        before = make_project([q("a"), q("b", ["a"]), q("c", ["b"], ending=True)])
        after = make_project([q("b", ["a"]), q("c", ["b"], ending=True)])
        result = compare_projects(before, after)
        self.assertEqual(result["removed"], ["a"])
        self.assertEqual(result["removal_impact"][0]["affected_transitive"], ["b", "c"])


class ModelIoTests(unittest.TestCase):
    def test_save_load_roundtrip(self):
        project = make_project([q("a"), q("b", ["a"], ending=True)])
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "p.json")
            save_project(project, path)
            loaded = load_project(path)
            self.assertEqual(loaded.ids(), ["a", "b"])
            self.assertTrue(loaded.get("b").is_ending)

    def test_duplicate_id_rejected(self):
        with self.assertRaises(ProjectError):
            Project.from_dict(
                {"quests": [{"id": "a"}, {"id": "a"}]}
            )

    def test_bad_reward_type(self):
        with self.assertRaises(ProjectError):
            Project.from_dict({"quests": [{"id": "a", "rewards": [{"type": "nope"}]}]})

    def test_reward_missing_field(self):
        with self.assertRaises(ProjectError):
            Project.from_dict(
                {"quests": [{"id": "a", "rewards": [{"type": "item", "item_id": "x"}]}]}
            )

    def test_export_import_roundtrip(self):
        project = load_project(SAMPLE_DEMO)
        runtime = export_runtime(project)
        self.assertNotIn("position", runtime["quests"][0])
        imported, problems = import_runtime(runtime)
        self.assertEqual(len(imported.quests), len(project.quests))
        self.assertEqual(problems, [])

    def test_import_detects_missing_refs(self):
        project = load_project(SAMPLE_DEMO)
        runtime = export_runtime(project)
        runtime["quests"][0]["prerequisites"] = ["q_ghost"]
        _, problems = import_runtime(runtime)
        self.assertTrue(any("q_ghost" in p for p in problems))

    def test_import_detects_reward_ref(self):
        data = {
            "kind": "quest-runtime",
            "quests": [
                {
                    "id": "a",
                    "prerequisites": [],
                    "condition": "",
                    "exclusive_with": [],
                    "rewards": [
                        {"type": "quest", "quest_id": "ghost", "state": "completed"}
                    ],
                }
            ],
        }
        _, problems = import_runtime(data)
        self.assertTrue(any("ghost" in p for p in problems))

    def test_unknown_version_rejected(self):
        with self.assertRaises(ProjectError):
            Project.from_dict({"format_version": 999, "quests": []})


class SampleTests(unittest.TestCase):
    def test_demo_sample_has_no_errors(self):
        project = load_project(SAMPLE_DEMO)
        errors = [i for i in analyze_project(project) if i.severity == "error"]
        self.assertEqual(errors, [])
        self.assertGreaterEqual(len(project.ending_quests()), 3)
        # 至少一对互斥任务
        self.assertTrue(any(q.exclusive_with for q in project.quests))
        # 至少一个可选支线
        self.assertTrue(any(q.optional for q in project.quests))

    def test_broken_sample_covers_all_codes(self):
        project = load_project(SAMPLE_BROKEN)
        codes = {i.code for i in analyze_project(project)}
        for expected in (
            "CYCLE",
            "UNREACHABLE",
            "MUTEX_DEAD_END",
            "CONDITION_BROKEN_REF",
            "CONDITION_INVALID",
            "NO_PATH_TO_ENDING",
        ):
            self.assertIn(expected, codes)


if __name__ == "__main__":
    unittest.main()

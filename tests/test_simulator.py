"""模拟器与 HTTP 服务的单元测试。"""

import json
import os
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

from quest_chain.model import Quest, Reward, Project, load_project
from quest_chain.server import _Handler
from quest_chain.simulator import Simulator

SAMPLE_DEMO = os.path.join(
    os.path.dirname(__file__), "..", "samples", "quest_demo.qchain.json"
)


def simple_project():
    return Project(
        name="sim",
        initial_flags={"switch": False},
        initial_variables={"rep": 0},
        quests=[
            Quest(id="start", title="起点", position={"x": 0, "y": 0}),
            Quest(
                id="gated",
                title="条件门",
                prerequisites=["start"],
                condition='var("rep") >= 5',
                position={"x": 0, "y": 0},
            ),
            Quest(
                id="end",
                title="结局",
                prerequisites=["gated"],
                is_ending=True,
                position={"x": 0, "y": 0},
            ),
        ],
    )


class StateMachineTests(unittest.TestCase):
    def test_initial_availability(self):
        sim = Simulator(simple_project())
        self.assertEqual(sim.quest_states["start"], "available")
        self.assertEqual(sim.quest_states["gated"], "locked")
        self.assertIn("等待前置", sim.blocked_reasons["gated"])

    def test_accept_and_complete_flow(self):
        sim = Simulator(simple_project())
        diff = sim.step("accept", "start")
        self.assertTrue(diff.ok)
        self.assertEqual(sim.quest_states["start"], "active")

        diff = sim.step("complete", "start")
        self.assertTrue(diff.ok)
        # gated 前置完成但 rep 仍为 0, 条件不满足
        self.assertEqual(sim.quest_states["gated"], "locked")
        self.assertIn("条件尚未满足", sim.blocked_reasons["gated"])

        sim.variables["rep"] = 10
        sim._recompute()
        self.assertEqual(sim.quest_states["gated"], "available")

    def test_illegal_actions_rejected(self):
        sim = Simulator(simple_project())
        self.assertFalse(sim.step("accept", "gated").ok)
        self.assertFalse(sim.step("complete", "gated").ok)
        self.assertFalse(sim.step("teleport", "start").ok)
        self.assertFalse(sim.step("complete", "nobody").ok)

    def test_failed_prerequisite_invalidates_chain(self):
        sim = Simulator(simple_project())
        sim.step("fail", "start")
        self.assertEqual(sim.quest_states["start"], "failed")
        self.assertEqual(sim.quest_states["gated"], "locked")
        self.assertIn("已失败", sim.blocked_reasons["gated"])
        self.assertEqual(sim.quest_states["end"], "locked")
        # 没有可做的任务 -> 卡住
        stuck = sim.stuck_info()
        self.assertIsNotNone(stuck)
        blocked_ids = {b["quest_id"] for b in stuck["blocked_quests"]}
        self.assertEqual(blocked_ids, {"gated", "end"})

    def test_terminal_state_is_sticky(self):
        sim = Simulator(simple_project())
        sim.step("fail", "start")
        sim._recompute()
        self.assertEqual(sim.quest_states["start"], "failed")

    def test_undo_restores_snapshot(self):
        sim = Simulator(simple_project())
        sim.step("complete", "start")
        self.assertEqual(sim.quest_states["start"], "completed")
        self.assertTrue(sim.undo())
        self.assertEqual(sim.quest_states["start"], "available")
        # 再撤销已经没有历史
        self.assertFalse(sim.undo())

    def test_reset(self):
        sim = Simulator(simple_project())
        sim.step("complete", "start")
        sim.reset()
        self.assertEqual(sim.quest_states["start"], "available")
        self.assertEqual(sim.history, [])


class MutexSimulationTests(unittest.TestCase):
    def test_mutex_invalidation(self):
        project = Project(
            quests=[
                Quest(id="a"),
                Quest(id="m1", prerequisites=["a"], exclusive_with=["m2"]),
                Quest(id="m2", prerequisites=["a"], exclusive_with=["m1"]),
            ]
        )
        sim = Simulator(project)
        sim.step("complete", "a")
        self.assertEqual(sim.quest_states["m1"], "available")
        self.assertEqual(sim.quest_states["m2"], "available")

        diff = sim.step("complete", "m1")
        self.assertEqual(sim.quest_states["m2"], "locked")
        self.assertIn("互斥任务", sim.blocked_reasons["m2"])
        self.assertTrue(any(x["quest_id"] == "m2" for x in diff.invalidated))

    def test_diff_buckets(self):
        project = Project(quests=[Quest(id="a"), Quest(id="b", prerequisites=["a"])])
        sim = Simulator(project)
        diff = sim.step("complete", "a")
        self.assertIn("b", diff.new_available)


class RewardTests(unittest.TestCase):
    def test_all_reward_types(self):
        project = Project(
            initial_flags={},
            initial_variables={"rep": 0},
            quests=[
                Quest(
                    id="a",
                    rewards=[
                        Reward("item", {"item_id": "potion", "amount": 2}),
                        Reward("currency", {"currency_id": "gold", "amount": 10}),
                        Reward("flag", {"flag": "done", "value": True}),
                        Reward("variable", {"variable": "rep", "op": "+=", "value": 5}),
                    ],
                ),
                Quest(id="b"),
            ],
        )
        sim = Simulator(project)
        diff = sim.step("complete", "a")
        self.assertEqual(sim.inventory["item"]["potion"], 2)
        self.assertEqual(sim.inventory["currency"]["gold"], 10)
        self.assertTrue(sim.flags["done"])
        self.assertEqual(sim.variables["rep"], 5)
        self.assertEqual(len(diff.rewards_gained), 4)

    def test_quest_reward_sets_state(self):
        project = Project(
            quests=[
                Quest(id="a", rewards=[Reward("quest", {"quest_id": "b", "state": "completed"})]),
                Quest(id="b"),
            ]
        )
        sim = Simulator(project)
        sim.step("complete", "a")
        self.assertEqual(sim.quest_states["b"], "completed")

    def test_variable_ops(self):
        project = Project(
            initial_variables={"x": 10},
            quests=[
                Quest(
                    id="a",
                    rewards=[
                        Reward("variable", {"variable": "x", "op": "-=", "value": 3}),
                    ],
                )
            ],
        )
        sim = Simulator(project)
        sim.step("complete", "a")
        self.assertEqual(sim.variables["x"], 7)


class EndingTests(unittest.TestCase):
    def test_ending_reached_event(self):
        sim = Simulator(simple_project())
        sim.variables["rep"] = 10
        sim.step("complete", "start")
        sim.step("complete", "gated")
        diff = sim.step("complete", "end")
        self.assertEqual(diff.endings_reached, ["end"])

    def test_demo_full_knights_route(self):
        project = load_project(SAMPLE_DEMO)
        sim = Simulator(project)
        route = [
            "q_intro",
            "q_herb_gathering",
            "q_training",
            "q_goblin_camp",
            "q_join_knights",
            "q_escort_mission",
            "q_castle_siege",
            "q_ending_good",
        ]
        for qid in route:
            diff = sim.step("complete", qid)
            self.assertTrue(diff.ok, f"{qid} 应该可以完成: {diff.message}")
        self.assertEqual(sim.quest_states["q_ending_good"], "completed")
        # 互斥阵营任务失效
        self.assertEqual(sim.quest_states["q_join_thieves"], "locked")
        self.assertIsNone(sim.stuck_info())


class SnapshotTests(unittest.TestCase):
    def test_snapshot_restore(self):
        sim = Simulator(simple_project())
        snap = sim.snapshot()
        sim.step("complete", "start")
        sim.restore(snap)
        self.assertEqual(sim.quest_states["start"], "available")


class BadConditionRobustnessTests(unittest.TestCase):
    def test_syntax_error_does_not_crash_simulation(self):
        project = Project(
            quests=[Quest(id="a", condition="var("), Quest(id="b", prerequisites=["a"])]
        )
        sim = Simulator(project)
        # a 条件语法错误 -> 永远 locked, 不抛异常
        self.assertEqual(sim.quest_states["a"], "locked")
        self.assertIn("条件求值失败", sim.blocked_reasons["a"])


class ProgressIoTests(unittest.TestCase):
    def test_progress_export_load_roundtrip(self):
        sim = Simulator(simple_project())
        sim.step("complete", "start")
        progress = sim.export_progress()
        self.assertEqual(progress["kind"], "quest-sim-progress")

        sim2 = Simulator(simple_project())
        warnings = sim2.load_progress(progress)
        self.assertEqual(warnings, [])
        self.assertEqual(sim2.quest_states["start"], "completed")

    def test_progress_with_changed_project_warns(self):
        sim = Simulator(simple_project())
        sim.step("complete", "start")
        progress = sim.export_progress()

        # 工程变更: 删除了 gated, 新增了 new_one
        changed = Project(
            quests=[
                Quest(id="start"),
                Quest(id="end", prerequisites=["start"], is_ending=True),
                Quest(id="new_one"),
            ]
        )
        sim2 = Simulator(changed)
        warnings = sim2.load_progress(progress)
        self.assertTrue(any("不存在" in w and "gated" in w for w in warnings))
        self.assertEqual(sim2.quest_states["start"], "completed")
        self.assertEqual(sim2.quest_states["new_one"], "available")

    def test_bad_progress_rejected(self):
        sim = Simulator(simple_project())
        with self.assertRaises(ValueError):
            sim.load_progress({"kind": "something-else"})


# ---------------------------------------------------------------------------
# HTTP 服务 (随机端口, 后台线程)
# ---------------------------------------------------------------------------


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def _call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
            method=method,
        )
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())

    def test_health_and_samples(self):
        self.assertTrue(self._call("GET", "/api/health")["ok"])
        samples = self._call("GET", "/api/samples")["samples"]
        self.assertTrue(any("demo" in s for s in samples))

    def test_validate_and_simulate_api(self):
        project = load_project(SAMPLE_DEMO).to_dict()
        result = self._call("POST", "/api/validate", project)
        errors = [i for i in result["issues"] if i["severity"] == "error"]
        self.assertEqual(errors, [])

        created = self._call("POST", "/api/sim/create", project)
        sid = created["session_id"]
        step = self._call(
            "POST", f"/api/sim/{sid}/step",
            {"action": "complete", "quest_id": "q_intro"},
        )
        self.assertTrue(step["diff"]["ok"])
        self.assertIn("q_training", step["diff"]["new_available"])

        undone = self._call("POST", f"/api/sim/{sid}/undo", {})
        self.assertTrue(undone["ok"])
        reset = self._call("POST", f"/api/sim/{sid}/reset", {})
        self.assertEqual(reset["quest_states"]["q_intro"], "available")

    def test_progress_api(self):
        project = load_project(SAMPLE_DEMO).to_dict()
        created = self._call("POST", "/api/sim/create", project)
        sid = created["session_id"]
        self._call(
            "POST", f"/api/sim/{sid}/step",
            {"action": "complete", "quest_id": "q_intro"},
        )
        progress = self._call("GET", f"/api/sim/{sid}/progress")
        self.assertEqual(progress["kind"], "quest-sim-progress")
        self.assertEqual(progress["quest_states"]["q_intro"], "completed")
        loaded = self._call("POST", f"/api/sim/{sid}/progress", progress)
        self.assertEqual(loaded["warnings"], [])
        self.assertEqual(loaded["quest_states"]["q_intro"], "completed")

    def test_import_export_api(self):
        project = load_project(SAMPLE_DEMO).to_dict()
        runtime = self._call("POST", "/api/export", project)
        self.assertEqual(runtime["kind"], "quest-runtime")
        imported = self._call("POST", "/api/import", runtime)
        self.assertEqual(imported["problems"], [])

    def test_impact_and_diff_api(self):
        project = load_project(SAMPLE_DEMO).to_dict()
        impact = self._call(
            "POST", "/api/impact", {"project": project, "quest_id": "q_intro"}
        )
        self.assertIn("q_training", impact["transitive"])
        diff = self._call("POST", "/api/diff", {"before": project, "after": project})
        self.assertEqual(diff["changed"], [])

    def test_static_index(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/")
        with urllib.request.urlopen(req) as resp:
            self.assertIn("text/html", resp.headers["Content-Type"])
            self.assertIn("任务链".encode("utf-8"), resp.read())


if __name__ == "__main__":
    unittest.main()

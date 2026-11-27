"""项目持久化与失败恢复测试。"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from framelab.core.project_store import (
    ProjectError,
    list_projects,
    load_project,
    new_project,
    project_path,
    save_project,
)


class TestProjectStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.project = new_project("/tmp/fake_clip.mp4")

    def test_save_creates_layout(self):
        save_project(self.tmp, self.project)
        pdir = os.path.join(self.tmp, self.project["id"])
        self.assertTrue(os.path.isdir(os.path.join(pdir, "frames")))
        self.assertTrue(os.path.isdir(os.path.join(pdir, "export")))
        self.assertTrue(os.path.isfile(project_path(self.tmp, self.project["id"])))

    def test_roundtrip(self):
        self.project["settings"]["dst_fps"] = 47.0
        save_project(self.tmp, self.project)
        loaded = load_project(self.tmp, self.project["id"])
        self.assertEqual(loaded["settings"]["dst_fps"], 47.0)
        self.assertEqual(loaded["source"]["path"], "/tmp/fake_clip.mp4")

    def test_bak_created_on_second_save(self):
        save_project(self.tmp, self.project)
        self.project["settings"]["speed"] = 2.0
        save_project(self.tmp, self.project)
        bak = project_path(self.tmp, self.project["id"]) + ".bak"
        self.assertTrue(os.path.isfile(bak))
        old = json.load(open(bak, encoding="utf-8"))
        self.assertEqual(old["settings"]["speed"], 1.0)

    def test_corrupt_main_falls_back_to_bak(self):
        # 第一次保存（nearest）成为历史版本
        save_project(self.tmp, self.project)
        # 第二次保存（blend）成功后，.bak 保留上一版 nearest
        self.project["settings"]["method"] = "blend"
        save_project(self.tmp, self.project)
        target = project_path(self.tmp, self.project["id"])
        with open(target, "w", encoding="utf-8") as f:
            f.write("{ broken json")
        # 主文件损坏 → 自动回退到上一个完整版本
        loaded = load_project(self.tmp, self.project["id"])
        self.assertEqual(loaded["settings"]["method"], "nearest")

    def test_both_corrupt_raises(self):
        save_project(self.tmp, self.project)
        target = project_path(self.tmp, self.project["id"])
        with open(target, "w", encoding="utf-8") as f:
            f.write("{ broken")
        with open(target + ".bak", "w", encoding="utf-8") as f:
            f.write("also broken")
        with self.assertRaises(ProjectError):
            load_project(self.tmp, self.project["id"])

    def test_list_projects_skips_garbage(self):
        save_project(self.tmp, self.project)
        os.mkdir(os.path.join(self.tmp, "not_a_project"))
        items = list_projects(self.tmp)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], self.project["id"])

    def test_path_traversal_rejected(self):
        save_project(self.tmp, self.project)
        with self.assertRaises(ProjectError):
            load_project(self.tmp, "../etc")


if __name__ == "__main__":
    unittest.main()

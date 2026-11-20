"""文件发现规则测试：跳过虚拟环境/版本控制/缓存目录，支持子目录过滤。"""

import os
import tempfile
import unittest

from sqli_scanner.walker import DEFAULT_SKIP_DIRS, discover_python_files


class WalkerTests(unittest.TestCase):
    def _make_project(self, root):
        files = [
            "main.py",
            "pkg/a.py",
            "pkg/b.txt",
            "venv/lib/python3.12/site-packages/evil.py",
            ".venv/bin/tool.py",
            ".git/hooks/pre-commit.py",
            "__pycache__/cached.py",
            ".pytest_cache/cache.py",
            "node_modules/lib/index.py",
            "build/generated.py",
            "sub/deep/c.py",
        ]
        for rel in files:
            full = os.path.join(root, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as fh:
                fh.write("# placeholder\n")

    def test_skips_well_known_dirs(self):
        with tempfile.TemporaryDirectory() as root:
            self._make_project(root)
            discovered, warnings = discover_python_files(root)
            rels = {f.relpath for f in discovered}
            self.assertIn("main.py", rels)
            self.assertIn("pkg/a.py", rels)
            self.assertIn("sub/deep/c.py", rels)
            for skipped in (
                "venv/lib/python3.12/site-packages/evil.py",
                ".venv/bin/tool.py",
                ".git/hooks/pre-commit.py",
                "__pycache__/cached.py",
                ".pytest_cache/cache.py",
                "node_modules/lib/index.py",
                "build/generated.py",
            ):
                self.assertNotIn(skipped, rels)
            # 非 Python 文件不进入结果
            self.assertNotIn("pkg/b.txt", rels)
            self.assertEqual(warnings, [])

    def test_subdir_filter(self):
        with tempfile.TemporaryDirectory() as root:
            self._make_project(root)
            discovered, _ = discover_python_files(root, subdirs=["sub"])
            rels = {f.relpath for f in discovered}
            self.assertEqual(rels, {"sub/deep/c.py"})

    def test_dot_subdir_scans_everything(self):
        with tempfile.TemporaryDirectory() as root:
            self._make_project(root)
            discovered, _ = discover_python_files(root, subdirs=["."])
            rels = {f.relpath for f in discovered}
            self.assertIn("main.py", rels)
            self.assertIn("sub/deep/c.py", rels)
            # 跳过规则仍然生效
            self.assertNotIn("venv/lib/python3.12/site-packages/evil.py", rels)

    def test_nonexistent_subdir_warns(self):
        with tempfile.TemporaryDirectory() as root:
            self._make_project(root)
            discovered, warnings = discover_python_files(root, subdirs=["nope"])
            self.assertEqual(discovered, [])
            self.assertEqual(len(warnings), 1)
            self.assertIn("nope", warnings[0])

    def test_subdir_outside_root_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            self._make_project(root)
            discovered, warnings = discover_python_files(root, subdirs=["../etc"])
            self.assertEqual(discovered, [])
            self.assertTrue(any("超出扫描根目录" in w for w in warnings))

    def test_single_file_input(self):
        with tempfile.TemporaryDirectory() as root:
            self._make_project(root)
            target = os.path.join(root, "main.py")
            discovered, _ = discover_python_files(target)
            self.assertEqual([f.relpath for f in discovered], ["main.py"])

    def test_extra_skip_dir(self):
        with tempfile.TemporaryDirectory() as root:
            self._make_project(root)
            os.makedirs(os.path.join(root, "generated"))
            with open(os.path.join(root, "generated/x.py"), "w") as fh:
                fh.write("\n")
            discovered, _ = discover_python_files(root, extra_skip=["generated"])
            self.assertNotIn("generated/x.py", {f.relpath for f in discovered})

    def test_default_skip_set_covers_required_dirs(self):
        for name in (".git", "__pycache__", "venv", ".venv"):
            self.assertIn(name, DEFAULT_SKIP_DIRS)


if __name__ == "__main__":
    unittest.main()

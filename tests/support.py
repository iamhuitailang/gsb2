"""Shared test fixtures.

Tests use only synthetic values. Nothing here contacts the network.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from workbench.core import Workbench  # noqa: E402
from workbench.rules import load_rules, parse_rules  # noqa: E402
from workbench.scanner import ScanOptions, scan_project  # noqa: E402

DEMO_ROOT = os.path.join(REPO_ROOT, "demo_project")


class WorkbenchTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="wb-test-")
        self.workbench = Workbench(os.path.join(self.tmp, "data"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ------------------------------------------------------------- helpers
    def make_project(self, files, name="project"):
        root = os.path.join(self.tmp, name)
        os.makedirs(root, exist_ok=True)
        for rel, content in files.items():
            path = os.path.join(root, rel)
            os.makedirs(os.path.dirname(path) or root, exist_ok=True)
            mode = "wb" if isinstance(content, bytes) else "w"
            with open(path, mode, **({} if mode == "wb" else {"encoding": "utf-8"})) as handle:
                handle.write(content)
        return root

    def copy_demo(self) -> str:
        target = os.path.join(self.tmp, "demo")
        shutil.copytree(DEMO_ROOT, target)
        return target

    def run_scan(self, root, **options):
        scan = self.workbench.start_scan(root, options=options)
        return self.workbench.wait_for_scan(scan["id"], timeout=120)

    def findings(self, scan_id):
        return self.workbench.all_scan_findings(scan_id)

    def by_rule(self, scan_id, rule_id):
        return [f for f in self.findings(scan_id) if f["rule_id"] == rule_id]


def scan_with_rules(root, rules_raw, options=None):
    rule_set = parse_rules(rules_raw, "<test>")
    return scan_project(root, rule_set, options or ScanOptions())

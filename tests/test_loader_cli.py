import json
import os
import subprocess
import sys
import tempfile
import unittest

from dnscheck.loader import ScenarioError, load_scenario

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def write_tmp(payload):
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        if isinstance(payload, str):
            f.write(payload)
        else:
            json.dump(payload, f)
    return path


class TestLoader(unittest.TestCase):
    def tearDown(self):
        if hasattr(self, "_path") and os.path.exists(self._path):
            os.unlink(self._path)

    def load(self, payload):
        self._path = write_tmp(payload)
        return load_scenario(self._path)

    def test_valid_scenario_loads(self):
        sc = self.load({
            "config": {"max_ttl": 100},
            "steps": [
                {"op": "query", "id": 1, "qname": "www.example.com",
                 "upstream": {"id": 1, "rcode": "NOERROR",
                              "question": {"name": "www.example.com", "type": "A"},
                              "answers": []}},
                {"op": "advance", "seconds": 10},
                {"op": "cleanup"},
            ],
        })
        self.assertEqual(sc.config.max_ttl, 100)
        self.assertEqual(len(sc.steps), 3)

    def test_invalid_json_locatable(self):
        self._path = write_tmp("{not json")
        with self.assertRaises(ScenarioError) as ctx:
            load_scenario(self._path)
        self.assertIn("line", str(ctx.exception))

    def test_missing_steps(self):
        with self.assertRaises(ScenarioError) as ctx:
            self.load({"config": {}})
        self.assertIn("steps", str(ctx.exception))

    def test_missing_qname_reports_step_index(self):
        with self.assertRaises(ScenarioError) as ctx:
            self.load({"steps": [{"op": "query", "id": 1}]})
        msg = str(ctx.exception)
        self.assertIn("step 0", msg)
        self.assertIn("qname", msg)

    def test_unknown_op_reports_step_index(self):
        with self.assertRaises(ScenarioError) as ctx:
            self.load({"steps": [{"op": "query", "id": 1, "qname": "a.example.com"},
                                 {"op": "explode"}]})
        self.assertIn("step 1", str(ctx.exception))

    def test_bad_record_field_locatable(self):
        with self.assertRaises(ScenarioError) as ctx:
            self.load({"steps": [{
                "op": "query", "id": 1, "qname": "a.example.com",
                "upstream": {"id": 1, "rcode": "NOERROR",
                             "question": {"name": "a.example.com"},
                             "answers": [{"name": "a.example.com", "type": "A", "ttl": "soon"}]},
            }]})
        msg = str(ctx.exception)
        self.assertIn("answers[0]", msg)
        self.assertIn("ttl", msg)

    def test_bad_ttl_value(self):
        with self.assertRaises(ScenarioError):
            self.load({"steps": [{
                "op": "query", "id": 1, "qname": "a.example.com",
                "upstream": {"id": 1, "rcode": "NOERROR",
                             "question": {"name": "a.example.com"},
                             "answers": [{"name": "a.example.com", "type": "A",
                                          "ttl": -5, "data": "192.0.2.1"}]},
            }]})


class TestCliEndToEnd(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "dnscheck", *args],
            cwd=REPO_ROOT, capture_output=True, text=True,
        )

    def test_samples_run_clean(self):
        for name in ("basic.json", "cname.json", "negative.json"):
            proc = self.run_cli(os.path.join("samples", name))
            self.assertEqual(proc.returncode, 0, msg=f"{name}: {proc.stderr}")
            self.assertIn("summary:", proc.stdout)

    def test_basic_sample_verdicts(self):
        proc = self.run_cli("samples/basic.json")
        out = proc.stdout
        self.assertIn("ACCEPT", out)
        self.assertIn("CACHE_HIT", out)
        self.assertIn("REJECT", out)
        self.assertIn("ttl clamped 3600 -> 300", out)

    def test_malformed_file_exit_code(self):
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as f:
            f.write('{"steps": [{"op": "query"}]}')
        try:
            proc = self.run_cli(path)
            self.assertEqual(proc.returncode, 2)
            self.assertIn("step 0", proc.stderr)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()

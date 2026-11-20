"""pseudonymize 的自动化测试。

运行方式（任选其一）：
    python3 -m unittest discover -s tests -v
    python3 -m pytest tests/
"""

import json
import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pseudonymize as pz


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.key_file = os.path.join(self.dir, "key.json")
        pz.generate_key_file(self.key_file, "v1")

    def tearDown(self):
        self.tmp.cleanup()

    # -- 测试辅助 -----------------------------------------------------------

    def path(self, name):
        return os.path.join(self.dir, name)

    def write_csv(self, name, text):
        path = self.path(name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        return path

    def read_text(self, path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def write_config(self, files, name="config.json"):
        cfg = {"key_file": self.key_file, "files": files}
        path = self.path(name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False)
        return path

    def col(self, name, **kw):
        rule = {"name": name}
        rule.update(kw)
        return rule


class TestKey(Base):
    def test_key_roundtrip_and_permissions(self):
        version, key = pz.load_key(self.key_file)
        self.assertEqual(version, "v1")
        self.assertEqual(len(key), pz.KEY_BYTES)
        mode = stat.S_IMODE(os.stat(self.key_file).st_mode)
        self.assertEqual(mode, 0o600)

    def test_init_key_refuses_overwrite(self):
        with self.assertRaises(pz.ConfigError):
            pz.generate_key_file(self.key_file, "v2")

    def test_load_key_missing_file(self):
        with self.assertRaises(pz.KeyLoadError):
            pz.load_key(self.path("no-such-key.json"))

    def test_load_key_corrupt_does_not_echo_content(self):
        bad = self.path("bad-key.json")
        secret = "SUPER-SECRET-KEY-MATERIAL"
        with open(bad, "w") as f:
            f.write(secret)  # 不是 JSON
        with self.assertRaises(pz.KeyLoadError) as ctx:
            pz.load_key(bad)
        self.assertNotIn(secret, str(ctx.exception))


class TestPseudonymSemantics(Base):
    def test_cross_file_linkage_same_scope(self):
        """同一范围内，相同敏感值在不同文件得到相同假名。"""
        a = self.write_csv("a.csv", "id,phone\n1,13800001111\n2,13800002222\n")
        b = self.write_csv("b.csv", "order,mobile\nX,13800001111\n")
        cfg = self.write_config([
            {"input": a, "output": self.path("out-a.csv"),
             "columns": [self.col("phone", field="phone", scope="crm")]},
            {"input": b, "output": self.path("out-b.csv"),
             "columns": [self.col("mobile", field="phone", scope="crm")]},
        ])
        pz.run_task(cfg)
        pa = self.read_text(self.path("out-a.csv")).splitlines()[1].split(",")[1]
        pb = self.read_text(self.path("out-b.csv")).splitlines()[1].split(",")[1]
        self.assertEqual(pa, pb)
        self.assertTrue(pa.startswith("psm-v1-"))
        self.assertNotIn("13800001111", self.read_text(self.path("out-a.csv")))

    def test_scope_isolation(self):
        """不同范围内，相同输入值得到互不相同的假名。"""
        a = self.write_csv("a.csv", "phone\n13800001111\n")
        b = self.write_csv("b.csv", "phone\n13800001111\n")
        cfg = self.write_config([
            {"input": a, "output": self.path("out-a.csv"),
             "columns": [self.col("phone", field="phone", scope="scope-a")]},
            {"input": b, "output": self.path("out-b.csv"),
             "columns": [self.col("phone", field="phone", scope="scope-b")]},
        ])
        pz.run_task(cfg)
        pa = self.read_text(self.path("out-a.csv")).splitlines()[1]
        pb = self.read_text(self.path("out-b.csv")).splitlines()[1]
        self.assertNotEqual(pa, pb)

    def test_leading_zeros_preserved_as_text(self):
        """客户编号按文本处理：00123 与 0123、123 是不同值，前导零参与假名。"""
        src = self.write_csv("c.csv", "cust_id\n00123\n0123\n123\n")
        cfg = self.write_config([
            {"input": src, "output": self.path("out.csv"),
             "columns": [self.col("cust_id", field="cust", scope="s")]},
        ])
        pz.run_task(cfg)
        lines = self.read_text(self.path("out.csv")).splitlines()[1:]
        self.assertEqual(len(set(lines)), 3)  # 三个假名互不相同
        for line in lines:
            self.assertTrue(line.startswith("psm-v1-"))

    def test_empty_and_missing_values(self):
        """空值与行尾缺失值都输出为空字符串，且不产生假名。"""
        src = self.write_csv("e.csv", "id,phone,email\n1,,\n2,13800001111\n")
        cfg = self.write_config([
            {"input": src, "output": self.path("out.csv"),
             "columns": [self.col("phone", field="phone", scope="s"),
                         self.col("email", field="email", scope="s")]},
        ])
        pz.run_task(cfg)
        lines = self.read_text(self.path("out.csv")).splitlines()
        self.assertEqual(lines[1], "1,,")          # 空值保持为空
        # 缺失的 email 补空，phone 已假名化
        self.assertTrue(lines[2].startswith("2,psm-v1-"))
        self.assertTrue(lines[2].endswith(","))

    def test_normalize_strip_and_casefold(self):
        """strip / 不区分大小写归一化后，表面不同的值得到相同假名。"""
        a = self.write_csv("a.csv", "email\n  Alice@Example.com\n")
        b = self.write_csv("b.csv", "email\nalice@example.COM\n")
        cfg = self.write_config([
            {"input": a, "output": self.path("out-a.csv"),
             "columns": [self.col("email", field="email", scope="s",
                                  normalize="strip_lower")]},
            {"input": b, "output": self.path("out-b.csv"),
             "columns": [self.col("email", field="email", scope="s",
                                  normalize="strip_lower")]},
        ])
        pz.run_task(cfg)
        pa = self.read_text(self.path("out-a.csv")).splitlines()[1]
        pb = self.read_text(self.path("out-b.csv")).splitlines()[1]
        self.assertEqual(pa, pb)

    def test_determinism(self):
        """同一输入与配置重复运行，结果字节级一致。"""
        src = self.write_csv("d.csv", "phone,name\n13800001111,张三\n")
        for tag in ("r1", "r2"):
            cfg = self.write_config([
                {"input": src, "output": self.path(f"out-{tag}.csv"),
                 "columns": [self.col("phone", field="phone", scope="s")]},
            ], name=f"cfg-{tag}.json")
            pz.run_task(cfg)
        self.assertEqual(self.read_text(self.path("out-r1.csv")),
                         self.read_text(self.path("out-r2.csv")))


class TestConfigErrors(Base):
    def test_duplicate_column_rule(self):
        src = self.write_csv("a.csv", "phone\n1\n")
        cfg = self.write_config([
            {"input": src, "output": self.path("out.csv"),
             "columns": [self.col("phone"), self.col("phone")]},
        ])
        with self.assertRaises(pz.ConfigError):
            pz.run_task(cfg)

    def test_missing_column(self):
        src = self.write_csv("a.csv", "phone\n1\n")
        cfg = self.write_config([
            {"input": src, "output": self.path("out.csv"),
             "columns": [self.col("email")]},
        ])
        with self.assertRaises(pz.ConfigError) as ctx:
            pz.run_task(cfg)
        self.assertIn("email", str(ctx.exception))

    def test_duplicate_output(self):
        src = self.write_csv("a.csv", "phone\n1\n")
        out = self.path("out.csv")
        cfg = self.write_config([
            {"input": src, "output": out, "columns": [self.col("phone")]},
            {"input": src, "output": out, "columns": [self.col("phone")]},
        ])
        with self.assertRaises(pz.ConfigError):
            pz.run_task(cfg)

    def test_invalid_normalize_mode(self):
        src = self.write_csv("a.csv", "phone\n1\n")
        cfg = self.write_config([
            {"input": src, "output": self.path("out.csv"),
             "columns": [self.col("phone", normalize="upper")]},
        ])
        with self.assertRaises(pz.ConfigError):
            pz.run_task(cfg)

    def test_duplicate_header_column(self):
        src = self.write_csv("a.csv", "phone,phone\n1,2\n")
        cfg = self.write_config([
            {"input": src, "output": self.path("out.csv"),
             "columns": [self.col("phone")]},
        ])
        with self.assertRaises(pz.ConfigError):
            pz.run_task(cfg)

    def test_config_error_happens_before_any_write(self):
        """配置错误时，任何输出文件都不应被创建。"""
        good = self.write_csv("good.csv", "phone\n13800001111\n")
        bad = self.write_csv("bad.csv", "phone\n13800002222\n")
        cfg = self.write_config([
            {"input": good, "output": self.path("out-good.csv"),
             "columns": [self.col("phone")]},
            {"input": bad, "output": self.path("out-bad.csv"),
             "columns": [self.col("no-such-col")]},
        ])
        with self.assertRaises(pz.ConfigError):
            pz.run_task(cfg)
        self.assertFalse(os.path.exists(self.path("out-good.csv")))
        self.assertFalse(os.path.exists(self.path("out-bad.csv")))


class TestAtomicity(Base):
    def test_existing_output_not_overwritten_and_rollback(self):
        """目标已存在时不覆盖，且同任务其他输出也不落盘。"""
        a = self.write_csv("a.csv", "phone\n13800001111\n")
        b = self.write_csv("b.csv", "phone\n13800002222\n")
        out_b = self.write_csv("out-b.csv", "这是用户已有文件，不能被覆盖\n")
        cfg = self.write_config([
            {"input": a, "output": self.path("out-a.csv"),
             "columns": [self.col("phone")]},
            {"input": b, "output": out_b, "columns": [self.col("phone")]},
        ])
        with self.assertRaises(pz.ConfigError):
            pz.run_task(cfg)
        self.assertFalse(os.path.exists(self.path("out-a.csv")))
        self.assertEqual(self.read_text(out_b), "这是用户已有文件，不能被覆盖\n")

    def test_bad_file_mid_run_rolls_back(self):
        """第二个文件中途损坏时，第一个文件的输出也被撤销。"""
        good = self.write_csv("good.csv", "id,phone\n1,13800001111\n")
        bad = self.write_csv("bad.csv", "id,phone\n1,13800002222,多余列\n")
        cfg = self.write_config([
            {"input": good, "output": self.path("out-good.csv"),
             "columns": [self.col("phone")]},
            {"input": bad, "output": self.path("out-bad.csv"),
             "columns": [self.col("phone")]},
        ])
        with self.assertRaises(pz.ProcessingError):
            pz.run_task(cfg)
        self.assertFalse(os.path.exists(self.path("out-good.csv")))
        self.assertFalse(os.path.exists(self.path("out-bad.csv")))
        # 临时文件也应清理干净
        leftovers = [f for f in os.listdir(self.dir) if f.startswith(".pseudonymize-")]
        self.assertEqual(leftovers, [])


class TestReport(Base):
    def test_report_contains_no_sensitive_values(self):
        src = self.write_csv("a.csv", "phone,name\n13800001111,张三\n")
        report_path = self.path("report.json")
        cfg = self.write_config([
            {"input": src, "output": self.path("out.csv"),
             "columns": [self.col("phone", field="phone", scope="s")]},
        ])
        report = pz.run_task(cfg, report_path=report_path)
        blob = json.dumps(report, ensure_ascii=False)
        self.assertNotIn("13800001111", blob)
        self.assertNotIn("psm-v1-", blob)  # 报告不含假名，避免映射反推
        self.assertEqual(report["total_rows"], 1)
        self.assertEqual(report["files"][0]["pseudonymized_columns"], ["phone"])
        on_disk = json.loads(self.read_text(report_path))
        self.assertEqual(on_disk, report)


if __name__ == "__main__":
    unittest.main()

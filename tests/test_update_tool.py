"""自动化测试：正常签发与验收、内容篡改、钥匙撤销、归档逃逸、
回滚、重复提交、激活中断恢复、并发互斥、日志不含私钥等。

运行：python -m unittest discover -s tests -v
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from update_tool import cli, crypto, keys as keystore  # noqa: E402
from update_tool.store import Store  # noqa: E402

TEST_KEY_BITS = 1024  # 测试用小钥匙，生成快；仅演示用途


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="upd-test-")
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.root = self.dir / "root"

    # ---- 辅助 ----

    def run_cli(self, *args, expect=0):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main(["--root", str(self.root), *args])
        self.assertEqual(code, expect,
                         f"cli {args} -> {code}（期望 {expect}）\n{buf.getvalue()}")
        return buf.getvalue()

    def make_key(self, trust=True):
        return keystore.generate_and_save(self.root, bits=TEST_KEY_BITS,
                                          label="test", trust=trust)

    def make_content(self, name, files: dict) -> Path:
        d = self.dir / name
        for rel, data in files.items():
            p = d / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data if isinstance(data, bytes) else data.encode())
        return d

    def pack(self, content, version, key_id, product="demo-app",
             channel="stable", out_name=None, min_tool="1.0.0"):
        out = self.dir / (out_name or f"pkg-{product}-{channel}-{version}.tar.gz")
        self.run_cli("pack", "--content", str(content), "--product", product,
                     "--channel", channel, "--version", version,
                     "--min-tool-version", min_tool,
                     "--key-id", key_id, "--out", str(out))
        return out

    def install(self, pkg, product="demo-app", channel="stable"):
        self.run_cli("trial-install", str(pkg))
        self.run_cli("activate", "--product", product, "--channel", channel)

    def current(self, product="demo-app", channel="stable"):
        return Store(self.root).load_state(product, channel)["current"]

    @staticmethod
    def rewrite_tar(src, dst, modify=None, add=()):
        """复制一个 tar，可修改指定成员内容、追加新成员（用于构造篡改/逃逸包）。"""
        modify = modify or {}
        with tarfile.open(src, "r:*") as tin, tarfile.open(dst, "w:gz") as tout:
            for m in tin.getmembers():
                data = tin.extractfile(m).read() if m.isreg() else None
                if m.name in modify:
                    data = modify[m.name]
                if data is None:
                    continue
                ti = tarfile.TarInfo(m.name)
                ti.size = len(data)
                tout.addfile(ti, io.BytesIO(data))
            for ti, data in add:
                if data is not None:
                    ti.size = len(data)
                    tout.addfile(ti, io.BytesIO(data))
                else:
                    tout.addfile(ti)


class TestHappyPath(Base):
    def test_sign_pack_inspect_install(self):
        kid = self.make_key()
        content = self.make_content("v1", {"bin/app": "hello-v1", "etc/conf": "a=1"})
        pkg = self.pack(content, "1.0.0", kid)

        out = self.run_cli("inspect", str(pkg))
        self.assertIn("ACCEPTED", out)

        self.install(pkg)
        self.assertEqual(self.current(), "1.0.0")
        # 内容落在版本目录，当前版本记录一致
        vdir = self.root / "install" / "demo-app" / "stable" / "versions" / "1.0.0"
        self.assertEqual((vdir / "bin" / "app").read_text(), "hello-v1")
        self.assertFalse((self.root / "install" / "demo-app" / "stable" / "staging").exists())

        out = self.run_cli("status")
        self.assertIn("1.0.0", out)

    def test_trial_install_does_not_touch_current(self):
        kid = self.make_key()
        self.install(self.pack(self.make_content("v1", {"f": "1"}), "1.0.0", kid))
        pkg2 = self.pack(self.make_content("v2", {"f": "2"}), "1.1.0", kid)
        self.run_cli("trial-install", str(pkg2))
        self.assertEqual(self.current(), "1.0.0")  # 试装不影响当前版本
        self.run_cli("activate", "--product", "demo-app", "--channel", "stable")
        self.assertEqual(self.current(), "1.1.0")


class TestTampering(Base):
    def test_payload_tampered(self):
        kid = self.make_key()
        pkg = self.pack(self.make_content("v1", {"bin/app": "original"}), "1.0.0", kid)
        bad = self.dir / "tampered.tar.gz"
        self.rewrite_tar(pkg, bad, modify={"payload/bin/app": b"evicted!"})
        self.run_cli("inspect", str(bad), expect=1)
        self.run_cli("trial-install", str(bad), expect=1)

    def test_manifest_tampered(self):
        kid = self.make_key()
        pkg = self.pack(self.make_content("v1", {"f": "x"}), "1.0.0", kid)
        with tarfile.open(pkg) as tf:
            manifest = json.loads(tf.extractfile("manifest.json").read())
        manifest["version"] = "9.9.9"  # 改清单但不重签
        bad = self.dir / "bad-manifest.tar.gz"
        self.rewrite_tar(pkg, bad, modify={
            "manifest.json": json.dumps(manifest, sort_keys=True).encode()})
        self.run_cli("inspect", str(bad), expect=1)

    def test_extra_file_not_in_manifest(self):
        kid = self.make_key()
        pkg = self.pack(self.make_content("v1", {"f": "x"}), "1.0.0", kid)
        bad = self.dir / "extra.tar.gz"
        ti = tarfile.TarInfo("payload/sneaky.sh")
        self.rewrite_tar(pkg, bad, add=[(ti, b"echo pwned")])
        self.run_cli("inspect", str(bad), expect=1)

    def test_manifest_problems_rejected(self):
        kid = self.make_key()
        priv = keystore.load_private(self.root, kid)

        def build(manifest_dict, payload_files, name):
            mb = json.dumps(manifest_dict, sort_keys=True).encode()
            sig = {"key_id": kid, "algorithm": "demo-rsa-sha256",
                   "signature": crypto.sign(priv, mb).hex()}
            out = self.dir / name
            with tarfile.open(out, "w:gz") as tf:
                for arcname, blob in [("manifest.json", mb),
                                      ("manifest.sig", json.dumps(sig).encode())]:
                    ti = tarfile.TarInfo(arcname)
                    ti.size = len(blob)
                    tf.addfile(ti, io.BytesIO(blob))
                for rel, data in payload_files.items():
                    ti = tarfile.TarInfo("payload/" + rel)
                    ti.size = len(data)
                    tf.addfile(ti, io.BytesIO(data))
            return out

        base = {"product": "demo-app", "channel": "stable", "version": "1.0.0",
                "min_tool_version": "1.0.0"}
        f_entry = {"path": "f", "sha256": hashlib.sha256(b"x").hexdigest(), "size": 1}

        # 缺字段
        m = dict(base)
        del m["channel"]
        self.run_cli("inspect", str(build({**m, "files": [f_entry]}, {"f": b"x"},
                                          "missing-field.tar.gz")), expect=1)
        # 重复路径（完全相同）
        m = {**base, "files": [f_entry, dict(f_entry)]}
        self.run_cli("inspect", str(build(m, {"f": b"x"}, "dup.tar.gz")), expect=1)
        # 规范化后冲突：a/./b 与 a/b
        m = {**base, "files": [dict(f_entry, path="a/b"), dict(f_entry, path="a/./b")]}
        self.run_cli("inspect", str(build(m, {"a/b": b"x"}, "normconf.tar.gz")), expect=1)
        # 清单声明了文件但归档里没有
        m = {**base, "files": [f_entry, dict(f_entry, path="ghost")]}
        self.run_cli("inspect", str(build(m, {"f": b"x"}, "ghost.tar.gz")), expect=1)


class TestTrustAndRevocation(Base):
    def test_untrusted_key_rejected(self):
        kid = self.make_key(trust=False)
        pkg = self.pack(self.make_content("v1", {"f": "x"}), "1.0.0", kid)
        self.run_cli("inspect", str(pkg), expect=1)

    def test_revoked_key_rejected_and_rotation(self):
        kid1 = self.make_key()
        pkg_old = self.pack(self.make_content("v1", {"f": "old"}), "1.0.0", kid1,
                            out_name="old.tar.gz")
        self.run_cli("inspect", str(pkg_old))  # 撤销前能通过

        # 轮换：新增下一把钥匙，撤销旧钥匙
        kid2 = self.make_key()
        self.run_cli("trust-revoke", kid1)
        self.assertNotEqual(kid1, kid2)

        # 旧钥匙签的包现在必须被拒绝，且换钥匙不能让它复活
        self.run_cli("inspect", str(pkg_old), expect=1)
        pkg_new = self.pack(self.make_content("v2", {"f": "new"}), "1.1.0", kid2,
                            out_name="new.tar.gz")
        self.run_cli("inspect", str(pkg_new))
        # 已撤销钥匙不能重新加入
        self.run_cli("trust-add",
                     str(self.root / "keys" / "public" / f"{kid1}.json"), expect=1)

    def test_trust_add_pubkey_file(self):
        kid = self.make_key(trust=False)
        pub = self.root / "keys" / "public" / f"{kid}.json"
        self.run_cli("trust-add", str(pub), "--name", "imported")
        pkg = self.pack(self.make_content("v1", {"f": "x"}), "1.0.0", kid)
        self.run_cli("inspect", str(pkg))


class TestArchiveEscape(Base):
    def _pkg_with_evil_member(self, member: tarfile.TarInfo, data=b"evil"):
        kid = self.make_key()
        pkg = self.pack(self.make_content("v1", {"f": "x"}), "1.0.0", kid)
        bad = self.dir / f"evil-{len(list(self.dir.iterdir()))}.tar.gz"
        self.rewrite_tar(pkg, bad, add=[(member, data)])
        return bad

    def test_path_traversal_rejected(self):
        ti = tarfile.TarInfo("payload/../../escape.sh")
        self.run_cli("inspect", str(self._pkg_with_evil_member(ti)), expect=1)

    def test_absolute_path_rejected(self):
        ti = tarfile.TarInfo("/tmp/abs-evil")
        self.run_cli("inspect", str(self._pkg_with_evil_member(ti)), expect=1)

    def test_symlink_rejected(self):
        ti = tarfile.TarInfo("payload/link")
        ti.type = tarfile.SYMTYPE
        ti.linkname = "/etc/passwd"
        self.run_cli("inspect", str(self._pkg_with_evil_member(ti, data=None)), expect=1)

    def test_hardlink_and_device_rejected(self):
        ti = tarfile.TarInfo("payload/hard")
        ti.type = tarfile.LNKTYPE
        ti.linkname = "payload/f"
        self.run_cli("inspect", str(self._pkg_with_evil_member(ti, data=None)), expect=1)
        ti = tarfile.TarInfo("payload/dev0")
        ti.type = tarfile.CHRTYPE
        self.run_cli("inspect", str(self._pkg_with_evil_member(ti, data=None)), expect=1)

    def test_unknown_top_level_entry_rejected(self):
        ti = tarfile.TarInfo("README-evil.txt")
        self.run_cli("inspect", str(self._pkg_with_evil_member(ti)), expect=1)

    def test_escape_does_not_write_outside(self):
        ti = tarfile.TarInfo("payload/../../escape-marker")
        bad = self._pkg_with_evil_member(ti)
        self.run_cli("trial-install", str(bad), expect=1)
        self.assertFalse((self.dir / "escape-marker").exists())
        self.assertFalse(Path("/escape-marker").exists())


class TestVersionRules(Base):
    def test_monotonic_per_channel(self):
        kid = self.make_key()
        self.install(self.pack(self.make_content("v11", {"f": "11"}), "1.1.0", kid))
        # 旧版本不能覆盖新版本
        old = self.pack(self.make_content("v10", {"f": "10"}), "1.0.9", kid,
                        out_name="old.tar.gz")
        self.run_cli("trial-install", str(old))
        self.run_cli("activate", "--product", "demo-app", "--channel", "stable",
                     expect=1)
        self.assertEqual(self.current(), "1.1.0")

    def test_duplicate_activation_rejected(self):
        kid = self.make_key()
        pkg = self.pack(self.make_content("v1", {"f": "1"}), "1.0.0", kid)
        self.install(pkg)
        # 重复提交同一个包：试装可以重来（幂等替换），但激活必须失败
        self.run_cli("trial-install", str(pkg))
        self.run_cli("activate", "--product", "demo-app", "--channel", "stable",
                     expect=1)
        self.assertEqual(self.current(), "1.0.0")

    def test_channels_and_products_independent(self):
        kid = self.make_key()
        self.install(self.pack(self.make_content("s1", {"f": "s1"}), "2.0.0", kid))
        # 另一通道从更低版本起步，互不影响
        beta = self.pack(self.make_content("b1", {"f": "b1"}), "1.0.0", kid,
                         channel="beta")
        self.install(beta, channel="beta")
        self.assertEqual(self.current(channel="beta"), "1.0.0")
        self.assertEqual(self.current(channel="stable"), "2.0.0")
        # 另一产品也互不影响
        other = self.pack(self.make_content("o1", {"f": "o1"}), "0.1.0", kid,
                          product="other-app")
        self.install(other, product="other-app")
        self.assertEqual(self.current(product="other-app"), "0.1.0")

    def test_min_tool_version(self):
        kid = self.make_key()
        pkg = self.pack(self.make_content("v1", {"f": "x"}), "1.0.0", kid,
                        min_tool="99.0.0")
        self.run_cli("inspect", str(pkg), expect=1)

    def test_rollback(self):
        kid = self.make_key()
        self.install(self.pack(self.make_content("v1", {"f": "1"}), "1.0.0", kid))
        self.install(self.pack(self.make_content("v2", {"f": "2"}), "1.1.0", kid))
        self.assertEqual(self.current(), "1.1.0")
        self.run_cli("rollback", "--product", "demo-app", "--channel", "stable")
        self.assertEqual(self.current(), "1.0.0")
        # 再往前没有了
        self.run_cli("rollback", "--product", "demo-app", "--channel", "stable",
                     expect=1)
        # 回滚后内容目录仍在
        vdir = self.root / "install" / "demo-app" / "stable" / "versions" / "1.0.0"
        self.assertTrue((vdir / "f").exists())


class TestCrashRecovery(Base):
    def _activate_in_subprocess(self, crash_at):
        env = dict(os.environ)
        env["UPDATE_TOOL_CRASH_AT"] = crash_at
        env["PYTHONPATH"] = str(REPO_ROOT)
        return subprocess.run(
            [sys.executable, "-m", "update_tool", "--root", str(self.root),
             "activate", "--product", "demo-app", "--channel", "stable"],
            capture_output=True, text=True, env=env, cwd=str(REPO_ROOT))

    def test_crash_after_move_then_recover(self):
        kid = self.make_key()
        self.install(self.pack(self.make_content("v1", {"f": "1"}), "1.0.0", kid))
        pkg2 = self.pack(self.make_content("v2", {"f": "2"}), "1.1.0", kid)
        self.run_cli("trial-install", str(pkg2))

        # 在“移动文件之后、写状态之前”模拟崩溃（真实进程退出，锁文件残留）
        proc = self._activate_in_subprocess("after-move")
        self.assertNotEqual(proc.returncode, 0)
        # 状态仍一致地指向旧版本
        self.assertEqual(self.current(), "1.0.0")
        # 陈旧锁被自动识别，重新 activate 完成恢复
        self.run_cli("activate", "--product", "demo-app", "--channel", "stable")
        self.assertEqual(self.current(), "1.1.0")
        vdir = self.root / "install" / "demo-app" / "stable" / "versions" / "1.1.0"
        self.assertEqual((vdir / "f").read_text(), "2")

    def test_crash_before_move_is_clean(self):
        kid = self.make_key()
        pkg = self.pack(self.make_content("v1", {"f": "1"}), "1.0.0", kid)
        self.run_cli("trial-install", str(pkg))
        proc = self._activate_in_subprocess("before-move")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIsNone(self.current())
        # staging 完好，重试即可成功
        self.run_cli("activate", "--product", "demo-app", "--channel", "stable")
        self.assertEqual(self.current(), "1.0.0")


class TestConcurrencyAndLogging(Base):
    def test_lock_blocks_second_operator(self):
        kid = self.make_key()
        pkg = self.pack(self.make_content("v1", {"f": "1"}), "1.0.0", kid)
        self.run_cli("trial-install", str(pkg))
        # 手工持锁（模拟另一个正在运行的操作）
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "lock").write_text(str(os.getpid()))
        try:
            self.run_cli("activate", "--product", "demo-app", "--channel", "stable",
                         expect=1)
            self.assertIsNone(self.current())
        finally:
            (self.root / "lock").unlink()
        self.run_cli("activate", "--product", "demo-app", "--channel", "stable")
        self.assertEqual(self.current(), "1.0.0")

    def test_two_threads_activate_once(self):
        kid = self.make_key()
        pkg = self.pack(self.make_content("v1", {"f": "1"}), "1.0.0", kid)
        self.run_cli("trial-install", str(pkg))
        results = []

        def worker():
            results.append(cli.main(["--root", str(self.root), "activate",
                                     "--product", "demo-app", "--channel", "stable"]))

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(results), [0, 1])  # 恰好一个成功
        self.assertEqual(self.current(), "1.0.0")

    def test_results_log_has_no_key_material(self):
        kid = self.make_key()
        pkg = self.pack(self.make_content("v1", {"f": "1"}), "1.0.0", kid)
        self.install(pkg)
        self.run_cli("trust-revoke", kid)
        log_file = self.root / "logs" / "results.jsonl"
        self.assertTrue(log_file.exists())
        text = log_file.read_text()
        for line in text.strip().splitlines():
            rec = json.loads(line)
            self.assertIn("action", rec)
            self.assertIn("ok", rec)
        # 私钥的 d 值绝不出现在日志里
        priv = json.loads((self.root / "keys" / "private" / f"{kid}.json").read_text())
        self.assertNotIn(priv["private"]["d"], text)
        self.assertNotIn(priv["public"]["n"], text)  # 连完整公钥模数也不写


if __name__ == "__main__":
    unittest.main()

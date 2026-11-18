"""例外测试：范围、失效时间、严格身份匹配。"""

import time

from tests._helpers import AuditTestCase


class ExceptionTests(AuditTestCase):
    def _one_finding(self):
        self.write("conf/open.conf", "x=1\n", 0o666)
        run = self.scan()
        return run["findings"][0]

    def test_active_exception_is_attached(self):
        finding = self._one_finding()
        self.auditor.add_exception(
            self.root, finding["id"], "finding", "", "已接受风险（虚构理由）"
        )
        run = self.scan()
        again = next(f for f in run["findings"] if f["id"] == finding["id"])
        self.assertIsNotNone(again["exception"])
        self.assertEqual(again["exception"]["scope"], "finding")

    def test_expired_exception_is_re_displayed(self):
        finding = self._one_finding()
        past = time.strftime(
            "%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 60)
        )
        self.auditor.add_exception(self.root, finding["id"], "finding", past, "临时例外")
        run = self.scan()
        again = next(f for f in run["findings"] if f["id"] == finding["id"])
        self.assertIsNone(again["exception"])

    def test_future_exception_stays_active(self):
        finding = self._one_finding()
        future = time.strftime(
            "%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + 3600)
        )
        self.auditor.add_exception(self.root, finding["id"], "finding", future, "临时例外")
        active = self.auditor.store.active_exception_map(self.root)
        self.assertIn(finding["id"], active)

    def test_exception_does_not_transfer_to_other_finding(self):
        finding_a = self._one_finding()
        self.auditor.add_exception(
            self.root, finding_a["id"], "finding", "", "仅针对 A"
        )
        # 换一个路径产生同类新发现，身份不同，不能继承 A 的例外
        self.write("conf/other.conf", "y=2\n", 0o666)
        run = self.scan()
        for finding in run["findings"]:
            if finding["id"] == finding_a["id"]:
                self.assertIsNotNone(finding["exception"])
            else:
                self.assertIsNone(finding["exception"])

    def test_revoked_exception_no_longer_applies(self):
        finding = self._one_finding()
        record = self.auditor.add_exception(
            self.root, finding["id"], "finding", "", "x"
        )
        self.assertTrue(self.auditor.revoke_exception(self.root, record["exception_id"]))
        active = self.auditor.store.active_exception_map(self.root)
        self.assertNotIn(finding["id"], active)

    def test_invalid_scope_rejected(self):
        finding = self._one_finding()
        with self.assertRaises(ValueError):
            self.auditor.add_exception(
                self.root, finding["id"], "hostname", "", "非法范围"
            )

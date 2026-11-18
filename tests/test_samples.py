"""样例一致性测试: 界面展示的样例结果必须与引擎实际决策一致。"""
import unittest

from cookie_sim.request import evaluate_request, script_readable_cookies
from cookie_sim.samples import SAMPLES, SAMPLE_NOW, build_sample_jar


class SamplesConsistencyTest(unittest.TestCase):
    def test_all_samples_match_expectations(self):
        for sample in SAMPLES:
            with self.subTest(sample=sample.id):
                jar = build_sample_jar(sample)
                # 拒收数量与原因片段
                rejections = jar.rejections()
                self.assertEqual(len(rejections), sample.expect_reject_count)
                for fragment in sample.expect_reject_reasons:
                    self.assertTrue(
                        any(fragment in r.reason for r in rejections),
                        f"{sample.id}: 拒收原因中找不到 {fragment!r}",
                    )
                # 请求决策
                d = evaluate_request(
                    jar,
                    sample.request_url,
                    sample.top_url,
                    method=sample.method,
                    is_navigation=sample.is_navigation,
                    now=SAMPLE_NOW,
                )
                self.assertIs(d.cross_site, sample.expect_cross_site)
                # cookie_header 已按路径长度/创建先后稳定排序;
                # decisions 保留入库顺序用于逐项展示, 这里对实际发送集合按 header 顺序核对
                sent_header = [pair.split("=", 1)[0]
                               for pair in d.cookie_header.split("; ") if pair]
                self.assertEqual(sent_header, sample.expect_sent_names,
                                 f"{sample.id}: 实际发送 {sent_header}")
                sent_set = {item.cookie.name for item in d.decisions if item.sent}
                self.assertEqual(sent_set, set(sample.expect_sent_names))
                # 每个决策都必须有五项检查与可读理由
                for item in d.decisions:
                    self.assertEqual(
                        {c.key for c in item.checks},
                        {"domain", "path", "secure", "expiry", "samesite"},
                    )
                    for chk in item.checks:
                        self.assertTrue(chk.detail)
                    if not item.sent:
                        self.assertTrue(item.block_reason)

    def test_sample_script_view_expectations(self):
        for sample in SAMPLES:
            if not sample.document_url:
                continue
            with self.subTest(sample=sample.id):
                jar = build_sample_jar(sample)
                view = script_readable_cookies(
                    jar, sample.document_url, now=SAMPLE_NOW)
                self.assertEqual(
                    [c.name for c in view.readable],
                    sample.expect_script_readable,
                )


if __name__ == "__main__":
    unittest.main()

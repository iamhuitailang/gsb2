"""multipart 表单解析测试。"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from secbench.server import _parse_multipart  # noqa: E402


class MultipartTest(unittest.TestCase):
    def test_filename_and_content_parsed_with_content_type(self) -> None:
        boundary = "----secbench-test"
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="sample_auth.jsonl"\r\n'
            "Content-Type: application/x-ndjson\r\n\r\n"
            '{"source": "auth"}\r\n'
            f"--{boundary}--\r\n"
        ).encode()
        filename, content = _parse_multipart(body, f"multipart/form-data; boundary={boundary}")
        self.assertEqual(filename, "sample_auth.jsonl")
        self.assertEqual(content, b'{"source": "auth"}')

    def test_missing_file_returns_empty(self) -> None:
        filename, content = _parse_multipart(b"--x--\r\n", "multipart/form-data; boundary=x")
        self.assertEqual(filename, "")
        self.assertEqual(content, b"")


if __name__ == "__main__":
    unittest.main()

"""测试辅助：调用 CLI 并捕获输出。"""
import io
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout

from gha_audit import cli

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLES = os.path.join(ROOT, "examples")


def run_cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = cli.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class CliTestCase(unittest.TestCase):
    def example(self, *parts):
        return os.path.join(EXAMPLES, *parts)

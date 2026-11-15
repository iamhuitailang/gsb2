#!/usr/bin/env python3
"""直播演示脚本：真正启动服务（随机端口 + 临时数据目录），跑完全流程后退出。"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def call(base, path, payload=None):
    url = base + path
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    port = free_port()
    data_dir = tempfile.mkdtemp(prefix="rc-demo-")
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(
        [sys.executable, "-m", "app.server", "--port", str(port), "--data-dir", data_dir],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        for _ in range(100):
            try:
                call(base, "/api/receiver/state")
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise SystemExit("服务未能启动")

        rc = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "demo.py"), "--base", base])
        return rc.returncode
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(data_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())

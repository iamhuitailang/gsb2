"""Web UI HTTP 接口冒烟测试（含 Range 请求）。"""

import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

from proxylink.gen_media import generate_all
from proxylink.project import Project
from proxylink.webui import Handler

try:
    import subprocess
    subprocess.run(["ffprobe", "-version"], capture_output=True, check=True)
    HAVE_FFMPEG = True
except Exception:
    HAVE_FFMPEG = False


@unittest.skipUnless(HAVE_FFMPEG, "环境缺少 ffmpeg/ffprobe")
class WebApiTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="proxylink_web_")
        media_dir = os.path.join(cls.tmp, "media")
        cls.paths = generate_all(media_dir, duration=2.0, fps=24,
                                 short_duration=1.0, head_shift=1.0)
        cls.project = Project(cls.tmp)
        o = cls.project.register(cls.paths["original"])
        p = cls.project.register(cls.paths["normal"])
        link = cls.project.create_link(o.id, p.id)
        cls.project.calibrate(link.id, [(0, 0)])
        cls.link_id = link.id
        cls.original_id = o.id

        Handler.project = cls.project
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _get(self, path):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}") as resp:
            return resp.status, resp.headers, resp.read()

    def _post(self, path, payload):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())

    def test_index_and_media_list(self):
        status, _, body = self._get("/")
        self.assertEqual(status, 200)
        self.assertIn("proxylink", body.decode("utf-8"))
        status, _, body = self._get("/api/media")
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)), 2)

    def test_seek_switch_and_cutpoint_flow(self):
        view = self._post("/api/session/seek",
                          {"link_id": self.link_id, "time": "1.0"})
        self.assertAlmostEqual(view["original"]["time"], 1.0, places=2)
        switched = self._post("/api/session/switch", {})
        self.assertEqual(switched["side"], "proxy")

        cut = self._post("/api/cutpoints",
                         {"link_id": self.link_id, "time": "0.5",
                          "side": "original", "label": "web"})
        self.assertIn("derived_from", cut)
        status, _, body = self._get("/api/export?format=csv")
        self.assertEqual(status, 200)
        self.assertIn("web", body.decode("utf-8"))

    def test_media_range_request(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/media/{urllib.parse.quote(self.original_id)}",
            headers={"Range": "bytes=0-1023"})
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 206)
            self.assertEqual(len(resp.read()), 1024)
            self.assertTrue(resp.headers["Content-Range"].startswith("bytes 0-1023/"))

    def test_relink_mismatch_returns_409(self):
        # 用原片路径冒充代理重挂接 -> 409 + 逐项不符信息
        proxy_id = [m for m in self.project.list_media()
                    if m.id != self.original_id][0].id
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/relink/do",
            data=json.dumps({"ref": proxy_id,
                             "new_path": self.paths["original"]}).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            urllib.request.urlopen(req)
            self.fail("应当返回 409")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 409)
            payload = json.loads(exc.read())
            self.assertTrue(payload["checks"])


if __name__ == "__main__":
    unittest.main()

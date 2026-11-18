"""服务配置解析与规则测试（sshd/nginx/apache/systemd/env/ini）。"""

from tests._helpers import AuditTestCase


class ServiceConfigTests(AuditTestCase):
    def test_sshd_rules(self):
        self.write("etc/sshd_config",
                   "PermitRootLogin yes\nPasswordAuthentication yes\n", 0o644)
        run = self.scan()
        self.assertEqual(len(self.by_rule(run, "SVC-SSHD-PERMIT-ROOT-LOGIN")), 1)
        self.assertEqual(len(self.by_rule(run, "SVC-SSHD-PASSWORD-AUTH")), 1)

    def test_sshd_safe_config_has_no_findings(self):
        self.write("etc/sshd_config",
                   "PermitRootLogin no\nPasswordAuthentication no\n", 0o644)
        run = self.scan()
        self.assertEqual(self.by_rule(run, "SVC-SSHD-PERMIT-ROOT-LOGIN"), [])
        self.assertEqual(self.by_rule(run, "SVC-SSHD-PASSWORD-AUTH"), [])

    def test_nginx_and_apache_http_listen(self):
        self.write("etc/nginx/nginx.conf", "server { listen 80; }\n", 0o644)
        self.write("etc/apache2/httpd.conf", "Listen 80\n", 0o644)
        run = self.scan()
        self.assertEqual(len(self.by_rule(run, "SVC-NGINX-HTTP-LISTEN")), 1)
        self.assertEqual(len(self.by_rule(run, "SVC-APACHE-HTTP-LISTEN")), 1)

    def test_systemd_root_user_and_writable_exec(self):
        self.write("opt/bin/run.sh", "echo x\n", 0o777)
        self.write(
            "etc/systemd/demo.service",
            "[Unit]\nDescription=demo\n[Service]\nUser=root\nExecStart=/opt/bin/run.sh\n",
            0o644,
        )
        run = self.scan()
        root_hits = self.by_rule(run, "SVC-SYSTEMD-ROOT-USER")
        exec_hits = self.by_rule(run, "SVC-SYSTEMD-WRITABLE-EXEC")
        self.assertEqual(len(root_hits), 1)
        self.assertEqual(len(exec_hits), 1)
        self.assertEqual(exec_hits[0]["evidence"]["exec_rel_path"], "opt/bin/run.sh")

    def test_systemd_safe_exec_passes(self):
        self.write("opt/bin/run.sh", "echo x\n", 0o755)
        self.write(
            "etc/systemd/demo.service",
            "[Unit]\nDescription=demo\n[Service]\nUser=demo\nExecStart=/opt/bin/run.sh\n",
            0o644,
        )
        run = self.scan()
        self.assertEqual(self.by_rule(run, "SVC-SYSTEMD-WRITABLE-EXEC"), [])
        self.assertEqual(self.by_rule(run, "SVC-SYSTEMD-ROOT-USER"), [])

    def test_bind_all_detection(self):
        self.write("etc/demo/app.conf", "listen = 0.0.0.0:9000\n", 0o644)
        run = self.scan()
        self.assertEqual(len(self.by_rule(run, "SVC-INSECURE-BIND-ALL")), 1)

    def test_comments_are_not_treated_as_directives(self):
        self.write("etc/sshd_config",
                   "# PermitRootLogin yes\nPermitRootLogin no\n", 0o644)
        run = self.scan()
        self.assertEqual(self.by_rule(run, "SVC-SSHD-PERMIT-ROOT-LOGIN"), [])

    def test_parse_failures_are_classified_separately(self):
        self.write_bytes("etc/demo/bad-utf8.conf", b"\x80\x81\xff not utf8\n", 0o644)
        self.write_bytes("etc/demo/binary.conf", b"\x7fELF binary\x00data\n", 0o644)
        run = self.scan()
        codes = self.notice_codes(run, "parse_error")
        self.assertIn("decode_failed", codes)
        self.assertIn("binary_file", codes)
        # 解析失败不产生半截发现项
        self.assertTrue(all(f["rel_path"] != "etc/demo/bad-utf8.conf"
                            for f in run["findings"]))

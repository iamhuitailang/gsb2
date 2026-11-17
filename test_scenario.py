#!/usr/bin/env python3
"""验收场景测试（直接运行：python3 test_scenario.py）

覆盖需求：
1. 甲乙同时点退出 → 只有一人成功，另一人收到原因提示且仍能打开管理页；
2. 留下的人把普通成员丙升为管理员后，自己退出成功；
3. 机构二的成员名单全程不变；
4. 降级 / 停用 / 移除 / 退出都会校验「操作后至少剩 1 名有效管理员」，停用账号不计入；
5. 每次操作（含被拒绝的）都写入审计日志。
"""

import http.client
import os
import tempfile
import threading
from urllib.parse import quote, parse_qs, urlparse

import app as srv

PASS = 0
FAIL = 0


def check(cond, label, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ✔ {label}')
    else:
        FAIL += 1
        print(f'  ✘ {label}  {extra}')


class Client:
    """带会话 cookie 的最小 HTTP 客户端（不自动跟随重定向）。"""

    def __init__(self, port):
        self.port = port
        self.cookie = ''

    def request(self, method, path, data=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        headers = {}
        if self.cookie:
            headers['Cookie'] = self.cookie
        body = None
        if data is not None:
            body = '&'.join(f'{k}={quote(str(v))}' for k, v in data.items())
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        conn.request(method, path, body, headers)
        resp = conn.getresponse()
        payload = resp.read().decode()
        set_cookie = resp.getheader('Set-Cookie')
        if set_cookie and set_cookie.startswith('sid='):
            self.cookie = set_cookie.split(';')[0]
        location = resp.getheader('Location')
        conn.close()
        return resp.status, location, payload

    def login(self, username, password='pass123'):
        return self.request('POST', '/login', {'username': username, 'password': password})

    def action(self, org_id, action, target=None):
        """提交操作，解析 303 回跳里的 ok/msg，返回 (ok, msg)。"""
        data = {'action': action}
        if target is not None:
            data['target'] = target
        _, location, _ = self.request('POST', f'/org/{org_id}/action', data)
        q = parse_qs(urlparse(location).query)
        return q['ok'][0] == '1', q['msg'][0]


def main():
    tmp = tempfile.mkdtemp(prefix='orgtest_')
    store = srv.Store(os.path.join(tmp, 'test.db'))
    srv.init_db(store)
    srv.seed(store)
    server = srv.App(('127.0.0.1', 0), store)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def uid(username):
        conn = store.connect()
        row = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
        conn.close()
        return row['id']

    def org_members(org_id):
        conn = store.connect()
        rows = conn.execute(
            """SELECT u.username, m.role, u.status FROM memberships m
               JOIN users u ON u.id=m.user_id WHERE m.org_id=? ORDER BY u.username""",
            (org_id,)).fetchall()
        conn.close()
        return [(r['username'], r['role'], r['status']) for r in rows]

    def audit(org_id):
        conn = store.connect()
        rows = conn.execute("SELECT actor, action, target, result, detail FROM audit_log "
                            "WHERE org_id=? ORDER BY id", (org_id,)).fetchall()
        conn.close()
        return [tuple(r) for r in rows]

    try:
        org2_before = org_members(2)

        print('场景一：甲乙同时退出机构一，只允许一人退出')
        jia, yi = Client(port), Client(port)
        jia.login('jia')
        yi.login('yi')
        barrier = threading.Barrier(2)
        results = {}

        def leave(name, client):
            barrier.wait()
            results[name] = client.action(1, 'leave')

        t1 = threading.Thread(target=leave, args=('甲', jia))
        t2 = threading.Thread(target=leave, args=('乙', yi))
        t1.start(); t2.start(); t1.join(); t2.join()

        ok_count = sum(1 for ok, _ in results.values() if ok)
        check(ok_count == 1, '两次并发退出只有 1 次成功', f'实际成功 {ok_count} 次: {results}')
        loser_name = '乙' if results['甲'][0] else '甲'
        loser = yi if results['甲'][0] else jia
        winner = jia if results['甲'][0] else yi
        ok, msg = results[loser_name]
        check(not ok and '有效管理员' in msg, f'{loser_name} 的退出被拒绝并说明原因', msg)

        status, _, _ = loser.request('GET', '/org/1/members')
        check(status == 200, f'{loser_name} 仍能打开机构一管理页', f'HTTP {status}')
        status, _, _ = winner.request('GET', '/org/1/members')
        check(status == 403, '已退出的人无权再打开管理页', f'HTTP {status}')

        print('场景二：留下的人先升丙为管理员，再退出成功')
        ok, msg = loser.action(1, 'promote', uid('bing'))
        check(ok, f'{loser_name} 将丙升为管理员', msg)
        ok, msg = loser.action(1, 'leave')
        check(ok, f'{loser_name} 自己退出成功', msg)
        members1 = org_members(1)
        check(members1 == [('bing', 'admin', 'active')],
              '机构一最终只剩丙一名有效管理员', str(members1))

        print('场景三：机构二名单保持原样')
        check(org_members(2) == org2_before, '机构二成员名单未变化',
              f'{org2_before} -> {org_members(2)}')

        print('场景四：降级 / 停用 / 移除 / 退出的有效管理员检查（机构三）')
        zhao, qian, sun = Client(port), Client(port), Client(port)
        zhao.login('zhao')
        qian.login('qian')
        sun.login('sun')

        status, _, _ = sun.request('GET', '/org/3/members')
        check(status == 403, '普通成员（孙）打不开管理页', f'HTTP {status}')

        ok, msg = zhao.action(3, 'demote', uid('qian'))
        check(ok, '赵把钱降为成员（还剩赵）', msg)
        ok, msg = zhao.action(3, 'demote', uid('zhao'))
        check(not ok and '有效管理员' in msg, '赵是最后一名有效管理员，自我降级被拒绝', msg)
        ok, msg = zhao.action(3, 'disable', uid('zhao'))
        check(not ok and '有效管理员' in msg, '赵是最后一名有效管理员，自我停用被拒绝', msg)

        ok, msg = zhao.action(3, 'disable', uid('sun'))
        check(ok, '停用普通成员孙（不影响管理员数）', msg)
        status, _, _ = sun.login('sun')
        check(status == 403, '停用的账号不能登录', f'HTTP {status}')
        ok, msg = zhao.action(3, 'enable', uid('sun'))
        check(ok, '重新启用孙', msg)

        ok, msg = zhao.action(3, 'promote', uid('sun'))
        check(ok, '赵把孙升为管理员（现有赵、孙两名）', msg)
        ok, msg = zhao.action(3, 'disable', uid('sun'))
        check(ok, '停用孙（还剩赵一名有效管理员）', msg)
        ok, msg = zhao.action(3, 'leave')
        check(not ok and '有效管理员' in msg, '孙已停用不计入，赵退出会被拒绝', msg)
        ok, msg = zhao.action(3, 'enable', uid('sun'))
        check(ok, '重新启用孙', msg)
        ok, msg = zhao.action(3, 'leave')
        check(ok, '孙恢复有效后，赵退出成功', msg)

        ok, msg = sun.action(3, 'remove', uid('qian'))
        check(ok, '孙移除普通成员钱', msg)
        ok, msg = sun.action(3, 'leave')
        check(not ok and '有效管理员' in msg, '孙是最后一名有效管理员，退出被拒绝', msg)

        print('场景五：操作均留有审计记录')
        logs1, logs3 = audit(1), audit(3)
        check(any(r[1] == '退出机构' and r[3] == '成功' for r in logs1)
              and any(r[1] == '退出机构' and r[3] == '已拒绝' for r in logs1),
              '机构一同时记录了成功与被拒绝的退出')
        check(any(r[1] == '升为管理员' and r[2] == '丙' and '成员 → 管理员' in r[4] for r in logs1),
              '丙的晋升记录了实际变化（成员 → 管理员）')
        check(len(logs3) >= 10, '机构三的操作全部入日志', f'共 {len(logs3)} 条')
        check(not audit(2), '机构二无任何操作记录')
    finally:
        server.shutdown()
        server.server_close()

    print(f'\n结果：{PASS} 通过，{FAIL} 失败')
    raise SystemExit(1 if FAIL else 0)


if __name__ == '__main__':
    main()

# 本地机构成员管理

内部工具的机构设置必须始终保留至少一名能够登录的管理员。本应用提供一个
零第三方依赖（仅 Python 3 标准库）的本地 Web 页面，机构管理员可以在页面上：

- 调整他人角色：升为管理员 / 降为普通成员
- 停用 / 重新启用账号
- 将成员移出机构
- 自己退出机构

降级、停用、移除、退出这四类操作，都会在写入前检查**操作完成后还剩几名
有效管理员**（`role='admin'` 且 `is_active=1`，停用账号不计入）。若操作会导致
机构没有任何有效管理员，操作被整体拒绝，页面提示具体原因，并在操作记录中
留一条 `blocked` 审计（明确写明“未执行任何变更”及原因）；成功操作记录成员
的实际变化。

## 运行

```bash
python3 -m app.server            # 默认 http://127.0.0.1:8000
PORT=8911 python3 -m app.server  # 指定端口
```

首次启动自动建表并写入种子数据（SQLite，位于 `data/app.db`，已在 .gitignore）。

演示账号（密码均为 `pass1234`）：

| 用户名 | 姓名 | 机构 | 角色 |
| --- | --- | --- | --- |
| jia | 甲 | 甲方机构 | 管理员 |
| yi | 乙 | 甲方机构 | 管理员 |
| bing | 丙 | 甲方机构 | 普通成员 |
| ding | 丁 | 乙方机构 | 管理员 |
| wu | 戊 | 乙方机构 | 普通成员 |

## 测试

```bash
python3 -m unittest discover -s tests -v   # 11 个端到端/服务层测试
python3 -m tests.stress_concurrent_leave   # 20 名管理员同时退出的压测
zsh tests/e2e_curl_demo.sh                 # curl 走查（需先启动服务）
```

## 并发与原子性

两名管理员可能同时在各自页面点击退出。实现上：

- Web 服务使用 `ThreadingHTTPServer`，每个请求独立连接、独立事务。
- 所有变更操作在同一个 **`BEGIN IMMEDIATE`** 事务内完成
  “剩余有效管理员检查 + 成员写入 + 审计写入”。该语句立即获取 SQLite 写锁，
  并发事务在锁上排队（`busy_timeout=10s` + WAL），因此检查与写入之间不会插入
  另一个事务的变更，杜绝“先各查一次都通过、然后双双退出”的竞态。
- 被拦截时仅写入一条 blocked 审计并提交，不触碰成员数据。

压测（20 名管理员各发一个并发退出请求）结果恒定为：19 个成功、1 个被拦截，
机构最终恰好剩 1 名有效管理员。

## 验收场景（与需求对应）

1. 甲、乙两个管理员会话同时对甲方机构提交退出 → 恰好一人成功，另一人页面
   收到“操作后将没有任何可登录的有效管理员（停用账号不计入）”提示。
2. 被拦截者仍能打开机构管理页（HTTP 200，成员表正常）。
3. 幸存者先把普通成员丙升为管理员，再自己退出 → 退出成功。
4. 最终甲方机构只剩丙一名有效管理员；乙方机构（丁、戊）名单与操作记录保持原样。

该场景由 `tests/test_member_management.py::ConcurrentLeaveTests` 通过真实
HTTP 服务 + 两个独立 Cookie 会话 + `Barrier` 同时发请求自动验证。

## 目录结构

```
app/
  db.py        # SQLite 连接、建表、种子数据、口令哈希(PBKDF2)
  service.py   # 业务逻辑：BEGIN IMMEDIATE 事务、管理员保护、审计
  templates.py # 服务端 HTML 渲染（统一转义）
  server.py    # ThreadingHTTPServer 路由、会话 Cookie、PRG
tests/
  test_member_management.py  # 单元/端到端测试
  stress_concurrent_leave.py # 高并发压测
  e2e_curl_demo.sh           # 手工 curl 验收脚本
```

## 数据模型

- `users`：账号与口令哈希
- `orgs`：机构
- `memberships`：机构-用户关系，含 `role(admin|member)` 与 `is_active(0|1)`
- `sessions`：登录会话 token
- `audit_logs`：每次操作的操作者、对象、动作、结果（success/blocked）与详情，
  成功记录成员实际变化，拦截记录拒绝原因

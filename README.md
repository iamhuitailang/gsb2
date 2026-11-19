# gsb2 工单系统

一个纯 Python 标准库实现的本地小型工单系统：SQLite 存储 + 内置 HTTP 服务 + 原生前端，无第三方依赖。

## 功能

- 登录后按小组分页查看工单（跨页勾选，选中编号会保留）
- 主管批量关闭**本组尚未结束**（待处理 / 处理中）的工单
- 提交前预览可关闭数量；真正执行时逐条重新校验工单当前所属小组与状态
- 批次结果区分「关闭成功」与「未处理」
- 组外或不存在工单只返回编号与「无权处理」，响应中不含标题、状态等任何内容
- 重复提交同一批（同一 `batch_key`）直接返回上次结果，不重复写关闭记录
- 管理员可转移工单所属小组（用于复现预览后工单被转走的场景）

## 运行

```bash
python3 -m ticket_system --reset-demo --port 8000
```

打开 http://127.0.0.1:8000 。

演示数据（`--reset-demo` 写入，且数据库为空时自动写入）：

| 账号 | 角色 | 小组 |
| --- | --- | --- |
| `supervisor_a` / `demo1234` | 主管 | 甲组（2 张开启工单） |
| `supervisor_b` / `demo1234` | 主管 | 乙组（1 张同名工单） |
| `admin` / `demo1234` | 管理员 | — |

数据库默认写在 `tickets.db`（已在 `.gitignore` 中忽略）。

## 测试

```bash
python3 run_tests.py            # 等价于下面这条，便于直接运行
python3 -m unittest discover -v
```

`tests/test_service.py` 覆盖领域逻辑，`tests/test_http.py` 走真实 HTTP 端口验证鉴权、CSRF 与完整场景。
`python3 -m scripts.scenario` 可打印题目场景的完整执行过程。

## API

除登录外均需 `X-Session-Token`；写操作还需 `X-CSRF-Token`（登录响应返回）。批次接口的 `batch_key` 是幂等键。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | `{username, password}` → `{token, csrf_token, user}` |
| POST | `/api/logout` | 删除当前会话 |
| GET | `/api/me` | 当前用户 |
| GET | `/api/groups` | 小组列表 |
| GET | `/api/tickets?page=&page_size=` | 本组工单分页 |
| POST | `/api/close-batches/preview` | `{ticket_ids}` → `{total, closable_count, items}` |
| POST | `/api/close-batches` | `{ticket_ids, batch_key}` → `{batch}` |
| GET | `/api/close-batches/{id}` | 查询批次结果（本人或管理员） |
| GET | `/api/tickets/{id}/audit` | 本组工单审计记录 |
| POST | `/api/tickets/{id}/transfer` | 管理员转移工单 `{to_group_id}` |

## 关键规则

- 可关闭状态只有 `open` / `processing`；`archived` 一律不动，`closed` 视为无需处理。
- 执行时对每条工单使用条件更新：
  `UPDATE ... WHERE id = ? AND group_id = ? AND status IN ('open','processing')`，
  因此预览后被转组或改状态的工单不会被误关。
- 权限判定顺序是「先看小组，再看状态」，组外工单无论什么状态都只报 `no_permission`，不泄露状态。
- 关闭记录 `close_records` 对 `ticket_id` 唯一，一张工单最多一条关闭记录。
- `close_batches (supervisor_id, batch_key)` 唯一，并保存请求指纹；同键不同编号返回 409。

# 项目面板实时推送服务

零依赖（Node >= 18），SSE 实时推送 + 断线补发，项目访问权限完全由服务端控制。

## 运行

```bash
node server.js          # 默认 3000 端口，PORT=3217 node server.js 可改
```

浏览器打开 `http://localhost:3000`，用 `alice / alice123` 登录（甲+乙两个项目），
或 `bob / bob123`（仅乙项目）。

## 安全模型

- 用户能访问哪些项目只由服务端 `permissions` 表决定，SSE 连接不接受任何项目参数，
  浏览器切换页面/篡改请求都无法扩大订阅范围。
- **撤权即时生效**：每次广播前逐连接重新查权限表，已连着的客户端立刻收不到被撤项目的更新；
  同时服务端推送 `sync` 事件，页面丢弃本地数据后按最新权限重新拉取。
- **补发按当前权限过滤**：重连时按 `Last-Event-ID` 补发遗漏事件，但只补仍有权限的项目；
  被撤项目的旧标题在 `/api/events`、`/api/tasks`、`/api/unread` 中同样不再出现。

## 接口

| 接口 | 说明 |
| --- | --- |
| `POST /login` | 登录，设置 HttpOnly Cookie |
| `GET /stream` | SSE 推送（需登录），支持 `Last-Event-ID` 补发 |
| `GET /api/tasks` | 当前有权限的项目及任务 |
| `GET /api/events?since=N` | 当前有权限的历史事件 |
| `GET /api/unread` | 未读数（按当前权限计算） |
| `POST /api/read` | 标记已读 `{ "id": N }` |
| `POST /admin/task` | 更新任务状态（需 `Authorization: Bearer admin-secret`） |
| `POST /admin/revoke` | 撤销用户项目权限 `{ "user", "project" }` |
| `POST /admin/grant` | 恢复用户项目权限 |

## 演示流程

```bash
# 1. 页面登录 alice，能看到甲、乙两项目的任务动态
# 2. 更新两边任务，页面两边都实时收到
curl -X POST localhost:3000/admin/task -H 'Authorization: Bearer admin-secret' \
  -H 'Content-Type: application/json' -d '{"project":"alpha","taskId":"a1","status":"已完成"}'
curl -X POST localhost:3000/admin/task -H 'Authorization: Bearer admin-secret' \
  -H 'Content-Type: application/json' -d '{"project":"beta","taskId":"b1","status":"测试中"}'

# 3. 管理员撤销 alice 的甲项目权限
curl -X POST localhost:3000/admin/revoke -H 'Authorization: Bearer admin-secret' \
  -H 'Content-Type: application/json' -d '{"user":"alice","project":"alpha"}'

# 4. 再分别更新两边任务：页面只收到乙项目的新消息，甲项目任务从列表消失、未读数同步减少
curl -X POST localhost:3000/admin/task -H 'Authorization: Bearer admin-secret' \
  -H 'Content-Type: application/json' -d '{"project":"alpha","taskId":"a2","status":"进行中"}'
curl -X POST localhost:3000/admin/task -H 'Authorization: Bearer admin-secret' \
  -H 'Content-Type: application/json' -d '{"project":"beta","taskId":"b2","status":"已完成"}'

# 5. 关闭再重开页面：补发结果、事件列表、未读数中都不会出现撤权后的甲项目标题
```

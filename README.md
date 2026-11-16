# gsb2 · 项目组入驻

内部项目组的入驻页面：管理员按 **邮箱 + 团队 + 角色** 发送邀请，邀请直接投递到项目自带的**本地收件箱**；受邀者必须用**已验证同一邮箱**的账号登录后才能接受。

零依赖，只需 Node.js 20+。

## 运行

```bash
npm start          # http://127.0.0.1:3000
npm test           # 领域规则 + HTTP 端到端测试
```

默认数据持久化到 `data/store.json`（可用 `DATA_FILE` 覆盖），`PORT` 覆盖端口。

演示账号：

| 账号 | 密码 | 说明 |
| --- | --- | --- |
| `admin@gsb2.local` | `admin123` | 管理员 |
| `alice@example.com` | `alice123` | 已验证普通用户 |
| `bob@example.com` | `bob123` | 已验证普通用户 |
| `unverified@example.com` | `unverified123` | 邮箱未验证（无法接受邀请） |

## 规则如何落地

| 需求 | 实现位置 |
| --- | --- |
| 管理员选择邮箱、团队、角色发邀请 | `Store.createInvite` / `POST /admin/invites` |
| 消息通过本地收件箱查看 | `Store.listMessagesForEmail` / `GET /inbox` |
| 受邀者须用已验证的相同邮箱账号接受 | `Store.acceptInvite` 校验 `emailVerified` 与邮箱一致 |
| 一人可同时收到多个团队邀请，各团队独立 | 只按 `(team, email)` 维护有效邀请，团队间互不影响 |
| 角色以服务端邀请记录为准，链接只定位邀请 | `acceptInvite({ token, userId })` 只从邀请记录取角色，路由不读 query/body 里的角色 |
| 改发邀请时旧链接作废 | 同 `(team, email)` 的旧 `pending` 邀请置为 `superseded`，旧令牌 GET 返回 404 |
| 撤销与接受只有一个最终结果 | 状态迁移是同步的「检查-再修改」，中间没有 `await`；只有 `pending` 能被迁移 |
| 已有成员再次打开邀请不重复建关系 | 先查成员关系再决定是否新建；已接受的邀请再次打开不会进入接受分支 |
| 旧邀请不能把已调整的角色改回去 | 每条成员关系记录 `roleUpdatedSeq`；只有创建时间晚于最近一次角色调整的邀请才能应用角色 |

## 邀请状态机

```
pending ──accept──► accepted
   │
   ├──revoke──────► revoked
   └──resend──────► superseded
```

`accepted` / `revoked` / `superseded` 均为终态，不会被再次迁移。

## 目录

```
src/store.js   领域规则与持久化（用户、团队、成员关系、邀请、收件箱）
src/auth.js    会话、CSRF、Cookie
src/views.js   服务端渲染页面
src/server.js  HTTP 路由
test/          领域测试与 HTTP 端到端测试
```

## 安全说明

- 邀请令牌 32 字节随机，服务端只保存 SHA-256 哈希；令牌不可猜测。
- 所有写操作校验 CSRF；登录成功后轮换会话 ID。
- 所有输出经过 HTML 转义；响应带 `no-store`、`nosniff`、`DENY`。
- 会话保存在内存中，进程重启后需要重新登录。
- 这是内部演示用的本地收件箱，邀请链接明文保存在本地数据文件中；生产环境应改为真实邮件投递并从存储中移除明文令牌。

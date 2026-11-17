# 付款指令复核系统（演示）

演示财务系统中的付款指令复核流程：提交人填写收款方与金额，**两名不同的复核人**对**同一版本**同意后，指令进入待执行。仅保存演示样例数据，页面可一键重置。

零外部依赖：基于 Node.js ≥ 24 内置的 `node:sqlite`、`node:http` 与原生前端实现，无需 `npm install`、无需构建。

## 快速开始

```bash
npm start          # 启动后访问 http://localhost:3000
npm test           # 运行 13 个端到端测试（含并发场景）
```

环境变量：`PORT`（默认 3000）、`DEMO_DB_PATH`（默认 `data/demo.db`）。

页面右上角可切换演示身份（甲=提交人，乙/丙=复核人）并重置样例数据。

## 业务规则

| 规则 | 实现方式 |
| --- | --- |
| 提交人不能复核自己的指令 | 服务端校验 `submitter_id !== reviewer_id`，返回 `FORBIDDEN_SELF_REVIEW` (403)，尝试仍写入审计时间线 |
| 同一复核人重复点击只算一次 | 数据库唯一约束 `(instruction_id, version, reviewer_id)` + 服务端幂等返回 `duplicate: true` |
| 复核绑定具体版本 | `approvals` 表带 `version` 字段；改版生成新版本，旧复核保留在历史版本上但不计入当前版本 |
| 旧页面提交复核要被拦截 | 乐观并发控制：请求携带 `expected_version`，与服务端当前版本不符返回 `VERSION_CHANGED` (409)，前端红色提示并引导刷新 |
| 两人同时复核不能产生两条待执行 | 全部写操作在 `BEGIN IMMEDIATE` 事务内完成，行锁串行化；状态翻转用条件 `UPDATE ... WHERE status='PENDING_APPROVAL'` 兜底，审计事件恰有一条 |
| 详情可追溯每次改动与复核 | 版本表保存每个版本的收款方/金额/变更说明，审计表记录创建、改版、复核、拒绝复核、进入待执行全部事件 |

### 数据模型（SQLite）

- `users`：三个固定演示用户（甲/乙/丙）
- `instructions`：指令主表，`current_version` 指向当前生效版本，状态为 `PENDING_APPROVAL` / `PENDING_EXECUTION`
- `instruction_versions`：每次修改收款方/金额新增一行（版本号递增）
- `approvals`：复核记录，唯一约束保证同一复核人对同一版本只算一次
- `audit_events`：全量审计事件（含被拒绝的复核尝试）

金额以**分（整数）**存储，杜绝浮点误差。

## 演示剧本（与验收口径一致）

1. 甲提交指令：收款方「华东供应商有限公司」，初始金额 **120.00 元**（重置后的样例数据即此状态，v1）
2. 乙对 v1 点「同意复核」→ 进度 1/2
3. 甲把金额改为 **150.00 元** → 生成 v2，乙在 v1 的复核保留但不再计入新版
4. 丙在**未刷新的旧页面**点同意（请求仍带 `expected_version=1`）→ 页面提示「⚠ 版本已变化，本次复核未生效」，可点「刷新并核对新版本」
5. 乙、丙分别对 v2 重新同意 → 第二人同意时 v2（150.00 元）进入**待执行**，只产生一条待执行结果
6. 待执行后指令锁定，修改与复核均返回 `INSTRUCTION_FINALIZED` (409)

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/users` | 演示用户列表 |
| GET | `/api/instructions` | 指令列表（含当前版本复核进度） |
| POST | `/api/instructions` | 提交人新建指令 `{user_id, payee, amount_yuan}` |
| GET | `/api/instructions/:id` | 详情：全部版本、各版本复核、审计时间线 |
| POST | `/api/instructions/:id/versions` | 提交人改版 `{user_id, payee, amount_yuan, expected_version}` |
| POST | `/api/instructions/:id/approvals` | 复核同意 `{user_id, expected_version}` |
| POST | `/api/reset` | 重置为初始样例数据 |

错误响应统一为 `{ "error": { "code", "message", "current_version" } }`，关键错误码：
`FORBIDDEN_SELF_REVIEW` / `FORBIDDEN_NOT_REVIEWER` / `FORBIDDEN_NOT_SUBMITTER` (403)、
`VERSION_CHANGED` / `INSTRUCTION_FINALIZED` (409)、`VALIDATION_ERROR` (400)。

## 目录结构

```
server.js              HTTP 入口与静态资源服务
src/db.js              表结构、连接、样例数据与重置
src/services.js        业务服务层（事务、版本校验、幂等、状态流转）
public/                原生 HTML/CSS/JS 单页（无构建）
test/payment.test.ts   node:test 端到端测试（权限、幂等、版本冲突、并发）
data/demo.db           运行后生成的 SQLite 文件（已 gitignore，仅样例数据）
```

## 测试覆盖

`npm test` 通过真实 HTTP 服务验证：自我复核拦截、重复点击幂等、版本冲突 409、
完整 120→150 剧本、两人**并发**复核只翻转一次状态、复核与改版并发不产生脏数据、
同一复核人并发重复点击只落一条记录、角色与金额校验、审计时间线完整性。

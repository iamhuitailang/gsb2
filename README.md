# 礼品卡流水接收与对账服务

连锁店各收银点向总部上报礼品卡流水（充值 / 消费 / 退款）。本服务负责接收、
去重、入账核算，并提供对账页面。零第三方依赖，仅使用 Node.js 内置模块
（`node:sqlite` + `node:http`），要求 Node ≥ 22.5。

## 快速开始

```bash
npm run seed     # 重置 data/giftcard.db 并复现题面完整场景
npm start        # 启动服务，打开 http://localhost:3000
npm test         # 运行全部 16 个测试（含真实 HTTP 并发）
```

环境变量：`PORT`（默认 3000）、`GC_DB_PATH`（默认 `data/giftcard.db`）。

## 核心规则

| 规则 | 实现 |
| --- | --- |
| 金额按分存储 | 全链路整数（`amount_cents` / `balance_cents`），前端元转分按两位小数字符串解析，规避浮点误差 |
| 按收银点 + 流水号去重 | 表上 `UNIQUE(register_id, seq)`；重复上报返回首条记录并标记 `duplicate: true`，不重复入账 |
| 充值 | 立即增加余额，状态 `posted` |
| 消费 | 余额充足则扣减入账；不足则保留为 `rejected`（余额不足原因），不丢流水 |
| 退款指向原消费 | 必须携带原消费的 `(refRegisterId, refSeq)`，可分多次退，累计不超过原消费金额 |
| 原消费未到 | 退款暂存为 `pending`（不动余额），原消费到达后按 **FIFO** 自动核算释放；超额的暂存退款转 `rejected`，不影响后续暂存退款 |
| 并发退款统一核算额度 | 每次提交在 `BEGIN IMMEDIATE` 写事务内完成"读可退额度 → 核算 → 写余额/累计已退"，写入串行化，两收银点同时退款只有额度内的通过 |
| 入账后余额 | 每笔已入账流水保存 `balance_after_cents` 快照，对账页可查任意流水入账后的余额 |
| 每笔消费可退金额 | 消费流水上维护 `refunded_cents`，接口与页面返回剩余可退 = 金额 − 已退 |

流水只追加不删除：暂存、被拒绝的流水都能在对账页按状态筛选并看到原因码与中文说明。

## 对账页面（http://localhost:3000）

- 卡选择 / 开卡（可指定初始余额），顶部展示当前余额（元 + 分）
- 上报流水表单：选退款时展开"原消费收银点 / 流水号"
- 流水明细：类型、金额（元/分双显示）、状态徽标、入账后余额、每笔消费剩余可退、原因/关联
- 已入账退款行提供 **"跳转 #id"** 链接，点击定位并高亮原消费（自动清除可能挡住目标行的筛选）
- 状态 / 类型筛选，每 3 秒自动刷新，也可手动刷新

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/cards` | 开卡 `{cardId, initialBalanceCents?}`，重复返回 409 |
| GET | `/api/cards/:cardId` | 卡余额 + 该卡全部流水 |
| POST | `/api/transactions` | 上报流水（见下），重复上报返回 200 + `duplicate:true`，新流水 201 |
| GET | `/api/transactions?cardId&status&type` | 流水查询，可按状态/类型筛选 |
| GET | `/api/transactions/:id` | 单笔流水详情 |

上报流水请求体：

```json
{
  "cardId": "C001",
  "registerId": "POS-A",
  "seq": "A-REF-2",
  "type": "refund",
  "amountCents": 3000,
  "refRegisterId": "POS-B",
  "refSeq": "B-PUR-1"
}
```

`refRegisterId` / `refSeq` 仅退款必填。错误统一返回
`{ "error": { "code", "message" } }`，校验错误 400，资源不存在 404，冲突 409。

## 数据模型（SQLite）

- `cards(id, balance_cents, created_at)`
- `transactions`：流水主表，含状态（`posted/pending/rejected`）、原因码、
  原消费定位键与命中后的 `linked_tx_id`、入账后余额快照、消费的累计已退金额；
  暂存退款有部分索引，按原消费定位键 + 到达顺序取 FIFO。

## 目录结构

```
src/db.js       建表与连接（WAL）
src/service.js  核心核算：事务、暂存/FIFO、退款额度、查询
src/server.js   HTTP 路由与静态托管
web/            对账页（原生 HTML/CSS/JS，无构建）
scripts/seed.js 题面场景种子脚本
test/           node:test 单元 + HTTP 端到端测试
```

## 题面场景的预期结果（`npm run seed` 复现）

1. 开卡初始余额 0 → 充值 100 元 → 余额 10000 分
2. 20 元退款先到、原消费缺失 → `pending`，余额仍为 10000 分
3. 60 元原消费补进 → 暂存退款一并生效，余额 6000 分，该消费剩余可退 4000 分
4. 两个收银点同时各退 30 元（不同流水号）→ 一笔 `posted`、一笔
   `rejected (REJECTED_REFUND_EXCEEDS)`
5. 最终余额 9000 分（90 元），剩余可退 1000 分（10 元）

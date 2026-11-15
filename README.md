# 本地营销归因服务

接收**活动点击、付款、整单退款**三类记录，按「付款前 24 小时内最后一次点击」做 last-click 归因，
支持埋点晚到改判、退款扣减、订单级归因时间线，以及按付款日期的报表查询与 CSV 导出（汇总/明细可对账）。

零外部依赖：Node.js（≥ 22.5，内置 `node:sqlite` / `node:http`），无需 `npm install`。

## 启动

```bash
npm run seed     # 初始化演示数据（data/ 已存在时用 RESET=1 npm run seed 重建）
npm start        # http://localhost:3217 （端口占用时：PORT=xxxx npm start）
npm test         # 端到端测试（临时数据目录，不污染 data/）
```

时间按服务器本地时区解释，建议 `TZ=Asia/Shanghai npm start`。

## 归因规则（页面“规则说明”同步公开）

1. **归因窗口**：订单归给同一账号、点击时间在 `[付款时间 − 24h, 付款时间]` 内的点击，**两端都含，正好 24h 也算**。
2. **last-click**：窗口内点击时间最晚的一次点击所属活动赢得归因；窗口内无点击 → **直接成交**。
3. **同刻定序**：两次点击时间完全相同时，按**点击编号字典序**定先后，编号靠后者视为更晚（建议等长编号）。
4. **晚到改判**：新点击若成为新的最后有效点击，订单立即从原活动移到新活动，两边报表同时变化，
   每次改判在订单时间线留痕并写明中文原因（同活动内换点击也记录）。
5. **整单退款**：退款挂在订单当前态上，从当前归属活动扣减、不改归因；若退款后又改判，
   订单（含退款状态）整体移到新活动，任意时刻净单数都不为负。同一退款单号、同一订单的重复退款只处理一次。
6. **统计口径**：按**付款日期**分组（入库时固化），与点击/退款的到达时间无关；
   每活动展示成交单数 / 退款单数 / 净单数，零单活动与直接成交都补零成行。

## 演示流程（seed 后的验收主线）

同一账号 A001，付款日 2026-11-15：

1. seed 后 O001（12:00 付款）已归因**活动甲**（10:00 点击 C01），O002 为**直接成交**；报表 甲=1 单。
2. 在「数据接入」上传 `samples/late-click.csv`（11:50 活动乙的晚到点击 C02）
   → O001 改归**活动乙**，甲 0 单、乙 1 单，订单时间线出现甲→乙改判原因。
3. 上传 `samples/refunds.csv`（O001 整单退款 R01）→ 活动乙成交 1 / 退款 1 / 净 0，甲仍为 0。
4. 「订单查询」打开 O001：可看到初始归因、甲→乙改判原因、整单退款三条时间线。

## CSV 格式

UTF-8（可带 BOM），表头按名称识别、列序不限，支持引号包裹与字段内逗号/换行。时间列为
`YYYY-MM-DD HH:mm:ss` 本地时间。

| 类型 | 必填列（括号内为中文别名） |
| --- | --- |
| 点击 | `click_id`(点击编号), `account_id`(账号), `campaign_id`(活动编号), `campaign_name`(活动名称), `click_time`(点击时间) |
| 付款 | `order_id`(订单编号), `account_id`(账号), `payment_time`(付款时间) |
| 退款 | `refund_id`(退款单号), `order_id`(订单编号), `refund_time`(退款时间) |

- 点击按 `click_id`、付款按 `order_id`、退款按 `refund_id` 幂等，重复提交计入 `duplicate` 不重复处理；
- 行级错误（空字段、坏时间、退款指向不存在的订单、同单二次退款）按行拒绝并返回 `第 N 行：…`，
  错误清单最多展示 10 条；仅空文件/缺表头属于整文件 400 拒绝。

## 目录结构

```
server/      db.js 建表 / csv.js 解析校验 / attribution.js 归因引擎 / reports.js 报表导出 / server.js HTTP
public/      原生 HTML/CSS/JS 单页（数据接入、归因报表、订单查询、规则说明四个 tab）
scripts/     seed 演示数据
samples/     点击/付款样例（seed 导入）与晚到点击/退款样例（演示手动上传）
test/        node:test 端到端测试（17 个用例）
data/        运行期 app.db（git 忽略）
```

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/ingest/(clicks|payments|refunds)` | 上传 CSV（raw body + `X-Filename` 头），返回接受/重复/错误计数 |
| GET | `/api/reports?date=` 或 `?startDate=&endDate=` | 活动×付款日报表（含直接成交与零单补零） |
| GET | `/api/orders?q=&campaignId=&payDate=` | 订单列表 |
| GET | `/api/orders/:orderId` | 订单详情与归因/退款时间线 |
| GET | `/api/exports/summary.csv` / `orders.csv` | 汇总 / 明细导出（带 BOM，Excel 可直接打开） |
| GET | `/api/samples/:key` | 样例 CSV 下载 |
| GET | `/api/ingest/batches` | 最近上传批次与计数 |

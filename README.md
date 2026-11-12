# 游戏事件回放分析平台

接收一局游戏产生的原始事件，在服务端重建时间线、识别异常并汇总对局结果；
网页端支持按玩家、日期、对局状态筛选，查看原始事件、异常标记、统计指标并导出 CSV。

- 后端：FastAPI + SQLAlchemy + SQLite（Python 3.11+）
- 前端：Vue 3 + Vite + vue-router
- 本地直接运行，**不需要 Docker**

---

## 目录结构

```
repo/
├── backend/
│   ├── app/
│   │   ├── main.py        # FastAPI 入口、CORS、启动建表
│   │   ├── config.py      # 限制项、支持的 schema 版本、规则版本号
│   │   ├── database.py    # 引擎、ORM 模型、UTC 时间类型
│   │   ├── schemas.py     # 请求/响应模型
│   │   ├── rules.py       # 规则引擎：时间线重建、异常、指标、哈希
│   │   ├── ingestion.py   # 批量接入：逐条验收、幂等、重算
│   │   └── api.py         # HTTP 路由（接入/查询/导出/重处理）
│   ├── scripts/seed.py    # 示例数据（乱序、重试、迟到、坏事件）
│   ├── tests/             # pytest，31 个用例
│   └── requirements.txt
└── frontend/
    ├── src/
    │   ├── views/SessionList.vue    # 筛选 + 列表 + 导出
    │   ├── views/SessionDetail.vue  # 统计/异常/时间线/原始事件
    │   ├── api.js / format.js
    │   └── App.vue / main.js / styles.css
    └── package.json
```

---

## 本地启动

### 1. 后端（默认端口 8000）

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

uvicorn app.main:app --host 127.0.0.1 --port 8000
# 首次启动自动建表，SQLite 文件在 backend/data/game.db
```

健康检查：

```bash
curl http://127.0.0.1:8000/api/health
# {"status":"ok","rules_version":"1.0.0","supported_schema_versions":["1.0"]}
```

> 端口被占用时换一个端口，并让前端代理指向它（见下）。

### 2. 前端（默认端口 5173）

```bash
cd frontend
npm install
npm run dev
# 若后端不在 8000：VITE_API_TARGET=http://127.0.0.1:<端口> npm run dev
```

浏览器打开 Vite 输出的地址（如 http://localhost:5173 ）。前端把 `/api`
代理到后端，无需额外配置。

### 3. 灌入示例数据

后端运行时，另开一个终端：

```bash
cd backend
source .venv/bin/activate
python -m scripts.seed
# 后端不在 8000 时：API_BASE_URL=http://127.0.0.1:<端口> python -m scripts.seed
```

### 4. 跑测试

```bash
cd backend
source .venv/bin/activate
pytest -q
```

---

## 事件格式

### 写入接口

`POST /api/events`，请求体是一个 JSON 对象，`events` 为事件数组（批量提交，
单批最多 **500 条**，原始请求体上限 **1 MiB**，超出分别返回 413 / 逐条拒收）：

```json
{
  "events": [
    {
      "event_id": "sess-a-e2",
      "session_id": "sess-a",
      "player_id": "p_alpha",
      "event_type": "player_action",
      "occurred_at": "2026-11-10T10:00:05Z",
      "sequence": 2,
      "schema_version": "1.0",
      "payload": { "action_type": "kill" }
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `event_id` | 事件全局唯一 ID，幂等去重的依据 |
| `session_id` | 对局（局次）ID，时间线按它分组 |
| `player_id` | 玩家 ID |
| `event_type` | 事件类型，见下表；不认识的类型会**接收并标记异常**，而不是丢弃 |
| `occurred_at` | 事件发生时间，ISO-8601 且**必须带时区**（如 `Z`、`+08:00`），内部统一转 UTC |
| `sequence` | 局内单调递增的非负整数序号，用于重建与缺口检测 |
| `schema_version` | 数据格式版本，当前只支持 `1.0` |
| `payload` | 事件负载，结构随 `event_type` 而定 |

**schema 1.0 认识的事件类型与 payload 约束：**

| event_type | payload 要求 |
| --- | --- |
| `session_start` | 可选 `mode`、`map`（字符串） |
| `player_action` | 必填 `action_type`（字符串）；其中 `kill/assist/objective/capture/purchase` 计为关键行为 |
| `item_pickup` | 必填 `item_id`（字符串） |
| `position` | 必填 `x`、`y`（数值，不接受布尔值） |
| `match_result` | 必填 `outcome`，取值 `win/loss/draw`；可选 `score` |
| `session_end` | 可选 `reason` |

请求体中出现任何未声明的顶层字段会被拒收（`extra: forbid`），因此客户端无法
通过额外字段塞入自报统计。**所有统计指标只由服务端从原始事件计算，客户端
上报的任何统计结果都不参与计算、也不入库。**

### 逐条响应（坏事件不连累好事件）

每条事件独立验收，响应逐条给出结论，一条坏事件不会让同批的好事件失败：

```json
{
  "accepted": 1,
  "rejected": 2,
  "duplicate": 1,
  "results": [
    { "event_id": "good-1", "accepted": true,  "code": "accepted", "reason": null },
    { "event_id": "bad-1",  "accepted": false, "code": "payload_rejected",
      "reason": "payload.item_id is required for event_type 'item_pickup'" }
  ],
  "session_ids": ["s1"]
}
```

拒收 `code` 取值：

| code | 含义 |
| --- | --- |
| `malformed_event` | 结构不符（缺字段、类型错、含未声明字段） |
| `unsupported_schema_version` | 未知 `schema_version`，**不会被悄悄按当前版本解释** |
| `bad_timestamp` | 时间无法解析或缺少时区 |
| `bad_sequence` | 序号不是非负整数 |
| `payload_rejected` | payload 不满足该事件类型的契约 |
| `duplicate_in_batch` | 同一批里 `event_id` 重复（批内第一条生效） |
| `duplicate_event_id` | 该 `event_id` 已入库，重发被幂等忽略 |
| `batch_limit_exceeded` | 单批超过 500 条 |

整个请求体不是合法 JSON 时返回 `400`；超过 1 MiB 返回 `413`。

---

## 重复、乱序、迟到事件的处理规则

平台**不假设事件按顺序到达**。原始事件只增不改，所有结论都可以从原始事件
重新推导。

### 1. 重复提交（幂等）

- 去重键是 `event_id`，数据库有唯一约束兜底。
- 已入库的 `event_id` 再次提交：返回 `duplicate_event_id`，**不新增、不重复计数**。
- 同一批次内重复：批内第一条生效，其余返回 `duplicate_in_batch`。
- 注意区分两个概念：`event_id` 相同是"同一条事件重发"（幂等忽略）；
  `event_id` 不同但 `sequence` 相同是"重复序号"（两条都保留，时间线标记
  `duplicate_sequence` 异常）。

### 2. 乱序到达

- 入库时记录 `received_at` 和自增入库 ID；重建时间线**不按到达顺序**，
  而是按 `sequence → occurred_at → event_id` 做确定性排序。
- 若事件的到达次序与其在时间线中的次序不一致，标记
  `out_of_order_arrival`（同批次内靠入库 ID 区分先后）。

### 3. 迟到事件

- 规则：对局的**第一个终端事件**（`match_result` 或 `session_end`）到达后，
  才收到的**非终端事件**视为迟到，标记 `late_arrival`。
- 迟到事件**不会被丢弃**：照常进入时间线（按 sequence 归位）、参与完整率
  与计数，只是带上异常标记。终端事件本身不会被标记为迟到。
- 没有任何终端事件的对局（进行中）不存在迟到概念。

### 4. 其他异常

| 异常 | 判定 |
| --- | --- |
| `missing_sequence` | 局内最小到最大序号之间有空洞；缺失序号列表在详情接口的 `metrics.missing_sequences` |
| `duplicate_sequence` | 不同 `event_id` 占用了相同 `sequence`，涉及的行都带标记 |
| `time_regression` | 按时间线顺序遍历时，后一条 `occurred_at` 早于前一条 |
| `unknown_event_type` | `event_type` 不在已知集合中；事件保留并计数，仅做标记 |

---

## 指标怎么算

对局汇总在每次写入后由服务端同步重算，接口返回的数字全部来自原始事件。

| 指标 | 计算方式 |
| --- | --- |
| 对局状态 `status` | 含 `match_result`/`session_end` 为 `completed`，否则 `open` |
| 胜负 `outcome` | 取 `match_result.payload.outcome`（`win/loss/draw`），没有则为 `null` |
| 局时长 `duration_seconds` | 终端事件与 `session_start` 的 `occurred_at` 之差（秒，下限 0）；缺起止事件时退化为最早/最晚事件之差 |
| 关键行为次数 `key_action_count` | `player_action` 中 `action_type ∈ {kill, assist, objective, capture, purchase}` 的条数，并给出按类型的明细 |
| 事件完整率 `completeness_rate` | 不同 `sequence` 数量 ÷（最大序号 − 最小序号 + 1）。有序号空洞即小于 1；完整时为 1.0 |
| 事件总数 `total_events` | 该局保留的全部原始事件数（重复序号、迟到、未知类型都计入） |
| 异常数 | 六类异常分别计数，`anomaly_total` 为其总和 |

### 确定性与版本区分

- `rebuild_session()` 是**纯函数**：输入相同的原始事件 + 相同规则版本，
  输出（含时间线顺序与 `result_hash`）必然相同，与插入顺序、到达时间无关。
- `result_hash` 是对规范化后的原始事件（按 `event_id` 排序、UTC 时间、
  排序键固定的 JSON）与规则版本一起做的 SHA-256。`received_at` 不参与哈希，
  因此重试/送达快慢不会改变结果。
- 规则版本号在 `backend/app/config.py` 的 `RULES_VERSION`，数据格式版本是
  事件里的 `schema_version`（当前 `1.0`，白名单在 `SUPPORTED_SCHEMA_VERSIONS`）。
- 每条汇总按 `(session_id, rules_version)` 唯一存储。**修改规则后调高
  `RULES_VERSION`**：旧汇总保留旧版本号，重算后产生新版本号的记录，
  新旧结果可以区分、对比，而不是被静默覆盖。详情页可手动触发
  `POST /api/sessions/{id}/reprocess` 按当前规则重算。

---

## HTTP API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/events` | 批量提交事件，逐条返回接收/拒收原因 |
| GET | `/api/sessions` | 对局列表，支持 `player_id`、`status`、`outcome`、`date`、`start_date`、`end_date`、`has_anomaly`、分页 |
| GET | `/api/sessions/{id}` | 对局详情：指标、异常分类、重建时间线 |
| GET | `/api/sessions/{id}/raw` | 原始事件，按**实际接收顺序**返回，用于核对乱序/重试/迟到 |
| GET | `/api/players` | 玩家下拉列表 |
| GET | `/api/export/sessions.csv` | 按当前筛选条件导出 CSV（与列表同一套过滤逻辑） |
| POST | `/api/sessions/{id}/reprocess` | 用当前规则版本重新处理一局 |
| GET | `/api/health` | 服务状态、规则版本、支持的 schema 版本 |

日期参数均为 UTC `YYYY-MM-DD`；`date` 按当天过滤，`start_date/end_date`
为包含端点的区间。

---

## 用示例数据验证乱序、重试和坏事件

`backend/scripts/seed.py` 通过 HTTP 接口写入三局数据并打印每步响应，
覆盖全部关键路径：

1. `sess-clean-001`：正常顺序、完整的胜局，无任何异常。
2. `sess-messy-002`：
   - 序号 3 先于序号 2 到达 → `out_of_order_arrival`；
   - 序号 4 的发生时间被回填，早于时间线中前一条 → `time_regression`；
   - 未知类型 `emote_spin` → `unknown_event_type`（保留不丢）；
   - 两条不同事件占用序号 3 → `duplicate_sequence`；
   - 序号 5 缺失 → `missing_sequence`，完整率 = 6/7 ≈ 0.857。
3. `sess-late-003`：先写入终局事件，间隔 1 秒后再补发中途的拾取事件
   → `late_arrival`，事件仍计入且按序号归位。
4. 把第一条事件**重发一遍** → 返回 `duplicate_event_id`，计数不变（幂等）。
5. 一批里混入 6 条坏事件（未知 schema 版本、payload 缺字段、无时区时间、
   负序号、结构残缺、自报统计字段）→ 逐条拒收并给出原因，同批其他事件不受影响。

快速核对：

```bash
# 异常分布
curl -s http://127.0.0.1:8000/api/sessions/sess-messy-002 | python -m json.tool
# 只看有异常的对局
curl -s "http://127.0.0.1:8000/api/sessions?has_anomaly=true"
# 按玩家 + 日期筛选并导出
curl -OJ "http://127.0.0.1:8000/api/export/sessions.csv?player_id=p_beta&date=2026-11-11"
```

也可以在网页上打开 `sess-messy-002`，在"重建时间线"和"原始事件/接收顺序"
两个页签之间对比：前者按序号归位并带异常标记，后者保留真实到达次序。

---

## 设计说明与安全边界

- **不信任客户端统计**：写入模型 `extra: forbid`，除约定的 8 个字段外一律
  拒收；数据库只存原始事件，所有指标在规则引擎中重算。
- **时间处理**：SQLite 不保留时区，所有时间经自定义 `UTCDateTime` 类型
  统一以 naive UTC 存储、读出时补回 UTC，跨时区输入的排序与日期过滤不受
  服务器本地时区影响。
- **请求限制**：1 MiB 请求体上限 + 500 条/批上限，避免大批量写入拖垮服务。
- **版本隔离**：未知 `schema_version` 直接拒收；规则变更通过
  `RULES_VERSION` 与按版本存储的汇总保留可追溯的新旧结果。
- **可重算**：原始事件不可变，任何时刻都能用 `reprocess` 从原始事件完整
  重建一局，`result_hash` 可用于校验两次处理是否一致。

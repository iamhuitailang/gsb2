# secbench · 本地安全事件关联工作台

一个**完全在本机运行**的安全事件关联分析工作台：把身份认证（auth）、反向代理（proxy）、
终端（endpoint）三类设备导出的 JSONL 事件导入本机 SQLite，做可解释的跨来源关联检测，
生成带证据时间线的告警，支持处置流转与结果导出。

- 仅依赖 Python 3.10+ 标准库，**不安装第三方包、不连接任何外部服务、不需要真实账号**
- 数据只落在本机 SQLite 文件（默认 `./secbench_data/secbench.db`）
- 所有样例数据均为合成数据，IP 使用 RFC 5737 文档保留地址，无真实攻击流量

## 目录结构

```
repo/
├── run_server.py            # 启动入口
├── run_tests.py             # 自动化测试入口（48 个用例）
├── secbench/
│   ├── storage.py           # SQLite 存储层、设置、告警/事件查询、清空
│   ├── ingestion.py         # JSONL 解析、校验、规范化、去重、冲突隔离、限额
│   ├── rules.py             # 三类关联检测规则与重评估
│   ├── export.py            # 告警/证据导出（JSON / JSONL）
│   ├── server.py            # 本地 HTTP API（http.server，默认 127.0.0.1:8080）
│   └── static/              # 原生 HTML/CSS/JS 前端，无外部依赖
├── samples/                 # 可直接导入的合成样例
│   ├── sample_auth.jsonl    # 身份认证事件（含撞库序列）
│   ├── sample_proxy.jsonl   # 反向代理事件（含路径探测序列）
│   ├── sample_endpoint.jsonl# 终端事件（含敏感导出）
│   ├── sample_messy.jsonl   # 乱序/重复/冲突/坏行混合样例
│   └── sample_late.jsonl    # 迟到事件样例
└── tests/                   # 自动化测试
```

## 一、启动

需要 Python 3.10 或更高版本（开发验证环境为 3.13）。

```bash
python3 run_server.py
```

看到如下输出后，浏览器打开 <http://127.0.0.1:8080>：

```
secbench 工作台已启动: http://127.0.0.1:8080
数据库文件: /…/secbench_data/secbench.db（仅本机）
```

可选环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SECBENCH_HOST` | `127.0.0.1` | 监听地址（仅本机，勿改为 0.0.0.0） |
| `SECBENCH_PORT` | `8080` | 监听端口 |
| `SECBENCH_DB` | `./secbench_data/secbench.db` | SQLite 文件路径 |

## 二、清理演示数据

两种方式：

1. 页面「① 导入」页底部点击 **清空全部数据**（删除全部事件、告警、批次与处置记录，数据库文件保留）；
2. 命令行直接删除数据库文件后重启：

   ```bash
   rm -rf secbench_data/
   python3 run_server.py
   ```

## 三、导入样例

在「① 导入」页依次选择 `samples/` 下的文件上传，或用命令行：

```bash
for f in samples/sample_auth.jsonl samples/sample_proxy.jsonl samples/sample_endpoint.jsonl; do
  curl -s -F "file=@$f;type=application/x-ndjson" http://127.0.0.1:8080/api/import
done
```

### JSONL 记录格式（每行一条）

```json
{"source": "auth", "event_id": "AUTH-1001", "event_time": "2026-11-18T09:00:05Z",
 "subject": "alice", "src_ip": "203.0.113.45", "action": "login",
 "target": "sso.example.internal", "result": "failure"}
```

必填字段：`source`、`event_id`、`event_time`、`subject`、`src_ip`、`action`、`target`、`result`。

- `source` 仅允许 `auth` / `proxy` / `endpoint`，其他来源记行级错误
- `event_time` 接受 ISO8601（含 `Z`、`+01:00` 偏移或无时区），统一规范化为 UTC `…Z`；
  无时区时间按 UTC 解释；无法解析记行级错误
- 原始行原文完整保留，页面与导出中均可逐条核对

### 导入计数与异常处理

每次导入分别统计 **已接收 / 重复 / 隔离 / 错误 / 总行数**：

- **乱序事件**：按事件时间排序存储，与导入顺序无关
- **重复事件**：相同 `source + event_id` 且内容指纹相同（字段顺序不同也算相同）只计一次；
  重复导入不会重复计数、不会产生重复告警
- **冲突编号**：`source + event_id` 相同但内容不同的记录进入**冲突隔离区**，
  绝不静默覆盖原记录，页面展示隔离原因与原始行
- **坏行**：坏 JSON、无效时间、缺必填字段、未知来源均记**行级错误**，其余行正常入库
- **导入限额**：默认单文件 2 MiB、单次 5000 条，超限**整批拒绝**（HTTP 413），
  已有数据不受影响；限额可在「④ 阈值与限额」页调整
- 每次导入生成独立批次记录，上一次导入结果不会被冒充成本次结果

可导入 `samples/sample_messy.jsonl` 观察：7 行中 1 条重复、2 条隔离、4 条行级错误、0 条接收。

## 四、检测规则

规则阈值与时间窗口均可在「④ 阈值与限额」页配置，保存后自动全量重评估。
**所有规则都要求跨事件的时间关联，单条普通失败记录不会告警。**

### R1_BRUTE_FORCE（高）多账号认证失败后成功登录

同一 `src_ip` 在失败统计窗口（默认 600 秒）内，对 **≥ 3 个不同账号** 出现登录失败，
且末次失败到一次成功登录的间隔不超过成功窗口（默认 300 秒）。

- 关联依据：同源地址 + 失败账号去重数 + 失败与成功的时间邻近关系
- 同一账号反复失败但账号数不达标、只有失败没有成功、成功登录距末次失败超时，均不告警

### R2_PROBE_THEN_ACCESS（中）可疑路径探测后同源相关访问或异常

同一 `src_ip` 先出现路径探测（`path_scan`、针对 `/.git`、`/wp-admin`、`/phpmyadmin`、
`/actuator` 等的 404），随后在窗口（默认 600 秒）内又访问敏感路径
（`/admin`、`/config`、`/backup`、`/.env`、`/api/internal`）或出现 5xx 响应。

- 关联依据：同源地址 + 探测与后续访问的先后时间关系
- 单独的 404 不告警

### R3_CROSS_IP_EXPORT（高）登录后跨来源地址敏感数据导出

同一账号成功登录后，在窗口（默认 900 秒）内从**与登录端不同的 `src_ip`** 执行
`bulk_export` / `data_export` / `file_download`。

- 关联依据：同主体 + 登录与导出的时间邻近关系 + 来源地址不一致
- 同源地址导出、导出早于登录、超出窗口均不告警

时间窗口边界均为**闭区间**（恰好落在边界上的事件计入），对应边界测试见 `tests/test_rules.py`。

### 重评估与迟到事件

每次导入或改阈值后全量重评估：

- 新证据（含时间更早的迟到事件）自动并入既有告警并按事件时间补齐时间线，
  **告警 ID 不变、处置状态与说明不被覆盖、原始事件不可变**
- 阈值变化导致规则不再命中时，历史告警标记为**已失效**（默认列表隐藏，
  勾选「显示已失效告警」可查），记录保留用于审计；规则重新命中时同 ID 复活
- 重复导入相同数据不会生成重复告警

## 五、预期告警（导入三份基础样例后）

| 告警 | 规则 | 严重度 | 涉及来源/主体 | 证据 |
| --- | --- | --- | --- | --- |
| #1 | R1_BRUTE_FORCE | 高 | auth；alice/bob/carol；203.0.113.45 | AUTH-1001~1005（4 失败 + 1 成功） |
| #2 | R2_PROBE_THEN_ACCESS | 中 | proxy；anonymous；198.51.100.77 | PX-2001~2004（探测 → /admin、5xx） |
| #3 | R3_CROSS_IP_EXPORT | 高 | auth+endpoint；alice | AUTH-1020 + EP-3001/3002（跨 2 个地址导出） |

随后导入 `samples/sample_late.jsonl`：迟到事件 `EP-3003` 按时间位置插入 #3 的证据时间线，
告警不新增、不重复。

每个告警页面展示：严重度、规则、涉及来源/主体/目标、人类可读的关联依据（含实际阈值与时间）、
按事件时间升序的证据时间线；每条证据可展开查看**原始事件 JSON**。

## 六、处置与筛选

- 筛选维度：严重度、时间范围、来源、主体、处置状态
- 处置状态：**待处理 open / 已确认 confirmed / 误报 false_positive**，可填写处置说明；
  重评估不会抹掉处置状态
- 导出：在当前筛选条件下导出 JSON 或 JSONL，内容包含
  - 引擎规则版本 `engine_rule_version` 与每条告警的 `rule_version`
  - 告警判断（`rationale` 关联依据）、严重度、处置状态与说明
  - 每条证据的事件编号 `event_id`、时间、角色、规范化字段与 `raw_record` 原始事件内容
- 导出的证据与页面时间线使用同一事件编号，可逐条核对

```bash
# 导出当前全部告警（JSON）
curl -s "http://127.0.0.1:8080/api/export?format=json" -o alerts.json
# 只导出已确认告警（JSONL，每行一条告警）
curl -s "http://127.0.0.1:8080/api/export?format=jsonl&status=confirmed" -o alerts.jsonl
```

## 七、自动化测试

```bash
python3 run_tests.py
```

48 个用例，全部仅用标准库 `unittest`，每个用例使用独立临时数据库。覆盖：

- 乱序事件、完全重复、字段顺序不同的同内容重复
- 冲突编号隔离且不覆盖、冲突记录再次导入计重复
- 坏 JSON / 无效时间 / 缺字段 / 未知来源的行级错误
- 文件大小与事件数限额整批拒绝、失败导入不污染既有数据
- 三类规则的命中与不命中场景、**时间窗口边界（闭区间）**、阈值可配置
- **迟到事件**补齐时间线、重复导入不产生重复告警
- **处置状态与说明在重评估后保留**、告警失效/复活生命周期
- 筛选、导出内容（规则版本/判断/证据编号/原始事件）、HTTP API 全链路冒烟

## 八、本地数据与安全说明

- 服务默认只绑定 `127.0.0.1`，不监听外部网卡，无任何外联请求
- 数据库、导入文件均在本机；删除 `secbench_data/` 即可彻底清除
- 无认证/账号体系，设计前提是单用户本机使用，请勿暴露到网络

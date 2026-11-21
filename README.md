# 转发地址安全分析台

一个完全本地运行的安全分析台，用来复盘反向代理传来的客户端地址：逐跳检查转发链里
**哪些地址能信**、**哪些输入可能被伪造**，并在依据不足时明确显示「无法判定」，
而不是挑一个看起来合理的结果继续。

- 后端：Python 3.10+ / FastAPI / SQLite
- 前端：Vue 3 + Vite
- 运行时**不解析域名、不向任何外部地址发起请求**，只处理页面提交的样例数据

---

## 1. 启动

### 后端

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 -m app            # 监听 127.0.0.1:8000
```

API 文档：<http://127.0.0.1:8000/docs>

数据库默认写入 `backend/data/forward_audit.sqlite3`（已被 `.gitignore` 忽略）。
可用环境变量 `FORWARD_AUDIT_DB` 指定其它位置，`FORWARD_AUDIT_PORT` 改端口。

### 前端（开发模式）

```bash
cd frontend
npm install
npm run dev               # http://127.0.0.1:5173，/api 已代理到 8000
```

### 单端口运行（生产式）

```bash
cd frontend && npm install && npm run build     # 产物在 frontend/dist
cd ../backend && python3 -m app                 # 由 FastAPI 直接托管 dist
# 打开 http://127.0.0.1:8000
```

### 测试

```bash
cd backend
python3 -m pytest
```

---

## 2. 页面功能

| 标签页 | 作用 |
| --- | --- |
| 发起判定 | 填写连接对端地址、转发字段、选择信任配置，提交后逐跳展示判定 |
| 演示请求 | 自带 10 组可直接运行的样例，可「运行」或「载入到判定页」修改 |
| 信任配置 | 管理多个 IPv4/IPv6 网段与单个代理地址，逐字段设置是否启用及链路长度上限 |
| 记录与导出 | 按时间 / 结论筛选历史记录，查看当时输入与配置快照，导出 JSON / CSV |

---

## 3. 判定规则（为什么这样判定）

1. **信任起点只有连接对端。** 只有连接对端（服务器实际建立连接的那一方）命中信任配置时，
   才会去读转发字段。请求头里出现 `10.x`、`127.0.0.1` 等看起来像内网代理的地址，
   **不会**因此获得信任。
2. **对端不可信 ⇒ 转发信息一律不用。** 最终客户端就是连接对端；所有转发字段逐条标注
   「已忽略（对端不可信）」，并给出理由。
3. **可信对端 + 列表字段 ⇒ 自右向左回溯。** 最右侧是离服务器最近的一跳；连续命中可信
   配置的地址标记为「可信代理」并继续向左；遇到的第一个不在可信配置中的地址就是客户端。
   已确定客户端左侧的地址属于上游声明，在当前信任边界内无法验证，标记为「未采用」。
4. **两种字段同时出现时做交叉核对。** `X-Forwarded-For` 与 `Forwarded` 都会被解析成
   规范化跳序：
   - 跳序完全相同 → 「两边一致」，结论由两者共同支撑；
   - 地址相同但顺序不同 → **顺序冲突**，无法判断哪边真实，**不采用任何一侧**；
   - 跳数或地址不同 → **无法对应**，同样不采用任何一侧。
5. **以下情况一律判为「无法判定」并说明依据不足**，不自动挑选一个结果继续：
   - 同一字段重复出现（不做拼接）；
   - 链中存在空项 / `unknown` / 格式错误的项；
   - 链中出现重复地址；
   - 跳数超过配置的链路长度上限；
   - 链中所有地址都是可信代理（原始客户端缺失，链条不完整）；
   - 单值字段（`X-Real-IP` / `CF-Connecting-IP`）与链式字段结论矛盾。
6. **解析严格、不猜。** IPv4 / IPv6 都支持，包括带端口、方括号、引号、多项、空项、
   `unknown` 和格式错误；IPv4 映射 IPv6（`::ffff:1.2.3.4`）会规范化为 IPv4 并注明。
   无法可靠解析时显示「无法判定」，不做静默丢弃或改写。

### 信任配置校验

配置不合法时**不会**按默认值继续，界面会逐条列出错误：

- 非法 IP / CIDR、带端口或方括号的条目、含区域标识（`%eth0`）的地址；
- CIDR 主机位不为零（例如 `10.0.0.5/8`）——提示正确写法，但**不改写**；
- `0.0.0.0/0`、`::/0`（等于信任所有来源）、组播、未指定地址；
- 重复条目（冲突）、条目互相包含（冗余，给出警告但不阻止保存）；
- 单值字段的上限不是 1、所有字段都被禁用、没有任何可信条目。

---

## 4. 演示样例与预期结论

`backend/app/demos.py` 内置以下样例（前端「演示请求」页可直接运行）：

| slug | 场景 | 预期状态 | 预期结论 | 预期最终地址 |
| --- | --- | --- | --- | --- |
| `trusted-chain` | 可信代理链还原 | 已判定 | `trusted_chain` 可信代理链还原成功 | `203.0.113.42` |
| `spoofed-header` | 伪造转发头 | 已判定 | `untrusted_peer` 对端不可信，转发信息被忽略 | `198.51.100.77` |
| `ipv4-ipv6-mixed` | IPv4/IPv6 混合 | 已判定 | `trusted_chain` 可信代理链还原成功 | `2001:db9:abcd::7` |
| `field-conflict` | 两种字段顺序冲突 | 无法判定 | `order_conflict` 两种字段顺序冲突 | 无 |
| `malformed-input` | 格式错误（空项/unknown/非法IP） | 无法判定 | `malformed_hop` 链中存在无法解析的地址 | 无 |
| `duplicate-header` | 同一字段重复出现 | 无法判定 | `duplicate_field` 同一转发字段重复出现 | 无 |
| `incomplete-chain` | 链条不完整（全是代理） | 无法判定 | `chain_incomplete` 链路未闭合 | 无 |
| `trusted-forwarded-consistent` | Forwarded 与 XFF 一致 | 已判定 | `trusted_chain` 可信代理链还原成功 | `203.0.113.42` |
| `single-field-conflict` | 单值字段与链路矛盾 | 无法判定 | `single_conflict` 单值字段与链路结果不一致 | 无 |
| `hop-limit` | 超过链路长度上限 | 无法判定 | `hop_limit_exceeded` 链长超出配置上限 | 无 |

每个样例都自带信任配置，不依赖你保存过的任何配置。运行后界面会显示「与预期一致 /
不一致」，后端测试 `test_every_demo_matches_its_expectation` 也会逐个校验。

### 清理演示数据

- 前端「演示请求」页 → **清理演示数据**；
- 或调用 `POST /api/demo-data/reset`；
- 该操作只删除 `source LIKE 'demo%'` 的分析记录，不影响手动提交的记录与已保存配置。
- 彻底清空：停止后端后删除 `backend/data/forward_audit.sqlite3`。

---

## 5. API 速览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与计数 |
| GET | `/api/demos` | 演示列表（含预期结论） |
| POST | `/api/demos/{slug}/run` | 运行演示（可选保存记录） |
| GET/POST | `/api/configs` | 列出 / 保存信任配置 |
| POST | `/api/configs/validate` | 只校验，不保存 |
| POST | `/api/analyze` | 执行判定（默认保存记录） |
| GET | `/api/analyses` | 按 `status` / `outcome` / `source` / `date_from` / `date_to` 筛选 |
| GET | `/api/export?format=json\|csv` | 导出记录（不含本机路径） |
| POST | `/api/demo-data/reset` | 清理演示记录 |

请求体使用字段名 `x_forwarded_for` / `forwarded` / `x_real_ip` / `cf_connecting_ip`，
每个字段的值可以是字符串（一次出现）或字符串数组（多次出现，如重复请求头）。

---

## 6. 记录与导出

- 每次判定保存：连接对端、请求字段原文、**当时的信任配置快照**、完整判定结果、
  结论与最终地址；
- 支持按时间范围、状态、结论类型、来源筛选；
- 导出 JSON / CSV 只包含上述数据，不含数据库路径、本机路径或用户名；
  后端导出前会再做一次路径脱敏。

---

## 7. 目录结构

```
backend/
  app/
    addressing.py   地址解析（IPv4/IPv6、端口、方括号、引号、Forwarded 语法）
    config.py       信任配置校验与规范化
    analyzer.py     纯函数式逐跳判定（无网络 I/O）
    demos.py        内置演示样例
    headers.py      请求头名归一化
    storage.py      SQLite 持久化
    main.py         FastAPI 路由与导出脱敏
  tests/            解析、配置、判定、API 测试
frontend/
  src/App.vue       标签页与共享表单状态
  src/components/   判定 / 演示 / 配置 / 记录四个视图
```

---

## 8. 边界说明

- 本工具只做**样例数据复盘**，不是线上 WAF，也不替代真实代理的访问控制；
- 不发起任何外部请求，不解析主机名，不使用真实账号或代理；
- 判定结果反映的是「在你提交的信任配置下」，因此配置快照会随记录一起保存；
- 记录导出后脱离本机，故导出内容不含本机文件路径。

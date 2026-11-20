# 本地安全策略管理台

一个只在本机运行的安全策略管理台：维护者可以查看、编辑策略包，导入外部提供的
JSON 策略包时**先预览再确认**。重点是让不可信配置在进入系统时**可审查、可拒绝**，
并且任何失败都不影响当前生效的规则。

* 后端：Python 3.11+ / FastAPI / SQLite（单文件）
* 前端：Vue 3（全局构建版，离线加载；`npm install` 会把运行时复制到 `web/vendor`）
* 不连接任何真实服务，不需要账号，没有外部依赖的运行时资源

---

## 1. 快速开始

```bash
# 1) 安装 Python 依赖（建议使用虚拟环境）
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2) 准备 Vue 3 运行时（只需一次；页面通过 /vendor/vue.global.prod.js 离线加载）
npm install          # 会把 node_modules 里的 Vue 复制到 web/vendor

# 3) 初始化数据库并激活基线样例（生成 v1）
./scripts/init.sh --baseline

# 4) 启动服务（仅绑定 127.0.0.1:8000）
./scripts/start.sh
# 浏览器打开 http://127.0.0.1:8000
```

> 如果这一步无法联网，也可以手动把任意一份 Vue 3.5 的
> `vue.global.prod.js` 放到 `web/vendor/`，效果相同；页面不会从 CDN 加载任何东西。

不用脚本也可以：

```bash
python3 -m app.cli init --baseline     # 初始化 + 激活基线
python3 -m app.cli serve --port 8000   # 启动
```

数据库默认位于 `data/policy.db`，可用 `--db` 或环境变量 `POLICY_DB_PATH` 指定。
删除该文件即可完全重置；重新执行 `init --baseline` 可从零再来。

### 只想重置、不激活基线

```bash
rm -f data/policy.db
python3 -m app.cli init
```

---

## 2. 验证方法

### 自动化测试

```bash
./scripts/test.sh            # 等价于 python3 -m pytest
python3 -m pytest -q tests/test_strict_json.py   # 只跑解析层
```

测试覆盖：

| 文件 | 关注点 |
| --- | --- |
| `tests/test_strict_json.py` | 重复字段名、未知字面量（NaN/Infinity）、嵌套深度、节点数、体积上限、BOM、非法 UTF-8、裸控制字符、孤立代理字符 |
| `tests/test_validation.py` | 未知字段、类型不符、必填缺失、版本不支持、CIDR/端口语义、规则 id 冲突、同优先级动作矛盾、警告类问题、规范化与摘要稳定性、差异计算 |
| `tests/test_api.py` | 预览不改状态、确认摘要、来源说明、审计写入、拒绝理由定位、并发 generation 冲突、写入中断回滚、整包原子切换、版本恢复与恢复审计、样例可用性、路径穿越防护 |

### 手工演练（页面内也能看到建议顺序）

1. **预览不生效**：在「样例库」点「基线策略包 → 立即预览」，看到差异和
   `预览 · 未生效` 标记；此时刷新页面或在「历史与恢复」里确认没有任何版本。
2. **成功应用**：填来源说明，点「确认并正式应用」，得到 v1，历史里出现
   `导入应用 / 已生效` 审计记录。
3. **查看差异**：载入「变更后的策略包」并预览，能看到新增 `allow-ops-ssh`、
   删除 `deny-admin-from-office`、修改 `allow-https-egress`，确认后成为 v2。
4. **拒绝异常输入**：依次预览 `10`～`17` 号异常样例。每条都会给出错误码与
   JSON 路径（如 `$.rules[0].action`、`$.rules[1].destination_ports[0]`），
   且当前生效版本保持不变。
5. **恢复历史版本**：在「历史与恢复」里对 v1 点「预览恢复」，确认差异后填写
   来源说明并恢复。系统会生成 **新版本 v3**（`source_kind=restore`），并写一条
   `版本恢复 / 已生效` 审计记录。
6. **并发保护**：打开两个页面，都先预览，然后在 A 页应用，再在 B 页应用。
   B 页会收到 `stale_generation`，当前生效版本不受影响。

命令行校验单份文件：

```bash
python3 -m app.cli validate samples/13-reject-conflict.json
```

---

## 3. 设计要点

### 3.1 预览与正式生效严格分离

* `POST /api/import/preview`：**纯只读**。校验、规范化、计算与当前生效版本的差异，
  返回 `digest`（规范化策略包的 SHA-256）与 `base_generation`，不写库。
* `POST /api/import/apply`：必须携带预览返回的 `confirm_digest` 和 `base_generation`。
  服务端**重新解析、重新校验**提交内容，并要求摘要与确认值完全一致——内容在预览
  后被改过一个字节就会被拒绝（`confirmation_mismatch`）。浏览器端的校验只用于
  提示，不参与信任决策。
* 前端在编辑器内容变化后会把旧预览标记为过期并禁用「确认并正式应用」。

### 3.2 输入校验（全部在服务端）

**解析层**（`app/strict_json.py`，自研递归下降解析器，不使用 `json.loads`）：

* 重复字段名 → `duplicate_key`（带路径与行列号），绝不"后者覆盖前者"；
* 未知/非法字面量：`NaN`、`Infinity`、前导零、尾随内容；
* 嵌套深度 > 8、节点数 > 25 000；
* 文档 > 512 KiB、单字符串 > 2 KiB、字段名 > 128 B；
* UTF-8 BOM、非法编码、字符串内裸控制字符、孤立代理字符。

**结构层**（`app/models.py`）：顶层、策略包、规则三处都做未知字段检查；类型用
`int`（排除 `bool`）、`str`、`bool`、`list` 严格判定；缺失必填字段、超长、超量
列表、非小写协议名、重复协议等都逐项报错。

**语义层**：

* `schema_version` 不在支持列表 → `unsupported_schema_version`；
* CIDR 必须主机位为 0、不得重复；重叠仅告警；
* 端口区间合法且互不重叠；ICMP 不允许端口；无 tcp/udp 时不允许端口；
* 规则 `id` 冲突 → `duplicate_rule_id`，消息里指出与哪一条冲突；
* 同优先级、条件重叠但动作相反 → `conflicting_rules`（指到后一条的路径）；
* 完全相同的规则 → `redundant_rule`（警告）；被更高优先级同动作规则覆盖 → 警告。

所有问题都带 `code` / `severity` / `path` / `message`，结构性错误还带 `line` /
`column`。

### 3.3 整包原子应用

SQLite 单事务（`BEGIN IMMEDIATE`）内完成三件事：

1. 校验 `base_generation` 仍等于当前 generation，否则 `409 stale_generation`；
2. 写入完整的新版本快照 + 审计记录；
3. 更新 `active_state` 指针（`generation + 1`）。

任一步失败整体回滚，`active_state` 与旧版本完全不受影响。SQLite 使用 WAL +
`synchronous=FULL`，写入是整页提交的。`tests/test_api.py` 用 monkeypatch 模拟
"写入中途抛错"来验证回滚。

### 3.4 审计与版本恢复

* `policy_versions`：每个生效版本一份完整快照（规范化 JSON + 摘要）。
* `audit_log`：`apply` / `restore` 的成功与失败都记录时间、来源说明、结果、
  版本号、错误码、详情（详情超 16 KiB 会截断并注明，避免审计表被撑爆）。
* 预览是只读检查，不写审计。
* 恢复同样走"预览 → 确认摘要 → 原子切换"，生成**新版本**而不篡改历史，
  审计里记录 `restored_from_version_id`。

### 3.5 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 当前生效版本、generation、规则数 |
| GET | `/api/history?limit=` | 版本列表 + 审计记录 |
| GET | `/api/versions/{id}` | 单个版本（含与当前版本的差异） |
| POST | `/api/import/preview` | 只读校验 + 差异 |
| POST | `/api/import/apply` | 确认后原子应用 |
| GET | `/api/versions/{id}/restore-preview` | 恢复前预览 |
| POST | `/api/versions/{id}/restore` | 确认后原子恢复 |
| GET | `/api/samples`、`/api/samples/{file}` | 内置样例清单与内容 |
| GET | `/api/openapi.json` | 本机 OpenAPI 描述（不加载外网文档 UI） |

请求封装字段：`document_text`（策略包 JSON 文本）、`source_note`、
`base_generation`、`confirm_digest`。封装的未知字段同样会被拒绝。

### 3.6 体积与资源限制

| 限制 | 值 |
| --- | --- |
| HTTP 请求体 | 2 MiB（超限 413） |
| 策略文档 | 512 KiB |
| JSON 嵌套深度 | 8 |
| JSON 节点数 | 60 000 |
| 单字符串 | 2 KiB |
| 规则数 | 200 |
| 每规则 CIDR / 端口 / 协议 | 64 / 64 / 3 |
| 问题列表 | 最多展示 200 条，超出标记 `issues_truncated` |

请求体上限比文档上限宽一倍，是为 JSON 转义（如中文转 `\uXXXX`）留余量；
决定大小的始终是二次解析出的文档本身。

---

## 4. 策略包格式

```jsonc
{
  "schema_version": "1.0",            // 目前仅支持 1.0
  "package": {
    "id": "baseline-office",          // 小写字母/数字开头，可含 . _ -
    "name": "办公网基础策略",
    "description": "可选",
    "revision": 1                     // 可选，正整数
  },
  "default_action": "deny",           // allow | deny
  "rules": [                          // 1..200 条
    {
      "id": "allow-dns",
      "name": "允许内网 DNS 查询",
      "description": "可选",
      "enabled": true,                // 可选，默认 true
      "priority": 10,                 // 1..100000，数值越小越优先
      "action": "allow",              // allow | deny
      "direction": "outbound",        // inbound | outbound
      "protocols": ["udp", "tcp"],    // tcp | udp | icmp，1..3 个
      "source_cidrs": ["10.20.0.0/16"],
      "destination_cidrs": ["10.20.0.53/32"],
      "destination_ports": [53]       // 整数或 "8000-8100"
    }
  ]
}
```

服务端会做规范化（规则按优先级排序、协议/端口/CIDR 排序、端口写法统一），
因此同样的语义总是得到同一个 `digest`。

---

## 5. 内置样例

| 文件 | 类型 | 演示内容 |
| --- | --- | --- |
| `01-valid-baseline.json` | 正常 | 基线，可直接应用 |
| `02-valid-changed.json` | 正常 | 相对基线有增删改，用于演示差异 |
| `10-reject-duplicate-key.json` | 异常 | `action` 重复出现 |
| `11-reject-unknown-field.json` | 异常 | 未知字段 `owner` / `log_level` |
| `12-reject-type-mismatch.json` | 异常 | 类型不符（字符串冒充布尔/数字/数组） |
| `13-reject-conflict.json` | 异常 | 规则 id 重复 + 同优先级动作矛盾 |
| `14-reject-unsupported-version.json` | 异常 | `schema_version = 2.0` |
| `15-reject-deep-nesting.json` | 异常 | 嵌套 12 层 |
| `16-reject-oversize.json` | 异常 | 描述字段约 600 KB，超过体积上限（由服务端按需生成，不占仓库体积） |
| `17-reject-semantic.json` | 异常 | 主机位非零、端口区间倒置、ICMP 带端口 |

`16` 号样例在 `app/samples.py` 中按需生成，因此样例目录里没有这个文件是正常的。
页面上也可以直接「导入本地 JSON」，文件内容同样经过服务端严格校验。

---

## 6. 目录结构

```
app/
  config.py        运行期常量与限制
  strict_json.py   严格 JSON 解析（重复键/深度/体积/编码）
  models.py        结构 + 语义校验、规范化、摘要、差异
  db.py            SQLite 存储与单事务原子切换
  service.py       预览/应用/恢复/审计编排
  samples.py       内置样例白名单读取
  main.py          FastAPI 应用与路由
  cli.py           init / serve / validate / samples
web/               Vue 3 页面（index.html、app.js、styles.css、vendor/vue）
samples/           正常与异常样例
tests/             自动化测试
scripts/           init.sh、start.sh、test.sh、make_samples.py
```

## 7. 已知边界

* 单机单进程部署，并发控制依赖 SQLite 的 `BEGIN IMMEDIATE` 与 generation 校验，
  不适用于多机共享数据库的场景。
* 没有账号体系（按需求只在本机运行）；如需在共享机器上使用，请在前面加一层
  反向代理认证。
* 策略语义检查覆盖"同优先级条件重叠且动作相反"等常见矛盾，非形式化求解器。

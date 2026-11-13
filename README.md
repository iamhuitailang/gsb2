# 本地接口联调签名校验工具

一个只在本机运行的接口签名联调工具：Vue 3 页面负责输入与查看，FastAPI 负责签名生成与验签，
SQLite 记录审计事件。**不会调用任何真实业务服务**，演示接口只有 `/api/demo/ping` 与 `/api/demo/echo`。

签名方案：`HMAC-SHA256-V1`，对一份规范化后的请求串计算 HMAC-SHA256。
工具覆盖：

- 页面输入请求方法、路径、查询串、请求体与时间戳，生成并展示签名结果与规范化串；
- 时间窗口校验（过期、超前都拒绝）；
- nonce 一次性校验（全局唯一，重复 nonce 返回 `409 nonce_replayed`）；
- 密钥轮换：旧密钥在宽限期内与新密钥**并行验签**，宽限期结束自动拒绝；
- 明确的规范化规则：空格、字段顺序、编码、空请求体都有一致处理；
- 审计记录只保存掩码后的签名 / nonce 和请求体哈希，服务端日志记录拒绝原因但不含敏感材料；
- 页面内提供一组可直接发送的本地请求样例，并实时展示签名生成结果和审计记录。

---

## 目录结构

```
repo/
├── README.md
├── backend/
│   ├── app/
│   │   ├── canonical.py    # 规范化请求串（客户端与服务端共享的唯一约定）
│   │   ├── config.py       # 本地配置加载与密钥状态（active / grace / retired）
│   │   ├── keytool.py      # 本地密钥 CLI：init / status / rotate / retire-grace
│   │   ├── audit.py        # SQLite nonce 表 + 审计表（原子写入）
│   │   ├── verifier.py     # 校验顺序：头 → 规范化 → 密钥 → 时间 → 签名 → nonce
│   │   ├── samples.py      # 实时生成的一组正常请求样例
│   │   └── main.py         # FastAPI 路由、日志配置、静态页面
│   ├── tests/              # pytest：规范化、验签、重放、轮换、审计遮蔽、API 端到端
│   ├── config.example.json # 配置模板（不含真实密钥）
│   └── requirements.txt
└── frontend/
    ├── src/
    │   ├── App.vue         # 页面：签名与请求 / 请求样例 / 审计记录 / 签名规则
    │   ├── store.js        # 状态与交互
    │   ├── api.js          # 仅访问同源 /api（开发时由 Vite 代理到 127.0.0.1:8000）
    │   └── format.js       # 规范化串与敏感字段展示规则
    └── vite.config.js
```

---

## 快速启动

需要 Python 3.10+ 与 Node.js 18+。以下命令都在 `repo/` 根目录执行。

### 1. 后端

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 生成本地配置和演示密钥（密钥原文只写入 backend/config.local.json，权限 600）
python -m app.keytool init

# 启动本地服务（仅监听 127.0.0.1）
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### 2. 前端（开发模式）

```bash
cd frontend
npm install
npm run dev          # http://127.0.0.1:5173 ，/api 由 Vite 代理到 :8000
```

### 2'. 前端（构建后由后端统一提供）

```bash
cd frontend
npm install
npm run build        # 产物写入 frontend/dist
cd ../backend
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

然后浏览 <http://127.0.0.1:8000/>。后端只在 `frontend/dist/index.html` 存在时返回页面。

### 3. 跑测试

```bash
cd backend
pytest -q
# 或在仓库根目录：
./run-tests.sh
```

---

## 密钥配置

### 配置文件位置

- 默认：`repo/backend/config.local.json`
- 可用环境变量 `SIGN_TOOL_CONFIG=/绝对/路径.json` 覆盖。

**该文件已被 `.gitignore` 排除，不要提交、不要粘贴到页面或日志。**
`keytool init` 会以 `0600` 权限写入；直接打开文件才能看到密钥原文。

```jsonc
{
  "time_window_seconds": 300,       // 允许的请求年龄（秒）
  "future_skew_seconds": 60,        // 允许时间戳超前服务器的时间（秒）
  "nonce_retention_seconds": 900,   // nonce 去重保留时长；必须 >= 前两者之和
  "database_path": "data/audit.sqlite3",
  "keys": [
    {
      "key_id": "demo-local-01",
      "secret": "由 keytool 生成的随机串（至少 16 字符）",
      "status": "active",           // active | grace | retired
      "created_at": "2026-11-13T00:00:00Z",
      "grace_until": null           // 仅 grace 状态必须填写
    }
  ]
}
```

约束（加载时强校验，失败会给出明确错误）：

- 必须**恰好一个** `status: "active"` 的密钥；
- `key_id` 只允许 `A-Z a-z 0-9 . _ -`，长度 ≤ 64；
- `secret` ≥ 16 字符；`grace` 状态必须有 `grace_until`；
- `nonce_retention_seconds >= time_window_seconds + future_skew_seconds`。

### 密钥轮换

```bash
# 生成新密钥并原子写回配置；旧密钥进入宽限期（默认 600 秒）
python -m app.keytool rotate --grace-seconds 600

# 立即结束宽限期，旧密钥立即退役
python -m app.keytool retire-grace

# 查看当前状态（只显示 key_id / 状态 / 截止时间，不显示密钥）
python -m app.keytool status
```

轮换语义：

| 阶段 | 旧密钥 | 新密钥 |
| --- | --- | --- |
| 轮换后至 `grace_until` | `grace`，**仍可验签** | `active`，正常验签 |
| `grace_until` 之后 | 自动按 `retired` 处理，**立即拒绝**（无需重启） | 保持 `active` |

`retired` 的密钥在 HMAC 计算之前就被拒绝，因此旧密钥不会消耗验签算力。
配置在服务启动时加载到内存；`rotate` 重建配置后需要重启服务才能生效
（宽限期的到期判断是按请求时刻实时计算的，无需重启）。

---

## 签名规则

### 规范化请求串

签名对象是下面 8 行文本（**8 行、LF 连接、末尾无换行**）：

```
HMAC-SHA256-V1
METHOD:<大写方法>
PATH:<百分号编码后的路径>
QUERY:<按编码字节排序后的 k=v&k=v>
TIMESTAMP:<Unix 秒>
NONCE:<客户端生成的唯一值>
KEY-ID:<密钥 ID>
BODY-SHA256:<请求体字节的 SHA-256，小写十六进制>
```

```
signature = hex(HMAC-SHA256(key = secret, message = canonical_string))
```

签名随请求头发送：

| 请求头 | 含义 |
| --- | --- |
| `X-Key-Id` | 用哪个密钥验签 |
| `X-Timestamp` | 与规范化串中的时间戳一致，Unix 秒 |
| `X-Nonce` | 8-64 个可见 ASCII 字符，每次请求唯一 |
| `X-Signature` | HMAC-SHA256 十六进制值（64 位，大小写均可） |

### 空格、编码与空请求体

| 情况 | 规则 |
| --- | --- |
| 方法 | 去首尾空白后转大写；内部不允许空白 |
| 路径 | 只接受 URL path；不含 `?`、`#`、协议与主机名。解码后重新百分号编码（保留 `/`，其余非 unreserved 字符大写编码）。`%2F`、无效的 `%` 转义、空路径段、`//`、末尾 `/`（根路径除外）一律拒绝，保证同一路径只有一种写法。服务端以**线上原始**（仍编码的）路径参与规范化，避免二次解码。 |
| 查询串 | 只按 `&` 拆分、百分号解码、再编码，然后按编码后的 `(name, value)` 字节排序。`+` 与 `%20` 等价；`a=` 是合法的空值；完全空的参数段（`a=1&&b=2`）丢弃；重复参数（`a=1&a=2`）全部保留并排序。参数名不能为空。**值里的 `&`、`;`、`=` 必须百分号编码**（裸 `;` 会被拒绝），保证拆分方式唯一。query 字符串本身不做首尾裁剪，值里的空格会参与签名。 |
| 请求体 | **从不解析、不重排、不重编码**。无论是否 JSON，都按发送时的原始 UTF-8 字节计算 SHA-256。JSON 字段顺序、缩进、空格都会改变签名。 |
| 空请求体 | 仍然计算哈希（SHA-256(`""`) = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`），`BODY-SHA256:` 行永远存在。 |
| 时间戳 | 十进制整数秒，不接受毫秒、浮点或空白。 |
| 签名 | 64 位十六进制 HMAC-SHA256，大小写均可；比较使用常量时间比较。 |

规则实现见 `backend/app/canonical.py`，客户端可以用任何语言照此实现。

---

## 校验顺序与拒绝原因

服务端固定顺序执行，每个被拒绝的请求都会写入一条审计记录：

1. 缺少签名头 → `missing_signature`
2. 规范化失败 → `malformed_request`（HTTP 400）
3. 密钥不存在 → `unknown_key_id`
4. 密钥已退役 → `retired_key`
5. `now - timestamp > time_window_seconds` → `timestamp_expired`
6. `timestamp - now > future_skew_seconds` → `timestamp_in_future`
7. 签名格式非法 → `malformed_signature`（HTTP 400）
8. HMAC 不一致 → `signature_mismatch`
9. 签名有效但 nonce 已用过 → `nonce_replayed`（HTTP 409）
10. 请求体超过 64 KiB → `body_too_large`（HTTP 413）

关键设计：

- **先验签、后占 nonce**：未通过签名校验的请求无法消耗他人的 nonce。
- nonce 表以 `nonce_hash` 为主键（**全局唯一**，跨密钥也不允许复用），`nonce` 不落明文，只存 SHA-256；
- nonce 插入与审计写入在同一个 `BEGIN IMMEDIATE` 事务中，并发重放只有一次成功；
- 过期 nonce 采用惰性清理，保留时长大于时间窗口，避免"nonce 已被清理但请求仍可被接受"。

---

## 审计与日志遮蔽

- 审计表只记录：`request_id`、时间、结论、原因枚举、原因详情、方法/路径/查询串、
  `key_id` 与密钥状态、时间戳、`nonce_masked`、`nonce_hash`、`signature_masked`、
  请求体 SHA-256 与字节数、来源。
- **不记录请求体原文，不记录完整签名，不记录 nonce 明文。**
- 查询串中形如 `token / secret / password / auth / credential / signature / api_key / access_key`
  的参数值统一替换为 `***`。
- 服务端日志只输出：`request_id`、结论、拒绝原因枚举、`key_id`、路径。
- API 响应与错误信息不包含密钥；`/api/meta` 与 `/api/samples` 只返回 `key_id` 和状态。

审计可在页面「审计记录」页查看，或：

```bash
curl -s http://127.0.0.1:8000/api/audit?limit=20 | jq
curl -s -o audit-export.json http://127.0.0.1:8000/api/audit/export?limit=200
```

---

## 本地请求样例

页面「请求样例」页会实时生成 5-6 条带签名的样例（时间戳与 nonce 都是新的）：

| 样例 | 关注点 |
| --- | --- |
| `GET 空请求体` | 空 body hash、无 query |
| `GET 带 query（乱序与重复参数）` | 查询串排序与 `+`/`%20` 等价 |
| `POST JSON 请求体` | 请求体字段顺序参与签名 |
| `POST 空请求体` | 空 body 也要签名 |
| `POST 含中文与空串字段` | UTF-8 编码 |
| `轮换宽限期使用旧密钥` | 有 `grace` 密钥时出现，验证新旧并行 |

每条样例可**直接发送**（只发到本机 `/api/demo/*`）、**载入到签名表单**，或复制**规范化串**与 **curl 命令**。
样例中的签名与请求头都会同时出现在页面上，方便对照。

> 同一条样例连续发送两次会被拒绝（`nonce_replayed`），这正是 nonce 校验在工作；
> 点「重新生成」会换新的时间戳与 nonce。

---

## 常用接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/meta` | 密钥 ID、状态、时间参数（无密钥原文） |
| GET | `/api/samples` | 实时签名样例 |
| POST | `/api/sign` | 按给定字段生成签名（不发送） |
| POST | `/api/canonical` | 只返回规范化串，便于对接客户端实现 |
| GET | `/api/audit` | 审计列表（`limit`、`before_id`、`decision`） |
| GET | `/api/audit/export` | 导出审计 JSON |
| GET | `/api/demo/ping` | 演示：验签后返回 pong |
| GET/POST | `/api/demo/echo` | 演示：验签后回显 |
| GET | `/health` | 探活 |

---

## 安全边界

- 服务默认只监听 `127.0.0.1`，**不要**用 `--host 0.0.0.0` 暴露到局域网/公网；
- 本工具是联调工具，不替代生产网关的鉴权、TLS、限流与密钥托管；
- 演示密钥由本机生成，仅用于本地联调；一旦 `config.local.json` 泄露，请立即 `keytool rotate`；
- 页面与日志永远不会显示密钥原文，但**配置文件本身**包含密钥，请依赖文件权限与磁盘加密。

---

## 常见问题

**页面提示"后端未就绪"**：后端没有启动，或 `config.local.json` 未生成。按上面步骤执行
`python -m app.keytool init` 后重启 uvicorn。

**改了 keytool 配置但没生效**：配置在服务启动时加载。轮换后重启 uvicorn；
宽限期到期不需要重启（按请求时间实时判定）。

**同一请求重发被 409**：这是 nonce 防重放生效。重新生成 nonce 和时间戳即可。

**签名总是不匹配**：优先检查请求体是否被客户端"美化"过（JSON 重排、加空格），
以及是否把 query 网编码了两遍。用页面「规范化串」与自己的实现逐行对比最快。

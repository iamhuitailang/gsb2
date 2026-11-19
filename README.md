# 本地源码安全审查工作台

一个完全在本机运行的源码疑似凭据扫描与复核工作台。它帮助开发者在自己的项目里发现新暴露的云访问凭据、私钥片段、授权令牌和数据库连接口令，同时用**稳定的内容身份**、**可过期的复核结论**和**基线对比**，避免被已确认的旧问题反复淹没。

- 没有第三方依赖，只使用 Python 3.8+ 标准库（`sqlite3`、`http.server`、`re`、`hmac`）。
- HTTP 服务只监听 `127.0.0.1`；页面不加载任何外部脚本、字体或图片，不会连接真实账号或外部扫描服务。
- 扫描结果、日志、SQLite 数据库和导出报告中**不包含匹配到的原文**。

---

## 1. 安装与启动

```bash
# 无需安装依赖
cd /path/to/repo
python3 -m workbench --data-dir ./workbench-data --open
```

启动后终端会打印地址（默认 `http://127.0.0.1:8765/`）。常用参数：

| 参数 | 说明 |
| --- | --- |
| `--data-dir PATH` | 工作台数据目录，默认 `./workbench-data`，也可用环境变量 `WORKBENCH_DATA_DIR` |
| `--rules PATH` | 规则文件路径，默认 `<data-dir>/rules.json` |
| `--host / --port` | 监听地址与端口，默认 `127.0.0.1:8765`（也可用 `WORKBENCH_PORT`） |
| `--open` | 启动后自动打开浏览器 |

首次启动会自动创建数据目录、默认规则文件和指纹密钥。

### 使用

1. 在「扫描与结果」页输入或「浏览…」选择本机项目目录，按需填写排除模式和上限，点击「开始扫描」。
2. 扫描在后台线程执行，页面显示进度；完成后可查看发现、未检查的文件、按风险/状态/复核状态/规则/路径筛选。
3. 点击一条发现，填写理由后「接受」或「忽略…」（忽略必须设置天数/到期时间）。
4. 在「基线与对比」页保存基线；在结果页的「基线对比」标签中选择基线比较。
5. 「导出 JSON / CSV」导出当前筛选下的报告（自动附带基线对比，如果当前在对比标签页）。

---

## 2. 扫描边界

扫描器对每个候选文件都执行以下检查，任何一项不满足都不会读取文件内容，并会在「未检查的文件」中写明原因：

| 情况 | 处理 |
| --- | --- |
| 符号链接（文件或目录） | **从不跟随**。指向项目根目录外的链接标记为 `symlink_outside_root`，其余为 `symlink` |
| 二进制文件 | 读取前 8 KiB 检测 NUL 字节和控制字符比例，标记为 `binary` |
| 文件过大 | 超过 `max_file_bytes`（默认 2 MiB）标记为 `too_large`，不读取 |
| 累计上限 / 文件数上限 | `total_size_limit` / `file_limit` |
| 默认忽略目录 | `.git`、`node_modules`、`venv`、`dist`、`build` 等，标记为 `excluded` |
| 无法读取 | `unreadable`，错误信息不含文件内容 |
| 真实路径越界 | 打开前用 `realpath` 再次确认位于项目根目录内，否则 `outside_root` |
| 超长行 | 超过 `max_line_chars`（默认 20000）的部分不扫描，标记为 `line_limit` |

工作台数据目录不能位于被扫描目录内，被扫描目录也不能包含数据目录，否则拒绝启动扫描，避免把本地数据库当作源码扫进来。

---

## 3. 规则配置

规则是 JSON 文件 `<data-dir>/rules.json`，可以在页面「规则配置」中直接编辑，或手改文件后重启。首次启动会从内置默认规则生成。

### 规则字段

```jsonc
{
  "id": "aws-secret-access-key",          // 唯一
  "family": "cloud.aws.secret-access-key",// 稳定命名空间，复核结论按 family 归属
  "name": "AWS Secret Access Key",
  "description": "说明",
  "kind": "line",                         // line | pem_block
  "pattern": "(?i)aws_secret_access_key\\s*[:=]\\s*['\"]?(?P<secret>[A-Za-z0-9/+=]{30,60})",
  "flags": "",                            // i m s x a
  "secret_group": "secret",               // 命名组或序号，决定哪些字符算作凭据原文
  "severity": "critical",                 // low | medium | high | critical
  "priority": 90,                         // 重叠时优先级高者胜出
  "enabled": true,
  "min_length": 30,
  "min_entropy": 3.2,                     // 香农熵下限，过滤占位符/低熵串
  "allowlist": ["(?i)^changeme$"],        // 命中即忽略
  "max_matches_per_line": 10,
  "path_include": ["*.env", "src/**"],    // 可选；为空表示不限
  "path_exclude": ["docs/**"],            // 可选
  "semantic_version": "1"                 // 手动提升可强制作废旧复核
}
```

- `kind: "pem_block"` 需要额外提供 `end_pattern`，匹配到 `-----BEGIN … PRIVATE KEY-----` 后会一直遮蔽到结束行，报告中只显示头部和一个「私钥内容已遮蔽」标记。
- 规则 ID 与 family 不能重复；同一 family 只允许一条规则，避免复核归属歧义。
- 保存前会做完整校验：JSON 语法、未知字段、正则合法性、命名捕获组存在性、数值范围。

### 重叠规则

同一行有多个规则命中且范围重叠时，按 `priority` → 风险等级 → 匹配长度排序，**只保留一个发现**，其余规则的 ID 记录在该发现的 `overlaps` 字段中。页面详情会提示「被更具体的规则覆盖，未重复计数」。

### 规则版本与语义哈希

- **规则版本**（`version`）：任一字段变化都会改变，随扫描结果和报告保存。
- **语义哈希**（`semantic_hash`）：只有当规则**含义**变化时才改变——`family`、`kind`、`pattern`、`flags`、捕获组、`end_pattern`、`min_entropy`、`min_length`、`allowlist`、`semantic_version`。
- 仅修改 `name`、`description`、`severity`、`priority`、`enabled` 属于外观/运营变化，不会作废复核。

保存规则前可使用「检查影响」，它会列出哪些 family 含义变化、仅外观变化、新增或移除。

---

## 4. 身份与复核

### 稳定身份

发现的身份是 `HMAC-SHA256(密钥, "v1" + family + 规范化后的凭据原文)`：

- 与**文件路径和行号无关**，所以移动文件文件、插入/删除行不会产生新发现，也不会被基线对比误报为新增。
- 与**凭据内容**绑定，凭据被替换会产生新身份，旧发现转为「已消失」。
- 密钥保存在 `<data-dir>/fingerprint.key`（权限 0600），不写入数据库，因此泄露报告无法反推凭据原文。

状态含义：

| 状态 | 含义 |
| --- | --- |
| `new` 新增 | 上次扫描同一项目中没有这个身份 |
| `persistent` 持续存在 | 上次扫描已有，本次仍在 |
| `resolved` 已消失 | 上次有、本次文件已检查且不再出现 |
| `unreviewable` 无法复核 | 上次有，但本次对应文件被跳过（二进制、过大、符号链接等），无法确认 |

### 复核结论

- 结论保存在 SQLite 中，键为「凭据指纹 + family + 规则语义哈希」。
- 「接受」不需要到期时间；「忽略」必须设置到期天数或到期时间（1 天到 10 年）。
- 忽略到期后复核状态自动变为「忽略已到期」，重新出现在待处理视图中。
- 规则含义变化后，旧规则的复核记录**保留用于审计**，但新发现显示「需重新复核」，不会错误套用旧结论。
- 每次接受/忽略都会写入 `review_events` 审计表。
- 复核理由必填（上限 2000 字符）。

---

## 5. 基线与对比

- 基于某次已完成扫描保存基线，可选范围：全部当前发现 / 仅已接受 / 仅未接受且未忽略。
- 基线记录其规则版本和规则快照；只能与同一项目目录（真实路径相同）的扫描比较。
- 比较结果分为：
  - **新增**：本次存在、基线没有的身份；
  - **仍存在**；
  - **路径或行号变化（身份稳定）**：身份相同但路径/行号/上下文变化，**不计入新增**；
  - **基线中已消失**：基线有、本次检查过且不再出现；
  - **无法确认**：基线有、本次对应文件未检查（不会误判为已消失）。
- 基线规则版本与本次扫描不同时会给出提示：新增可能来自规则变化而不是新增凭据。

---

## 6. 导出

`GET /api/scans/<id>/report?format=json|csv`（页面按钮同款）导出：

- `ruleset.version` 与完整规则快照；
- 扫描开始/结束时间、统计信息和扫描参数；
- 每条发现：文件、行号、列、规则、风险、状态、复核状态、**遮蔽后的行预览**、匹配长度与熵、内容指纹、规则版本与语义哈希、重叠规则；
- `not_inspected`：所有未检查的文件及机器可读原因（`binary`、`too_large`、`symlink_outside_root` 等）和中文说明；
- `baseline_comparison`：附带基线对比（如指定 `baseline_id`）；
- `redaction.matched_text_included: false` 明确声明不含原文。

CSV 使用同样的字段，并对以 `= + - @` 开头的单元格做防公式注入转义。

---

## 7. 数据保存与迁移

所有状态都在 `--data-dir` 指定的目录：

```
workbench-data/
├── state.db          # 扫描、发现、复核、复核事件、基线（SQLite，WAL）
├── fingerprint.key   # 32 字节 HMAC 密钥，0600
└── rules.json        # 规则
```

- **备份/迁移**：复制整个目录即可；三者必须一起保留，否则指纹无法与历史复核对应。
- **清空历史**：停止服务后删除 `state.db*`（保留 `fingerprint.key` 可继续匹配旧身份）。
- **重置规则**：删除 `rules.json` 后重启会重新生成默认规则。
- `state.db`、规则文件和密钥都不应提交到版本库；仓库的 `.gitignore` 已覆盖数据库与运行产物。

---

## 8. 演示项目与测试

### 演示项目

`demo_project/` 只包含**合成**凭据，不连接任何服务：

- `src/config.py`：AWS key id + secret、与更具体规则重叠的 GitHub token、低熵与占位符反例；
- `src/db.py`：带内嵌口令的 PostgreSQL 连接串 + `changeme` 占位符；
- `src/http_client.js`：`Authorization: Bearer …`；
- `demo_certs/demo-key.txt`：PEM 私钥块（合成内容）；
- `moved/config.py`：与 `src/config.py` 相同的凭据，用于验证文件移动后身份不变；
- `notes/README.txt`：普通文本，用于制造行号偏移。

先准备无法直接提交的演示素材（越界符号链接、超大文件、二进制文件）：

```bash
python3 scripts/make_demo.py            # 创建 links/ assets/ huge/
python3 scripts/make_demo.py --clean    # 清理
```

然后启动工作台，选择 `demo_project/` 目录即可看到发现与「未检查的文件」。

### 运行测试

```bash
python3 -m unittest discover -s tests -v
```

覆盖的场景：

| 测试文件 | 覆盖内容 |
| --- | --- |
| `tests/test_scanner_security.py` | 符号链接越界、内部符号链接、二进制、超大文件、文件数量上限、原文遮蔽、私钥整段遮蔽 |
| `tests/test_rules.py` | 规则校验、重叠规则只报一次、allowlist、熵阈值、规则版本与语义哈希、演示项目命中 |
| `tests/test_identity_reviews.py` | 行号移动 / 文件移动后身份稳定、凭据替换、复核必填理由、忽略到期、规则变化后旧复核不套用、外观变化保留复核、规则影响分析 |
| `tests/test_baseline_export.py` | 基线新增/消失/迁移、跨项目拒绝、未检查文件不算消失、筛选、JSON/CSV 导出不含原文、跳过原因 |
| `tests/test_demo_project.py` | 基于真实演示目录的端到端校验（含生成素材） |
| `tests/test_http.py` | 真实 HTTP 服务：静态页、路径穿越、CSRF 头、Host 限制、完整扫描-复核-导出流程、禁止扫描数据目录 |

---

## 9. 安全设计说明

- **原文生命周期**：匹配原文只存在于扫描线程内存中，用于计算指纹和长度/熵，随后立即丢弃；不进入日志、数据库、页面或导出。
- **预览**：每一行会把**所有**命中范围（包括被重叠规则淘汰的）一起替换为 `[REDACTED]`，防止子串泄露。
- **HTTP 边界**：只接受本机 `Host`；写操作要求 `X-Workbench-Request: 1` 且校验 `Origin`；CSP 禁止外部资源与内联脚本；不提供文件内容下载接口。
- **目录选择器**：只列目录名，不读取文件内容；不跟随符号链接目录。
- **无网络**：代码中没有对外请求；扫描完全基于本地文件系统。

## 10. 已知限制

- 规则是正则 + 熵的启发式检测，不能替代正式的凭据轮换流程；发现「已消失」不代表凭据已失效。
- 身份基于内容：同一凭据出现在多个文件时会共享同一指纹，复核结论对所有这些位置生效。
- 超长单行只扫描前 `max_line_chars` 个字符。
- 仅在 macOS/Linux 上验证；Windows 下的符号链接行为取决于权限设置。

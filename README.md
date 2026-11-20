# CSP 策略审查工作台（离线版）

一个面向开发人员的**内容安全策略（Content-Security-Policy, CSP）发布前审查工具**：
在浏览器本地完成策略的编辑、检查、资源覆盖分析、样例请求验证与多策略比较。

- **完全离线、零第三方依赖**：仅使用 Node.js 内置模块与浏览器原生 ES Module，不安装任何 npm 包，不连接任何外部服务。
- **不发起网络请求**：用户输入的地址只做字符串级 URL 解析与来源匹配，工具本身绝不访问这些地址。
- **不执行导入内容**：导入的策略文本只作为数据解析；任何解析失败都按“拒绝”处理，绝不会成为放行资源的理由。
- 浏览器端与 Node 端（CLI / HTTP API / 自动化测试）**共用同一套核心逻辑**（`src/core/`），分析结果保持一致。

## 目录结构

```
.
├── server.mjs               # 本地静态服务 + JSON API（仅监听 127.0.0.1）
├── package.json             # 零依赖，仅声明脚本与 Node 版本要求
├── scripts/
│   ├── cli.mjs              # 命令行：demo / lint / evaluate / compare
│   └── audit-offline.mjs    # 离线审计：检查源码是否出现白名单外的外部 URL
├── src/
│   ├── core/                # 与运行环境无关的核心逻辑（浏览器/Node 共用）
│   │   ├── directives.js    # 指令目录、回退链、拼写建议
│   │   ├── sources.js       # 源表达式解析模型与 URL 匹配引擎
│   │   ├── parser.js        # 容错解析器（精确定位行列、多策略头）
│   │   ├── linter.js        # 语义检查（过宽来源、危险组合、模式差异等）
│   │   ├── coverage.js      # 逐资源类型覆盖与优先级分析
│   │   ├── evaluator.js     # 样例请求判定（含重定向、内联、strict-dynamic）
│   │   ├── compare.js       # 顺序无关的策略差异比较
│   │   └── index.js         # 统一导出
│   ├── data/
│   │   └── demo-policies.js # 6 条演示策略 + 10 个演示样例请求
│   └── web/
│       └── storage.js       # 浏览器 localStorage 封装
├── web/                     # 单页工作台（原生 HTML/CSS/JS，无框架）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test/                    # node:test 自动化测试（84 个用例）
    ├── parser.test.js
    ├── sources.test.js
    ├── linter.test.js
    ├── coverage.test.js
    ├── evaluator.test.js
    ├── compare.test.js
    ├── demo.test.js
    └── server.test.js       # 启动真实本地服务的端到端测试
```

## 环境要求

- Node.js **≥ 18**（开发环境为 v24，使用内置 `node:test`、`node:http`、`fetch`）。
- 现代浏览器（Chrome / Edge / Firefox / Safari 的近两年版本）。
- 无需 `npm install`，没有任何外部依赖。

## 启动（网页工作台）

```bash
npm start
# 或
node server.mjs
```

看到以下输出后，用浏览器打开 **http://127.0.0.1:5179/** ：

```
CSP 审查工作台已启动（纯本地，无外部连接）
  地址:   http://127.0.0.1:5179/
```

可通过环境变量更换端口：`PORT=8080 node server.mjs`。
服务只绑定回环地址 `127.0.0.1`，局域网与外部网络无法访问；响应自带严格 CSP 头（`default-src 'none'` 等）。

也可以不启动服务、直接用浏览器打开 `web/index.html`（file:// 协议）使用，核心模块均为相对路径的原生 ESM；推荐使用本地服务以获得完整 MIME 与安全响应头。

## 运行测试

```bash
npm test
```

无需联网、无需安装依赖。当前共 **84 个用例**，覆盖：

- 解析：合法策略、未知指令、重复指令、值格式错误、行列定位、多策略头；
- 来源匹配：主机/协议/端口/路径/通配符规则、`'self'`、data/blob 边界；
- 检查器：过宽来源、危险关键字组合、`'none'` 互斥、strict-dynamic、覆盖缺口；
- 覆盖分析：回退链、显式指令优先级、空值指令忽略；
- 评估器：放行/拦截、内联 nonce/哈希、unsafe-inline 降级、strict-dynamic、重定向双检、多策略交集、报告模式、**解析失败默认拒绝**；
- 比较：新增/删除/放宽/收紧、顺序稳定性、模式变化；
- 演示数据与服务器端到端接口。

离线审计（确认源码无白名单外 URL）：

```bash
npm run audit:offline
```

## 命令行用法

```bash
# 列出内置演示策略
node scripts/cli.mjs demo

# 检查一段策略文本（含错误时进程退出码为 1）
node scripts/cli.mjs lint "default-src 'self'; script-src self 'unsafe-inline'"

# 检查文件中的策略
node scripts/cli.mjs lint --file ./policy.txt --mode report-only

# 样例验证（纯本地字符串判断，不访问 URL）
node scripts/cli.mjs evaluate \
  --policy "script-src 'self' https://cdn.example.com" \
  --type script --url https://evil.test/x.js

# 两条策略比较
node scripts/cli.mjs compare "img-src 'self'" "img-src 'self' https://img.test"
```

## HTTP API（可选，供脚本集成）

服务启动后提供以下接口，请求/响应均为 JSON，内部与网页调用同一套核心逻辑：

| 接口 | 作用 |
| --- | --- |
| `POST /api/parse` | 解析策略并返回语法 + 语义问题、规范化结果 |
| `POST /api/coverage` | 返回逐资源类型的回退链与生效来源 |
| `POST /api/evaluate` | 对样例请求给出 allowed / blocked 等判定与命中规则 |
| `POST /api/compare` | 比较两条策略，返回稳定的新增/删除/放宽/收紧差异 |

请求体上限 2MB；静态文件服务对路径穿越做了归一化拦截。

## 网页功能说明（对应需求）

1. **策略管理与编辑**：新建、编辑、删除；按指令查看配置；导入/导出（支持本工具 JSON 与纯文本 CSP）；无效输入实时提示行列位置与修复建议，不静默丢弃；原文与规范化结果分栏同时展示。
2. **检查结果**：重复指令、未知指令、值格式错误、过宽来源、危险关键字组合、报告/强制模式差别；同一规则可同时呈现多个问题，按 error / warning / info 分级。
3. **资源覆盖分析**：对脚本、样式、图片、字体、连接、框架等 12 类资源给出回退链、最终生效指令、生效来源与优先级解释（显式指令 > 回退、nonce/哈希 > unsafe-inline、strict-dynamic 对白名单的影响等）。
4. **样例验证**：选择资源类型、来源地址、是否内联、是否重定向（可填重定向后地址）、nonce/哈希、strict-dynamic 信任传播；给出每策略的判定、命中指令/来源与完整判定轨迹。
5. **策略比较**：并排展示新增、删除、放宽、收紧；基于规范化集合计算，调换指令或来源顺序不会产生无意义差异。
6. **演示数据**：一键载入 6 条策略（安全、宽松、重复、无效、报告模式、多策略头）与 10 个演示样例。

## 数据存储与隐私

- 所有策略仅保存在当前浏览器的 **localStorage**（键名 `csp-workbench.policies.v1`），不写入磁盘其他位置、不上传任何服务器。
- 清除浏览器站点数据即可完全删除。
- 演示地址仅使用保留/演示域（`example.com`、`demo.local`、`.test`、`.invalid`），只参与字符串判断。

## 关键安全语义（本工具的判定约定）

- 解析失败（地址无法解析、指令值非法、`'none'` 与其他值共存等）一律导向**拒绝/无法证明允许**，不会被当成放行理由。
- 多强制策略取交集：资源必须通过**全部**强制策略；报告模式策略只产生上报结论，不影响实际加载。
- 重定向场景下，重定向前与重定向后两个地址都必须通过检查。
- `'strict-dynamic'` 生效时，主机白名单、协议源、`'self'`、`'unsafe-inline'` 在 CSP3 浏览器中被忽略，信任由 nonce/哈希脚本传播。
- 同一指令存在 nonce/哈希时，`'unsafe-inline'` 在 CSP3 浏览器中被忽略（旧浏览器反之，工具会在覆盖分析中注明）。

## 许可证

MIT

# 本地网页资源安全策略分析台

一个完全离线运行的 CSP（Content Security Policy，内容安全策略）教学/审计工具：
录入策略文本和一组页面资源请求，逐条查看每个资源**会不会被允许、被哪条指令、
哪条来源表达式放行或拦截**，并保留可追溯的分析历史。

- 纯 Python 标准库后端 + 原生 HTML/CSS/JS 前端，**零第三方依赖**
- 只监听 `127.0.0.1`，不访问外部网站，不采集或发送任何用户输入
- 所有数据保存在本机 `data/csp-console.json`

## 本地启动

需要 Python 3.9+（开发环境为 3.13）：

```bash
python3 server.py
# 可选参数
python3 server.py --port 8000 --host 127.0.0.1 --data data/csp-console.json
```

启动后浏览器打开 <http://127.0.0.1:8000/> 即可。停止按 `Ctrl+C`。

### 运行自动化测试

```bash
python3 -m unittest discover -s tests -v
```

核心引擎共 35 个测试用例，覆盖解析错误定位、来源匹配、默认规则回退、
随机标记/摘要、`strict-dynamic`、多策略叠加、仅报告模式与历史快照保护。
内置样例本身也带预期结果，页面「④ 本地样例」可一键运行自检，
或命令行执行：

```bash
python3 -c "from csp.samples import run_samples; import json; print(json.dumps(run_samples()['all_pass']))"
```

## 功能与页面

| 页面 | 能力 |
| --- | --- |
| ① 策略管理 | 多份策略的增删改、模式切换（拦截/仅报告）、语法校验、文件导入与文本导出 |
| ② 新建分析 | 录入页面地址、资源类别、资源地址、nonce/摘要/内联原文、发起方与父脚本信任状态，多选策略后运行判定 |
| ③ 分析记录 | 按判定结果、资源类别、策略快照、模式、关键字筛选，导出 CSV/JSON，展开查看逐策略逐来源的判定依据 |
| ④ 本地样例 | 5 组共 27 条固定样例（放行、拦截、默认回退、多策略叠加、仅报告），可重复运行并与预期自动比对 |

### 判定结果如何追溯

每条分析记录都保存：

- 评估时刻的**策略快照**（策略全文 + 模式 + 名称）。之后删除或替换策略，
  历史记录展示的仍是当时那份规则，不会被当前规则悄悄改写；
- 每份策略的命中指令、指令回退链、最终判定与中文原因；
- 每条来源表达式的逐条匹配结论（命中/未命中 + 原因）；
- 仅报告模式下「本来会发生的拦截」也会作为报告记录保留，
  含策略、资源类别、命中原因与时间戳。

## 规则范围（支持的语法）

### 指令

参与资源放行判断的 fetch 类指令：

`default-src`、`script-src`、`script-src-elem`、`script-src-attr`、
`style-src`、`style-src-elem`、`style-src-attr`、`img-src`、`font-src`、
`media-src`、`child-src`、`frame-src`、`connect-src`、`worker-src`、
`manifest-src`、`object-src`。

资源类别回退链（专用指令缺失时逐级回退）：

- 图片：`img-src → default-src`
- 脚本：`script-src-elem → script-src → default-src`
- 样式：`style-src-elem → style-src → default-src`
- 字体：`font-src → default-src`
- 媒体：`media-src → default-src`
- 子页面：`frame-src → child-src → default-src`
- 接口连接：`connect-src → default-src`；Worker：`worker-src → child-src → script-src → default-src`

回退链上任何指令都不存在时，该类资源**不受限**（页面会明确说明，而非隐式放行）。

### 来源表达式

- 关键字：`'self'`、`'none'`、`'unsafe-inline'`、`'unsafe-eval'`、
  `'unsafe-hashes'`、`'wasm-unsafe-eval'`、`'strict-dynamic'`
- 随机标记：`'nonce-<base64>'`，用于内联脚本/样式与带 nonce 的外部脚本元素
- 内容摘要：`'sha256-'`、`'sha384-'`、`'sha512-'`（另识别 `'sha1-'`）；
  内联原文可由本机自动计算 sha256 摘要，也可手填摘要
- 协议来源：如 `https:`、`data:`、`blob:`
- 主机源：`scheme://host:port/path`，支持 `*` 任意主机、`*.example.com` 子域通配、
  `:*` 任意端口与路径前缀匹配

### 关键语义

- 一份策略内来源列表为**或**关系；多份拦截模式策略之间为**与**关系，
  取最严格结果，一类资源的放行不会扩散到另一类资源；
- `'none'` 与其他来源共存时 `'none'` 被忽略（给出警告）；
- 同时存在 nonce/hash 时 `'unsafe-inline'` 被忽略（CSP3 规则，给出警告）；
- `'strict-dynamic'` 仅对脚本生效：主机/协议/`'self'` 来源失效，
  受信任脚本（带正确 nonce/hash）动态发起的加载经信任传播放行。
  因本工具不模拟真实 DOM，传播判定需要在请求中显式标注
  「父脚本受信任」，未标注时按不受信任处理（从严，不猜测）；
- 端口按协议默认端口归一（http=80、https=443 等），
  主机源不写端口时只匹配默认端口；
- `data:`/`blob:` 等无主机 URL 只能被对应协议来源放行，
  `'self'` 与主机源不匹配它们。

### 拦截模式与仅报告模式

- 拦截模式（enforce）：判定为拦截即最终拦截；
- 仅报告模式（report-only）：只记录「本来会发生的拦截」，
  **不改变最终放行结果**。报告随分析记录持久化，不向任何网络地址发送。

## 暂不支持 / 有意不实现的情况

工具对这些写法**不做宽松猜测**，而是给出 warning/error 说明：

1. **非 fetch 类指令不参与资源判定**，保存时逐条提示：
   `base-uri`、`form-action`、`frame-ancestors`、`navigate-to`、`sandbox`、
   `report-to`、`report-uri`、`trusted-types`、`require-trusted-types-for`、
   `upgrade-insecure-requests`、`block-all-mixed-content`
   （例如不会自动把 http 改写成 https，请求需直接给最终地址）；
2. 未知指令名、无法识别的带引号关键字 → 警告，不参与放行；
3. 解析错误（重复指令、空指令、未闭合引号、非法端口、非法 nonce/hash、
   无法识别的来源等）→ **整份策略拒绝入库**，返回行/列/片段/原因，
   绝不把问题规则悄悄当成空策略；
4. 不模拟 DOM 与 JS 执行：`'unsafe-eval'`、Trusted Types、
   `'strict-dynamic'` 的自动传播链不做动态推演（见上，需人工标注父脚本信任）；
5. 不支持 IPv6 主机源与国际化（punycode）域名的专门校验；
6. CSP3 的 `'strict-dynamic'` 与 `'unsafe-eval'` 交互、
   `'unsafe-hashes'` 放行事件处理器等边缘场景不做专门实现，
   相关关键字按「不匹配外部 URL」处理并保留说明；
7. 路径匹配按 CSP 规范的前缀方式实现，不做查询串/片段匹配。

## 目录结构

```
repo/
├── server.py              # 本地 HTTP 服务（http.server，仅 127.0.0.1）
├── csp/
│   ├── parser.py          # 策略文本解析 + 语法/语义校验（带位置）
│   ├── matcher.py         # 来源表达式与 URL 匹配
│   ├── engine.py          # 单/多策略判定、回退链、报告模式
│   ├── storage.py         # 本地 JSON 持久化与策略快照
│   └── samples.py         # 内置样例与预期自检
├── static/                # 前端（原生 HTML/CSS/JS，无外部资源）
├── tests/test_engine.py   # 核心引擎自动化测试
└── data/                  # 运行后生成本地数据文件
```

## 隐私说明

- 服务只绑定回环地址，不配置任何外部上报端点；
- 页面不引用任何 CDN、字体、统计脚本；
- 内联内容的摘要在本机计算（浏览器 Web Crypto 或本地 Python），
  输入内容仅写入本机数据文件，可随时在页面清空或直接删除 `data/` 目录。

# CSP 检查台（本地）

一个只在本机运行的内容安全策略（Content Security Policy）检查工具：贴入策略文本和页面资源清单，判断每项资源是否会被浏览器策略放行，并说明判断依据。纯静态页面，**不连接外网、不需要账号、不把任何输入发送到网络**。

## 启动

方式一（推荐，避免个别浏览器对 `file://` 的限制）：

```bash
cd 本目录
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

方式二：直接用浏览器打开 `index.html`（所有脚本均为本地文件，无网络请求）。

## 使用方法

1. **页面地址**：被检查页面的 URL，用于解析 `'self'`、无协议来源和相对路径资源。
2. **策略**：每行一条 CSP 策略；多条策略同时生效（资源必须被**所有**策略放行才算放行）。
3. **资源清单**：每行一项，格式为：

   ```
   类型 地址|inline [nonce=...] [hash=...]
   ```

   - 类型：`script` / `style` / `img` / `font` / `connect` / `frame` / `object`
   - 地址：完整 URL、相对路径，或 `inline` 表示内联内容
   - `nonce=...` / `hash=sha256-...`：仅用于 `inline`，表示该内联内容携带的随机标记或摘要

4. 点击 **检查**（或先 **加载样例**），查看：
   - **统计**：策略数、放行/阻止/错误数量及按类型汇总
   - **检查结果**：每项资源的结论，以及逐策略的判断依据（用了哪条指令、是否经 `default-src` 回退、匹配了哪个来源表达式、被哪条策略阻止）
   - **策略分析**：重复指令、未知指令、无效来源、`'none'` 并存、`'unsafe-inline'` 被 nonce/哈希压制等问题

内置 6 个本地样例，覆盖：基础放行/阻止、`default-src` 回退、多策略冲突、nonce/哈希内联授权、通配符/端口/路径边界、带格式问题的策略。加载后可随意修改输入重新检查。

## 验证

核心匹配逻辑有独立测试（不依赖浏览器）：

```bash
node tests/csp.test.js
```

应输出 `通过 60 项，失败 0 项`。也可在页面中加载各样例，对照样例描述人工核对结论。

## 检查器覆盖的规则范围

- fetch 指令：`default-src`、`script-src`、`style-src`、`img-src`、`font-src`、`connect-src`、`frame-src`、`object-src`
- `default-src` 回退：未设置类型专属指令时回退，结果中明确标注
- 来源表达式：`'self'`、`'none'`、协议源（`https:`、`data:` 等）、主机源（精确、`*`、`*.example.com`）、显式端口与 `:*`、路径（精确与 `/` 结尾的前缀匹配）
- 协议升级匹配（策略 `http:` 可覆盖 `https:` 资源，`ws:` 可覆盖 `wss:`）；无协议来源跟随页面协议
- 来源边界严格按主机名匹配：`cdn.example.com.evil.com` 不会匹配 `cdn.example.com`，`example.com` 不会匹配 `*.example.com`
- 内联授权：`'unsafe-inline'`、`'nonce-...'`、`'sha256/384/512-...'`；nonce/哈希存在时按 CSP3 忽略 `'unsafe-inline'`
- 多策略取交集，并指出造成阻止的具体策略
- 策略体检：重复指令（仅第一条生效）、重复来源、未知指令、无效来源表达式、空指令、`'none'` 与其他来源并存等
- 已知但不评估的指令（如 `frame-ancestors`、`report-uri`、`worker-src` 等）会提示并跳过

## 无法替代真实浏览器验证的情况

本工具是**静态分析**，以下行为请以真实浏览器为准：

- 不抓取页面、不执行脚本：无法发现运行时动态插入的资源、重定向后的最终地址、`'strict-dynamic'` 的传播效果
- 不计算内容哈希：资源清单中的 `hash=` 需要你自己算好贴入，工具只做字符串比对
- 不模拟 `report-only` 与强制策略的差异、`upgrade-insecure-requests` 的自动改写、`'unsafe-eval'` 对 eval 的影响
- 路径匹配按规范做精确/前缀比较，不处理 `..`、大小写规范化等 URL 归一化边角
- 不评估 `script-src-elem`/`script-src-attr`、`worker-src`、`child-src` 等更细粒度指令的回退链
- 各浏览器对 CSP2/CSP3 的支持存在差异（例如 `'unsafe-inline'` 与 nonce 并存的行为），结论以 CSP3 为准

## 安全说明

页面只通过 `textContent` 渲染用户输入，不使用 `innerHTML`/`eval`，输入的策略和资源文本不会作为网页代码执行。所有逻辑在 `js/csp.js`（纯函数）与 `js/app.js`（界面）中，样例数据在 `js/samples.js`，均不发起网络请求。

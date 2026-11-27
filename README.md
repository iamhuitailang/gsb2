# 不可信富文本预览台(本地)

一个**完全本地运行、零外部依赖、不联网**的安全演示工具:粘贴或导入任意不可信
HTML,查看经过白名单清理后的安全预览,并阅读一份可理解的处理报告——哪些元素、
属性、样式或地址被移除/改写,以及原因。

## 功能一览

- **输入**:文本框粘贴、导入本地 `.html/.htm/.txt` 文件、一键载入内置演示样例、清空
- **白名单清理**:仅保留安全排版标签与属性;事件属性、脚本入口、危险嵌入、不支持的
  标签一律不进入预览
- **地址策略**:协议白名单 + 混淆归一化,拦截 `javascript:`、外站 URL、协议相对地址、
  `data:` 非图片、`blob:`/`file:` 等;被拒链接无法导航,预览不发起任何外部请求
- **隔离预览**:预览位于无令牌 `<iframe sandbox="">` 中,并附带 `default-src 'none'`
  的 CSP,帧内脚本不执行、表单不提交、弹窗/新窗口/顶层导航全部禁用,也无法访问父页面
- **三视图切换**:清理结果预览 / 清理结果源码 / 原始输入(原始输入只作为纯文本呈现)
- **处理报告**:按类别列出移除的元素、属性、CSS 声明、URL 判定与解析容错记录;
  报告只含类别信息与截断地址,**不回显可执行的原始危险标记**
- **统一入口**:粘贴、导入、切换样例都调用同一个 `sanitizeHtml`,安全结果完全一致

## 环境要求

- Node.js **>= 18**(开发与验证使用 Node 24)
- 无需 `npm install`,无任何第三方依赖,无需真实账号或在线服务

## 本地启动

```bash
npm start
# 或指定端口
PORT=8080 npm start
```

然后用浏览器打开提示的地址(默认 <http://127.0.0.1:5173>)。服务器只监听本机
回环地址 `127.0.0.1`,不对外暴露。

## 运行测试

```bash
npm test
```

使用 Node 内置测试运行器(`node:test`),覆盖:

| 测试文件 | 覆盖范围 |
| --- | --- |
| `test/url-policy.test.js` | 协议白名单、大小写/空白/实体/NUL 混淆、data: URI 限定、相对地址、锚点上下文 |
| `test/tokenizer.test.js` | 容错分词、大小写归一、引号形式、重复属性、rawtext、注释/DOCTYPE、畸形标签 |
| `test/parser.test.js` | 片段树构建、void 元素、隐式闭合、交叉嵌套容错、未闭合元素 |
| `test/css-sanitizer.test.js` | 样式属性白名单、`url()`/`expression`/`@import`/脚本协议拦截、自定义属性 |
| `test/sanitizer.test.js` | 端到端清理、事件属性、危险子树、实体绕过、幂等性、报告不含载荷 |
| `test/edge-cases.test.js` | 实体编解码、控制字符/NUL、双层编码、深度嵌套、异常空白、多次清理稳定性 |
| `test/isolation.test.js` | 沙箱令牌、CSP 指令、无 `innerHTML`/`document.write`、端到端隔离不变量 |
| `test/integration.test.js` | 全部演示样例的安全不变量、多入口一致性、幂等性、报告可序列化 |
| `test/server.test.js` | 静态资源、样例 API、路径穿越防护、安全响应头、405/404 |

## 目录结构

```
.
├── package.json            # 零依赖,仅 start/test 两个脚本
├── samples/                # 6 份本地演示样例(覆盖常见风险)
├── public/
│   ├── index.html          # 应用外壳(自带 CSP)
│   └── styles.css
├── src/
│   ├── server.js           # 零依赖本地 HTTP 服务 + 样例 API
│   ├── sanitizer/          # 核心安全库(页面与测试共用同一份代码)
│   │   ├── tokenizer.js    # 容错 HTML 分词状态机
│   │   ├── parser.js       # 片段树构建(隐式闭合/容错)
│   │   ├── entities.js     # 实体编解码
│   │   ├── url-policy.js   # 地址安全策略
│   │   ├── css-sanitizer.js# 内联样式白名单清理
│   │   ├── sanitizer.js    # 白名单清理主入口 + 报告 + 序列化
│   │   └── preview.js      # 隔离预览文档(CSP 壳)
│   └── ui/
│       ├── app.js          # 前端主控(唯一清理入口)
│       └── labels.js       # 报告原因码的中文说明
└── test/                   # node:test 自动化测试
```

## 安全设计要点

### 1. 白名单而非黑名单

- 标签、属性、CSS 属性、URL 协议全部采用**默认拒绝**的白名单制。
- `script/iframe/object/embed/svg/math/canvas/template/noscript/form/...` 属于
  危险元素,**整棵子树移除**(连文本内容一起丢弃),避免脱壳残留。
- 不在白名单的普通未知标签只移除标签本身、保留已清理的子节点(安全脱壳)。
- 所有 `on*` 事件属性、命名空间属性(`xlink:` 等)一律移除。

### 2. 针对绕过的解析期处理

- 标签名/属性名统一小写;属性值与文本在判断前做**一遍**实体解码(与浏览器一致),
  输出时统一重新编码,保证结果规范且幂等。
- URL 判定前剥离控制字符、零宽字符、BOM、软连字符与各类空白,
  使 `java\tscript:`、`&#106;avascript:` 等混淆无法隐藏协议。
- 自研容错分词器/树构建器不依赖浏览器 DOM 做安全判断,畸形标签、交叉嵌套、
  未闭合引号、重复属性等都有确定性的处理与记录。

### 3. 双重隔离

1. `<iframe sandbox="">`:**不带任何令牌**,因此帧内无脚本、无同源访问、
   无表单提交、无弹窗、无顶层/新窗口导航。
2. 帧文档 CSP:`default-src 'none'; img-src data:; style-src 'unsafe-inline';
   form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
   即便沙箱配置被误改,帧内也无法执行脚本或发起外联。

应用外壳自身也带 CSP(`script-src 'self'`,无内联脚本),且报告与原始输入一律
通过 `textContent` 渲染,代码中不存在 `innerHTML`/`document.write`/
`insertAdjacentHTML`。

### 4. 地址策略摘要

| 地址类型 | 结论 |
| --- | --- |
| `http(s)://任意主机` | 拒绝(预览不发起任何外联) |
| `//host` 协议相对、`\` 反斜杠伪装 | 拒绝 |
| `javascript:`/`vbscript:` 等脚本协议(任意混淆) | 拒绝并移除属性 |
| `data:image/(png|jpeg|gif|webp|avif|bmp|x-icon);base64,...` | 仅图片且 base64 时放行 |
| `data:image/svg+xml`、`data:text/html` 等 | 拒绝(SVG/HTML 可携带脚本) |
| `blob:`/`filesystem:`/`file:`/`mailto:`/`tel:`/自定义协议 | 拒绝 |
| 相对路径、根相对路径 | 拒绝(隔离帧无法解析,且防止未来放开 CSP 时外连) |
| 页内锚点 `#fragment`(仅 href) | 放行(不发起请求、不导航出帧) |

## 边界与说明

- 这是一个**安全演示/教学工具**,策略刻意保守:默认不加载任何网络图片,
  仅允许内联 base64 图片;富文本中的外部链接会被移除 `href` 并在报告中说明。
- 自研解析器实现的是 HTML5 片段解析的关键安全子集,而非 100% 浏览器等价;
  所有偏离规范的畸形输入都会被容错处理并计入报告,目标是**确定性安全**而非像素级还原。
- 全部样例与数据均为本地构造,不包含真实网站、在线服务或真实凭据。

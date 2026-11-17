# 供应商报告库（gsb2）

采购系统接收供应商发来的 HTML 报告，本仓库提供一个**本地**报告库：
导入、列表、隔离预览、资源检查。零外部依赖，只用 Node 内置模块。

```bash
npm start          # 启动业务页 / 隔离报告站点 / 第二个本地站点
npm test           # 净化器单测 + 服务端契约 + 真实 Chrome 端到端校验
```

启动后打开 `http://127.0.0.1:4100/`。

## 三个站点

| 站点 | 默认地址 | 作用 |
| --- | --- | --- |
| 业务系统 | `http://127.0.0.1:4100` | 账号信息、报告列表、导入、预览容器 |
| 隔离报告站点 | `http://127.0.0.2:4100` | 只提供报告正文与随报告导入的本地资源 |
| 第二个本地站点 | `http://127.0.0.3:4100` | 记录收到的请求数，用来证明外部资源没被加载 |

三者用不同的**回环地址**而不是不同端口：浏览器把它们视为不同的源，
cookie 与前端存储也按主机隔离。端口被占用时会自动顺延；若环境不允许
绑定 `127.0.0.2/127.0.0.3`，会退回 `127.0.0.1` + 三段相邻端口，此时隔离
仍然成立（端口不同即不同源），只是 cookie 作用域退化为同主机——报告内容
依旧以不透明源运行、脚本全禁，业务 API 也始终拒绝非 same-origin 请求。

## 隔离是怎么保证的

报告内容只有一条渲染路径：`GET /r/<id>/<token>/content`。

- **列表预览**：业务页把这个地址放进 `sandbox=""` 的跨源 iframe。
- **独立预览**：报告站点自己的外壳 `/r/<id>/<token>` 里嵌同一个地址。

两种预览加载的是同一份响应、同一套响应头，因此不存在“列表一套、独立一套”：

```
default-src 'none'; style-src 'unsafe-inline';
img-src <报告源> data:; media-src <报告源>;
script-src 'none'; connect-src 'none'; object-src 'none';
frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none';
frame-ancestors <业务源> <报告源>; sandbox
```

`sandbox`（无参数）让正文以不透明源运行，拿不到业务页的 DOM、cookie 和会话。
报告站点本身没有任何业务接口，只接受 GET，并校验 Host 与不可猜测的 token。

业务 API 额外拒绝跨站来源（`Sec-Fetch-Site` / `Origin`），跨站调用连会话
cookie 都拿不到，且会被记录到 `/api/security`。

## 资源检查与外部资源

导入时即做净化并产出检查结果，保存在 `data/reports/<id>/check.json`：

- 本地随附资源 → 已载入（图片改写为 `/a/<id>/<name>`，本地样式表内联）
- `data:image/*` → 内嵌已载入
- 其他 http(s)、协议相对、任意 scheme → **外部，未载入**
- 报告引用了但没随附 → 本地缺失

外部资源**不会自动加载**：正文里的引用被替换成“外部图片未载入”这类占位说明，
地址只出现在资源检查清单里。作者也可以用
`<meta name="external-resource" content="https://…">` 声明需要的外部资源，
同样只进清单。

## 标题与文件名

导入者提供的标题、文件名按纯文本处理：只去掉控制字符并截断长度，绝不参与
路径拼接；在业务页用 `textContent`、在报告外壳用 HTML 转义展示。

## 样例报告

业务页的“生成样例报告”会创建一份表格报告，包含：

- 表格与文字；
- 一张随报告提供的本地图片 `images/chart.png`；
- 一张指向第二个本地站点的图片；
- 一段模仿“报告内按钮”的脚本：加载时改标题、向业务接口发请求、向第二站点
  发图片信标，点击按钮还会改写结果文字。

预览中应当：能读到表格与本地图片；第二个站点计数保持为 0；脚本完全不运行
（标题不变、按钮无反应）。关闭报告后业务会话继续可用。`npm test` 逐条验证这些。

## 目录

```
src/
  main.js         入口
  app.js          三个 HTTP 服务、端口分配与回退
  config.js       回环地址/端口/源
  sanitize.js     HTML 净化 + 资源分类（纯函数）
  store.js        报告落盘与读取
  security.js     三类站点的响应头与跨站判断
  businessServer.js / businessPage.js / app.css.js   业务站点
  reportServer.js 隔离报告站点（正文 / 外壳 / 本地资源）
  trackerServer.js 第二站点（请求计数）
  session.js      业务会话
  samples.js / png.js 样例报告与本地 PNG 生成
test/
  sanitize.test.mjs  净化器单测
  unit.test.mjs      样例、存储、三站点启动
  e2e.mjs            服务端契约 + 真实 Chrome（CDP，无第三方依赖）
  cdp.mjs            极简 CDP 客户端
```

# 本地 RPA 执行台

一个**仅面向本地系统**的重复录入自动化工具：导入 CSV → 预览确认 → 自动打开本机模拟业务网站逐条录入 → 实时显示进度。
不连接任何真实网站、不使用真实账号，数据全部保存在本地，无需 Docker。

## 技术选型

| 层 | 方案 | 说明 |
| --- | --- | --- |
| 执行台前端 | Vue 3 + Vite | 导入预览、任务管理、SSE 实时进度 |
| 后端 | Node.js + Express | 仅监听 `127.0.0.1` |
| 本地数据库 | SQLite（better-sqlite3，WAL 模式） | 任务、记录、日志，单文件落盘 |
| RPA 自动化 | Playwright（Chromium，可回退系统 Chrome） | 只访问 `http://127.0.0.1:<port>/mock` |
| 模拟业务后台 | Express 静态页面 + 模拟 API + 独立 JSON 存储 | 含表单校验、确认勾选、重复申请 409 |

## 目录结构

```
repo/
├── server/                 # 后端 + RPA 引擎 + 模拟业务网站
│   ├── src/
│   │   ├── index.js        # 服务入口（含重启恢复标记）
│   │   ├── db.js           # SQLite 状态机
│   │   ├── csv.js          # CSV 解析与字段校验
│   │   ├── masking.js      # PII 日志遮蔽
│   │   ├── runner.js       # 任务编排（启动/停止/恢复/SSE）
│   │   ├── sse.js          # 实时事件推送
│   │   ├── mock-store.js   # 模拟业务系统独立存储
│   │   ├── automation/playwright-runner.js  # 浏览器自动化引擎
│   │   ├── routes/         # jobs API / mock API
│   │   └── public/mock-site/index.html      # 模拟业务网站页面
│   ├── scripts/smoke-test.mjs               # 端到端冒烟测试
│   └── data/               # 运行后生成：SQLite、截图、模拟后台 JSON
├── console/                # Vue 3 执行台
└── samples/
    ├── demo-applications.csv                 # 字段完整的演示 CSV（8 条）
    └── demo-applications-with-errors.csv     # 含校验错误的演示文件
```

## 快速开始

```bash
npm install                 # 安装依赖
npm run install:browser     # 安装 Playwright Chromium（也可跳过，自动回退系统 Chrome）

# 方式一：开发模式（两个进程）
npm run dev:server          # 后端 + 模拟网站  http://127.0.0.1:3210
npm run dev:console         # 执行台界面       http://127.0.0.1:5173

# 方式二：构建后单端口托管
npm run build:console
npm start                   # 界面、API、模拟网站同在 http://127.0.0.1:3210
```

打开执行台 → 导入 `samples/demo-applications.csv` → 预览确认 → 开始执行，
可同时在 `http://127.0.0.1:3210/mock/` 观察浏览器自动填表过程（默认有头模式）。

无头模式 / 调整节奏：`HEADLESS=1 STEP_DELAY=0 npm start`。

## 核心流程与状态机

- **导入只预览，不执行**：CSV 解析校验后任务为 `preview`，用户确认变为 `ready`，再手动点击才执行。
- 记录状态：`pending → running → success / failed / skipped / interrupted`。
- 任务状态：`preview → ready → running → completed / interrupted / failed`。
- **停止**：执行完当前一条后中断，剩余记录保持 `pending`，任务标记 `interrupted`。
- **重启恢复**：服务启动时把崩溃前停在 `running` 的任务/记录显式标记为 `interrupted`（而非假装运行中），
  在执行台点击「恢复未完成记录」即可继续。

## 如何保证已完成记录不重复提交（双重幂等）

1. **提交前查重**：RPA 引擎每条记录填表前先查询模拟后台，申请编号已存在则直接标记 `skipped`，
   根本不打开表单提交。
2. **提交时兜底**：模拟后台以申请编号为唯一键，重复提交返回 HTTP 409，引擎同样按 `skipped` 处理。
3. **状态过滤**：恢复执行只选取 `pending / interrupted / failed` 的记录，`success / skipped` 永不重新进入浏览器流程；
   记录认领是单条原子 SQL 事务（`claimNextRecord`），同一条不会被执行两次。

## 隐私字段遮蔽

`server/src/masking.js` 统一处理：手机号（`138****8001`）、姓名、身份证号、邮箱、住址、银行账号
在写入日志前按字段遮蔽，另有正则兜底遮蔽异常堆栈里可能出现的手机号/身份证/邮箱。
明文仅存在于本地 SQLite 与模拟后台 JSON，**任何日志行都不含完整个人信息**。

## 演示 CSV 字段

申请编号、业务类型、申请人姓名、手机号、身份证号、邮箱、申请金额、所在城市、详细住址、银行账号、申请说明。
校验规则：必填、手机号/身份证/邮箱格式、金额为正、业务类型枚举、文件内申请编号唯一；
不合规的行进「校验错误」清单并被排除，不影响其余记录导入。

## 冒烟测试

```bash
npm run smoke   # 独立测试库 + 无头浏览器，26 项断言
```

覆盖：CSV 校验（含错误行/重复编号）、导入预览状态机、浏览器自动录入全流程、截图落盘、
重复申请前置查重跳过、二次启动幂等、手动停止与恢复、**模拟进程崩溃后的重启标记与续跑**、
日志 PII 遮蔽（含"无 undefined、含具体申请编号"回归断言）。

> 浏览器说明：优先使用 Playwright 自带 Chromium；若当前平台无法下载（如本机 `npx playwright install`
> 报不支持），引擎自动回退到系统 Google Chrome（路径见 `config.js`，可用 `CHROME_PATH` 覆盖），两者均为本地浏览器。

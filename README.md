# 本地文件接收与隔离工作台

一个本地运行的文件上传检查工作台：文件只有在通过**服务端基于实际内容的检查**后才能被下载；
未通过检查的文件进入隔离区，无法通过普通下载接口取回。所有状态变化都留下可查看的审计记录，
且页面不会暴露本机绝对路径。

## 安全模型（核心设计）

### 1. 不可信的输入一律不参与信任决策
- 客户端提供的**文件名、扩展名、浏览器 `Content-Type`（MIME）仅作展示与记录**，不参与任何放行判断。
- 服务端独立读取文件字节，用魔数（magic bytes）嗅探真实类型，再对图片做容器结构解析（读取尺寸、校验结束块等），
  防止“带个图片头的杂凑文件”蒙混过关。
- 文件名经过 `path.basename` 清洗后只用于展示；**落盘存储名全部由服务端用随机 UUID 生成**，
  上传路径不受用户控制。

### 2. 格式与大小限制
- 允许格式（可在 `server/config.mjs` 调整）：`png / jpeg / gif / webp / bmp / zip`。
- 单文件大小默认上限 10 MB，在两个阶段强制：
  - busboy 流式传输阶段硬截断（超限立即停止接收，返回 413）；
  - 检查阶段二次确认。超限文件同样进入隔离区并留下拒收记录。

### 3. ZIP 安全解压（`server/lib/zip-inspect.mjs`）
基于 `yauzl` 的惰性（lazyEntries）单遍流式解析，任何一条不满足即整个压缩包拒收：
- **条目数量**上限（默认 100，以实际遍历为准，不信任中央目录自报数量）；
- **解压后总大小**上限（默认 20 MB）与**单条目大小**上限（默认 10 MB），边解压边计数，
  即使中央目录伪造大小也会被实际字节计数拦截（防 zip-bomb）；
- **目录范围**：条目名规范化后必须严格落在每个任务独立的随机解压目录内，
  拒绝绝对路径、Windows 盘符、`..` 穿越片段（zip-slip）、符号链接/设备等特殊条目、`.lnk`；
- 重复条目路径检测；文件以 `wx` 排他方式创建，杜绝覆盖。
- 解压目录是每个任务一次性的临时目录，检查通过后立即清除，只保留原始 ZIP。

### 4. 隔离区与下载隔离
- 通过的文件落在 `data/accepted/`，拒收文件落在 `data/quarantine/`，**物理分目录**。
- 下载接口 `/api/download/:id` 只服务 `accepted` 任务；隔离任务一律返回 **403**，
  不存在任何能取回隔离文件的普通通道。
- 隔离清理只操作 `quarantine/` 内、且数据库登记过的随机文件名，并经路径包含校验；
  对非隔离任务调用清理返回 409。清理只删文件、保留任务记录与审计日志，因此**不可能误删已通过文件**。

### 5. 审计与信息最小化
- 所有状态变化（接收、通过、拒收、转隔离、下载允许/拒绝、清理）以追加方式写入 SQLite `audit_log`，只增不改。
- 数据库与日志**不保存本机绝对路径**，存储位置只用随机文件名表达；接口返回也不含路径。
- 下载响应带 `X-Content-Type-Options: nosniff`，`Content-Type` 使用服务端认可的类型而非浏览器声明值。

## 技术选型（无 Docker）

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Node.js 内置 `node:http` | 零 Web 框架，路由自管 |
| 持久化 | Node 内置 `node:sqlite` | 任务状态 + 审计日志，无需原生编译或外部数据库 |
| 上传解析 | `busboy` | 流式 multipart，支持传输中硬截断 |
| ZIP 解析 | `yauzl` | 惰性条目遍历、CRC 校验、严格文件名 |
| 前端 | Vue 3 + Vite | 组合式 API，单页应用 |
| 类型嗅探 | 自研 `server/lib/sniffer.mjs` | 魔数 + 图片结构解析，可审计、零额外供应链 |

要求 Node.js ≥ 22.5（使用内置 `node:sqlite`）。

## 目录结构

```
server/
  config.mjs           集中配置（限制、允许格式、数据目录，支持环境变量覆盖）
  index.mjs            HTTP 服务、路由、上传/下载/隔离清理
  inspection.mjs       检查流水线（大小→嗅探→结构/ZIP→落盘或隔离）
  db.mjs               node:sqlite 任务表与审计表
  lib/
    sniffer.mjs        字节魔数嗅探 + PNG/JPEG/GIF/WebP/BMP 结构校验
    zip-inspect.mjs    ZIP 安全检查与受控解压
    paths.mjs          路径包含校验与文件名清洗
client/
  src/                 Vue 3 组件（上传、任务表、状态徽标、审计抽屉、样例）
  public/samples/      项目自生成的合法样例图片与 ZIP
scripts/generate-samples.mjs  纯代码生成样例（无第三方版权素材）
tests/security.test.mjs       node:test 安全测试（20 个用例）
data/                  运行时生成：tmp/ accepted/ quarantine/ app.db（不入库）
```

## 快速开始

```bash
npm install
npm run samples     # 生成合法样例到 client/public/samples（已随仓库提供可重跑）

# 开发模式（两个终端）
npm run dev:server  # 后端 http://localhost:8787
npm run dev:client  # 前端 http://localhost:5173 （API 自动代理到 8787）

# 生产模式（单端口）
npm run build       # 构建前端到 client/dist
npm start           # http://localhost:8787 同时提供页面与 API
```

打开页面后可：
- 拖拽/选择文件上传，或点击“合法样例”卡片（样例上传时刻意伪造 MIME，演示服务端忽略声明）；
- 在任务表查看状态（已通过/隔离中/已清理）、服务端检出类型、拒收原因与提示；
- 已通过文件可下载，隔离文件按钮置灰且接口返回 403；
- 打开“审计记录”抽屉查看完整状态变化；
- 单个或批量清理隔离文件（已通过文件不受影响）。

## 配置（环境变量）

| 变量 | 默认 | 含义 |
|---|---|---|
| `FIW_PORT` | 8787 | 监听端口 |
| `FIW_DATA_DIR` | `./data` | 数据目录（含数据库与三类文件目录） |
| `FIW_MAX_UPLOAD_BYTES` | 10485760 | 单文件上传字节上限 |
| `FIW_ZIP_MAX_ENTRIES` | 100 | ZIP 条目数上限 |
| `FIW_ZIP_MAX_TOTAL` | 20971520 | ZIP 解压总字节上限 |
| `FIW_ZIP_MAX_ENTRY` | 10485760 | ZIP 单条目字节上限 |

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload` | multipart 字段 `file`；通过返回任务，超限 413 |
| GET | `/api/tasks` | 任务列表 |
| GET | `/api/tasks/:id` | 任务详情 |
| GET | `/api/tasks/:id/audit` | 单任务审计记录 |
| GET | `/api/audit` | 全局审计记录 |
| GET | `/api/download/:id` | 仅 `accepted` 可下载，隔离返回 403 |
| DELETE | `/api/quarantine/:id` | 清理单个隔离文件（非隔离任务 409） |
| POST | `/api/quarantine/purge-all` | 批量清理隔离文件 |
| GET | `/api/health` | 健康检查与当前限制 |

## 测试

```bash
npm test
```

覆盖：魔数嗅探与结构校验、路径穿越拦截、ZIP 的 zip-slip/绝对路径/条目超限/zip-bomb/损坏包、
伪造扩展名与 MIME、隔离下载 403、隔离清理不影响已通过文件、空文件、审计无绝对路径泄露等 20 个用例。

## 关于样例图片

`client/public/samples/` 下的 PNG/JPEG/GIF/BMP 与 ZIP 均由 `scripts/generate-samples.mjs`
用纯代码编码生成（自带 PNG/BMP/GIF/JPEG 编码器与 ZIP 打包），不含任何第三方版权素材，可自由使用。
WebP 的服务端检查能力完整保留；当前环境无可用的本地 WebP 编码器，故未提供 WebP 样例文件，
你可以自行上传任意 WebP 验证。

# 网页采集与变更追踪工具

面向本地资料站点的采集与变更追踪工具：设置起始地址和采集规则后，程序沿页面链接采集标题、正文和更新时间，保存每轮结果，并标记页面的**新增、修改、未变、消失**。内置一组本地演示网页，全程不依赖外网。

技术栈：Vue 3 + Vite（前端）、FastAPI（后端）、SQLite（持久化），不使用 Docker。

## 目录结构

```
backend/        FastAPI 应用（采集器、API、SQLite 持久化）
frontend/       Vue 3 前端
sample_site/    本地演示站点（静态 HTML，含分页、重复链接、更新时间标注）
scripts/        mutate_site.py —— 修改演示站点以模拟页面变更
```

## 启动方式

需要 Python 3.10+ 和 Node 18+。共三个进程：

```bash
# 1. 演示站点（端口 8001）
cd sample_site && python3 -m http.server 8001

# 2. 后端 API（端口 8010）
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8010

# 3. 前端（端口 5173，已配置 /api 代理到 8000）
cd frontend
npm install
npm run dev
```

打开 http://localhost:5173 ，在「采集规则」页点击**开始新一轮采集**（预置规则已指向演示站点）。

## 演示流程（新增 / 修改 / 消失）

1. 启动三个进程后，运行第一轮采集 → 所有页面标记为「新增」。
2. 再运行一轮 → 全部「未变」（演示增量运行与去重）。
3. 执行 `python3 scripts/mutate_site.py`（修改 art2、删除 art4、新增 art7）。
4. 运行第三轮 → art2「修改」、art7「新增」、art4「消失」。
5. 到「差异对比」页选择第 1、3 轮，查看页面级变化和 art2 的正文 diff。
6. 恢复站点：`python3 scripts/mutate_site.py --restore`（脚本首次运行时会自动备份原始文件）。

## 采集范围与规则

- **同域限制**：默认只采集与起始地址同域（scheme + host + port）的页面，站外链接直接忽略。
- **包含 / 排除**：可配置正则，分别作为白名单和黑名单作用于规范化后的 URL。
- **URL 规范化**：统一小写 scheme/host、去默认端口、去 fragment、剔除 utm_* 等追踪参数并排序查询参数、去末尾斜杠，保证同一页面只采集一次（演示站点首页故意放了 3 个指向同一文章的链接用于验证去重）。
- **分页**：列表页的分页链接就是普通 `<a>` 链接，由 BFS 自然发现，无需特殊配置。
- **最大页面数**：`max_pages` 限制单轮抓取上限，防止失控。

## 限速与重试策略

- **限速**：每次请求之间固定间隔 `delay_ms`（默认 500ms），串行抓取，不并发。
- **重试**：请求失败（网络错误或 5xx）按指数退避重试，最多 `retry_times` 次（默认 2，退避 1s、2s、4s 封顶）；404/410 等客户端错误不重试。最终失败的页面记为 `failed` 并继续后续队列。
- **User-Agent**：固定标识 `local-tracker-bot/1.0`。

## 增量运行与历史

- 每轮运行为每个访问到的页面保存一条 `page_history` 快照（标题、正文、更新时间、内容哈希）。
- 正文 SHA-256 与上一轮不一致 → `changed`；首次出现 → `new`；一致 → `unchanged`；历史存在但本轮未访问到 → `removed`。
- 运行进行中，前端每秒轮询，实时显示**排队 / 处理中 / 完成**数量。
- 规则与全部历史结果保存在 `backend/data.db`（SQLite），重启不丢失。

## 导出

「当前页面」页可导出当前仍存在的页面集合：

- `GET /api/export/current?format=json`
- `GET /api/export/current?format=csv`

## API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PUT | `/api/rules[/{id}]` | 规则查询与维护 |
| POST | `/api/rules/{id}/runs` | 启动一轮采集 |
| GET | `/api/runs`、`/api/runs/{id}` | 运行列表 / 详情（含计数） |
| GET | `/api/runs/{id}/pages` | 某轮采集到的页面 |
| GET | `/api/pages` | 当前页面状态 |
| GET | `/api/diff?run_a=&run_b=` | 两轮间页面级差异 |
| GET | `/api/diff/page?run_a=&run_b=&url=` | 单页正文 unified diff |
| GET | `/api/export/current?format=` | 导出当前结果 |

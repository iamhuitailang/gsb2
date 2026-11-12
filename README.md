# 本地视频裁切与转码工具

在浏览器中预览本地视频、按毫秒精度裁切区间、选择输出格式与编码参数，由后端调用
**真实 FFmpeg** 完成处理。前端 Vue 3，后端 FastAPI，任务与文件信息保存在 SQLite。
纯本地运行，不使用 Docker，文件不会上传到任何外部服务。

## 功能一览

- 视频上传（限制文件类型与大小），上传后在播放器中预览、拖动时间轴
- 双柄时间轴 + `HH:MM:SS.mmm` 文本输入，**裁切精确到毫秒**
- 输出容器（MP4/MKV/WebM/MOV/AVI/MP3）与音视频编码器、CRF、preset、码率均可在页面选择，
  每个参数都有明确文字说明，任务卡片展示实际执行的 FFmpeg 命令
- 提交后后台异步处理，前端展示**来自 FFmpeg 实际处理进度**的百分比
- 同时运行的任务数有上限（默认 2），超出的任务排队
- 任务可取消：终止对应 FFmpeg 进程组并清理该任务的临时文件
- 任务与文件元数据持久化在 SQLite，**刷新/重启浏览器后任务不丢失**；
  服务重启后未完成的任务自动重新排队
- 完成后可在线预览（支持拖动播放的 Range 请求）和下载
- 不同任务的输出文件以任务 ID 命名、重名自动加序号，**不会互相覆盖**

## 环境要求

| 组件 | 版本要求 | 说明 |
| --- | --- | --- |
| FFmpeg | **4.4 及以上，推荐 5.x / 6.x / 7.x / 8.x** | 需同时提供 `ffmpeg` 和 `ffprobe`，本项目在 8.1 上开发验证 |
| Python | 3.10+（推荐 3.12/3.13） | 后端运行环境 |
| Node.js | 18+（推荐 20/22/24） | 前端构建环境 |

### 安装 FFmpeg

安装后请确认 `ffmpeg` 与 `ffprobe` 都在 PATH 中：

```bash
ffmpeg -version
ffprobe -version
```

**macOS（Homebrew）**

```bash
brew install ffmpeg
```

**Ubuntu / Debian**

```bash
sudo apt update
sudo apt install ffmpeg
```

> Ubuntu 22.04 自带源为 4.4.x，满足最低要求；如需更新版本可用
> [官方静态构建](https://ffmpeg.org/download.html) 或 `sudo add-apt-repository ppa:ubuntuhandbook1/ffmpeg6`。

**Windows**

1. 从 <https://ffmpeg.org/download.html> 下载 Windows 静态构建（gpl 版即可），解压；
2. 把解压目录下的 `bin`（包含 `ffmpeg.exe`、`ffprobe.exe`）加入系统 PATH；
3. 重新打开终端，执行 `ffmpeg -version` 验证。

如果 ffmpeg 不在 PATH，可用环境变量指定可执行文件路径：

```bash
export FFMPEG_BIN=/usr/local/bin/ffmpeg
export FFPROBE_BIN=/usr/local/bin/ffprobe
```

## 目录结构

```
.
├── backend/            FastAPI 后端
│   ├── app/
│   │   ├── main.py         应用入口（生命周期、路由、静态资源挂载）
│   │   ├── config.py       路径与限制配置（环境变量可覆盖）
│   │   ├── db.py           SQLite 访问层（aiosqlite，WAL 模式）
│   │   ├── runner.py       任务队列、并发 worker、FFmpeg 进程管理
│   │   ├── ffmpeg_ops.py   格式/编码白名单、参数校验、命令构建
│   │   ├── media.py        ffprobe 元数据探测
│   │   ├── storage.py      文件名消毒、隔离目录、安全删除
│   │   └── routers/        files / tasks / misc 路由
│   ├── tests/              纯逻辑单元测试（pytest）
│   └── requirements.txt
├── frontend/           Vue 3 + Vite 前端
│   ├── src/components/     上传、裁切预览、编码设置、任务列表
│   └── vite.config.js      开发期 /api 代理到 8000
├── scripts/            一键启动脚本
└── data/               运行后自动生成（已被 .gitignore 忽略）
    ├── app.db              SQLite 数据库（含 WAL 辅助文件）
    ├── uploads/            上传的源视频（uuid 存储名）
    ├── outputs/            处理结果（任务 id 命名）
    └── temp/               每个任务一个临时目录，完成/取消后清理
```

## 启动步骤（本地开发模式）

需要两个终端。

### 1. 启动后端（端口 8000）

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

或直接使用脚本：`./scripts/start-backend.sh`

### 2. 启动前端（端口 5173）

```bash
cd frontend
npm install
npm run dev
```

或直接使用脚本：`./scripts/start-frontend.sh`

浏览器打开 <http://localhost:5173>，Vite 会把 `/api` 请求代理到后端 8000 端口。

> 若本机 5173 或 8000 端口已被占用，可用环境变量调整，无需改代码：
>
> ```bash
> # 后端换端口
> uvicorn app.main:app --host 127.0.0.1 --port 8011
> # 前端换端口并把代理指向新后端
> VITE_PORT=5180 VITE_API_TARGET=http://127.0.0.1:8011 npm run dev
> ```

### 3. 单端口模式（可选，前后端合一）

```bash
cd frontend && npm run build       # 产物输出到 frontend/dist
cd ../backend && uvicorn app.main:app --host 127.0.0.1 --port 8000
```

后端检测到 `frontend/dist` 后会自动挂载静态资源，直接访问
<http://localhost:8000> 即可使用完整应用。

### 运行测试

```bash
cd backend
pip install -r requirements.txt -r requirements-dev.txt
pytest tests/ -q
```

## 使用说明

1. **选择视频**：点击或拖拽上传。允许扩展名：
   `.mp4 .mov .m4v .mkv .avi .webm .flv .wmv .ts .mpg .mpeg .3gp .ogv`；
   服务端还会用 ffprobe 校验内容，伪造扩展名的非视频文件会被拒绝。
   默认大小上限 **2048 MB**。
2. **设置裁切区间**：拖动双柄时间轴，或直接在输入框填写
   `时:分:秒.毫秒`（如 `00:00:01.500`）。可点击“定位到起点/终点”在播放器中确认画面。
3. **选择格式与编码**：容器格式决定可选的编码器；选择 H.264/HEVC/VP9/VP8 时
   可设置 CRF 与 preset，码率留空则按 CRF 控制质量。
   选择 `copy` 表示不重新编码（速度最快，但只能在关键帧处裁切，无法保证毫秒精度；
   需要精确到毫秒时请使用真实编码器）。
4. **提交任务**：任务进入队列，worker 按并发上限依次处理，页面每秒刷新真实进度。
5. **预览与下载**：成功后任务卡片内可直接播放结果，也可新窗口预览或下载。
6. **取消任务**：处理中或排队中的任务都可取消，后端会终止 FFmpeg 进程组并删除临时文件。

## 文件保存位置与清理办法

所有运行数据默认在项目根目录的 `data/` 下，可用环境变量
`VIDEO_TOOL_DATA` 改到其他位置：

```bash
export VIDEO_TOOL_DATA=/path/to/your/data
```

| 目录/文件 | 内容 | 清理方式 |
| --- | --- | --- |
| `data/app.db` | 文件与任务的全部元数据、状态、进度 | 删除即重置全部历史记录（先停服务） |
| `data/uploads/` | 上传的源视频，存储名为 uuid，**不使用原始文件名拼路径** | 页面上删除文件（有进行中任务时会被拒绝），或停服后手动删除目录内容 |
| `data/outputs/` | 成功任务的输出文件，以任务 ID 命名 | 页面上“删除记录”会同时删除对应输出；也可停服后手动清理 |
| `data/temp/` | 任务运行中的临时输出，成功/取消时自动清理 | 页面“清理临时文件”按钮（自动跳过运行中的任务目录），或手动删除 |

页面提供的清理入口：

- 任务卡片 **删除记录**：删除终态任务的数据库记录与对应输出文件；
- 任务区 **清理临时文件**：清理所有未在运行的临时目录并报告释放空间；
- 文件区 **删除**：软删除文件记录并删除上传的源文件。

彻底重置（注意会丢失全部历史与文件）：

```bash
# 先停止后端服务
rm -rf data/
```

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VIDEO_TOOL_DATA` | 项目根目录 `data/` | 数据库与各类文件的根目录 |
| `VIDEO_TOOL_MAX_UPLOAD_MB` | `2048` | 单文件上传大小上限（MB） |
| `VIDEO_TOOL_MAX_CONCURRENCY` | `2` | 同时运行的 FFmpeg 任务上限 |
| `FFMPEG_BIN` | PATH 中的 `ffmpeg` | ffmpeg 可执行文件路径 |
| `FFPROBE_BIN` | PATH 中的 `ffprobe` | ffprobe 可执行文件路径 |

## 安全设计说明

- **路径安全**：上传文件名只做展示与下载头使用，服务端存储名一律为 uuid；
  临时目录与输出路径都有根目录校验，拒绝任何路径逃逸。
- **类型与大小**：扩展名白名单 + ffprobe 内容探测双重校验；上传流式落盘并实时统计大小，
  超限立即中断并删除残片。
- **命令注入**：FFmpeg 通过 `asyncio.create_subprocess_exec` 的参数数组启动，
  不经过 shell；格式、编码器、preset、CRF、码率全部走白名单/正则校验。
- **进程隔离**：每个任务独立临时目录、独立进程组；取消时 `killpg` 整组终止，
  防止 ffmpeg 派生子进程残留。
- **输出隔离**：输出文件名包含任务 ID，目标已存在时追加序号而非覆盖。
- **进度真实性**：进度解析自 ffmpeg `-progress pipe:1` 输出的 `out_time_us`
  与任务裁切时长的比值，不是模拟值。
- **重启恢复**：服务启动时把 `queued/processing` 状态的任务重新入队，
  并清理上次崩溃残留的临时目录与孤儿目录。

## 常见问题

**Q: 选择 copy 编码后裁切点不精确？**
A: 流复制模式下 FFmpeg 只能从最近关键帧开始裁切，这是容器/编码层面的限制。
需要毫秒精度时请选择 libx264 等真实编码器。

**Q: 页面显示的进度长时间不动？**
A: 进度来自 FFmpeg 实际输出时间。音频转码（MP3）或极短视频可能跳变较快；
若任务失败，卡片会展示 FFmpeg 的错误尾部信息。

**Q: 端口被占用怎么办？**
A: 后端改 `uvicorn` 的 `--port`，同时修改 `frontend/vite.config.js` 里的代理目标。

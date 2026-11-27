# 镜头剪辑台 Shot Shelf

把长视频按镜头切成可检索的片段目录：自动建议切点、逐段缩略图、标签与备注、按标签 / 时长 / 时间范围筛选，最后导出可以直接双击打开、离线浏览的网页式缩略图目录。

**视频只在本机读取和分析，不上传任何服务。** 没有账号、没有云同步、没有外部请求——应用是一个本地 Python 服务（只监听 `127.0.0.1`）+ 原生 HTML/CSS/JS 界面，解码和抽帧全部交给本机的 ffmpeg。

---

## 快速开始

```bash
# 需要：Python 3.10+ 和 ffmpeg（macOS: brew install ffmpeg）
python3 run.py --open        # 启动并自动打开 http://127.0.0.1:8765/
```

首次启动后：

1. 点 **加载样片** —— 会在 `samples/` 生成一段 24 秒演示视频并自动分析；
2. 在左侧列表点片段，中间可以预览、逐帧、改入出点、加标签和备注；
3. 右侧调灵敏度 / 最小镜头 / 弱变化合并，点 **应用并重新切分**；
4. 点 **导出目录**，得到 `data/exports/<名称>-<时间戳>/index.html`。

想用自己的视频：点 **导入视频**，填入视频的**绝对路径**（macOS 上可用“浏览…”调起系统文件选择器）。

```bash
python3 run.py --help
python3 run.py --generate-sample   # 只生成样片，不启动服务
python3 -m unittest discover -s tests -v   # 运行测试
```

---

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 导入本地视频，生成缩略图和候选镜头边界 | 导入后后台跑一次 ffmpeg 场景分析，缓存每帧的 scene 分数、平均亮度、平均饱和度；切点由缓存数据计算，调整参数不再重复解码 |
| 用户能调整灵敏度、合并误切片段、手动补边界 | 侧栏的灵敏度 / 强切点阈值 / 最小镜头 / 亮度与饱和度容差都会即时重算；列表可多选合并；播放头处按 `S` 切分，或在证据表里删除某个切点；手动结果以 override 形式保存，改灵敏度不会丢 |
| 每个片段保留源视频和起止时间 | 项目 JSON 和导出清单都写明源视频绝对路径 + `start_ms` / `end_ms` + 时间码 + 帧号 |
| 按时间码预览时不能因为缩略图抽帧而错位 | 缩略图用**输入侧 `-ss` + 重编码**做精确 seek；缓存键包含 `指纹 + 片段起止 + 取样点`，改边界后旧图在缓存层面不可能被复用；每次抽帧用 `showinfo` 读出实际解码 PTS，前端显示“对位准确 / 偏移 N ms” |
| 相邻镜头变化不明显时可合并 | 两段画面的**中位亮度/饱和度差**都在容差内、且切点不是强切点时自动合并（可在侧栏关闭）；另有弱变化合并与闪光合并规则 |
| 明显切换但间隔很短时仍可保留 | 短于“最小镜头”的片段，如果**两侧切点都达到强切点阈值**，标记为“保留短镜头”，不并入邻居 |
| 把判断依据显示出来 | 每个候选切点记录 scene 分数、类型（硬切 / 渐变 / 手动）、过渡宽度、亮度 Δ、饱和度 Δ、置信度、中文判断理由；界面表格、片段编辑器和导出的 HTML 都带证据表 |
| 片段可加标签和备注 | 编辑器内回车加标签，备注自动保存（防抖 650ms）；人工修正后标签/备注按时间重新锚定 |
| 按标签、时长和时间范围筛选 | 左侧筛选栏：标签（任一 / 全部）、时长档位、起止时间码、全文搜索，可组合 |
| 调整片段边界后相关缩略图及时更新 | 缩略图 URL 带“指纹 + 起止”版本参数，服务端按新边界重新计算内容键，改边界必换新图 |
| 保存项目 | 每次编辑都原子写入 `projects/<id>.json`；顶部可切换项目，`?project=<id>` 可直达 |
| 导出网页式缩略图目录和片段清单 | 导出目录含 `index.html`（离线可开，带筛选 / 搜索 / 证据表）、`shots.csv`、`manifest.json`、`thumbs/` |
| 清单能定位回原视频 | 每张卡片和 CSV 都有 `file:///.../video.mp4#t=12.345` 形式的跳转链接，系统播放器从该时间点播放；同时列出原始绝对路径与 `HH:MM:SS:FFF` 帧时间码 |
| 本地样片，含硬切 / 慢变化 / 静止画面 | `python3 run.py --generate-sample` 由 ffmpeg lavfi 合成，脚本见 `shot_shelf/samples.py`，期望结果写在 `samples/sample_manifest.json` |

---

## 样片说明

样片共 24 秒、25fps、640×360，由 ffmpeg lavfi 在本机合成（不需要下载素材）：

| 时间 | 内容 | 期望的自动判断 |
| --- | --- | --- |
| 0–3s | 静止深蓝画面 | 0 个切点 |
| 3s | 硬切到青绿 | 保留 |
| 6–10s | 构图不变，轻微色相漂移 | **不切**（慢变化被忽略） |
| 10s | 硬切到砖红 | 保留 |
| 12–12.6s | 0.6 秒白色短镜头，两侧都是硬切 | **保留短镜头** |
| 12.6–16s | 蓝色场景，中途亮度轻跳 | 判为弱变化并合并 |
| 16–19s | 静止深灰画面 | 0 个切点 |
| 19–21.5s | 慢渐变转场到紫色 | 识别为**渐变切点** |
| 21.5–24s | 紫色静止收尾 | — |

演示“人工修正”的推荐操作：

1. 把灵敏度拉到 0.1，会多出一些候选；观察证据表里被标为“已合并”的行和理由；
2. 在 6–10s 的慢变化区间手动按 `S` 切一刀，再用“清除人工修正并重检”恢复；
3. 选中 12–12.6s 的短镜头，把它并入邻居，看证据表如何改口；
4. 在 16s 附近手动补一个切点，再删除它。

---

## 数据、素材和缓存

所有运行期数据都在仓库根目录下（可用环境变量 `SHOT_SHELF_HOME` 改到别处）：

| 路径 | 内容 | 能否删除 |
| --- | --- | --- |
| `projects/*.json` | 项目文件：源路径、检测参数、片段、标签、备注 | **删了就丢项目**，请自行备份 |
| `data/analysis/*.json` | 每帧场景分析缓存（按源文件指纹命名） | 可删，删后重新“分析”即可重建 |
| `data/thumbs/<project>/` | 镜头缩略图 jpg + 对位元数据 json | 可删，会按需重建 |
| `data/previews/<project>/` | “抽帧对位检查”用到的预览帧 | 可删 |
| `data/exports/` | 导出的网页目录（含复制出去的缩略图） | 可删，需要时重新导出；**导出的目录是自包含的**，单独拷走仍可浏览 |
| `samples/` | ffmpeg 生成的演示样片 | 可删，重新“加载样片”会再生成 |

**清理方式**

- 界面右上角 **缓存与清理** → “清理全部缓存（保留项目）”：清空 analysis / thumbs / previews / exports / samples，保留 `projects/`；
- 或直接删目录：

  ```bash
  rm -rf data/analysis data/thumbs data/previews data/exports
  rm -rf samples                 # 演示样片
  rm projects/p-xxxxx.json       # 删除单个项目（界面里“删除这个项目”等效）
  ```

- 要彻底不留痕：删掉 `data/`、`samples/`、`projects/` 三个目录即可。源视频本身从未被复制或修改，删除这些目录不会影响你的视频文件。

`.gitignore` 已忽略 `data/`、`projects/`、`samples/`、`public/samples/`，不会被误提交。

**为什么缓存可以安全删除**

- 分析缓存以“源文件指纹（真实路径 + 大小 + 修改时间 + inode）”命名，源文件被替换或重新编码后，旧缓存自动失效，不会把旧片的切点套到新片上；
- 缩略图以“指纹 + 片段起止 + 取样点 + 宽度”为键，改边界必然换键，因此删缓存只会慢一次，不会造成错位。

---

## 不上传视频

- 服务只绑定 `127.0.0.1`，代码中没有任何外发网络请求；
- 浏览器与服务器之间只传 JSON 和一个本地视频路径，视频经 `/api/projects/<id>/video` 以 HTTP Range 流式读取，不落盘、不转码；
- “浏览…”调用的是 macOS 原生 `osascript` 文件选择器；它只返回路径，不读取内容；
- 导出目录里的 `file://` 链接指向你的原始视频，导出物本身只包含缩略图和元数据。

---

## 设计与实现要点

### 时间码与“不错位”

- 所有时间以**整数毫秒**存储，避免浮点累加漂移；显示时额外给出 `HH:MM:SS:FF` 帧号（由源 fps 计算）；
- 抽帧使用 ffmpeg 的输入侧 `-ss` 加 `-frames:v 1` 重编码，属于**精确 seek**（从上一个关键帧解码到目标帧），而不是只看关键帧的快速 seek；
- 每次抽帧都用 `showinfo` 读出实际解码帧的 PTS，与请求时间对比，差值写入 sidecar；“抽帧对位检查”面板直接展示这个偏移，正常应为 0ms；
- 缩略图缓存键 `sha1(fingerprint | start_ms | end_ms | offset_ms | width)`：**边界一改，键就变**，所以旧图在协议层面就不可能被拿来冒充新片段的首帧。

### 切点检测

1. **解码一次**：`scale=320:-2, signalstats, select='gte(scene,0)', metadata=print`，得到每帧的时间、scene 分数、YAVG、SATAVG；
2. **候选**：高于灵敏度的局部峰值 = 硬切点；低分但有界、累计变化和最终画面差都显著的区间 = 渐变转场；
3. **合并规则**（按顺序迭代，直到稳定）：
   - 闪光 / 瞬时遮挡：很短的中间段 + 两侧画面几乎一致 → 三段合并；
   - 短片段：两侧都是强切点 → “保留短镜头”；否则并入较短的邻居；
   - 画面接近：相邻两段的中位亮度/饱和度差都在容差内且切点不强 → 合并；
4. **人工覆盖**：手动切点存进 `manual.add`，删除的切点存进 `manual.remove`，两者始终优先于自动结果。因此滑动灵敏度不会悄悄丢掉手工切分。

`shot_shelf/detect.py` 顶部注释完整列出了规则，`tests/test_detect.py` 用合成序列覆盖了静止、硬切、慢变化、短镜头、弱变化、闪光、渐变等情形，不需要 ffmpeg 即可运行。

### 导出物

- `index.html`：深色缩略图网格，可搜索 / 按标签 / 按时长 / 按时间排序，卡片显示片段号、起止时间码、帧号、标签、备注、源路径和播放高亮时间点；底部折叠“自动切点判断依据”表；
- `shots.csv`：含序号、片段 ID、起止时间码与秒数、时长、开始/结束帧号、缩略图采样时间码、标签、备注、源视频绝对路径、跳转链接；
- `manifest.json`：机器可读的完整项目快照（源信息、检测参数、全部切点证据、片段列表）。

### 代码结构

```
run.py                  启动入口
shot_shelf/
  media.py              ffmpeg/ffprobe 封装：探测、场景分析、精确抽帧
  detect.py             切点候选与合并规则（纯函数，可单测）
  store.py              项目 JSON、编辑操作、缓存清理
  thumbnails.py         内容寻址的缩略图缓存
  export.py             网页目录 + CSV + manifest
  samples.py            用 ffmpeg lavfi 合成演示样片
  server.py             127.0.0.1 HTTP 服务 + JSON API（无上传接口）
  timecode.py           毫秒/时间码/帧号互转
web/                    index.html + styles.css + app.js（无构建步骤）
tests/                  单元测试（不依赖 ffmpeg）
```

### API 速览（全部本地）

```
GET  /api/health                       ffmpeg / ffprobe / 分析滤镜自检
GET  /api/projects                     项目列表
POST /api/projects                     {"path": "/abs/video.mp4"} 导入
GET  /api/projects/<id>                完整项目（含切点证据）
POST /api/projects/<id>/analyze        后台分析，返回 job_id
GET  /api/jobs/<job_id>                进度
POST /api/projects/<id>/detect         {"settings": {...}} 重新切分
POST /api/projects/<id>/split          {"shot_id", "at_ms"} 加切点
POST /api/projects/<id>/merge          {"shot_ids": [...]} 合并
POST /api/projects/<id>/boundaries/add      {"at_ms"} 手动补切点（等价 split）
POST /api/projects/<id>/boundaries/remove   {"at_ms"} 删除切点
PATCH /api/projects/<id>/shots/<shot>  改标签/备注/入出点
GET  /api/projects/<id>/thumb?shot_id&pos&w  缩略图（响应头带取样与偏移）
GET  /api/projects/<id>/frame?t_ms&w         精确抽帧
GET  /api/projects/<id>/video         支持 Range 的视频流
POST /api/projects/<id>/export        导出网页目录
GET  /api/cache  POST /api/cache/clear       缓存用量 / 清理
POST /api/samples                      生成/复用本地样片并建项目
GET  /api/pick-file                    macOS 原生文件选择器（返回路径）
POST /api/reveal                       用系统默认程序打开导出入口
```

---

## 已知限制

- 需要本机安装 ffmpeg（含 `select` / `signalstats` / `metadata` 滤镜与 `libx264`）；启动时右上角会显示自检结果；
- 场景分数基于画面直方图差异，缓慢溶解和大幅运动都依赖阈值判断，最终仍建议人工复核——这正是证据表和人工修正存在的原因；
- 浏览器播放器对某些编码（如 ProRes、部分 MKV）可能无法直接播放，但缩略图、切点、导出仍可正常工作，可用系统播放器通过导出清单定位；
- 样片用 ffmpeg lavfi 合成；若本机 ffmpeg 缺少 `drawtext` 或字体缺字形，样片会自动去掉文字标注继续生成，不影响切点演示；
- 目前没有多用户 / 多机同步设计，项目文件就是事实来源，拷贝 `projects/*.json` 即可迁移项目（源视频仍需在原路径）。

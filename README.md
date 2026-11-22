# 本地视频亮度范围（limited/full）检查与转换页

解决的问题：同一段短片在一个播放器里颜色正常，换一个播放器就像蒙了一层灰。
根因几乎总是**亮度范围标记（color range / full_range_flag）与实际编码像素不匹配**——
播放器按错误的范围解释了 YUV 电平：

- `limited / TV`：合法亮度 Y=16–235，播放时拉伸到显示 0–255
- `full / PC`：合法亮度 Y=0–255，原样显示
- full-range 像素被按 limited 解释 → 暗部/高光被压级、整体发灰（最常见的“蒙灰”）
- limited 像素被按 full 解释 → 对比不足、画面泛白

本工具在本机核对**文件里的标记**和 ffmpeg 抽出的**真实像素电平**，并提供两种修正操作。
全程纯本地运行，不上传任何文件，不改动源文件。

## 运行

依赖：Python 3.10+（只用标准库）和 ffmpeg/ffprobe（需在 PATH，建议 6.0+）。

```sh
./run.sh                 # 默认 http://127.0.0.1:8791
PORT=9000 ./run.sh       # 自定义端口
```

打开浏览器访问提示的地址即可。所有产物在 `workspace/`：

```
workspace/sources/   上传的原件（永不修改，转换只读它）
workspace/outputs/   导出的转换结果
workspace/samples/   程序生成的样例
workspace/history.json  转换历史（含每次的实际电平变化）
```

## 功能与需求对应

1. **声明范围 vs 预览解释**：加载后显示 ffprobe 读到的容器/码流范围标记（tv/pc/unknown）、
   像素格式、分辨率帧率帧数。标记缺失时必须手动选择按 limited 还是 full 解释，
   并给出“多数播放器默认猜 limited”的说明。选择只影响预览，不改动文件。
2. **并排核对**：同一条 ffmpeg 抽出的原始 YUV444p 码流，分别按 limited / full 两种解释
   用 Canvas 渲染，可肉眼对比；下方是 0–255 编码 Y 的直方图（越界区红/黄高亮）、
   9 个固定检查点（编码 Y=0/8/16/…/255 在两种解释下的显示灰阶）、16 条灰阶带实测，
   并自动列出被 limited 解释压成同一纯黑/纯白的具体电平。
3. **两种修正操作**：
   - **仅修正标记（retag）**：MP4/MOV 走 `h264_metadata`/`hevc_metadata` 位流滤镜，
     码流逐字节复制、像素电平零变化、秒级完成；页面明确说明“判断错了画面会变白/变灰”。
     MKV 的范围信号在容器层（见下“容器差异”），行为有额外提示或约束。
   - **实际转换像素（pixels）**：`scale=in_range/out_range` 重映射每个电平并重新编码
     （CRF 16），音轨流复制保留；页面说明重编码不可逆、limited→full 无法恢复被裁掉的信息。
   - **重复转换提示**：同一素材已按某目标范围输出过时，再次转换会先弹确认，
     并区分“相同方式重复”和“换了一种方式”，像素模式点明二次量化/裁剪误差。
4. **跳帧与播放**：可跳转到指定帧号复核（含首尾帧），方向键逐帧；
   逐帧导航和原生视频播放都不会改变当前选择的范围解释。音轨保留，源文件只读。
5. **导出与回读**：导出文件可再次载入，回读时重新跑 ffprobe + 抽帧统计，
   展示当前范围标记、灰阶带峰值电平、Y min/max 与越界像素占比；
   每次转换记录的是**实际电平变化**（如 Ymin 0→16、越界占比 3.86%→0.03%），不是设置回显。
6. **程序样例**：一键生成 3 份 4 秒 1280×720、带 440Hz 测试音的短片，
   上半幅是 full-range 16 级灰阶阶梯（Y=0,17,…,255），下半幅是 SMPTE 色条：
   - `ramp_bars_full_correct_pc.mp4`：full 像素 + 正确 full 标记
   - `ramp_bars_full_wrongtag_tv.mp4`：**同一份 full 像素 + 错误 limited 标记**（“蒙灰”最小复现）
   - `ramp_bars_limited_correct_tv.mp4`：像素缩到 limited（Y≈16–235）+ 正确 limited 标记

   前两份像素统计完全一致、仅标记不同，可直接验证“问题出在标记而非像素”。

## 容器差异（实测 ffmpeg 8.1）

- **MP4/MOV（H.264/HEVC）**：范围标志在码流 VUI 的 `video_full_range_flag`，
  位流滤镜可无损流复制改写，是 retag 的推荐路径。
- **MKV/WebM**：范围在容器 BlockGroup 的 `ColourRange` 元素，优先级高于码流 VUI。
  ffmpeg 的 muxer 只按编码时的帧属性写该元素，无法流复制改写：
  - limited→full 改标记：可做一次“电平不变的重编码”（有压缩损失，界面会提示）；
  - full→limited 纯改标记：做不到——写 tv 必然把 full 电平钳到 16–235，
    工具会直接报错并引导改用像素转换（正确重映射而非硬钳）或转存 MP4。

## 接口一览（均为本地 HTTP）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/upload` | 上传并探测（头 `X-Filename` 带文件名） |
| GET  | `/api/probe?id=` | 重新探测标记/流信息 |
| GET  | `/api/frame?id=&n=` | 抽第 n 帧原始 YUV444p（响应头带宽高） |
| GET  | `/api/stats?id=&n=` | 该帧 Y 直方图/越界占比/灰阶带 |
| POST | `/api/convert` | `retag` 或 `pixels`，重复时返回 `need_confirm` |
| POST | `/api/recheck` | 对导出文件回读标记与电平 |
| POST | `/api/generate-samples` | 生成并回读校验三份样例 |
| GET  | `/api/media?id=` | 视频流（支持 Range，供 video 标签与下载） |

## 目录结构

```
app/ffmpeg_core.py   ffmpeg 封装：探测、抽帧、统计、retag、像素转换、样例生成
app/server.py        标准库 HTTP 服务与工作区/历史管理
app/static/          单页前端（无框架、无外部依赖）
run.sh               启动脚本
```

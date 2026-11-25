# 本地视频防抖工作台（Local Video Stabilizer）

一个完全本地运行的手持视频防抖工具：分析画面运动轨迹 → 调整稳定强度 / 平滑范围 →
左右同步预览原始取景（叠加“最终有效画幅”框）与稳定后画面 → 标记不处理区间 →
逐帧检查 → 保存项目参数 → 导出新视频。**原片始终只读，不会被修改。**

后端 Python + OpenCV + Flask，前端原生 HTML/CSS/JS（无 CDN、无外部服务，可离线使用）。

---

## 功能与需求对照

| 需求 | 实现 |
| --- | --- |
| ① 生成运动轨迹，稳定强度 / 平滑范围可调，同时看到原始与校正后取景 | 光流 + 相似变换估计逐帧 `dx/dy/da` 并累加为轨迹；轨迹图含 X / Y / 旋转 / 运动量四个视图；左侧原图、右侧稳定画面同步逐帧刷新 |
| ② 裁切范围可调，显示最终有效画幅，避免裁掉重要主体 | 裁切倍数滑杆 + 一键自动计算无黑边倍数；左侧原图叠加青色四边形（输出四角反算回原图的位置）与压暗区，即最终有效画幅 |
| ③ 区分镜头切换 / 快速摇摄与抖动，可手动标记不处理区间 | 自动检测切换点（✂ 红色虚线，检测准确到帧）与快速摇摄（橙色标记）；支持在轨迹图上拖拽框选区间标记“不处理”，也可一键把摇摄 / 切换标记为区间；摇摄自适应校正默认开启 |
| ④ 逐段 / 逐帧预览与导出时间位置一致，暂停后单帧检查 | 预览 JPEG 与导出视频调用**同一个** `Stabilizer.render_stabilized(frame, i)`，变换只由帧序号 `i` 决定；`←/→` 逐帧、`Home/End` 首末帧、空格播放暂停 |
| ⑤ 保存分析项目和参数，可继续调整并导出新文件，不动原片 | `projects/*.vstab.json` 保存全部分析数据与参数；导出始终写入 `exports/*_stabilized.mp4`；另可导出逐帧处理参数 JSON |
| ⑥ 附带轻微抖动 / 快速摇摄 / 镜头切换本地短片 | `samples/sample_shake.mp4`、`sample_pan.mp4`、`sample_cuts.mp4`，可用 `python3 make_samples.py` 随时重新生成 |
| README 写清本机依赖与素材清理方法 | 见下文「本机依赖」「素材清理」 |

---

## 目录结构

```
repo/
├── app.py                 # Flask 本地服务 + API + 启动入口
├── make_samples.py        # 生成三套示例短片
├── requirements.txt
├── vstab/
│   ├── engine.py          # 分析 / 轨迹 / 平滑 / 画幅 / 逐帧渲染（核心）
│   ├── exporter.py        # ffmpeg 管道导出（保留原片音轨）
│   ├── samples.py         # 示例短片程序化生成
│   ├── jobs.py            # 后台任务与进度
│   └── storage.py         # samples/projects/exports 路径约定
├── templates/index.html   # 单页界面
├── static/app.js          # 交互 / 轨迹图 / 走带控制
├── static/style.css
├── samples/               # 示例短片（运行 make_samples.py 后出现）
├── projects/              # 保存的 *.vstab.json 项目
└── exports/               # 导出的视频与 *.params.json 参数文件
```

---

## 本机依赖

### 1. ffmpeg / ffprobe（必需）

用于导出 H.264 MP4、保留原片音轨、探测音视频信息。

```bash
# macOS（Homebrew）
brew install ffmpeg

# Ubuntu / Debian
sudo apt update && sudo apt install ffmpeg

# Windows
# 从 https://www.gyan.dev/ffmpeg/builds/ 下载并把 bin 目录加入 PATH
```

验证：

```bash
ffmpeg -version
ffprobe -version
```

> 找不到 ffmpeg 时工具仍可用 OpenCV 兜底导出 mp4v 无声视频，但建议安装 ffmpeg。

### 2. Python 3.10+ 与依赖包

开发验证版本为 Python 3.13。建议使用虚拟环境：

```bash
cd /path/to/repo
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

依赖只有：`flask`、`opencv-python`、`numpy`。
如果本机 Python 已经装过这些包（开发机即如此），也可以直接用系统 `python3` 运行。

---

## 启动

```bash
python3 app.py
```

启动后会自动打开浏览器；若没有自动打开，手动访问终端中打印的地址（默认 <http://127.0.0.1:8765>，端口被占用会自动向后选择）。

常用参数：

```bash
python3 app.py --port 9000       # 指定端口起点
python3 app.py --no-browser      # 不自动打开浏览器
python3 app.py --generate-samples  # 仅生成示例素材后退出

# 或使用便捷脚本(会检查 ffmpeg / 依赖并自动安装 requirements)
./run.sh
```

服务只绑定 `127.0.0.1`，局域网其他设备无法访问。

### 自带的自检脚本（可选）

```bash
# 引擎数值正确性: 事件检测、已知平移恢复、区间单位阵、导出后抖动下降
python3 scripts/verify_engine.py

# 零黑边覆盖(品红哨兵逐帧) + 带音轨视频的 AAC 音轨保留
python3 scripts/audio_check.py

# HTTP 端到端: 需先启动 app.py, 会真实分析 / 改参 / 取帧 / 存项目 / 导出
python3 scripts/e2e_check.py http://127.0.0.1:8765

# 真实 Chrome 交互冒烟(需本机装了 Google Chrome 与 playwright):
pip install playwright && python3 scripts/ui_check.py http://127.0.0.1:8765
```

---

## 三分钟上手

1. 页面顶部「示例短片」处点击任意 chip：
   - `SLIGHT SHAKE`：轻微手持抖动；
   - `FAST PAN`：中段有一次快速摇摄；
   - `SCENE CUTS`：4 个镜头硬切。
   首次使用若显示「未生成」，点击 chip 会自动生成，或运行 `python3 make_samples.py`。
2. 等待「正在分析画面运动轨迹」结束，出现左右双预览与轨迹曲线。
3. 右侧拖动 **稳定强度**、**平滑范围**，画面与曲线即时刷新。
4. 调整 **裁切 / 放大倍数**（或保持「参数变化时自动」），在左侧原图确认青色有效画幅框没有切掉重要主体。
5. 在轨迹图上 **横向拖拽** 框选一段 → 「标记为不处理」；也可用「自动标记摇摄区间」。
6. 空格播放 / 暂停，暂停后用 `←` `→` 逐帧检查。注意对比导出后同一帧。
7. 顶栏「💾 保存项目」，下次用下拉框「载入项目」继续。
8. 「导出处理参数 JSON」得到逐帧 `dx/dy/da`、平滑值、校正矩阵、裁切、区间等；
   或在右下「导出」填写文件名后「导出稳定视频」。成品在 `exports/`，原片不动。

### 打开自己的视频

在顶部输入框填写本机视频的**绝对路径**（支持 `.mp4 .mov .m4v .avi .mkv .webm`），
点击「分析打开」。1080p 数分钟的视频分析通常只需十几秒到一分钟（分析在 640 宽的降采样画面上进行）。

---

## 帧级一致性是怎么保证的

- 分析结果（逐帧运动 / 轨迹 / 切换 / 摇摄）与参数都保存在项目中。
- 每次调整参数，服务端重算逐帧校正矩阵 `matrices[i]`。
- 预览接口 `/api/frame?kind=stable&i=N` 与导出循环都调用
  `Stabilizer.render_stabilized(frame, N)`，不存在第二套预览算法或代理素材。
- 因此预览停在第 N 帧看到的画面，就是导出视频的第 N 帧。

### 键盘快捷键

| 按键 | 作用 |
| --- | --- |
| `空格` | 播放 / 暂停 |
| `←` / `→` | 上一帧 / 下一帧 |
| `Home` / `End` | 第一帧 / 最后一帧 |

---

## 导出的文件

- `exports/<片名>_stabilized.mp4`：H.264 + yuv420p，faststart；若原片有音轨则编码为 AAC 并保留。
- `exports/<片名>.params.json`：每次导出视频时同步写入的逐帧处理参数 sidecar。
- 顶栏「导出处理参数 JSON」会单独下载同样结构的参数文件，字段包括：
  - 视频信息与全部参数；
  - 每帧的 `delta / trajectory / smoothed / correction`；
  - 包络权重 `envelope`、有效缩放 `zoom`；
  - **实际使用的 2×3 仿射矩阵 `matrix_src_to_dst`**；
  - 该帧是否属于不处理区间 / 切换 / 摇摄。
- `projects/<名称>.vstab.json`：完整项目（含分析数组），可拷贝到其他机器同版本目录继续调整。
  注意：项目 JSON 记录的是原片的**绝对路径**，移动 / 删除原片后仍可载入查看与调参，但预览 / 导出需要把原片放回原路径。

---

## 素材清理

所有生成物都在仓库内的三个目录中，删除不影响程序运行，也绝不会碰到你的原片。

```bash
# 1) 删除三套示例短片（随时可用 python3 make_samples.py 重新生成）
rm -f samples/sample_shake.mp4 samples/sample_pan.mp4 samples/sample_cuts.mp4
#    或一次删除 samples 下所有 mp4：
rm -f samples/*.mp4

# 2) 删除导出的成品视频与逐帧参数 sidecar
rm -f exports/*.mp4 exports/*.json

# 3) 删除保存的分析项目（谨慎：删后无法继续调整，除非另行备份 JSON）
rm -f projects/*.vstab.json

# 4) 一键清理全部运行期产物（保留 samples/ exports/ projects/ 目录与 .gitkeep）
rm -f samples/*.mp4 exports/* projects/*.json
```

如果使用虚拟环境，删除 `.venv/` 即可移除全部 Python 依赖：`rm -rf .venv`。

> 示例短片由 `vstab/samples.py` 用 OpenCV 程序化绘制并经本机 ffmpeg 编码，
> 不含任何第三方版权素材。

---

## 实现原理简述

1. **运动估计**：在相邻灰度帧间用 `goodFeaturesToTrack` + 金字塔 LK 光流跟踪特征点，
   以 RANSAC `estimateAffinePartial2D` 求相似变换，分解出平移 `dx,dy` 与旋转 `da`。
2. **事件检测**：内点过少 / 估计失败判为镜头切换（跨切换不累计轨迹，平滑也不跨越切换点）；
   位移大且内点充足判为快速摇摄。
3. **轨迹与平滑**：`trajectory = cumsum(delta)`；每个镜头内部对 X/Y/A 分别做边缘反射的
   高斯平滑，半径由「平滑范围 × fps」换算。
4. **校正量**：`correction = strength × (smoothed − trajectory) × envelope`。
   包络在手动不处理区间内严格为 0，并在区间边界、切换点两侧做 smoothstep 衰减；
   摇摄自适应会按运动量平滑地降低校正权重。
5. **裁切画幅**：绕画面中心合成「旋转 + 缩放 + 平移」矩阵；对每帧二分求满足
   “输出四角反算回原图后仍在画面内”的最小缩放，进而得到全局自动裁切倍数。
6. **导出**：逐帧 `warpAffine` 后以 raw bgr24 管道送入 ffmpeg libx264，
   原片作为第二输入仅用于音轨。

---

## 常见问题

**Q: 预览里有黑边？**
A: 裁切倍数小于该参数下消除黑边所需值。点击「自动计算无黑边倍数」，或手动加大倍数；
画面上的黄色警告条会提示受影响的大致帧数。

**Q: 自动裁切后画面放得太大？**
A: 通常是个别跟踪异常帧或大幅度摇摄导致。可在异常运动段 / 摇摄段标记「不处理区间」，
或开启摇摄自适应，自动倍数会随之下降。

**Q: 处理自己的长视频很慢 / 内存高？**
A: 分析只在 640 宽降采样帧上进行且不缓存全部帧；预览按帧 seek + 单帧缓存。
导出是逐帧流式的，内存占用恒定。1080p 以上分辨率的预览可在走带栏切到 720p / 480p。

**Q: 导出视频和预览帧位置对不齐？**
A: 两者共用同一逐帧函数，正常情况下严格对齐。若原片是损坏的可变帧率（VFR）封装，
建议先用 ffmpeg 转成恒定帧率 MP4 再分析。

**Q: 端口 8765 被占用？**
A: 服务会自动尝试后续端口，以终端打印的 URL 为准，也可用 `--port` 指定。

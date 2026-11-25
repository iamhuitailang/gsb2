# SeamSqueeze — 展签长横图本地内容感知缩图

把一张宽横图「挤窄」给展签用：两侧都有人 / 物件，不能简单裁边。
本工具用 **seam carving（接缝雕刻）**，优先从留白处一条条抽走 8 连通
接缝，让背景非均匀收缩，而被圈选的完整物件永远不会被接缝穿过。

纯本地运行，无需网络；图片用内置几何图案生成，不依赖外部素材。

## 它解决的六个需求

| # | 需求 | 实现位置 |
|---|------|----------|
| 1 | 设目标宽高、圈定必保物件、标记优先缩减留白 | `seamsqueeze/masks.py`、CLI `--protect/--shrink`、GUI 拖拽框选 |
| 2 | 画出拟缩减位置、逐步预览、完整物件不被穿过 | `engine.preview_seam` / `remove_seam`、`viz.draw_seam`、CLI `preview` |
| 3 | 宽高都变可调先后，保护区随图像映射，撤销不串位 | `engine.resize_to(order=...)`、`src_map` 源像素映射 + 完整快照撤销 |
| 4 | 同尺寸对照普通缩放 / 直接裁边；放不下时明确提示 | `seamsqueeze/compare.py`、`check_target` / `ProtectionBlockedError` |
| 5 | 导出结果与缩减位置说明；项目可从源图复现；不覆盖源图 | `seamsqueeze/project.py`、`tools/exportutil.py`（含同路径保护） |
| 6 | 稀疏图样 + 密集条纹两个例子，证明背景变形与保护区效果 | `seamsqueeze/demo.py` |

## 目录结构

```
seamsqueeze/        核心库
  energy.py         Sobel 能量 + 保护罚值/留白偏置 + 最小代价缝 DP
  engine.py         抽缝、撤销、源像素映射、顺序控制、可行性下界
  masks.py          保护/留白矩形（源图坐标系）
  compare.py        普通缩放 / 居中裁边对照
  viz.py            蒙版高亮、缝叠加、缩减位置图、三联拼图
  demo.py           稀疏图样 / 密集条纹生成
  project.py        项目 JSON、SHA-256 校验、确定性回放、Markdown 说明
tools/
  cli.py            命令行（demo / run / preview / replay / info）
  gui.py            matplotlib 本地交互界面
  exportutil.py     导出与源图保护
tests/              pytest 回归（16 项）
examples/           运行后生成的演示图与导出产物
```

## 快速开始

```bash
pip install -r requirements.txt

# 1) 生成两张几何演示图，并打印推荐蒙版坐标
python tools/cli.py demo --out examples

# 2) 稀疏图样：宽 720 -> 500，高不变，先压宽度
python tools/cli.py run examples/sparse.png --out examples/run_sparse \
    --target 500 300 --order width_first \
    --protect 24,97,156,229:左圆 --protect 566,99,694,227:右方块 \
    --shrink 190,32,530,294:中部留白

# 3) 密集条纹：宽高都变，交替顺序，背景条纹被局部挤密而圆完好
python tools/cli.py run examples/dense.png --out examples/run_dense \
    --target 620 250 --order alternate \
    --protect 40,108,150,218:左圆 --protect 570,108,680,218:右圆 \
    --shrink 190,28,530,298:中部条纹

# 4) 逐步预览（每隔 N 步存一张拟抽缝高亮图）
python tools/cli.py preview examples/sparse.png --out examples/preview \
    --target 500 300 --every 50 \
    --protect 24,97,156,229 --protect 566,99,694,227 \
    --shrink 190,32,530,294

# 5) 从项目文件 + 源图逐像素复现
python tools/cli.py replay examples/run_sparse/result_project.json \
    --out examples/replay
```

也支持隔离模式运行（与不可信数据同机时更安全）：`python -I tools/cli.py ...`。

## 交互界面

```bash
python tools/gui.py --demo sparse     # 或 --demo dense
python tools/gui.py path/to/image.png
```

左侧面板：选择「画保护区 / 画留白」后在图上拖拽矩形；填目标宽高与
宽高顺序；`预览下一缝` 高亮拟抽位置（触碰保护区会红字警示）、
`抽走一缝`、`撤销一步`、`缩到目标`、`三联对照`、`导出结果`。

## 关键设计

### 为什么保护区不会被穿过
每个像素代价 = Sobel 梯度 + 保护区巨额正罚（`PROTECT_PENALTY`）−
留白偏置（`SHRINK_BOOST`）。动态规划求 8 连通最小代价缝时，任何含
保护像素的路径代价都远高于纯自由路径；若所有路径都被迫穿过保护，
引擎直接抛 `ProtectionBlockedError`，而不是硬切。

### 撤销为什么不串位
引擎为每个现存像素维护 `src_map`（到源图 id 的映射）。每次抽缝同步
作用于图像、两张蒙版和 `src_map`；撤销恢复的是抽缝前的**完整快照**，
蒙版逐像素还原，不存在重投影漂移。GUI 中改蒙版则从源图按已执行方向
确定性重建，结果与逐步操作一致。

### 宽高先后
`width_first` / `height_first` / `alternate`（默认）三种顺序，对应
不同的变形分布；顺序与每一步方向都写进项目文件。

### 可复现 & 不覆盖源图
项目 JSON 只存「源图绝对路径 + SHA-256 + 蒙版矩形 + 每步方向」，
不内嵌结果像素。回放时先核对哈希（源图被改则拒绝），再用确定性 DP
重放，得到逐像素一致的结果。所有导出写入独立输出目录，且导出路径
若与源图是同一文件会直接报错。

## 导出产物（以 `run` 为例）

- `result_seam.png`：seam carving 结果
- `result_compare.png`：同尺寸三联对照（seam / 普通缩放 / 直接裁边）
- `result_removed.png`：源图上标红所有被抽走的像素位置
- `result_report.md`：逐步记录、涉及源列/源行区间、保护与留白坐标
- `result_project.json`：可复现项目（配合源图 `replay`）

## 测试

```bash
python -m pytest tests/ -q
```

覆盖：物件像素逐像素幸存、留白偏好、两种顺序差异、撤销快照一致性、
超下界拒绝、零自由路径阻断、项目回放逐像素一致、篡改源图哈希拒绝、
三联同尺寸、CLI 端到端（含 `-I`）。

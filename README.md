# 本地多焦点照片合成工具（focus stacking）

给一批细小摆件拍近照时，景深很浅：前面清楚了后面就糊。本工具把同一场景
3~5 张不同对焦点的照片配准、逐像素挑最清晰的源，合成一张前后都清楚的图，
并输出来源图供回看。纯本地运行，无需联网、无外部服务。

## 运行

```bash
pip install -r requirements.txt

# 图形界面
python main.py

# 命令行：生成自带样例并直接合成
python -m focus_stack.cli samples --set scene   --out ./demo       --run
python -m focus_stack.cli samples --set failure --out ./demo_fail  --run

# 命令行：合成自己的图片（顺序即用户给定顺序，不会重排）
python -m focus_stack.cli fuse --images a.png b.png c.png d.png --out ./out
```

## 功能与需求对应

| 需求 | 实现位置 |
| --- | --- |
| 打开 3~5 张图、按用户顺序保留、可调整顺序 | `ui_tab_load.py`、`app_state.AppState.load_paths` |
| 焦点呼吸导致的小幅缩放/平移配准，边缘对照预览 | `registration.py`（金字塔 ECC 仿射）、`edge_overlay` |
| 前后都清楚的合成图 + 来源图，点击回看倾向源与清晰度差异 | `fusion.py`、`ui_tab_composite.py`、`pipeline.point_info` |
| 遮挡区域固定给某张源（pin），重影检查，纯色区稳定选取 | `selection.py`、`ui_tab_pins.py` |
| 同倍率边缘检查：原图/硬边界/柔和交界，覆盖不足可裁剪或标明 | `ui_tab_edges.py`、`fusion.edge_regions`、`geometry.crop_to_mask` |
| 保存原图引用、配准、局部选择，导出 PNG 与来源图；改一块不影响其他 pin | `project.py`、`ui_tab_save.py` |
| 自带细纹/纯色/遮挡样例 + 明显移位失败样例 | `samples.py` |

## 工作流程（5 个页签）

1. **导入与配准**：打开图片或一键生成样例。配准状态表给出每张源的
   相关系数与判定（正常/警告/失败）；“配准边缘对照”把各源 Canny 边缘
   用不同颜色叠在参考帧上，边缘重合说明对得齐，出现彩色重边即错位。
2. **合成与回看**：柔和交界（softmax 权重混合，温度可调）或硬边界
   （直接选像素）。点击合成图任一点，右侧列出该点各源的相对清晰度、
   原始分数、配准状态与像素颜色，并在来源图上看到颜色编码的来源选择。
3. **固定区域与重影**：在图上拖矩形/椭圆（多边形逐点双击结束），把一块
   区域强制指定给某张源，适合处理前后遮挡。接缝带内自动计算源间颜色差，
   红色高亮重影风险；每个 pin 周边给出单独的重影统计。pin 是矢量图形，
   重算配准后仍然有效；增删任一 pin 时其他 pin 原样保留。
4. **边缘检查**：所有视图共享缩放倍率，并排查看对齐后的各源、硬边界结果
   （标签切换白线）与柔和交界结果。覆盖不足时可“裁到共同覆盖区”或
   “保留全帧并用灰色斜纹标明无效区”。
5. **保存**：工程目录包含
   - `project.json`：原图相对引用与顺序、2x3 配准矩阵与状态、矢量 pin、全部参数
   - `cache.npz`：清晰度栈/标签/权重（可删，重开时按需重算）
   - `sources/`：源图副本，整个工程文件夹可迁移
   - `composite.png`、`source_map.png`：合成图与来源图

## 算法说明

- **配准**：以第 1 张为参考帧，对每张源做两级金字塔 ECC 仿射配准
  （`cv2.findTransformECC`），估计缩放/平移/旋转/剪切。判定分三档：
  相关系数阈值 + 变换参数合理性（默认缩放 ±10%、旋转 5°、平移短边 20%），
  超阈的源标记为失败并排除出自动合成，界面给出具体超阈项。阈值集中在
  `registration.RegistrationConfig`。
- **清晰度**：拉普拉斯响应的局部方差（variance of Laplacian），窗口均值
  用 `boxFilter` 滑动求和（等价积分图，O(n)）。
- **选择**：清晰度 argmax 出标签；平局固定取编号最小的源，因此大面积纯色
  区（所有分数接近 0）逐次运行结果完全一致。再用位平面计数的多数投票
  滤波器做空间平滑，让选择连片、无碎斑；pin 像素在滤波中受保护。
- **融合**：硬模式按标签选像素；软模式在可用源上做 softmax(分数/温度)
  加权混合。无效区（非共同覆盖）权重为 0。
- **重影**：相邻像素标签不同处形成接缝并外扩，带内计算被选中源与其他源
  的最大颜色差，差异越大柔和融合越可能出重影。

## 测试

```bash
python -m pytest tests/ -q
```

30 个测试覆盖几何变换、配准（含失败判定）、清晰度、pin 与多数滤波、
硬/软融合、端到端管线、工程保存/重开、GUI 生命周期（无显示环境自动跳过）。

## 目录结构

```
focus_stack/
  geometry.py       仿射/warp/覆盖区
  registration.py   ECC 配准、状态判定、边缘对照
  sharpness.py      拉普拉斯方差清晰度
  selection.py      标签、多数滤波、pin、接缝/重影
  fusion.py         硬/软合成、来源图、点击回看
  pipeline.py       端到端管线
  project.py        工程保存/读取
  samples.py        自带样例生成
  app_state.py      GUI 状态与后台线程
  ui_*.py           Tkinter 各页签与画布
tests/              pytest 测试
main.py             GUI 入口
```

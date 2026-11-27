# badcol — 面阵扫描图坏列分析与补图工具

针对"同几列在多张里反复异常、单张里又混着正常竖栏线"的扫描面阵坏列问题。
图片可由工具自行合成（带已知答案与干净参考），无需准备真实数据即可验证全流程。

## 六项需求对应关系

| # | 需求 | 实现 |
|---|------|------|
| 1 | 同尺寸一组照片，背景/图案每张变化，含固定坏线与偶发竖线 | `synth.py`：每帧独立背景/竖带/随机正常竖线；注入 persistent（每帧）与 intermittent（指定帧）两类，形态分 offset/dead/noisy，同时输出干净参考帧 |
| 2 | 输出可疑坏列与证据，区分总是异常/少数帧异常，支持手动补选排除 | `detect.py`：邻居列中位数基线 + 两遍扫描（连续坏列互不参考），输出每列命中帧、残差、方向、分数、置信度；`ColumnSelection` 支持补选/排除/保护 |
| 3 | 相邻坏列、左右边沿、保护范围、连续坏列不可靠可见 | `repair.py`：双侧线性插值；贴边沿单侧复制标 `edge_copy`；连续坏列超 `max_span` 或参考不足标 `unreliable`；无健康邻居标 `unrepaired`；保护列标 `protected` 且不动 |
| 4 | 同视图切图看修补前后与列剖面，核对未选位置不变 | `gui.py`：帧滑块、原图/修补后切换、列均值+残差剖面、点击补选/Shift 排除/右键保护、一键"校验未选位置不变"（逐字节） |
| 5 | 保存坏列表并应用到另一同规格批次，尺寸不符明确提示 | `badlist.py`：JSON 格式 v1；高宽不符直接拒绝（退出码 2，不乱补）；帧数不符仅警告并跳过越界帧号 |
| 6 | 导出补好的图、每帧变更统计，用干净参考区分真恢复与误删 | `report.py`：修补图导出、`change_stats.csv`、`clean_comparison.csv`（恢复 MAE / 误伤 MAE / 结论） |

## 快速开始

```bash
pip install -r requirements.txt

# 1) 生成模拟批次（defective/ 缺陷帧, clean/ 干净参考, manifest.json 注入清单）
python3 -m badcol.cli synth --out tmp/demo --frames 8

# 2) 检测：固定坏列入坏列表, 单帧弱候选只进 evidence.json 等人工确认
python3 -m badcol.cli detect --input tmp/demo/defective --out tmp/demo/analysis
#   想让弱候选也进坏列表: 加 --include-weak

# 3) 修补并与干净参考对比
python3 -m badcol.cli repair \
  --input tmp/demo/defective \
  --badlist tmp/demo/analysis/badlist.json \
  --out tmp/demo/fixed \
  --clean tmp/demo/clean

# 4) 交互视图（切帧、修补前后、剖面、手动选区、导出）
python3 -m badcol.cli gui --input tmp/demo/defective --clean tmp/demo/clean
```

也可跑无 GUI 的端到端脚本：`python3 examples/demo_pipeline.py`

## 检测原理与判读

1. 每个像素用同帧左右各 2 列的逐行中位数作为期望基线，残差 = 原值 − 基线；
2. 第一遍找出候选坏列，第二遍把候选列从邻居基线中剔除——
   否则连续坏列（如 37/38）会互相参考而漏检；
3. 每列每帧同时看残差中位数（偏置/死列）与稳健标准差（噪声列），
   噪声尺度用整批 MAD（逐帧 MAD 会被随机正常竖线放大、抬高阈值）；
4. 按命中比例区分：
   - `persistent`：命中 ≥ 80% 帧，总是异常；
   - `intermittent`：少数帧异常；
   - 置信度 `strong`（≥3 帧复现）/ `weak`（1~2 帧，可能是正常竖线巧合，默认不进坏列表）。

## 修补状态含义

| 状态 | 含义 | 可信度 |
|------|------|--------|
| `repaired` | 左右健康列线性插值 | 高 |
| `edge_copy` | 贴图像边沿、仅单侧健康列，最近邻复制 | 降级，界面黄色可见 |
| `unreliable` | 连续坏列超过 `--max-span`（默认 3）或单侧参考缺失，仍填值但不冒充可靠恢复 | 低，界面橙色 |
| `unrepaired` | 两侧都没有健康列（整幅都坏），保留原值 | 未修补，界面红色 |
| `protected` | 保护范围内，一律不动 | — |

## 坏列表格式（badcol-badlist-v1）

```json
{
  "format": "badcol-badlist-v1",
  "height": 220, "width": 300, "n_frames": 8,
  "persistent": [2, 37, 38, 120, 299],
  "intermittent": [{"col": 255, "frames": [0, 5]}],
  "protected": [120],
  "notes": ""
}
```

`persistent` 对所有帧生效；`intermittent` 只对列出的帧号生效。
应用到新批次时：高宽不一致直接报错拒绝；帧数不一致时固定列照用、
越界偶发帧号跳过并逐条警告。

## GUI 操作

- 帧滑块 / 上一帧下一帧：同一视图切换图片；
- 原图 / 修补后单选：修补前后对照（切换前自动修补）；
- 点击图像或剖面：补选/取消补选（可选仅当前帧或所有帧）；
- Shift+点击：排除该自动候选；右键或 Alt+点击：保护切换；
- "校验未选位置不变"：逐字节核对选区外零改动；
- 保存/加载坏列表、导出修补图与统计（含干净参考对比）。

## 测试

```bash
python3 -m pytest -q          # 18 个用例, 覆盖六项需求与全部 CLI 子命令
```

## 目录结构

```
badcol/
  io_utils.py  图像读写、灰度转换、同尺寸校验
  synth.py     模拟批次生成（含干净参考与注入清单）
  detect.py    坏列检测、证据、手动选区
  repair.py    修补与状态标记、未选位置不变校验
  badlist.py   坏列表序列化与跨批次尺寸校验
  report.py    变更统计、干净参考对比、导出
  gui.py       matplotlib 交互视图
  cli.py       命令行入口
examples/demo_pipeline.py  无 GUI 端到端演示
tests/                     pytest 测试
```

# 本地三维骨骼权重检查器

一个不需要完整动画编辑器的本地工具：生成低面数手臂网格和骨架，在静止 / 轻微弯曲 / 明显弯曲姿势间切换，专门检查肘部重合顶点、相邻骨骼带跑、权重锁定/归一、每点骨骼数截断以及常见权重数据错误。

## 运行

```bash
npm install
npm run dev
```

浏览器打开 Vite 输出的本地地址（通常是 <http://localhost:5173>）。

其他命令：

```bash
npm test
npm run build
npm run sample
```

`npm run sample` 会在终端直接复现肘部接缝问题：两个静止位置完全相同的独立顶点，在 82° 弯臂后会明显分开。

## 能做什么

1. **程序化手臂与骨架**：无需外部模型。肘部有一圈刻意重复的重合顶点，静止时闭合，弯曲时可暴露权重不一致。
2. **姿势与变形前后对照**：顶部切换静止、38° 轻弯、82° 明显弯曲；右侧显示选中点的静止坐标、当前姿势坐标、差值向量和位移长度。白球是静止位置，黄球是变形后位置，黑线连接二者。
3. **重合顶点分别检查**：同一静止空间位置若对应多个独立顶点 ID，右侧和左下方会分别列出，可逐个切换查看骨骼和权重。
4. **骨骼影响色**：左侧选择骨骼后，视口用蓝色 sequential ramp 显示该骨骼对表面的权重。
5. **改权重、锁定和保存前检查**：右侧可编辑权重、锁定某根骨骼的值。保存前显示锁定总量、归一后剩余可分配权重、未锁定原始权重和与缩放系数。锁定总量大于 1 时禁止提交，项目原数据保持不变。
6. **2 骨 / 4 骨对比**：给出静止、轻弯、强弯下两套蒙皮结果的最大/平均位置差和变化点数；当前选中点会列出保留、舍去、原权重和重分配后权重。
7. **明确并列规则**：权重相同时依次按：
   - 锁定骨骼优先；
   - 骨骼表顺序 / 较小骨骼编号；
   - 原影响槽位顺序。
8. **问题定位与单点修复**：自动扫描零权重、失效骨骼编号、远距离骨骼影响。点击提示会选中并把视口焦点移到该点；“仅修复当前点”只替换当前顶点 ID，不会批量修改旁边已经调过或锁住的点。
9. **导出 / 导入 / 读回核对**：导出的 JSON 包含骨架、静止位置、三角索引、逐顶点权重、锁、标签和当前 UI 配置。导入后可执行序列化 → 解析 → 静止/轻微/明显弯曲变形核对。
10. **接缝最小样例**：应用内点击“接缝小样例”，或导入 [`examples/seam-repro.json`](./examples/seam-repro.json)。命令行复现脚本是 [`examples/repro-seam.mjs`](./examples/repro-seam.mjs)。

## 直接复现接缝问题

最小数据只有两根骨和两个静止坐标相同的独立顶点：

```json
[
  { "id": "A", "position": [0, 0.24, 0], "weights": { "UpperArm": 0.12, "Forearm": 0.88 } },
  { "id": "B", "position": [0, 0.24, 0], "weights": { "UpperArm": 0.88, "Forearm": 0.12 } }
]
```

运行：

```bash
npm run sample
```

核心代码：

```js
import { createSeamReproProject } from './src/core/modelFactory.js';
import { deformProject } from './src/core/skinning.js';

const rig = createSeamReproProject();
const d = deformProject(rig, 'strong');

const seamDelta = Math.hypot(
  d.positions[0] - d.positions[3], // A.x - B.x
  d.positions[1] - d.positions[4],
  d.positions[2] - d.positions[5],
);

console.log(seamDelta); // 82° 弯曲后 > 0.12，重合点被不同骨骼拉开
```

## 目录结构

```text
src/
  core/
    modelFactory.js   # 程序化低面数手臂、骨架、故意植入的接缝/数据问题
    skinning.js       # LBS 蒙皮、姿势矩阵、位移统计
    weights.js        # 归一、锁定、最多 N 根骨骼截断和并列规则（纯函数）
    diagnostics.js    # 零权重/失效编号/过远影响扫描与单点修复
    compare.js        # 2 骨 vs 4 骨集合和姿势统计
    io.js             # schema 解析、导出、读回校验
  three/Viewer.js     # Three.js 视口、拾取、骨架、标记和热力颜色
  main.js             # 无框架 UI 与状态流
examples/
  repro-seam.mjs      # 命令行直接复现
  seam-repro.json     # 可导入的最小样例
tests/                # node:test 纯逻辑与蒙皮回归测试
```

## 权重保存规则

设锁定权重合计为 `L`：

- `L <= 1`：剩余 `1 - L` 分配给未锁定影响；通常按未锁定原始权重正比例缩放。
- 未锁定原始权重和为 0 且仍有余额：在未锁定行之间平均分配。
- `L > 1`：返回 `LOCKED_TOTAL_EXCEEDS_ONE`，UI 不提交修改，原 JSON/内存项目不变。
- 没有未锁定行但仍有余额：返回 `REMAINDER_WITHOUT_TARGET`，先添加影响骨骼。

所有规划函数都不修改输入；UI 只有在规划成功后才按顶点 ID 替换数据。

## 说明

这是面向排查和修权的本地检查器，不是完整动画编辑器：时间轴、关键帧、刷权重、镜像权重和导出 DCC 原生格式不在范围内。导出的 JSON 是工具自己的可往返格式。

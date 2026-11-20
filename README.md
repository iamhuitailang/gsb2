# 植被散布工具（Vegetation Scatter Tool）

在程序生成的地形上用笔刷散布树、草和岩石的网页工具：规则化随机分布、分块增量编辑、
固定种子可复现，项目可保存恢复，实例清单可导出。全部资源程序生成，**无需下载任何模型**。

技术栈：Vite + Three.js（渲染）+ 纯 ESM 核心算法（`node:test` 单测覆盖）。

---

## 本地启动

要求 Node.js ≥ 18（开发使用 Node 24 验证）。

```bash
npm install        # 安装依赖（three / vite，无其他运行时依赖）
npm run dev        # 开发服务器，默认 http://localhost:5173 ，自动打开浏览器
```

其他命令：

```bash
npm run build              # 生产构建到 dist/
npm run preview            # 本地预览生产构建
npm test                   # 运行核心算法单元测试（16 个用例）
npm run generate:sample    # 生成示例项目 public/samples/demo-sample.veg.json
```

生成示例后，在应用左侧面板「种子与项目 → 打开项目」选择
`public/samples/demo-sample.veg.json`，即可恢复一个已刷好 6000+ 株植被的场景。
该目录在 `.gitignore` 中，可随时用脚本重新生成。

> 浏览器需支持 WebGL2（近年的 Chrome / Edge / Firefox / Safari 均可）。
> 无头环境请加 SwiftShader 软件渲染参数，见文末「测试与验证」。

---

## 操作指南

| 操作 | 效果 |
| --- | --- |
| 左键拖动（绘制） | 在笔刷区域按当前规则生成/重刷植被 |
| 左键拖动（擦除） | 移除笔刷区域内实例 |
| 左键拖动（替换模型） | 保留候选点位置，仅把模型换成指定规则 |
| 左键拖动（手绘遮罩） | 加/减遮罩；规则可设置遮罩阈值参与过滤 |
| 右键/中键拖动 | 旋转视角（OrbitControls） |
| 滚轮 | 缩放 |

- **笔刷半径/强度**：面板滑块实时调整。
- **拖动不重复堆放**：笔刷落点按半径 35% 空间节流，且每格只有
  「未触碰 / 已绘制 / 已擦除」三个离散状态，重复涂抹是幂等操作。
- **实时预览**：每帧只重建预算内的脏分块（默认 6 块/帧），大区域编辑不卡帧。

### 规则参数（每条模型一条规则）

| 参数 | 含义 |
| --- | --- |
| 出现比例 `weight` | 多条规则在同一格同时命中时的决胜权重（相对值，自动归一化） |
| 密度 `density` | 每平方米期望实例数，驱动候选格网尺寸与伯努利投放概率 |
| 间距 `spacing` | 与任意实例的最小中心距离（米），含跨规则约束 |
| 旋转范围 | 绕 Y 轴随机旋转角（度） |
| 缩放范围 | 均匀随机缩放倍数 |
| 最大倾斜 | 贴合地形法线允许的倾斜角（度） |
| 海拔范围 | 仅在该高度区间生成 |
| 坡度范围 | 仅在该坡度（度）区间生成 |
| 遮罩阈值 | 遮罩强度低于阈值不生成（0 = 忽略遮罩） |

参数修改后只重新评估已绘制区域；密度变化会按世界坐标迁移笔刷格网状态，
刷过的区域不丢、未刷区域不会凭空出现实例。

---

## 核心设计（与需求对应）

1. **确定性随机**：所有随机量由 `(seed, 格坐标, 规则哈希, 用途盐值)` 派生
   （`src/core/rng.js`，mulberry32 + 整数哈希），不使用 `Math.random`。
   固定种子时同一区域永远生成相同结果，与计算顺序、分块边界无关。
2. **全局候选格网**：候选点在格内做确定性抖动。格点评估是纯函数，
   因此笔刷重刷、规则变更、项目恢复在任何时刻重算结果一致。
3. **分块惰性重建**：世界按 32m × 32m 分块（`CHUNK_SIZE`）。重建某块时向四周扩
   `maxSpacing` 的 padding 并按全局格序评估，padding 格只参与间距计算不产出实例，
   保证**跨块边界的密度、随机性、间距与全量计算逐字节一致**（有专项测试）。
4. **增量更新**：规则/遮罩/笔刷只把受影响 chunk 标脏；遮罩变化通过改动包围盒
   定位相交块，未触碰的块零开销。
5. **间距约束**：均匀空间哈希做邻域查询，每条规则的 `spacing` 对所有已落位实例生效。
6. **擦除 / 替换 / 局部重刷**：擦除写格状态；替换只对当前真正有实例的格写强制规则，
   保留位置不补洞；重刷即对脏格重新跑纯函数评估。
7. **渲染**：每条规则一个 `InstancedMesh`（模板几何合并为单几何 + 顶点色），
   draw call 数等于规则数，与实例总数无关；容量不足自动扩容。
8. **程序素材**：地形是带种子的 value-noise FBM 高度场；树/草/岩石全部由
   Cone/Icosahedron/Dodecahedron 等基础几何体拼装，无外部资源。

---

## 文件格式

### 项目文件（`.veg.json`，本质是标准 JSON）

面板「保存项目」下载，「打开项目」恢复。结构：

```jsonc
{
  "schemaVersion": 1,
  "name": "vegetation-project",
  "savedAt": "2026-11-21T00:00:00.000Z",
  "seed": 20240901,
  "rules": [
    {
      "id": "pine",
      "name": "针叶树",
      "kind": "tree",              // tree | grass | rock
      "color": 3107651,
      "enabled": true,
      "weight": 6,
      "density": 0.08,
      "spacing": 2.4,
      "rotation": { "min": 0, "max": 360 },
      "scale": { "min": 0.9, "max": 1.6 },
      "tiltMax": 8,
      "heightRange": [-40, 40],
      "slopeRange": [0, 28],
      "maskThreshold": 0,
      "maskInvert": false
    }
    // ...其余规则
  ],
  "terrain": {
    "width": 128,
    "depth": 128,
    "resolution": 129,
    "heights": [ /* resolution² 个高度，行优先 Float32 转普通数组 */ ]
  },
  "mask": {
    "width": 128, "depth": 128, "cellSize": 1,
    "nx": 129, "nz": 129,
    "values": [ /* 0..1 遮罩强度，行优先 */ ]
  },
  "scatter": {
    "seed": 20240901,
    "cellSize": 1.348,
    "nx": 95, "nz": 95,
    "cellState": [ /* 0=未触碰 1=已绘制 2=已擦除，每格一个字节 */ ],
    "forcedRules": [ [123, "pine"] ],   // 替换工具写入的 [格序号, 规则id]
    "paramsSignature": 123456789,       // 规则指纹，恢复时校验是否需要重算
    "instances": [ /* 实例快照，见下；保证位置逐字节恢复 */ ]
  }
}
```

恢复时地形引用、遮罩、规则、格状态与实例快照全部还原；若保存后规则被外部修改导致
指纹不匹配，对应分块才会按新规则重算，否则原样保留。

### 实例清单导出

「导出实例 JSON / CSV」导出当前所有实例（不含地形）。

JSON 形态：

```jsonc
{
  "format": "vegetation-instances",
  "schemaVersion": 1,
  "count": 3251,
  "seed": 20240901,
  "instances": [
    {
      "id": 4512,                 // 候选格序号，确定性 id
      "model": "grass",           // 规则 id
      "kind": "grass",
      "name": "草丛",
      "position": { "x": 0.4369, "y": 1.2041, "z": -0.3843 },
      "rotationYDeg": 297.5,
      "quaternion": { "x": 0, "y": -0.518, "z": 0, "w": 0.855 },
      "scale": 1.22,
      "normal": { "x": 0.02, "y": 0.999, "z": -0.04 }
    }
  ]
}
```

CSV 表头：

```
id,model,kind,posX,posY,posZ,rotationYDeg,scale,normalX,normalY,normalZ
```

坐标为世界坐标（米），地形中心在原点，XZ 为水平面，Y 为高度。

---

## 目录结构

```
src/
  core/            # 不依赖 Three 的纯算法层，可直接在 Node 中测试
    rng.js         # 确定性 PRNG 与整数哈希
    terrain.js     # 高度场、双线性采样、法线/坡度、程序地形生成
    mask.js        # 手绘遮罩栅格
    rules.js       # 规则数据结构、环境约束、权重选择
    scatter.js     # 散布引擎：候选格网、分块、间距、增量重建、序列化
    project.js     # 项目存档与实例导出
    constants.js
  render/          # Three.js 渲染层
    terrain-view.js
    vegetation.js      # 程序化树/草/岩石模板
    vegetation-view.js # InstancedMesh 池与分块增量更新
    helpers.js         # 笔刷光圈、遮罩热力图、分块边界
  ui/
    editor.js      # 场景、指针交互、渲染循环、脏块调度
    panel.js       # 侧边控制面板
  main.js
test/
  scatter.test.js  # 16 个单元测试：确定性、幂等、间距、边界连续、增量、存档、导出
scripts/
  generate-sample.js
```

---

## 测试与验证

- `npm test`：16 个用例覆盖
  同种子结果一致、不同种子分布不同、重复涂抹幂等、跨规则间距、
  **逐块重建 == 全量评估的边界连续性**、规则变化只影响已绘制块、
  擦除/重刷/替换、高度坡度约束、遮罩局部重算、存档往返、JSON/CSV 导出。
- 无头浏览器（无 GPU）冒烟测试参数：

  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --headless=new --no-sandbox --use-angle=swiftshader \
    --enable-unsafe-swiftshader --ignore-gpu-blocklist \
    http://localhost:4173/
  ```

## 已知边界

- 候选格最小边长 0.25m（`MIN_CELL_SIZE`），密度极高时自动收敛，避免格点爆炸。
- 实例数量受 `spacing` 物理上限约束：密度再大，单位面积实例数不会超过间距允许值。
- 替换工具若目标规则的环境约束拒绝该点（如坡度超限），该点回退为普通评估而非强制保留。

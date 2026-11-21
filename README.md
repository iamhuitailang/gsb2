# 多角度角色素材预览器

在正式做美术素材之前，先用**程序化生成的占位角色**验证多角度序列的选择逻辑、
镜像补齐、锚点对齐和配置导出。纯静态页面，**零依赖、零构建**，
直接双击 `index.html`（`file://`）即可运行；也可以 `npm run serve` 后访问 http://localhost:8123 。

## 它解决什么问题

2D 角色按镜头方向切换外观，最容易出三类错：

1. **选错朝向**——尤其转过 0°/360° 边界时，首尾选到两张离得最远的图；
2. **地面跳位置**——不同方向/帧的脚底锚点不一致，换皮时角色在地上滑动或跳动；
3. **缺素材无感知**——缺方向、缺帧要到游戏里才发现，镜像补齐关系也没人核对。

本工具把这三类问题在素材阶段就暴露出来。

## 六条需求对应实现

| 需求 | 实现位置 |
| --- | --- |
| ① 多方向多动作帧序列，每帧锚点+停留时间，按方向列出缺角度/缺帧 | `js/angle.js` 的 `audit()`；面板右侧「素材缺口报告」；缩略图缺帧打 × |
| ② 拖镜头一整圈，边界切换正确，首尾不选到最远图 | `selectDirection()` 用**圆环最短距离**选向；转盘高亮切换边界；页头「整圈扫掠测试」自动转一圈并断言切换次数与首尾 |
| ③ 直接切 / 短过渡两模式；转身保持动作进度；换皮不跳地面位置 | 面板「直接切/短过渡」单选；动作按**周期进度 `progress∈[0,1)`** 取帧，换方向沿用同一进度；`drawLayer()` 把每帧锚点钉在同一地面点，可用「锚点对齐」开关对比 |
| ④ 缺方向镜像补齐，可关闭并指出替代来源 | `resolve()`/`mirrorAngle()`；画面角标显示「镜像替代 ← E」；关闭后显示「该朝向无可用素材」占位；N/S 镜像后是自己，明确标为无来源 |
| ⑤ 同屏双版本对照，镜头/动作进度同步，标签与素材替换独立 | 两个 `ViewerPanel` + 共享时钟与同步总线；「同步双面板」可关；各自独立选数据集、改标签、切镜像 |
| ⑥ 保存锚点/方向/替代关系并导出游戏可读配置；含锚点错位与缺方向两组例子 | `js/exporter.js` 导出 `multi-angle-sprite-config/v1` JSON，支持导回；锚点编辑自动存 localStorage；示例见下 |

## 三组内置示例

- **标准版 `standard`**：8 方向 × 2 动作（待机 4 帧 / 行走 6 帧）齐全，锚点统一。
- **锚点错位版 `anchor-shift`**：锚点随方向和帧故意漂移。
  关掉「锚点对齐」能看到角色在地面上跳，打开后脚底稳定钉在同一地面点——用来验收对齐逻辑。
- **缺素材版 `missing`**：行走缺 W/NW/N，待机缺 W，待机 SE 第 3 帧缺帧。
  其中 N 镜像后仍是自己、无法补齐，会一直留在缺口报告里。

## 程序化角色自带的“校验线索”

占位角色不是灰块，刻意画了能肉眼判断对错的标记（`js/sprites.js`）：

- 头顶**朝向箭头**随镜头旋转；
- 左上角方向字母、右上角帧序号；
- **左手红色 L 手套**（不对称标记）——镜像补齐后手套会跑到画面右侧、字母翻转，
  替代素材一眼可辨。

## 导出的配置格式

`导出此面板 JSON`（或 `npm run generate:examples` 生成到 `examples/`）输出：

```jsonc
{
  "format": "multi-angle-sprite-config/v1",
  "angleConvention": "0=north, clockwise, degrees",
  "directions": [ { "id": "W", "angle": 270, ... } ],
  "actions": [ { "id": "walk", ... } ],
  "sequences": {
    "walk:E": { "frames": [ { "source": "...", "anchor": {"x":80,"y":152}, "durationMs": 150, "missing": false } ] }
  },
  "substitutions": [ { "actionId": "walk", "directionId": "W", "sourceDirectionId": "E", "mirror": true } ],
  "unresolved": [ { "actionId": "walk", "directionId": "N", "reason": "no-sequence" } ]
}
```

- `substitutions`：镜像替代关系，游戏侧直接照做，无需再推断；
- `unresolved`：怎么都补不上的缺口（缺方向、缺帧）；
- 真实素材只需把帧的 `source` 从 `proc://...` 换成图片相对路径，结构不变。
  导出的 manifest 可用页头「导入 manifest」导回预览器核对。

## 操作

- **改镜头**：舞台上左右拖，或直接拖/点右侧转盘（转盘按指针方位角取值）；
- **动作进度**：拖动时间轴 scrub，或点缩略图跳到指定帧；
- **改锚点**：点缩略图选帧后在右侧填 X/Y，或在舞台上 `Shift+拖动` 黄色锚点；
- **改停留时间**：右侧「停留 ms」；
- 所有锚点/时长修改自动存浏览器 localStorage，刷新不丢。

## 目录与测试

```
index.html              入口（file:// 直开）
js/angle.js             纯算法：选向/镜像/取帧/审计（不依赖 DOM）
js/sprites.js           程序化角色帧生成
js/example-data.js      三组示例数据
js/exporter.js          配置导出与回填导入
js/viewer.js            单面板（画布/转盘/过渡/镜像/锚点/报告）
js/app.js               双面板、同步总线、共享时钟、扫掠、持久化
js/selftest.js          浏览器与 node 共用断言
test/angle.test.mjs     node 单元测试
tools/export-examples.mjs  导出 examples/*.json
tools/smoke.mjs         无头浏览器冒烟测试（复用本机 playwright）
examples/               导出的 manifest（镜像开/关各一份）
```

```bash
npm test                 # 算法单元测试（选向边界、整圈、镜像、缺帧、导出往返）
npm run generate:examples
npm run smoke            # 需要本机装有 playwright（npx playwright 或全局）
```

角度约定：**0°=北，顺时针递增，90°=东，180°=南，270°=西**。

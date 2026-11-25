# TAA 逐帧重影检查台

一个零依赖的 WebGL2 小场景,用来按帧检查"移动栅栏在抗锯齿下边缘稳定、但移动时出现重影"
这类时域抗锯齿(TAA)现象。所有画面状态都是**帧号的纯函数**,与显示器刷新率、墙钟完全解耦,
重跑同一镜头能拿到逐位一致的帧用于比对。

## 解决的问题

| 需求 | 实现 |
|------|------|
| 1. 程序化移动相机与不同速度几何,能看同一点前一帧落点 | 场景全部由 `evaluate(frame)` 解析给出;G-buffer 输出逐像素速度纹理,追踪点沿速度场反推历史落点 |
| 2. 单帧 vs 历史帧结果,移动边缘与静止细线分开看 | 单帧/TAA/分屏/区域掩膜四种视图;分块统计分别累计移动边缘重影与静止边缘变化 |
| 3. 遮挡挪开/相机跳变/画布变尺寸的明确重开规则 | 统一 `reset(reason)` 入口 + 7 类原因码;深度不一致/出屏逐像素判定显露,显露像素权重强制为 0 |
| 4. 屏幕拖影与画面抖动两套取样标记 | GhostProbe(盯移动边缘)、JitterProbe(盯静止细线)、Track(点追踪),逐帧留痕 |
| 5. 锁定路径导出原图与处理结果 | 从帧 0 完整重放,输出 4 列联系表 PNG + 全量指标 JSON |
| 6. 不以真实刷新率为唯一时钟,重跑可比对 | 固定步长 `FIXED_DT`,画面只由帧号决定;两次重放/导出逐位一致(有自动化测试) |

## 运行

需要一个静态服务器(ES 模块不能用 `file://`):

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000/index.html
```

操作:空格播放/暂停,方向键单帧,`G`/`J`/`T` 选择探针类型后点击画布放置。
右侧滑块可实时调历史权重、高速拒绝阈值、权重地板、深度 ε,并开关 Halton 抖动。

## 目录结构

```
js/
  clock.js      确定性帧时钟:t(N)=N*FIXED_DT,rAF 只负责调度不参与渲染参数
  prng.js       mulberry32 + Halton(2,3) 抖动序列,重开即归零
  math.js       列主序 mat4、透视(含亚像素 jitter)、lookAt、pingPong
  scene.js      场景纯函数:相机漂移/计划瞬移、两条不同速度栅栏、遮挡物滑入滑出、静止细线墙
  geometry.js   立方体/四边形/全屏三角形,实例化立方体 VAO(几何+双矩阵同 VAO)
  shaders.js    全部 GLSL:G-buffer MRT、TAA resolve、分块统计、显示
  renderer.js   FBO/ping-pong 管理、重开规则、RGBA32F 采样能力探测、管线编排
  probes.js     两套探针 + 点追踪,直接读 GPU 纹理逐帧留痕
  charts.js     逐帧折线图(重影/静止边缘/权重),带悬停十字线与重置事件竖线
  overlay.js    2D 覆盖层:探针标记、追踪轨迹、分屏线、帧水印
  exporter.js   锁定路径重放 + 联系表 PNG + 指标 JSON
  app.js        主编排与 UI
test/
  run-tests.js        Node 纯逻辑测试(npm test)
  shader-check.html   8 个着色器编译检查
  runtime-check.html  管线/确定性/重开/探针运行时检查
  reveal-check.html   遮挡挪开显露脉冲与权重归零检查
  export-quick.html   导出结构与两次导出逐位一致性
  app-check.html      真实页面 UI 联动
  cdp-*.mjs           无头浏览器 CDP 驱动(无第三方依赖)
```

## 确定性保证(需求 6)

- 画面任意帧 N 的状态 = `scene.evaluate(N)` 的纯函数结果,不含 `Date.now()`/`performance.now()`。
- `requestAnimationFrame` 的真实时间只进入调度累加器,决定"何时推进下一帧",
  不进入任何相机、几何、抖动计算。60Hz 与 120Hz 屏上同帧号画面相同。
- Halton 抖动序号随帧递增,任何重开都归零,因此抖动序列也可复现。
- 自动化验证:`runtime-check.html` 断言两条独立重放的读回像素 `maxAbsDiff === 0`;
  `export-quick.html` 断言两次完整导出的逐帧指标逐位一致。

## 重开规则(需求 3)

全部走 `Renderer.reset(reason)`,原因码定义在 `RESET_REASON`:

| 原因码 | 触发条件 |
|--------|----------|
| `first-frame` | 首次渲染 |
| `manual-reset` | 点击"重开" |
| `camera-jump` | 计划内瞬移(帧 300)或手动相机瞬移 |
| `loop-restart` | 镜头播放到末尾回绕 |
| `seek-replay` | 时间轴非线性跳转(从 0 重放到目标帧) |
| `canvas-resize` | 画布尺寸变化(FBO 整体重建) |
| `seed-change` | 更换镜头 seed / 导出重放 |

逐像素的显露判定在 resolve 着色器内:重投影 UV 出屏,或当前深度与重投影历史深度
差值超过 `depthEps`,即标记显露(`debug.g=1`)并把历史权重强制为 0,
该区域本帧直接取当前帧颜色,下一帧起才重新累积历史。

## 关键指标(分块统计 GPU 累计 + CPU 求和)

- `ghost` / `edgeGhost`:全图与移动边缘上的平均 `|TAA - 单帧|` 亮度(重影强度)
- `staticEdgeDelta` / `staticFlatDelta`:静止细线边缘与平坦区的历史改动量(画面抖动)
- `meanWeight`:历史权重均值;`disoccludedPx`:本帧显露像素数

## 已知平台注意点

部分驱动(无头 Chrome 的 SwiftShader)虽支持 `RGBA32F` 渲染,但在
"MRT + 深度附件 + 纹理采样"组合下对 32F 纹理采样会静默返回 0。
渲染器启动时用相同组合做一次真实往返探测,失败即退回 `RGBA16F`(TAA 的工业界常规精度)。
可用 `?float32=1` 强制 32F 做对比。真机 GPU 一般两者都正常。

## 测试

```bash
npm test          # Node 纯逻辑:时钟、PRNG、场景可复现性、矩阵
```

浏览器侧测试页在 `test/` 下,可用无头 Chrome + `test/cdp-run.mjs` 驱动,
或直接在浏览器打开对应 HTML 查看 `<pre>` 结果。

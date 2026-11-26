# 第三人称游戏镜头调试器（Third-Person Camera Debugger）

一个零素材、全部几何体程序化生成的 Web 工具，用来调试第三人称游戏镜头：

- **跟随目标**：距离、高度 / 肩部偏移、俯仰、水平角度偏移、前向注视、FOV，全部可配。
- **镜头区域（Camera Zone）**：盒体区域 + 优先级 + 出区滞回；角色进入不同区域自动换用不同镜头参数与**镜头边界（AABB clamp）**。
- **可配缓动切换**：每个区域可设过渡时间与缓动曲线；缓动途中再次切区（包括**反向穿过边界**）会以「当前混合值」重新起步，机位另有帧率无关阻尼，不会突然跳回。
- **遮挡处理**：从注视枢轴向期望机位做射线检测，依次尝试「沿射线前移 / 左右侧移 / 侧移+回收 / 抬高」等候选，选取代价最小且视线通畅的机位；右侧检查器与左上 HUD 会显示**当前避让原因**、命中物体、距离和全部候选探测结果。
- **路线时间轴**：假角色沿程序生成的测试路线行走，支持播放 / 暂停 / 拖动 scrub / 倍速 / 单次 / 循环 / **往返（专门验证反向穿界）**。暂停后可查看当前区域、目标坐标 / 朝向、最终机位 / 注视点 / FOV / 边界状态与混合参数。
- **保存与导出**：编辑结果自动存 localStorage；可「保存项目」下载完整项目 JSON（区域 + 路线 + 全部参数），「打开项目」恢复；可「导出运行时镜头配置」得到游戏运行时可直接读取的精简 JSON。
- **内置示例场景**：开阔广场、带门楣 / 门框的**门洞**、两道长墙夹出的**窄路**、转角观景台，以及货箱、立柱、遮挡测试墙等障碍。

技术栈：Vite + TypeScript + Three.js，纯 DOM 面板，无其他运行时依赖。

---

## 运行

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

其他命令：

```bash
npm run build        # 类型检查 + 产出 dist/
npm run preview      # 本地预览构建产物（4173 端口）
npm run typecheck    # 只做 tsc 类型检查
npm run test:logic   # 区域 / 缓动 / 路线的纯逻辑自检
```

操作：

- 调试视角下：鼠标左键旋转、右键平移、滚轮缩放。
- 顶部右上可切换 **调试轨道视角 / 游戏镜头视角**（后者就是被调试镜头看到的画面）。
- `空格`：播放 / 暂停（焦点在输入框时不触发）。
- 时间轴上的数字刻度对应路径点，点击可定位；右侧检查器实时显示该帧的完整解算结果。

---

## 场景与区域一览

| 区域 id | 名称 | 设计意图 |
| --- | --- | --- |
| `zone_plaza` | 开阔广场 | 大跟随距离、右肩偏移，场景开阔 |
| `zone_door` | 门洞近距离 | 短距离、居中、快速过渡；Bounds 把镜头 z 向夹在门洞宽度内 |
| `zone_alley` | 窄路俯视 | 短距离 + 大俯仰；Bounds 把镜头限制在两墙之间 |
| `zone_overlook` | 转角观景 | 大距离、左肩偏移 + 水平转角、慢速电影感过渡 |

路线（`src/core/defaults.ts` 中的 `createDefaultProject()`）依次经过：
广场起点 → 斜行经过货箱 / 遮挡测试墙 → 门洞前 → 穿门洞 → 窄路 → 右转 → 观景终点。
顶部循环模式切到 **往返**，角色会原路返回，可清楚验证反向经过区域边界时镜头平滑交接、不跳变。

---

## 如何编辑路线

路线是一个**有序路径点数组**，点间使用向心 Catmull-Rom 曲线（alpha = 0.5）平滑连接，直角转弯不易过冲。
每个路径点字段：

```jsonc
{
  "id": "wp_3",
  "name": "门洞前",
  "x": -3.2, "y": 0, "z": 0, // 世界坐标，Y 一般为 0（地面）
  "moveTime": 3.4,            // 从上一个点移动到本点所需秒数（第一个点忽略）
  "hold": 0.4                 // 到达本点后停留秒数
}
```

三种编辑方式：

### 1. 面板编辑（最直接）

左侧「**测试路线**」Tab：

- 直接修改每个点的 `X / Y / Z`、`移动s`、`停留s` 和名称；
- 点击「**○ 开启点击地面添加路径点**」，然后在 3D 场景地面上点击即可追加点（拖动旋转视角不会误加点，位移超过 6px 的按下-抬起会被视为相机操作）；
- 「**＋ 在假角色当前位置追加路径点**」可以抓取当前角色站位；
- 每张路径点卡上的 `⏯` 按钮（或时间轴下方的数字刻度）会把时间轴定位到该点并暂停；
- `✕` 删除点。改动会自动保存到浏览器 localStorage。

### 2. 编辑项目 JSON

点顶部「**保存项目**」得到 `camera-debugger-project-*.json`，其中 `route.waypoints` 就是路线；
按上面的格式增删改后，用「**打开项目…**」加载即可恢复全部区域与路线。JSON 解析做了字段兜底，缺字段会补默认值。

### 3. 改内置默认路线

编辑 `src/core/defaults.ts` 中的 `createDefaultProject().route.waypoints`，然后清除浏览器 localStorage
（DevTools → Application → Local Storage，键名 `tp-camera-debugger-project-v1`），或点顶部「**新建示例**」。

> 时间轴总时长 = 所有 `moveTime`（第一个点除外）+ 所有 `hold`。
> 播放时每段移动内部使用 smoothstep 缓起缓停；循环模式支持 `once | loop | pingpong`。

---

## 镜头区域与切换不跳变的原理

区域是绕 Y 轴可旋转的盒体（`center / size / rotationY`）。目标点先变换到盒体局部坐标做包含测试；
多个区域重叠时取 `priority` 大者（同级取体积小者）。每个区域带 `hysteresis`（米）：
目标越界但距离小于滞回值时，旧区域仍保留候选资格，避免在边界上反复抖动。

切换区域时，`ParamBlender` 从 **当前已经混合出来的参数快照** 向新区域参数做缓动
（`transitionTime` + `easing`）。因此即使过渡只进行到一半就再次切换、或反向穿回边界，
新过渡的起点始终等于上一帧的当前值。最终机位 / 注视点 / FOV 还分别走帧率无关指数阻尼，
所以任何情况下画面都不会出现单帧跳变。`npm run test:logic` 中有专门的往返穿界跳变断言。

---

## 遮挡避让原因说明

检查器「遮挡与避让」面板会给出以下状态（HUD 同步显示）：

| kind | 中文含义 | 触发条件 |
| --- | --- | --- |
| `clear` | 视野通畅 | 枢轴 → 期望机位射线无命中 |
| `pull-in` | 前移避让 | 直射被挡，沿原射线收到命中点前 `skin` 处代价最低 |
| `side-shift` | 侧向避让 | 左 / 右移位后视线通畅，且代价比损失距离更小 |
| `combined` | 组合避让 | 侧移后仍有遮挡，继续沿新射线回收 |
| `raise` | 抬高避让 | 抬高机位后视线通畅（或抬高 + 回收） |
| `forced` | 强制贴近 | 所有候选都被挡时的兜底，强制贴到最近命中点前 |

候选列表中绿点表示该候选视线通畅、红点表示仍被挡并标出命中物。
场景中所有带名称的墙 / 箱子 / 立柱都是碰撞体（`userData.occluder`），
右上「碰撞体」开关可以查看它们的包围盒。

---

## 保存与运行时配置

### 完整项目（编辑器用）

「保存项目」/「打开项目」使用 `ProjectData`（见 `src/core/types.ts`），包含区域、路线、默认参数、遮挡设置。
编辑时还会自动写入 localStorage（键 `tp-camera-debugger-project-v1`），刷新不丢。

### 导出给游戏运行时

「**导出运行时镜头配置**」下载 `camera-config.runtime-*.json`，结构为：

```jsonc
{
  "format": "tpc-camera-config",
  "formatVersion": 1,
  "defaultParams": { "distance": 6.5, "shoulder": 0.9, "pitch": 14, /* ... */ },
  "occlusion": { "enabled": true, "skin": 0.25, "sideProbe": true, "raiseProbe": true, "smoothing": 0.08 },
  "zones": [
    {
      "id": "zone_door",
      "name": "门洞近距离",
      "priority": 3,
      "shape": { "type": "box", "center": [0.8, 2.5, 0], "size": [5.2, 5, 7], "rotationY": 0, "hysteresis": 0.25 },
      "transition": { "time": 0.35, "easing": "easeOutCubic" },
      "params": { /* 该区域 CameraParams */ },
      "bounds": { "enabled": true, "min": [-7.5, 0.4, -1.75], "max": [3.6, 3.4, 1.75] }
    }
    // ...
  ]
}
```

运行时读取示例：

```ts
const res = await fetch('/config/camera-config.runtime.json');
const cfg = await res.json();

function pickZone(x: number, z: number) {
  // 注意 rotationY 需要把点变换到盒体局部坐标，可直接移植 src/camera/zones.ts
  return cfg.zones
    .filter((zone) => boxContains(zone.shape, x, z))
    .sort((a, b) => b.priority - a.priority)[0];
}
// 进入区域时用 zone.transition 对当前 CameraParams 做缓动；
// 每帧从目标枢轴按 params 球算期望机位，做射线遮挡回收，最后 clamp 到 zone.bounds。
```

---

## 目录结构

```
index.html                  布局骨架（顶栏 / 左右面板 / 视口 HUD / 时间轴）
src/
  main.ts                   装配：渲染循环、播放状态、文件存取、地面加点
  styles.css                全部 UI 样式
  core/
    types.ts                ProjectData / CameraZone / CameraParams / 状态报告等类型
    defaults.ts             内置示例项目（场景数值都在这里）
    easing.ts               缓动曲线、帧率无关阻尼、角度插值
    projectStore.ts         localStorage、JSON 恢复 / 兜底、运行时导出
  camera/
    zones.ts                盒体包含、优先级 + 滞回选择、ParamBlender
    occlusion.ts            射线遮挡与多候选避让求解
    CameraRig.ts            区域→混合→期望机位→避让→Bounds→平滑 总装
  route/
    RouteTimeline.ts        向心 Catmull-Rom + 时间段 + once/loop/pingpong
  scene/
    buildWorld.ts           程序化场景与假角色
    Gizmos.ts               区域盒 / Bounds / 路线 / 射线 / 候选点 / 相机视锥
  ui/
    dom.ts                  极简 h() 与表单控件
    LeftPanel.ts            三个 Tab 外壳
    ZoneTab.ts              区域与镜头参数编辑
    CameraTab.ts            默认参数与遮挡设置
    RouteTab.ts             路径点编辑
    Inspector.ts            右侧实时检查器
scripts/logic-check.ts      纯逻辑自检（npm run test:logic）
```

## 验证情况

- `npm run build` 通过 TypeScript strict 检查与 Vite 打包。
- `npm run test:logic` 验证路线端点 / 循环映射、区域滞回、往返穿界无单帧跳变。
- 端到端巡检（使用本机 Chrome + `puppeteer-core`，不会额外下载 Chromium）：

  ```bash
  npm run build
  npx vite preview --port 4199 --strictPort &
  BASE_URL=http://127.0.0.1:4199/ npm run test:e2e   # 区域/遮挡/边界/导出/刷新恢复 + 截图
  BASE_URL=http://127.0.0.1:4199/ npm run test:ui    # 面板编辑 / 地面加点 / 删除等交互
  ```

  `test:e2e` 会沿整条路线逐点检查：4 个区域都会进入、至少出现一次带中文原因的真实避让、Bounds 至少 clamp 一次、暂停检查器有当前区域 / 目标 / 最终机位、运行时配置与项目 JSON 下载合法、刷新后能从 localStorage 恢复；截图输出到 `tmp/shots/`，下载产物在 `tmp/downloads/`（均已被 `.gitignore` 忽略）。

## 实现说明 / 可移植性

区域选择、滞回、参数混合、路线采样都是不依赖 DOM / Three 渲染的纯逻辑
（`src/camera/zones.ts`、`src/route/RouteTimeline.ts`、`src/core/easing.ts`），
`npm run test:logic` 直接用 `tsx` 跑这些模块。遮挡求解 `src/camera/occlusion.ts`
只依赖 Three 的 `Raycaster`，移植到其它引擎时可按同样的
「直射回收 → 侧移 → 抬高 → 选取代价最小的通畅候选」策略重写。

# 运行时导出格式说明（bone-runtime-anim v1）

编辑器「导出运行时」生成单个 JSON 文件，MIME 为 `application/json`，
UTF-8 编码。该文件被 `runtime/runtime.js` 的 `SkeletonPlayer` 直接加载，
也可供任意游戏引擎自行解析。

## 顶层结构

```jsonc
{
  "format": "bone-runtime-anim",   // 格式标识
  "formatVersion": 1,              // 格式版本号
  "exportedAt": "2026-...ISO...",  // 导出时间
  "name": "项目名",
  "bones": [ /* 骨骼 */ ],
  "parts": [ /* 图片/几何部件 */ ],
  "images": [ /* 内嵌图片资源，可空 */ ],
  "ik": [ /* IK 约束 */ ],
  "animations": [ /* 动作 */ ]
}
```

## bones[ ]：骨骼层级与静止姿势

```jsonc
{
  "id": "bone_xxx",
  "name": "forearmL",
  "parentId": "bone_yyy",          // null 表示根骨骼
  "rest": {                        // 静止姿势的局部变换
    "x": 0, "y": 64,               // 相对父旋转节点的局部平移
    "rotation": 0,                 // 弧度，逆时针为正（屏幕坐标 y 向下）
    "scaleX": 1, "scaleY": 1
  }
}
```

引擎侧 FK 使用两级节点 rig：

- 关节节点 `joint = parentRotNode · T(rest.x, rest.y)`，决定关节世界位置；
- 旋转节点 `rotNode = joint · R(rotation) · S(scaleX, scaleY)`，决定本骨朝向，
  子骨骼与部件都挂在旋转节点下。

这样自身旋转不会移动自己的关节，骨长（子骨 rest 平移的模）在任何旋转下恒定。

## parts[ ]：视觉部件

```jsonc
{
  "id": "part_xxx",
  "name": "左前臂",
  "boneId": "bone_yyy",            // 绑定的骨骼；null 表示不绑定
  "shape": {
    "type": "rect",                // rect | circle | polygon | image
    "width": 60, "height": 70,     // rect
    "radius": 20,                  // circle
    "points": [ {"x":0,"y":0} ],  // polygon
    "imageId": "img_xxx"           // image 类型引用 images[].id
  },
  "offset": { "x": 0, "y": 0, "rotation": 0, "scaleX": 1, "scaleY": 1 },
  "fill": "#4aa3ff", "stroke": "#10233d",
  "opacity": 1, "visible": true
}
```

部件世界矩阵 = 所绑定骨骼的旋转节点矩阵 · 部件 offset 复合矩阵。
绘制顺序按骨骼在 `bones` 数组中的深度优先顺序（同级可用编辑器调整 zOrder）。

## images[ ]：图片资源

```jsonc
{ "id": "img_xxx", "name": "hand.png", "src": "data:image/png;base64,...", "width": 64, "height": 64 }
```

`src` 为 dataURL，工程文件自包含、不依赖外部路径。

## ik[ ]：两段式 IK 约束

```jsonc
{
  "id": "ik_xxx",
  "name": "左腿 IK",
  "rootBoneId": "bone_hip",
  "midBoneId": "bone_knee",
  "effBoneId": "bone_ankle",       // 末端关节
  "bend": 1,                       // 弯曲方向 +1 / -1
  "enabled": true,
  "target": { "x": -26, "y": 6 }   // 静止目标的世界坐标
}
```

运行时每帧求解：余弦定理解出 root/mid 两段的世界方向角，
再换算为局部旋转回写；目标超出 `|root-mid| + |mid-eff|` 最大伸展时标记 `limited`
并把末端钳制到最大伸展处，骨长始终不变。

## animations[ ]：动作

```jsonc
{
  "id": "anim_xxx",
  "name": "行走 walk",
  "frameRate": 24,                 // 帧率
  "frameCount": 24,                // 总帧数
  "loop": true,
  "keys": {                        // 按骨骼 id 索引的关键帧
    "bone_xxx": [
      { "frame": 0, "x": 0, "y": 0, "rotation": 0, "scaleX": 1, "scaleY": 1,
        "easing": "linear" }       // linear|easeIn|easeOut|easeInOut|hold
    ]
  },
  "ikKeys": {                      // 按 IK 约束 id 索引的目标点关键帧
    "ik_xxx": [ { "frame": 0, "x": -26, "y": 6 } ]
  }
}
```

### 插值规则

- 未打关键帧的通道回退到该骨骼的 `rest` 值。
- 线性通道（x/y/scale）做线性插值；rotation 走最短角度路径（归一化到 ±π 后插值），
  保证旋转连续。
- `loop: true` 时，末帧之后的时间会循环包裹到首帧，末帧→首帧之间同样参与插值。
- `hold` 缓动在到达下一关键帧前保持上一关键帧的值（阶跃）。

## 运行时最小用法

```js
const player = new SkeletonPlayer(runtimeData);
player.anim = runtimeData.animations[0];
player.play('行走 walk');

function frame() {
  player.update(dt);                 // dt 秒，内部累积播放时间
  const { world, pos, partWorld } = player.evaluate();
  // world:     每根骨骼旋转节点的仿射矩阵
  // pos:       每个关节的世界坐标
  // partWorld: 每个部件的世界矩阵，直接用于绘制
  requestAnimationFrame(frame);
}
```

# 三维路线辅助线对照页

原生 WebGL2 实现的屏幕等宽三维折线（路线辅助线）本地对照页，无外部依赖。

## 打开方式

直接双击 `index.html`，或：

```bash
python3 -m http.server 8123
# 浏览器打开 http://localhost:8123/index.html
```

## 功能对照

- **屏幕等宽**：线宽按屏幕像素（CSS px）计，镜头推拉时粗细不变；HUD 实时显示实际设备像素宽度
- **近裁面裁剪**：线段穿过镜头前方裁切边界时只显示可见部分，不冒尖刺；深度与场景方块一致
- **拐角**：尖接（miter，可限长）/ 平接（bevel）/ 圆接（round，含圆帽），内置近 180° 掉头、重合点、极短线段用例
- **虚线**：按世界距离或屏幕距离计数；屏幕距离模式每帧按当前投影重排，遮挡不打断计数
- **像素密度**：1x / 跟随设备 / 2x / 0.5x 切换，可导出 PNG 与屏幕预览对比
- **预设与保存**：跨可见边界 / 急折角 / 绕物体三组预设；镜头与路线参数可存 localStorage 或导出 JSON

## URL 参数（便于分享对照）

`index.html#preset=sharp&join=round&dashMode=screen&dashOn=1&width=14&dist=3.5&yaw=1.1&pitch=0.5&scaleMode=2`

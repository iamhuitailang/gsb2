# 测试

本目录包含两套零第三方依赖的测试，只需要本机 Node.js（≥18，内置 WebSocket/fetch）和 Google Chrome。

## 1. 算法单测：修订版帧对齐

```bash
node tests/alignment.test.cjs
```

在 Node 的 vm 中直接加载 `src/revision.js`，用合成画面指纹验证动态规划对齐：

- 插入场景（90 → 105 帧）：插入点前一一对应、插入点后整体后移；
- 删除场景（90 → 85 帧）：被删帧落入 gap 边界且置信度为 0，触发「待人工确认」；
- 意见映射：点意见/时间段意见的新帧号与置信度；
- NCC 性质：相同指纹为 1，不同指纹低于软阈值。

## 2. 端到端测试：真实 Chrome 全流程

先启动带远程调试端口的无头 Chrome：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/vrs-chrome-profile --no-first-run about:blank &
```

再运行（端口可用 `CDP_BASE` 环境变量覆盖）：

```bash
node tests/e2e.cjs
```

通过 Chrome DevTools Protocol 驱动真实浏览器，覆盖 8 组共 40+ 项检查：

1. 打开本地视频并识别帧数/分辨率；
2. 逐帧前进后退、时间码显示与三种格式跳转（帧号/秒/`HH:MM:SS:FF`）；
3. 点意见、矩形标记、时间段、同帧多条编号、归一化坐标缩放贴合、列表筛选排序、点击跳转；
4. 项目 JSON 保存与恢复；
5. 替换修订版：NCC 匹配、意见迁移（60–74 → 75–89）、同帧意见区分、人工确认、修订记录帧数；
6. 迁移后标记渲染；
7. CSV / JSON / HTML 报告导出（含内嵌缩略图、时间码列）；
8. 时间码工具边界（非法帧号拒绝等）。

下载产物默认写入系统临时目录 `vrs-test-downloads/`。

> 端到端测试会逐帧扫描样片指纹（90+105 帧），完整运行约 1–2 分钟。

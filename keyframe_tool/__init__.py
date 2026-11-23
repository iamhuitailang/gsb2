"""关键帧裁切检查工具。

模块划分：
- times:   时间换算（容器绝对时间 <-> 显示时间线）
- ffmpeg:  ffmpeg / ffprobe 进程封装
- probe:   素材探测（显示帧、关键帧、轨道起点、音轨覆盖）
- cuts:    快速裁切 / 逐帧精确裁切的计划与执行
- verify:  成品读回与源帧映射
- report:  核对记录（Markdown + JSON）
- genmedia: 生成带帧号、长短 GOP、提示音的测试素材
- server:  本机 HTTP 页面与 API
"""

__version__ = "1.0.0"

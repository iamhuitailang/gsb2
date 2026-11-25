"""横转竖取景重排工具 (reframer).

只依赖 Python 标准库 + 系统 ffmpeg/ffprobe。
核心数据流: 关注框轨迹(tracks.json) -> 取景时间表(schedule.json) ->
预览 / 竖版成片 / 报告, 预览与成片共用同一份逐帧裁框表达式。
"""

__version__ = "1.0.0"

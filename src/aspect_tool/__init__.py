"""画幅诊断与规范化工具 (local aspect-ratio diagnostics & normalization).

模块划分:
  probe    读取存储/显示宽高、SAR、显示矩阵与时长
  geometry 纯几何: 旋转/方形化/fit/crop 的坐标映射 (不依赖 ffmpeg, 可单测)
  ffmpeg   抽帧与转码封装
  annotate 黑边/有效区/裁切区/标记点的可视化
  normalize 转换编排 + 导出后复检
  fixtures 生成自带测试素材
  compare  同一时间点输入/输出逐帧比较
"""

__version__ = "1.0.0"

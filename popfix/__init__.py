"""popfix —— 录音爆点自动定位与局部修复工具。

模块划分:
  wavio     wav 读写(基于 soundfile, 内部统一 float64)
  synth     程序化生成测试素材(干净参考 + 爆点损伤 + 真值)
  detect    高频残差能量检测爆点候选, 按间隔合并
  manifest  修补清单的加载/保存与手工编辑
  repair    只修确认区间的局部插值修复 + 对齐切片
  verify    对照干净参考核对漏修/误伤/残差
"""

__version__ = "0.1.0"

"""采样率转换试听台（sample-rate conversion bench）。

只依赖 numpy / scipy / matplotlib（GUI 部分），全部处理在本地完成。
"""

__version__ = "1.0.0"

# 常用目标采样率
COMMON_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 192000]

QUALITY_HIGH = "high"   # Kaiser 窗 FIR + 多相滤波（抗混叠）
QUALITY_LOW = "low"     # 线性插值，无抗混叠滤波
QUALITY_LABELS = {
    QUALITY_HIGH: "高质量（多相 FIR，抗混叠）",
    QUALITY_LOW: "低质量（线性插值，无抗混叠）",
}

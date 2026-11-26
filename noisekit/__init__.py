"""noisekit —— 本地录音底噪降噪预览工具。

模块划分:
- dsp:      STFT、谱减降噪、噪声样本语音检出、频谱/波形统计
- audioio:  音频读写与导出命名
- samples:  合成演示样音
- project:  工程文件读写
- server:   仅监听 127.0.0.1 的本地 HTTP 服务与 API
- cli:      命令行入口
"""

__version__ = "1.0.0"
ALGO_VERSION = 1

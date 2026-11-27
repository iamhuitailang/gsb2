"""mp4rescue —— 分段 MP4(fMP4) 崩溃录像抢救工具。

只处理本工具自己生成的 fMP4(empty_moov + moof/mdat 分段),
解析层为纯 Python,ffmpeg 只负责重封装与可解码性校验。
"""

__version__ = "0.1.0"

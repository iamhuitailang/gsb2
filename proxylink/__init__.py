"""proxylink — 本地代理素材挂接与时间位置校验工具。

模块划分：
- timecode: 时间码解析/格式化/帧吸附
- media:    ffprobe 探针与文件签名
- mapping:  标定、时间换算、可靠区间计算
- store:    数据模型与 JSON 持久化
- project:  高层操作（登记、挂接、标定、剪辑点、播放头、重挂接、导出）
- gen_media: 带画面计数标记的测试素材生成
- webui:    本地 Web 界面
- cli:      命令行入口
"""

__version__ = "1.0.0"
SCHEMA_VERSION = 1

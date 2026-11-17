# 虚构样例项目

本目录中的所有“凭据”均为人工编造, 不对应任何真实账号或服务,
仅用于演示 `secretscan` 的检测、去重与脱敏行为。

- `demo_config.env` — 赋值类与厂商格式令牌
- `settings.py` — 高熵字符串、Bearer 令牌与自定义规则
- `demo_private_key.txt` — PEM 私钥块标记
- `assets/logo.bin` — 含 NUL 字节的伪二进制文件, 应被自动跳过

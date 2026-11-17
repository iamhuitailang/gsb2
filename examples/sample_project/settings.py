"""虚构样例源码 —— 所有凭据均为人工编造, 仅用于演示扫描效果。"""

# 普通配置, 不应告警
TIMEOUT_SECONDS = 30
SERVICE_NAME = "billing-demo"

# 赋值类命中 (credential.assignment) 与高熵命中 (entropy.high)
client_secret = "Zx9Qm4Tv7Lk2Pw8Rn5Yc3Hf6Dg1Ja0Nb"

# 厂商已知格式命中
AWS_KEY = "AKIAEXAMPLE111111111"
SLACK_TOKEN = "REDACTED_SLACK_TOKEN_FOR_DEMO"

# HTTP 头中的 Bearer 令牌
AUTHORIZATION_HEADER = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVC"

# 自定义规则命中 (见 examples/secretscan.toml): CORP_TOKEN 不在内置
# 敏感名称列表中, 因此由自定义规则独立产生告警。
CORP_TOKEN = "AbCdEf1234567890Zy"

# 高熵规则独立命中: 变量名不含敏感词, 依靠长度与字符分布信号发现。
RANDOM_SEED_VALUE = "kP8wR2nT6vL9xQ4mZ7cH1fD3sJ5aB0gE"

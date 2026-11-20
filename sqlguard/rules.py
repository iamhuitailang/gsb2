"""规则定义。"""

RULES = {
    "SQLI001": {
        "severity": "high",
        "confidence": "confirmed",
        "message": "外部输入被拼接进 SQL 查询文本，可能导致 SQL 注入",
        "description": (
            "来自命令行参数、环境变量或 Web 请求的外部数据，经过字符串拼接、"
            "格式化或 f-string 进入数据库查询文本。应改用参数化查询。"
        ),
    },
    "SQLI002": {
        "severity": "high",
        "confidence": "confirmed",
        "message": "查询结构（表名/列名等）混入外部输入，参数占位符无法保护标识符",
        "description": (
            "查询中虽然使用了参数占位符，但表名、列名等结构部分仍由外部输入"
            "动态拼入。占位符只保护数据值，不保护标识符，应对结构部分使用"
            "白名单校验。"
        ),
    },
    "SQLI003": {
        "severity": "medium",
        "confidence": "uncertain",
        "message": "外部输入可能进入 SQL 查询，但传播路径经过无法分析的代码，证据不足",
        "description": (
            "污点数据在到达查询前经过了无法静态分析的调用或不确定的分支，"
            "无法确认是否仍然可控，建议人工核查。"
        ),
    },
}

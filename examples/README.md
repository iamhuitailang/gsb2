# 示例项目说明

`sample_app/` 是给扫描器对照结果用的示例代码，**不是可运行的应用**：
其中引用的 `some_unknown_lib`、`external_sanitizer` 等模块并不存在。
扫描器只做语法解析，不需要这些依赖存在。

四类场景：

| 文件 | 场景 | 预期结果 |
| --- | --- | --- |
| `direct_concat.py` | 直接拼接 / f-string / % / format 动态 SQL | 确认风险（vulnerability） |
| `through_helper.py` | 输入经本地辅助函数传递后进入 SQL | 确认风险（vulnerability） |
| `parameterized.py` | 参数绑定写法 | 不报告 |
| `unconfirmed.py` | 经无法确认的第三方调用 | 待复核（review） |

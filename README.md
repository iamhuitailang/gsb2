# pseudonymize — 本地 CSV 敏感字段假名化工具

把多份业务台账 CSV 中的敏感列（手机号、邮箱、客户编号等）替换为**本地密钥保护**的稳定假名，其余列原样保留，输出文件可直接交给分析人员做关联统计。

- 纯 Python 标准库实现，**完全本地运行，不访问任何外部服务**
- 同一关联范围内，相同敏感值跨文件得到相同假名；不同范围之间互不可关联
- 多文件输出作为一个整体：全部成功才落盘，中途失败自动回滚，绝不覆盖已有文件

## 环境要求

Python 3.9+，无第三方依赖。

## 快速开始

```bash
# 1. 生成本地密钥（只需一次）
python3 pseudonymize.py init-key --key-file keys/my.key --key-version v1

# 2. 按任务配置执行假名化
python3 pseudonymize.py run --config task.json --report out/report.json

# 3. 运行测试
python3 -m unittest discover -s tests -v    # 或 python3 -m pytest tests/
```

`examples/` 目录内有完整演示（全部为虚构数据）：

```bash
cd examples
python3 ../pseudonymize.py init-key --key-file keys/demo.key
python3 ../pseudonymize.py run --config config.json --report out/report.json
```

## 任务配置格式

配置为 JSON 文件。其中的相对路径一律**相对于配置文件所在目录**解析。

```json
{
  "key_file": "keys/my.key",
  "files": [
    {
      "input": "data/customers.csv",
      "output": "out/customers.csv",
      "columns": [
        {"name": "客户编号", "field": "customer_id", "scope": "crm"},
        {"name": "手机号", "field": "phone", "scope": "crm", "normalize": "strip"},
        {"name": "邮箱", "field": "email", "scope": "crm", "normalize": "strip_lower"}
      ]
    },
    {
      "input": "data/orders.csv",
      "output": "out/orders.csv",
      "columns": [
        {"name": "客户编号", "field": "customer_id", "scope": "crm"},
        {"name": "联系手机", "field": "phone", "scope": "crm", "normalize": "strip"}
      ]
    }
  ]
}
```

### 列规则字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | CSV 中的列名（按表头精确匹配） |
| `field` | 否 | 逻辑字段标识，默认取 `name`。不同文件里列名不同但含义相同的列（如 `手机号` / `联系手机`），设置相同 `field` 才能互相关联 |
| `scope` | 否 | 关联范围，默认 `default`。同一 `(scope, field)` 内假名稳定一致；不同 scope 之间结果互不可关联 |
| `normalize` | 否 | 比较前归一化方式：`raw`（默认，原文）、`strip`（去首尾空白）、`lower`（不区分大小写）、`strip_lower`（两者兼有） |

### 配置校验（写文件前完成）

以下问题会在**写出任何文件之前**以可读错误报告，退出码为 2：

- 同一文件内同一列配置了重复规则
- 配置的列在输入表头中不存在，或表头本身有重复列名
- 多个文件的输出路径重复、输入输出路径相同、`normalize` 取值非法
- 任一输出文件或报告文件已存在（拒绝覆盖）

## 密钥的初始化与保管

```bash
python3 pseudonymize.py init-key --key-file keys/my.key --key-version v1
```

- 密钥为 32 字节随机数，文件权限固定为 `0600`，已存在时拒绝覆盖
- 密钥文件是假名可复现的唯一依据：**丢失则历史输出无法再关联，泄露则假名保护失效**
- 请把密钥文件与脱敏输出分开保管，不要提交到版本库（本仓库 `.gitignore` 已排除 `*.key`），不要随数据外发
- 轮换密钥时用新的 `--key-version`（如 `v2`）生成新文件；假名前缀中的版本号（`psm-v1-…`）用于区分不同密钥产出的结果，版本号本身不包含密钥内容

## 输出语义

- 假名格式：`psm-<密钥版本>-<16 位十六进制>`，由 `HMAC-SHA256(密钥, scope ‖ field ‖ 归一化值)` 截断生成，不是未加密的普通摘要
- 所有值一律按**文本**处理，不做数字推断：`00123` 的前导零会保留并参与假名计算，`00123`、`0123`、`123` 是三个不同的值
- 空值与行尾缺失值统一输出为**空字符串**（不产生假名）；仅含空白且声明了 `strip` 的值同样归为空
- 未配置的列、表头、行顺序、原始空行均原样保留；输入按 UTF-8（兼容 BOM）读取，输出为 UTF-8
- 同一输入与配置重复运行，输出字节级一致

## 多文件整体提交与回滚

1. 先完成全部配置与表头校验，再检查所有输出路径均不存在
2. 每个文件先写到输出目录下的临时文件
3. 全部临时文件写完后才逐一落位；落位使用硬链接语义，目标已存在则失败而非覆盖
4. 任一步失败（坏文件、磁盘错误、目标冲突）都会撤销已落位的输出并清理临时文件，不会留下"部分成功"的结果

## 运行报告

`run` 会把报告 JSON 打印到标准输出，`--report` 可同时写入文件。报告只包含：密钥版本、每个文件的输入/输出路径、处理行数、被替换的列名。**不包含**原始敏感值、假名值或任何逐行内容，因此无法从报告反推映射关系。密钥文件损坏或报告写入失败时，错误信息只含路径与错误类型，不会把密钥内容带进终端日志。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 可预期的错误（配置、密钥、输入数据、输出冲突等），标准错误中有可读说明 |
| 1 | 未预期的内部错误 |

## 项目结构

```
pseudonymize.py            # 工具本体（单文件，仅标准库）
tests/test_pseudonymize.py # 自动化测试（跨文件关联、范围隔离、前导零、空值、配置错误、回滚等）
examples/                  # 虚构样例数据与演示配置
```

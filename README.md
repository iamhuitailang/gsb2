# secretscan

离线、本地运行的疑似凭据扫描命令行工具。仅依赖 Python 3.11+ 标准库,
**不访问网络、不依赖任何外部服务或第三方包**, 报告与基线全程脱敏,
凭据原文不会写入终端、报告文件或基线文件。

## 功能概览

- 递归扫描指定目录, 默认只检查文本文件; 自动跳过版本控制目录
  (`.git` 等)、明显二进制文件 (按扩展名与 NUL 字节嗅探) 和超过
  大小上限的文件
- 符号链接安全边界: 链接解析后若落在扫描根目录之外则跳过并告警,
  扫描不会被链接带出根目录
- 内置规则覆盖常见凭据赋值、AWS / GitHub / Slack / Google 已知格式、
  PEM 私钥标记和 Bearer 令牌; 另支持基于长度、香农熵与字符分布的
  高熵检测, 可发现不匹配任何已知格式的随机字符串
- 支持在 TOML 配置中声明自定义正则规则; 每条规则都有稳定标识
  (`rule_id`) 与严重级别 (`low` / `medium` / `high` / `critical`)
- 同一段内容命中多条规则时按区间重叠去重, 只保留严重级别最高的一条
- 检测结果包含相对路径、行列位置、规则标识、严重级别、可读原因与
  稳定指纹; 路径不携带扫描根绝对前缀, 命中内容统一替换为
  `***REDACTED***`
- 基线文件以指纹记录已确认发现: 指纹与行号无关, 文件前后增删无关行
  不会让旧发现变成新问题; 已消失与已过期的基线条目分别单独列出
- 文本 / JSON 两种报告, 排序稳定; `--new-only` 只看新增; 退出码
  区分扫描失败、发现问题与没有新问题
- 单个文件不可读、编码异常等只产生过程告警, 不影响其他文件结果

## 快速开始 (从初始化到扫描的完整命令)

```bash
# 1. 首次扫描样例项目 (不带配置时使用内置默认规则)
python3 -m secretscan examples/sample_project

# 2. 使用示例配置 (含自定义规则与高熵参数) 扫描, 输出 JSON 报告
python3 -m secretscan examples/sample_project \
  --config examples/secretscan.toml \
  --format json --output report.json

# 3. 把当前发现写入基线 (已人工确认, 之后不再视为新问题)
python3 -m secretscan examples/sample_project \
  --config examples/secretscan.toml \
  --update-baseline baseline.json

# 4. 日常复扫: 基线之外没有新发现时退出码为 0
python3 -m secretscan examples/sample_project \
  --config examples/secretscan.toml \
  --baseline baseline.json

# 5. 只关心新增发现 (例如接入 CI)
python3 -m secretscan . --baseline baseline.json --new-only
```

## 命令行参数

| 参数 | 说明 |
| --- | --- |
| `root` | 扫描根目录 (位置参数) |
| `-c, --config PATH` | TOML 配置文件, 省略时使用内置默认值 |
| `-b, --baseline PATH` | 基线 JSON; 提供后区分新增 / 已确认 / 过期 / 消失 |
| `--new-only` | 报告只保留基线之外的新增发现 |
| `--update-baseline PATH` | 把本次全部发现原子写入基线后退出, 不输出扫描报告 |
| `-f, --format text\|json` | 报告格式, 默认 `text` |
| `-o, --output PATH` | 报告输出文件, 省略时写到标准输出 |
| `--version` | 打印版本 |

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 扫描成功且没有新增发现 (含基线全部覆盖的情况) |
| `1` | 扫描成功, 但存在基线之外的新增发现 |
| `2` | 扫描未能执行: 根目录缺失、配置无效、基线损坏或报告无法写出 |

## 配置文件格式 (TOML)

完整示例见 [`examples/secretscan.toml`](examples/secretscan.toml),
所有字段均可省略:

```toml
max_file_bytes = 1048576            # 单文件大小上限, 超过则跳过并告警
skip_vcs_dirs = [".git", ".svn"]    # 跳过的版本控制目录名
binary_extensions = [".png", ".zip", ".pdf", ".pyc", ".db"]
enable_builtin_rules = true         # 是否启用内置正则规则

[entropy]
enabled = true
min_length = 20                     # 候选片段最短长度
max_length = 256
min_entropy = 4.0                   # 香农熵下限 (bit)
min_char_classes = 2                # 至少出现的字符类别数
max_digit_ratio = 0.6               # 数字占比上限, 压制时间戳等长数字

# 自定义正则规则, 可声明任意多条
[[rules.custom]]
id = "corp.internal-token"          # 稳定标识: 小写字母/数字/./_/-
pattern = '''CORP_TOKEN\s*=\s*["']?(?P<value>[A-Za-z0-9]{16,})["']?'''
severity = "medium"                 # low | medium | high | critical
reason = "命中公司内部令牌命名约定"
```

说明:

- `pattern` 中若包含名为 `value` 的捕获组, 只对该组的内容告警
  (适合 `name = "secret"` 这类赋值, 避免把变量名也算进命中区间);
  否则对整个匹配告警。
- 配置字段缺失、取值非法、正则无法编译都会在扫描前报错并以退出码
  `2` 终止, 不会带着坏配置静默扫描。
- TOML 字面量字符串 (`'''...'''`) 中的正则转义写单反斜杠,
  例如 `\s`; 普通双引号字符串中则需写成 `\\s`。

## 基线文件与更新方式

基线为 JSON, 每条记录只保存指纹与元数据 (路径、规则、严重级别、
长度、首次记录日期、可选过期日期与备注), **不保存凭据原文**:

```json
{
  "format_version": 1,
  "generated_on": "2026-11-18",
  "entries": [
    {
      "fingerprint": "25b95b2f924e552a",
      "path": "settings.py",
      "rule_id": "entropy.high",
      "severity": "low",
      "reason": "高熵字符串: ...",
      "match_length": 32,
      "first_seen": "2026-11-18",
      "expires_on": null,
      "note": null
    }
  ]
}
```

- **更新基线**: 重新运行 `--update-baseline`, 写入采用临时文件 +
  原子替换; 仍存在的指纹保留原 `first_seen` / `expires_on` / `note`,
  新指纹以当天为 `first_seen`, 已消失的条目不写入。
- **指纹稳定性**: 指纹 = SHA-256(相对路径 + 规则标识 + 命中原文),
  与行号无关, 行号整体平移不会产生新告警。
- **过期条目**: 给条目设置 `"expires_on": "YYYY-MM-DD"`, 日期到达后
  即使仍命中也按新发现处理, 并在报告的“已过期”区单独列出。
- **消失条目**: 基线中存在但本次扫描未出现的条目, 在报告“已消失”
  区单独列出, 不会被静默当作仍有效。
- 基线 JSON 结构损坏、版本不符、字段缺失或指纹重复都会报错并以
  退出码 `2` 终止。

## 输出脱敏

- 所有路径均为相对扫描根的 POSIX 路径, 报告不出现根目录绝对前缀。
- 文本报告的上下文行与 JSON 的 `context_redacted` 字段中, 每个命中
  区间都替换为 `***REDACTED***`; 同一行多个命中全部脱敏。
- 基线只存哈希指纹, 终端、报告、基线三处都不会出现凭据原文。

## 错误处理

| 情况 | 行为 |
| --- | --- |
| 扫描根目录不存在 / 不是目录 | 报错, 退出码 `2` |
| 配置无效 | 报错, 退出码 `2` |
| 基线损坏 | 报错, 退出码 `2` |
| 文件超过 `max_file_bytes` | 跳过并记录 `oversized` 告警 |
| 二进制文件 (扩展名或 NUL 嗅探) | 跳过, 计入二进制跳过数 |
| 文件不可读 | 记录 `read-error` 告警, 其他文件照常出结果 |
| 非 UTF-8 文件 | latin-1 回退解码并记录 `encoding-fallback`, 行列仍准确 |
| 越界符号链接 | 跳过并记录 `symlink-file` / `symlink-dir` 告警 |

## 运行测试

```bash
python3 -I run_tests.py
```

`-I` 以隔离模式运行, 避免从当前目录意外载入同名模块; 启动器会显式
把仓库根加入 `sys.path`。43 个用例覆盖: UTF-8 / latin-1 编码、
重复命中去重、行号变化下的指纹稳定性、过期与消失基线、符号链接
越界边界、输出脱敏、退出码与单文件容错。

## 目录结构

```
secretscan/            # 工具源码 (仅标准库)
  cli.py               # 参数解析与退出码
  config.py            # TOML 配置与校验
  rules.py             # 内置规则、自定义规则、高熵检测与去重
  scanner.py           # 目录遍历、链接边界、文件读取与逐行扫描
  baseline.py          # 基线读写、指纹比对、过期/消失判定
  report.py            # 文本 / JSON 报告与脱敏渲染
  models.py            # Finding / Warning 数据模型与稳定排序
  redaction.py         # 行内容脱敏
examples/
  secretscan.toml      # 示例配置
  sample_project/      # 只含虚构凭据的样例项目
tests/                 # unittest 测试套件
run_tests.py           # 隔离模式测试启动器
```

> 注意: `examples/sample_project/` 与 `tests/` 中的所有凭据均为人工
> 编造的虚构数据, 不对应任何真实账号; 扫描本仓库时这些位置出现
> 告警属于预期行为, 可用基线确认或在 CI 中配合 `--new-only` 忽略。

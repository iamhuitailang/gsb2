# 本地安全基线核查台

一个**完全本地运行、只读、离线**的主机安全基线核查工具。选择一个本地目录，检查其中的
文件/目录权限风险与常见服务配置的不安全项，结果可解释、可比较、可复核，并支持基线快照、
带失效时间的例外和报告导出。

- 纯 Python 3.9+ 标准库实现，**无第三方依赖、无外部账号、无网络请求**
- 核查过程**不修改任何用户文件、不执行被检查目录中的程序或配置**
- 扫描范围严格限制在选定目录内，符号链接一律不跟随
- 口令、令牌、私钥等敏感内容在读取边界统一遮蔽，不出现在页面、日志、状态文件或导出中
- 样例与测试中的全部凭据均为带 `EXAMPLE-FAKE` 标记的虚构值

## 安装

无需安装依赖，克隆后直接使用（要求 Python 3.9 或更高版本）：

```bash
python3 --version          # 确认 3.9+
chmod +x run_tests.sh      # 可选：测试脚本
```

## 启动 Web 页面

```bash
python3 -m baseline_audit serve
# 可选参数：--host 127.0.0.1 --port 8765 --data-dir .audit_data
```

打开浏览器访问 `http://127.0.0.1:8765`，在页面输入待核查目录的**绝对路径**后点击
“开始核查”。服务只绑定回环地址，不监听外部网卡。

页面支持：

- 按风险等级（高/中/低）、发现状态（新增/仍存在/发生变化/已消失）、相对路径关键字筛选
- 点击任一发现查看规则说明、判断理由、修复建议、可复核证据（行号、权限、遮蔽后的配置行）
- 保存核查基线、为具体发现添加带范围与失效时间的例外、撤销例外
- 查看读取/解析/工具三类错误、历次核查记录与审计日志
- 一键导出 JSON 报告（仅含相对路径、规则版本与核查时间）

## 命令行用法

全局参数 `--data-dir` 需放在子命令之前，默认为当前目录下的 `.audit_data`：

```bash
# 执行一次只读核查
python3 -m baseline_audit --data-dir .audit_data scan /path/to/target

# 查看历史核查
python3 -m baseline_audit runs /path/to/target

# 把最近一次核查保存为基线（可加 --run-id 指定历史记录）
python3 -m baseline_audit baseline /path/to/target

# 为发现添加例外（--expires-at 为 UTC 时间，留空表示永久）
python3 -m baseline_audit exception /path/to/target F-xxxxxxxx \
    --scope finding --expires-at 2026-12-31T23:59:59 --reason "已接受风险"

# 导出报告（JSON，只含相对路径）
python3 -m baseline_audit export /path/to/target > report.json

# 查看审计日志
python3 -m baseline_audit log
```

## 生成虚构样例

```bash
python3 tools/generate_samples.py                 # 默认生成到 samples/demo-target
python3 tools/generate_samples.py /tmp/demo-target
```

样例目录覆盖：过宽权限（777/666/setuid/setgid/无粘滞位公共目录）、收紧权限对照、
sshd/nginx/apache/systemd/env 配置风险、明文凭据与私钥、非 UTF-8 与二进制配置、
越界/循环/断裂/目录内符号链接、不可读目录。可重复运行，脚本会幂等重建样例。

快速体验：

```bash
python3 tools/generate_samples.py
python3 -m baseline_audit serve
# 浏览器中输入 samples/demo-target 的绝对路径
```

## 运行测试

```bash
./run_tests.sh
# 或
python3 -m unittest discover -s tests -v
```

53 个测试覆盖：安全与风险权限、符号链接越界与循环、服务配置解析、重复核查的身份稳定性、
基线变化与损坏、例外到期与严格身份匹配、敏感内容遮蔽（结果/日志/导出/状态文件）、
部分文件失败隔离、只读保证与 Web API。依赖文件权限位的断言在 root 下会自动 skip。

## 支持的规则范围

当前规则版本 `1.0.0`（规则内容指纹随每次核查与导出一并记录）。

**权限类**

| 规则 ID | 风险 | 说明 |
| --- | --- | --- |
| PERM-WORLD-WRITABLE-FILE | 高 | 文件对所有用户可写 |
| PERM-WORLD-WRITABLE-DIR | 中 | 目录全局可写且无粘滞位（有粘滞位的 1777 不报） |
| PERM-SETUID | 高 | 文件设置 setuid 位 |
| PERM-SETGID | 中 | 文件设置 setgid 位 |
| PERM-SENSITIVE-WORLD-READABLE | 中 | 密钥/凭据/.env 等敏感文件全局可读 |
| PERM-GROUP-WRITABLE-CONFIG | 低 | 配置文件组可写 |

**服务配置类**（按文件名/后缀识别：sshd_config、nginx.conf、httpd.conf/apache2.conf、
`.service`、`.env`、`.ini`、`.conf`/`.cfg`/`.config`）

| 规则 ID | 风险 | 说明 |
| --- | --- | --- |
| SVC-SSHD-PERMIT-ROOT-LOGIN | 高 | sshd 允许 root 直接登录 |
| SVC-SSHD-PASSWORD-AUTH | 中 | sshd 启用口令认证 |
| SVC-NGINX-HTTP-LISTEN | 低 | nginx 明文 HTTP 监听 |
| SVC-APACHE-HTTP-LISTEN | 低 | Apache 明文 HTTP 监听 |
| SVC-SYSTEMD-ROOT-USER | 低 | systemd 服务以 root 运行 |
| SVC-SYSTEMD-WRITABLE-EXEC | 高 | ExecStart 启动路径组/全局可写 |
| SVC-INSECURE-BIND-ALL | 低 | 监听 0.0.0.0 暴露全部网卡 |
| SVC-PLAINTEXT-SECRET | 高 | 配置中出现明文口令/令牌/私钥（值不落盘） |

## 安全设计说明

- **范围控制**：遍历起点解析为真实路径，整个过程不跟随任何符号链接。越界链接、链接循环、
  断裂链接、目录内链接分别产生 `read_error` 提示；越界目标的内容与文件名不会进入结果。
- **三类错误分离**：文件/目录读取失败（`read_error`）、配置解析失败（`parse_error`，
  含非 UTF-8、二进制、超大文件）、工具自身/状态数据错误（`tool_error`，含基线损坏）
  分别呈现；单个文件异常不影响其他文件，也不会清除已得到的结果。
- **稳定身份**：发现 ID = 哈希(规则 ID + 相对路径 + 规则内维度)，与行号和具体值无关。
  重复核查据此区分新增/仍存在/变化/消失；路径或规则不再对应时，旧发现只标记为消失，
  旧例外不会套用到其他发现。
- **基线与规则版本**：基线保存规则版本号与规则内容指纹；规则变化或基线文件损坏时
  页面与报告明确告警，不静默沿用旧结论。
- **敏感遮蔽**：键名保留、值统一替换为 `[REDACTED]`，另存仅由值哈希得到的短指纹用于
  判断“值是否变化”；自由文本（例外理由、日志）另有高熵令牌兜底遮蔽。
- **路径安全**：内部存储与所有导出只使用相对路径；绝对路径仅存在于服务进程内存的
  会话 token 映射中，页面刷新后需重新选择目录。
- **状态隔离**：核查历史、基线、例外、审计日志保存在工具数据目录（默认 `.audit_data`），
  该目录即使位于被核查树内也会被自动排除，且永不写入被核查目录。

## 已知限制

1. 规则集面向常见基线场景，不是完整的 CIS/等保对标；ACL、xattr、能力位(capabilities)、
   SELinux/AppArmor 上下文暂不分析。
2. 服务配置采用行式静态解析，覆盖常见写法；复杂的 include 嵌套、变量展开、条件片段
   （nginx if、systemd specifier、Apache 表达式）不会被求值，可能漏报。
3. systemd ExecStart 仅检查选定目录内可映射到的可执行文件；目录之外的目标不越界检查，
   也不臆测结论。
4. 明文凭据识别基于键名/格式模式与高熵特征，可能存在漏报（未知命名）或误报；
   工具只遮蔽、不判断凭据是否有效。
5. 权限语义按 POSIX 模式位实现；Windows 平台仅能做有限检查，建议在 macOS/Linux 上使用。
6. 以 root 运行核查时，操作系统本身的权限限制不生效，相关测试会自动跳过；
   日常建议用普通账号运行。
7. Web 会话 token 保存在内存中，服务重启或页面刷新后需要重新选择核查目录（这是有意的
   最小化设计，避免在磁盘或浏览器中持久化绝对路径）。

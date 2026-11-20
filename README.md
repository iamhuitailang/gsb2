# 本地软件更新包验收工具（update_tool）

一个**纯离线**的更新包验收演示工具：开发者生成带签名的更新包，维护人员在隔离目录里检查、试装，确认无误后再切换到新版本。不连接任何更新服务器，不改动机器上已有的软件——所有状态只写在工具自己的 `--root` 目录里。

只依赖 Python 3.9+ 标准库，干净环境即可运行。

## 快速开始

```bash
# 一键端到端演示（生成密钥 → 打包 → 验收 → 试装 → 激活 → 篡改拒绝 → 回滚）
python3 examples/run_demo.py

# 跑全部自动化测试
python3 -m unittest discover -s tests -v
```

## 命令一览

所有命令形如 `python3 -m update_tool [--root DIR] <命令>`。`--root` 是工具的演示状态目录，默认 `./updtool_state`（也可用环境变量 `UPDATE_TOOL_ROOT` 指定）。

| 命令 | 作用 |
|---|---|
| `keygen [--name N] [--bits 2048] [--no-trust]` | 生成本地演示签名密钥对，默认同时加入受信列表 |
| `trust-list` | 查看受信公钥及状态（active / revoked） |
| `trust-add <公钥文件>` | 把一把公钥加入受信列表（新增下一把钥匙） |
| `trust-revoke <key_id>` | 撤销钥匙；此后它签发的包一律拒绝，且不能重新加入 |
| `pack --content DIR --product P --channel C --version V --key-id K --out F` | 把内容目录打成带签名的更新包（`.tar.gz`） |
| `inspect <包>` | 完整验收一个包，只检查，不改变安装状态 |
| `trial-install <包>` | 验收通过后试装到隔离 staging 目录，**不影响当前版本** |
| `activate --product P --channel C` | 把试装中的版本切换为当前版本 |
| `rollback --product P --channel C` | 回滚到激活历史中的上一个版本 |
| `discard-staged --product P --channel C` | 丢弃试装中的版本 |
| `status [--product P] [--channel C]` | 查看当前安装状态 |

典型流程：

```bash
python3 -m update_tool keygen --name release-2026
python3 -m update_tool trust-list          # 记下 key_id
python3 -m update_tool pack --content ./my-app-files --product demo-app \
    --channel stable --version 1.1.0 --key-id <key_id> --out pkg-1.1.0.tar.gz
python3 -m update_tool inspect pkg-1.1.0.tar.gz
python3 -m update_tool trial-install pkg-1.1.0.tar.gz
python3 -m update_tool status              # 试装中: 1.1.0，当前版本不变
python3 -m update_tool activate --product demo-app --channel stable
```

## 目录结构（都在 `--root` 下）

```
updtool_state/
├── keys/private/<key_id>.json   # 私钥，权限 600，绝不写进日志
├── keys/public/<key_id>.json    # 公钥
├── trust/trusted.json           # 受信钥匙库（active / revoked）
├── install/<产品>/<通道>/
│   ├── state.json               # 当前版本、激活历史、试装中的版本（原子写）
│   ├── staging/                 # 试装内容（隔离区，不影响当前版本）
│   └── versions/<版本>/         # 已激活版本的完整内容
├── tmp/                         # 验收过程中的临时解包目录
├── lock                         # 互斥锁（带 pid，进程死亡后自动识别）
└── logs/results.jsonl           # 可读的结果记录（不含任何密钥材料）
```

## 更新包格式与验收规则

包是一个 `.tar.gz`，内含 `manifest.json`、`manifest.sig` 和 `payload/` 下的全部文件。清单绑定：**产品、更新通道、版本、最低工具版本，以及每个文件的相对路径 + SHA-256 + 大小**。

`inspect` / `trial-install` 按顺序做以下检查，任何一条失败都拒绝：

1. **归档安全**：只允许 `manifest.json`、`manifest.sig` 和 `payload/` 下的普通文件；拒绝绝对路径、`..` 越界、反斜杠、符号链接/硬链接/设备文件、规范化后重名的条目；限制文件数量（1 万）、单文件大小（256 MiB）和总解包体积（512 MiB）。解包不用 `extractall`，逐个校验后写盘并做 realpath 包含检查，内容只会落在目标目录内。
2. **清单合法**：缺字段、重复路径、路径规范化后冲突（如 `a/b` 与 `a/./b`）、非法版本号一律拒绝。
3. **签名**：签发钥匙必须在本地受信列表中且未被撤销，签名本身有效（演示用 RSA+SHA-256，见下方安全说明）。
4. **工具版本**：包的 `min_tool_version` 不能超过本工具版本（当前 1.0.0）。
5. **内容核对**：解包到隔离临时目录后双向比对——缺文件、清单之外的多余文件、大小或摘要不符，全部拒绝。

## 版本与状态规则

- 试装只写 `staging/`，当前生效版本不受影响；验收不通过根本不会进入试装。
- 激活时版本按通道**单调前进**：旧版本、相同版本都不能覆盖新版本；回退只能显式用 `rollback`。
- 不同产品、不同通道的状态各自独立，互不干扰。
- 同一时刻只允许一个更新操作（`lock` 文件互斥）；并发执行时第二个操作会失败退出，不会互相覆盖。

## 失败后的处理

- **验收失败**：什么都不改变，错误信息说明原因；`logs/results.jsonl` 留下一条可读记录。
- **试装冲突**：已有别的版本在试装中时，`trial-install` 会拒绝并提示先 `activate` 或 `discard-staged`。
- **激活中途崩溃**：状态文件先写 `.tmp` 再原子替换；崩溃后 `state.json` 仍一致地指向旧版本。直接重新执行同一条 `activate` 即可——工具会发现文件已就位，补写状态完成激活。崩溃留下的 `lock` 会在下次运行时按 pid 自动识别为陈旧锁并清理。
- **模拟激活中断**（不需要手工改任何文件）：

  ```bash
  UPDATE_TOOL_CRASH_AT=after-move python3 -m update_tool \
      activate --product demo-app --channel stable
  ```

  可注入点：`before-move`（移动文件前）、`after-move`（移动后、写状态前）、`after-state`（写完状态后）。
- **锁残留**：若确认另一个操作已退出而锁未被自动清理，删除 `--root/lock` 后重试即可。

## 测试

```bash
python3 -m unittest discover -s tests -v
```

覆盖：正常签发与验收、内容篡改（负载/清单）、清单缺项与路径冲突、多余文件、未受信钥匙、钥匙撤销与轮换、归档逃逸（`..`、绝对路径、符号链接、硬链接、设备文件）、版本单调前进、重复提交、产品/通道隔离、回滚、激活中断恢复（真实子进程崩溃）、并发互斥、日志不含私钥材料。

## 安全说明

这是**离线演示工具**，不是生产方案：

- 签名用的是纯标准库实现的演示版 RSA（`update_tool/crypto.py`），未做侧信道防护；真实环境请换成经过审计的库（如 Ed25519）。
- 私钥明文存放在 `--root/keys/private/`（权限 600），仅用于本地演示。
- 信任模型是单机的 `trusted.json`，没有证书链和远程分发。

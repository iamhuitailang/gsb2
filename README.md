# authdemo — 账号校验与口令摘要迁移演示（仅本机运行）

一个纯 Python 标准库实现的演示工具：管理员导入旧账号数据，用户用虚构账号登录；
登录成功时按账号现有摘要版本自动升级到当前格式，全程不放松校验规则。
不连接任何真实身份服务，所有账号均为虚构。

## 摘要格式

| 版本 | 格式 | 说明 |
|------|------|------|
| v1（旧） | `v1:<md5_hex>` | 无盐 MD5 |
| v2（旧） | `v2:<salt_hex>:<sha256_hex>` | 盐化 SHA-256 |
| v3（当前） | `v3:<iterations>:<salt_hex>:<hex>` | PBKDF2-HMAC-SHA256 |

## 启动方法（无需安装依赖，Python 3.10+）

```bash
# 1. 生成虚构旧账号数据（摘要文件，不含明文口令）
python3 scripts/generate_sample_data.py

# 2. 导入（自动识别版本；缺字段/未知版本/损坏记录进入 needs_review）
python3 -m authdemo import data/legacy_accounts.jsonl --db demo.db

# 3. 登录（省略 --password 会安全地提示输入）
python3 -m authdemo login alice --db demo.db

# 4. 管理员查看迁移结果（不含任何可用于登录的凭据）
python3 -m authdemo report --db demo.db
python3 -m authdemo events --db demo.db        # 审计/迁移事件日志
```

虚构账号口令（仅演示用）：`alice/alice-demo-pass-1`(v1)、
`bob/bob-demo-pass-2`(v2)、`carol/carol-demo-pass-3`(v3)、
`dave/dave-demo-pass-1`(v1)、`erin/erin-demo-pass-2`(v2)。
示例数据中还包含未知版本、损坏、缺字段、版本不一致的坏记录用于演示导入处理。

## 运行自动化检查

```bash
python3 -m unittest discover -s tests -v
```

覆盖：正确/错误口令、登录后升级且升级摘要持续有效、失败登录不改写账号、
8 线程并发登录同一旧账号（CAS 升级，无丢失更新、不重置 login_count）、
迁移中断（崩溃后账号仍可用、下次登录重试升级）、损坏/未知/不一致记录导入、
重复导入不覆盖、报告与日志不含明文口令或完整摘要、数据库文件中无明文口令。

## 关键设计

- **升级不放宽校验**：先用旧格式严格校验口令，通过后才计算并写入 v3 摘要；
  失败登录对账号数据零写入。
- **并发安全**：升级用 compare-and-swap（`UPDATE ... WHERE digest=<旧值>`），
  较晚完成的旧摘要写回不会覆盖已升级的摘要；升级只动 digest/version/migrated_at，
  不触碰其他账号状态。
- **安全失败**：未知版本、损坏、版本列与摘要串不一致的记录一律拒绝登录
  （`account_unavailable`），绝不放行。
- **不泄露凭据**：日志与审计表只记录用户名和版本号；`report` 不输出摘要；
  明文口令只存在于生成脚本和本 README（均为虚构），不落库、不进日志。
- **迁移留痕**：`migration_log` 表记录 imported / migrated / migration_skipped /
  migration_failed / needs_review 等事件，供管理员审计。

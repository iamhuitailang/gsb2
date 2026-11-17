# gsb2 · 本地角色管理后台（可核对审计）

一个只在本机运行的角色管理后台，带可独立核对的审计记录、导出与只读校验。

## 快速开始

```sh
make demo    # 生成演示数据：两个机构、六条普通管理记录、两份导出副本
make test    # 运行全部测试
make serve   # http://127.0.0.1:8787/
```

演示账号（密码见 `app/demo.py` 中的 `PASSWORD`）：

| 账号 | 机构 | 规则集 |
| --- | --- | --- |
| `jia`（甲管理员） | `org-alpha` 甲公司 | `rbac-cn-2026.1` |
| `yi`（乙管理员） | `org-beta` 乙公司 | `rbac-cn-2026.2` |

## 审计能力

**留痕范围**：添加角色（`role.grant`）、收回角色（`role.revoke`）、替换角色
（`role.change`）无论成功还是失败都会写入审计记录；跨机构越权尝试记为
`access.denied`。每条记录固定包含：操作人 `actor`、针对对象 `target`、角色
`role`、变更前后 `changes`、所用规则集 `rule_set`（含规则定义摘要
`detail.rule_set_digest`）、结果 `outcome`、原因 `reason`、时间 `created_at`
与机构内序号 `seq`。

**原子提交**：角色表变更与对应审计记录、以及审计基准中的承诺条目，写入同一个
SQLite 事务（主库 + ATTACH 的基准库，均使用非 WAL 日志模式）。任一步失败则
整体回滚；被规则拒绝的请求会回滚业务变更但仍提交失败记录。

**只读约束**：普通管理员只能查询本机构（越界请求返回 403 并留痕）。审计表与
基准表都由触发器禁止 `UPDATE`/`DELETE`，Web 层也不提供编辑、删除入口。

**脱敏**：所有审计字段在落库前经过 `canonical.redact()`，按键名（`password`、
`token`、`api_key`……）与值模式（`Bearer`、JWT、`key=value`）双重清洗；落库前
还会用 `contains_sensitive()` 复核，命中则拒绝写入。

## 完整性模型

- 每条记录的内容摘要：`digest = sha256(canonical_json(payload_fields))`
- 记录哈希：`record_hash = sha256(prev_hash + "\n" + digest)`
- `prev_hash` 指向上一条的 `record_hash`，首条为 64 个 `0`
- 审计基准（`audit-baseline.db`）与主库**分开存放**，逐条保存
  `audit_id/org_id/seq/created_at/digest/prev_hash/record_hash`，扮演独立的
  锚点，避免“用导出文件自证清白”。

导出副本（`/audit/export`，可限定 `first_seq`/`last_seq`）包含
`selection`、`payload_fields`、逐条 `manifest`、`first_prev_hash`、
`last_record_hash` 与 `bundle_digest`，任何第三方都能据此独立复核顺序与内容。

## 校验入口

`/verify` 只读地核对所选副本：

1. 逐条用**内容**重算摘要与记录哈希，不采信副本自带的值；
2. 校验副本内部哈希链是否逐条衔接；
3. 与**本地审计基准**逐字段比对（机构、序号、时间、摘要、前序哈希、记录哈希），
   基准中不存在的记录直接判定失败；
4. 用基准（而非副本的 `selection`）计算覆盖范围，报告缺失区间；
5. 以 `mode=ro` 打开主库做交叉比对。

判定结果：`verified`（顺序、内容一致且覆盖完整）、`incomplete`（已包含部分
一致但缺少区间）、`failed`。校验过程不写入主库或基准；测试会用字节级比对确认
两个数据库文件在校验前后完全不变。

独立的离线核对脚本（不导入本应用代码）：

```sh
python3 tools/verify_export.py data/exports/org-alpha-full.json \
    --baseline data/audit-baseline.db --org org-alpha
```

## 演示场景

`make demo` 生成两份副本并跑一遍校验：

| 副本 | 内容 | 期望结果 |
| --- | --- | --- |
| `org-alpha-full.json` | 甲公司 seq 1–3 | `verified`：顺序与内容一致 |
| `org-alpha-tail-only.json` | 甲公司 seq 2–3 | `incomplete`：缺少 seq 1 这一段 |

校验后原始审计页仍显示全部 3 条记录。

## 目录

```
app/canonical.py   规范化序列化、摘要、链式哈希、脱敏
app/store.py       SQLite 存储、审计追加、基准附件、追加-only 触发器
app/rules.py       两套版本化角色规则
app/service.py     授权、角色变更、失败审计
app/report.py      导出包生成与只读校验
app/web.py         本地 Web 后台（登录、角色、审计、校验）
app/demo.py        演示数据与场景
app/cli.py         命令行入口
tools/             独立核对脚本、测试脚本
tests/             单元测试与 HTTP 端到端测试
```

## 边界说明

- 密码使用 stdlib `scrypt` 存储；审计记录从不保存密码或令牌。
- 基准库能证明“导出内容与本地承诺一致”，但若攻击者同时篡改主库与基准库，
  需要把基准周期性复制到独立介质（例如离线备份）才能进一步提高保证。
- 服务默认仅监听 `127.0.0.1`，面向单机部署。

# 调价审核 · 委托值班（演示小后台）

主管休假前，可以把**指定门店**、**指定动作**、**指定起止时间**的调价审核权限临时委托给值班员。
值班员接受后即可代审这些门店的申请；主管自己的权限不受影响。

零依赖，只用 Node.js 内置模块（Node ≥ 18）。

```bash
npm start          # http://localhost:4173
npm test           # 领域 + HTTP 测试
```

数据保存在内存里，重启即恢复样例数据。

## 样例数据

| 角色 | 员工 | 说明 |
| --- | --- | --- |
| 区域主管 | 甲 | 门店一、门店二都有查看 / 通过 / 驳回权限 |
| 值班员 | 乙 | 无自有审核权限，已接受甲的委托：**门店一，2 小时** |
| 门店店员 | 丙 | 无审核权限，提交了各门店的调价申请 |

两家门店各有若干条待审 / 已处理申请；「演示控制」页可以快进、回拨或跳到任意时间，
并可以收回 / 恢复甲的直接权限。

## 关键规则

- **委托三要素**：门店范围、允许的动作（审核通过 / 驳回，审核动作自动包含查看）、起止时间。
- **只能委托自有权限**：发起委托时逐门店逐动作校验，范围不能超过委托人"当前直接拥有"的权限。
- **代来的权限不能再转委托**：校验时只认直接授予，乙拿代来的门店一权限去委托第三人会被拒
  （`DELEGATION_CANNOT_BE_REDELEGATED`）。
- **动态取交集**：受托权限 = 委托动作 ∩ 委托人此刻的直接权限。主管权限被收回时，
  代审权限立即消失，不需要额外的清理任务。
- **到期 / 提前结束**：待办列表实时过滤；直接打开或刷新审核页都会被 403 拦住；
  提交时会再次校验，所以在审核页停留期间委托到期也无法提交。
- **必须接受**：委托创建后为「待接受」，被委托人接受后且在时间窗内才生效。
- 主管自己的直接权限全程有效，审核记录里会写明是通过「自有权限」还是「代审」处理的。

## 页面

- `/` 待办：只列出当前身份**此刻真的能处理**的申请，并标注权限来源（自有 / 代 X 审核、委托到期时间）。
- `/delegations` 委托管理：我发起的 / 我受托的委托，接受、拒绝、提前结束，新建委托。
- `/demo` 演示控制：本地演示时钟、主管权限开关、演示脚本。
- `/applications/:id` 审核页：详情、意见、通过 / 驳回；权限失效时展示被拦截原因与错误码。

页面每 4 秒轮询一次，委托到期或权限收回应在数秒内反映到待办和已打开的审核页
（提交时会同步再校验，不依赖轮询）。

## 走查脚本

1. 以 **乙** 打开 `/`：只有门店一的申请（"代 甲 审核"），门店二看不到。
2. 直接访问门店二的审核地址 `/applications/a3`：被 403 拦住，提示没有权限。
3. 打开门店一某条申请的审核页，保持页面打开，去 `/demo` 快进 2 小时（或等乙的委托到期）。
4. 回到审核页：按钮变灰、提示已无提交权限；直接刷新得到「委托已到期」拦截页。
5. 在 `/demo` 收起甲的「门店一 直接权限」：乙的待办里门店一条目立即消失，
   已打开的审核页同样不能再提交。
6. 切到 **甲**：甲的待办仍包含两家门店，委托不影响主管自有权限。
7. 以 **乙** 打开 `/delegations`：没有新建入口（代来的权限不能再转委托）。

## 设计要点

- `server/permissions.js` 是所有权限判断的唯一来源：直接权限、委托状态机、
  有效权限（并集）、以及"为什么被拒"的可解释原因。列表、详情、提交三处复用同一套函数，
  避免前端藏按钮而后端漏校验。
- 委托只存"意图"（门店 + 动作 + 时间窗 + 接受状态），**不复制权限**；
  每次判定都现场与委托人当前权限求交集，所以收回主管权限无需级联更新。
- 演示时钟仅影响服务端判定时间（`clockOffsetMs`），前端展示服务端返回的 `clock.now`，
  不做本地时间推断。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap?userId=` | 员工、门店、权限、委托、待办、演示时钟 |
| POST | `/api/delegations` | 新建委托 |
| POST | `/api/delegations/:id/accept` | 被委托人接受 |
| POST | `/api/delegations/:id/decline` | 被委托人拒绝 |
| POST | `/api/delegations/:id/end` | 发起人提前结束 |
| GET | `/api/applications/:id?userId=` | 审核页数据（无权返回 403 + 原因码） |
| POST | `/api/applications/:id/decision` | 通过 / 驳回（服务端重新校验） |
| POST | `/api/clock` | `{ offsetMs }` 或 `{ iso }` 调整演示时钟 |
| POST | `/api/demo/grants` | `{ userId, storeId, active }` 收回 / 恢复直接权限 |

错误统一返回 `{ error: { code, message } }`，常见 code：

`SCOPE_EXCEEDS_OWN_PERMISSION`、`DELEGATION_CANNOT_BE_REDELEGATED`、`DELEGATION_EXPIRED`、
`DELEGATION_ENDED`、`DELEGATION_NOT_STARTED`、`DELEGATION_NOT_ACCEPTED`、
`DELEGATOR_PERMISSION_REVOKED`、`DIRECT_PERMISSION_REVOKED`、`ACTION_NOT_DELEGATED`、
`NO_PERMISSION`、`APPLICATION_CLOSED`、`SELF_DELEGATION`、`ACTION_REQUIRED`、
`INVALID_TIME_RANGE`、`NOT_DELEGATEE`、`NOT_DELEGATOR`。

## 目录

```
server/store.js        样例数据与内存存储
server/permissions.js  权限与委托状态机（核心）
server/service.js      业务动作与视图
server/server.js       HTTP 与静态文件
public/                原生 HTML/CSS/JS 前端
test/                  领域测试 + HTTP 测试
```

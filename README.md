# gsb2 — 工单系统第三方应用授权演示

工单系统为两个本地演示应用（甲、乙）提供 OAuth 风格授权：

- 用户在确认页**按应用勾选**授权范围：`read:titles`（只读标题）、`update:status`（更新状态）
- 设置页可查看已授权的应用和范围，并可逐个撤销
- 应用使用自己的 `client_id`/`client_secret` 换取访问凭据 + 续期凭据
- 凭据权限不超过用户授权的范围，也不超过当前用户还能访问的工单（请求时校验）
- 撤销某个应用：其访问凭据和续期能力一起失效，其他应用不受影响
- 只读升级为可更新需重新经过用户确认；已发出的只读凭据（含续期所得）仍按原范围处理

## 结构

```
server/app.py            工单系统 + 授权服务 + 设置页（Flask，内存存储）
clients/ticket_client.py 演示应用共用的 API 客户端
clients/app_jia.py       甲应用（client_id: app-jia）
clients/app_yi.py        乙应用（client_id: app-yi）
demo.py                  端到端演示：自动起服务并验证全部场景
```

## 运行

一键演示（无需先启动服务）：

```
python3 demo.py
```

手动体验：

```
python3 server/app.py          # http://localhost:5051
```

- 用户登录：`alice` / `alice123`
- 授权链接示例：`http://localhost:5051/authorize?client_id=app-jia&scope=read:titles`
  （确认后页面显示授权码，粘贴给应用换取凭据）
- 设置页：`http://localhost:5051/settings`
- 应用调用示例：

```
python3 clients/app_jia.py exchange <授权码>
python3 clients/app_jia.py titles <访问凭据>
python3 clients/app_yi.py update <访问凭据> 1 done
```

## 演示场景（demo.py 覆盖）

1. 只给甲读权限：甲能查两张工单标题，更新状态被 403 拒绝
2. 乙先只读、再升级为可更新：升级需重新确认；旧只读凭据及续期所得仍只读
3. 乙用新凭据成功更新工单 #1
4. 设置页显示两个应用及各自范围
5. 撤销乙：乙的访问凭据、续期能力均失效（401），甲仍能查标题、能续期

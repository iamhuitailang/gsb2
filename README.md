# 本地账号登录服务（账号 / 来源双层失败限流）

纯 Python 标准库实现（`http.server` + `sqlite3`），无需安装第三方依赖。
账号失败与来源失败各自独立计数、各自维护窗口截止时间；并发请求在单事务 +
进程锁内串行判定，计数不丢不重；计数与截止时间落库，重启后继续生效。

## 限流规则

| 维度 | 计数键 | 默认上限 | 默认窗口 | 含义 |
| --- | --- | --- | --- | --- |
| 账号层 | 用户名 | **3 次** | 300 秒 | 同一账号无论从哪个来源失败都累计，切来源无法清空 |
| 来源层 | 来源标识 | **5 次** | 600 秒 | 同一来源下无论换哪个账号失败都累计，换账号无法无限重试 |

- 两套窗口**截止时间相互独立**，账号窗过期不影响来源窗，反之亦然。
- 请求先过账号层、再过来源层，任一层达上限即拦截；被拦请求不校验密码、不再写计数。
- 成功登录只清除**该账号自身**的失败计数；来源计数与其他账号一律保留。
- 对外失败响应始终是同一个 HTTP 401 与同一句 `用户名或密码错误`，
  不区分密码错误、账号锁定、来源锁定；具体生效层只写进管理员日志（`account` / `source`）。
- 窗口截止时间基于**演示时钟**判断，时钟偏移持久化，重启后仍按原截止时间判断。

## 来源从哪来

- `POST /api/login`（普通登录）：来源由服务端取 TCP 对端地址（`ip:127.0.0.1`），
  请求体里即使带 `source` 字段也会被忽略，用户无法自己指定来源。
- `POST /api/demo/login`（本地测试入口）：允许请求体传 `source` 模拟不同来源，
  仅允许本机（loopback）访问，来源标识需匹配 `^[A-Za-z0-9_-]{1,64}$`。
- 其余演示/管理接口（时钟、管理员日志）同样仅本机可访问。

## 快速开始

```bash
python3 -m app.main
# 打开 http://127.0.0.1:8080 ，演示账号：
#   jia / jia-pass-123
#   yi  / yi-pass-123
```

页面上可以：推进/回拨/重置演示时钟、选择测试入口或普通接口、模拟不同来源、
查看两套窗口各自的失败次数与截止时间（含“还剩多少秒可重试”）、查看带生效层
标注的管理员日志。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 普通登录，来源取连接地址，忽略自填 `source` |
| POST | `/api/demo/login` | 本地测试入口，可传 `source` |
| POST | `/api/demo/clock` | `{"action":"advance","seconds":N}` 或 `{"action":"reset"}` |
| GET  | `/api/demo/status?username=u&source=s` | 两层窗口的次数、上限、截止时间、retry_after |
| GET  | `/api/demo/admin-log` | 管理员日志（标注 `layer=account/source`） |
| GET  | `/health` | 健康检查与当前演示时钟 |
| GET  | `/` | 演示页面 |

登录请求体：`{"username": "...", "password": "..."}`，测试入口再加 `"source": "..."`。

## 验收样例（与需求对应）

1. jia 在 `demo-src-A` 失败 2 次、`demo-src-B` 失败 1 次 → 账号累计 3 次，账号层锁定。
2. 从新来源 `demo-src-C` 再试，即使密码正确也被账号层拦截，且来源 C 计数保持 0。
3. yi 在用量未满的 `demo-src-C` 上用正确密码登录成功。
4. 把演示时钟推进超过账号窗口截止时间，jia 再用正确密码可以登录。
5. 同一来源下 5 个不同账号各失败 1 次后，第 6 个全新账号被来源层拦截。
6. 重启服务后，锁定状态与截止时间保持不变，仍按原截止时间判断。

以上场景在 `tests/` 中全部自动化覆盖（含 40 线程并发计数与重启持久化）。

## 运行测试

```bash
python3 -m unittest discover -t . -s tests -v
```

## 配置（环境变量）

| 变量 | 默认值 |
| --- | --- |
| `LOGIN_SVC_DATA_DIR` | `./data` |
| `LOGIN_SVC_HOST` / `LOGIN_SVC_PORT` | `127.0.0.1` / `8080` |
| `LOGIN_SVC_ACCOUNT_LIMIT` / `LOGIN_SVC_ACCOUNT_WINDOW` | `3` / `300` |
| `LOGIN_SVC_SOURCE_LIMIT` / `LOGIN_SVC_SOURCE_WINDOW` | `5` / `600` |

## 目录结构

```
app/
  config.py      配置
  storage.py     SQLite 连接、建表、事务与进程锁
  clock.py       演示时钟（偏移持久化，可注入时间源）
  accounts.py    账号与 PBKDF2 密码哈希
  rate_limit.py  双层限流器（判定 + 计数，单事务原子完成）
  admin_log.py   管理员日志（SQLite + 日志文件，标注生效层）
  service.py     服务门面与演示账号播种
  http_server.py HTTP 路由与来源处理
  main.py        启动入口
web/index.html   演示页面
tests/           核心规则与 HTTP 端到端测试
```

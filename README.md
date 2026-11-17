# 本地知识库(目录继承权限 + 显式拒绝)

公司资料按「目录 / 子目录 / 文档」组织。管理员给用户组授予某个目录的查看或编辑权限,
下级默认继承;子目录可以显式拒绝某个组的查看,**拒绝优先于任何其他组的允许**。

## 规则

- 权限(ACL)只挂在目录上,按「组 + 目录 + view/edit + allow/deny」记录。
- 判定从文档所在目录一路向上走到根,收集用户所有组命中的条目:
  1. 任一级出现该用户任一组的 `deny view` → 拒绝(另一组的 allow 无法挽救);
  2. 任一级有 `allow view` / `allow edit` → 可看(编辑蕴含查看);
  3. 编辑需要 `allow edit` 且未被 deny view;默认无授权即不可见;管理员放行。
- 列表、搜索、文档查看、下载全部走 `app/permissions.py` 的同一套判定。
- 文档链接是 `/api/documents/{id}`,不含路径;移动文档/目录后按**新位置**实时判定,
  旧链接无法绕过。
- `GET /api/documents/{id}/permission` 返回判定链,解释继承来自哪个目录、或哪条拒绝生效。

## 运行

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 8000
```

打开 http://127.0.0.1:8000 ,右上角切换用户体验不同权限。
首次启动自动写入样例数据(`data/`,删除该目录可重置):

- 目录:`资料库/`(项目组 allow view)下有 `公开子目录/`(公开文档B)、
  `机密子目录/`(项目组 deny view、设计组 allow view,内有受限文档),根下还有公开文档A。
- 用户:管理员(id=1)、张三 ∈ 项目组(id=2)、王五 ∈ 项目组+设计组(id=3)。

## 演示(样例场景)

```bash
# 张三搜索:能命中公开文档A/B,受限文档被过滤
curl -G -H "X-User-Id: 2" --data-urlencode "q=项目周报" http://127.0.0.1:8000/api/search

# 直接打开受限文档:403,并说明是哪条拒绝生效
curl -H "X-User-Id: 2" http://127.0.0.1:8000/api/documents/3

# 权限详情:解释继承来源 / 生效的拒绝
curl -H "X-User-Id: 2" http://127.0.0.1:8000/api/documents/1/permission

# 管理员把公开文档A移动到机密子目录,旧链接随即打不开
curl -X POST -H "X-User-Id: 1" -H "Content-Type: application/json" \
     -d '{"directory_id": 3}' http://127.0.0.1:8000/api/documents/1/move
curl -H "X-User-Id: 2" http://127.0.0.1:8000/api/documents/1   # 403

# 王五虽在设计组(对机密子目录有 allow),仍被项目组的 deny 拒绝
curl -H "X-User-Id: 3" http://127.0.0.1:8000/api/documents/3   # 403
```

## 测试

```bash
.venv/bin/python -m pytest tests/ -q
```

覆盖:继承授权、显式拒绝、deny 优先于跨组 allow、移动后旧链接失效、
搜索/列表/下载统一过滤、编辑蕴含查看、权限详情解释。

## 结构

```
app/main.py          FastAPI 路由(目录树、文档 CRUD/移动、搜索、下载、ACL 管理、权限详情)
app/permissions.py   统一权限判定与解释(所有入口共用)
app/db.py            SQLite schema
app/seed.py          样例数据
app/static/index.html 极简页面(目录树、搜索、文档查看、权限详情、管理员 ACL 管理)
tests/test_permissions.py
```

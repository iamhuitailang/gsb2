"""权限场景测试:继承、显式拒绝、deny 优先、移动后旧链接失效、统一判定。"""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "kb.db"),
                     files_dir=str(tmp_path / "files"))
    return TestClient(app)


# 种子数据里的固定 id(按插入顺序)
ADMIN, ZHANGSAN, WANGWU = 1, 2, 3
D_ROOT, D_PUBLIC, D_SECRET = 1, 2, 3
DOC_A, DOC_B, DOC_SECRET = 1, 2, 3


def as_user(uid):
    return {"X-User-Id": str(uid)}


def test_search_finds_public_docs_but_not_restricted(client):
    r = client.get("/api/search", params={"q": "项目周报"}, headers=as_user(ZHANGSAN))
    titles = {d["title"] for d in r.json()}
    assert titles == {"公开文档A", "公开文档B"}

    r = client.get("/api/search", params={"q": "薪酬"}, headers=as_user(ZHANGSAN))
    assert r.json() == []


def test_direct_open_of_restricted_doc_is_denied(client):
    r = client.get(f"/api/documents/{DOC_SECRET}", headers=as_user(ZHANGSAN))
    assert r.status_code == 403
    assert "显式拒绝" in r.json()["detail"]
    # 下载走同一套规则
    r = client.get(f"/api/documents/{DOC_SECRET}/download", headers=as_user(ZHANGSAN))
    assert r.status_code == 403


def test_deny_beats_other_group_allow(client):
    # 王五同时在项目组(deny)和设计组(allow),仍被拒绝
    r = client.get(f"/api/documents/{DOC_SECRET}", headers=as_user(WANGWU))
    assert r.status_code == 403


def test_permission_explanation_shows_inheritance_source(client):
    r = client.get(f"/api/documents/{DOC_A}/permission", headers=as_user(ZHANGSAN))
    body = r.json()
    assert body["allowed"] is True
    assert "资料库" in body["reason"]          # 继承自父目录
    assert body["decisive"]["kind"] == "allow"


def test_permission_explanation_shows_effective_deny(client):
    r = client.get(f"/api/documents/{DOC_SECRET}/permission", headers=as_user(ZHANGSAN))
    body = r.json()
    assert body["allowed"] is False
    assert "机密子目录" in body["reason"]
    assert body["decisive"]["kind"] == "deny"


def test_moved_doc_old_link_now_denied(client):
    # 移动前:张三能打开公开文档A
    assert client.get(f"/api/documents/{DOC_A}", headers=as_user(ZHANGSAN)).status_code == 200
    # 管理员把公开文档A移动到机密子目录
    r = client.post(f"/api/documents/{DOC_A}/move", json={"directory_id": D_SECRET},
                    headers=as_user(ADMIN))
    assert r.status_code == 200
    # 旧链接(同一个文档 id)随即打不开
    r = client.get(f"/api/documents/{DOC_A}", headers=as_user(ZHANGSAN))
    assert r.status_code == 403
    # 权限详情解释是新位置的 deny 生效
    body = client.get(f"/api/documents/{DOC_A}/permission",
                      headers=as_user(ZHANGSAN)).json()
    assert body["allowed"] is False
    assert "机密子目录" in body["reason"]
    # 搜索也搜不到了
    r = client.get("/api/search", params={"q": "项目周报"}, headers=as_user(ZHANGSAN))
    assert {d["title"] for d in r.json()} == {"公开文档B"}


def test_tree_and_listing_hide_restricted_subtree(client):
    tree = client.get("/api/tree", headers=as_user(ZHANGSAN)).json()
    names = [n["name"] for n in tree]
    assert "资料库" in names
    child_names = [c["name"] for c in tree[0]["children"]]
    assert "公开子目录" in child_names
    assert "机密子目录" not in child_names
    # 直接访问受限目录也被拒
    r = client.get(f"/api/directories/{D_SECRET}", headers=as_user(ZHANGSAN))
    assert r.status_code == 403


def test_edit_requires_edit_grant(client):
    # 张三只有 view,不能改文档
    r = client.put(f"/api/documents/{DOC_A}",
                   json={"title": "x", "content": "y"}, headers=as_user(ZHANGSAN))
    assert r.status_code == 403
    # 也不能在目录下新建
    r = client.post("/api/documents",
                    json={"directory_id": D_ROOT, "title": "t", "content": "c"},
                    headers=as_user(ZHANGSAN))
    assert r.status_code == 403


def test_edit_grant_implies_view(client):
    # 管理员给项目组在公开子目录加 edit 授权
    groups = client.get("/api/groups", headers=as_user(ADMIN)).json()
    g_project = next(g["id"] for g in groups if g["name"] == "项目组")
    client.post("/api/acl", json={"directory_id": D_PUBLIC, "group_id": g_project,
                                  "permission": "edit", "effect": "allow"},
                headers=as_user(ADMIN))
    # 张三可以编辑公开文档B(edit 蕴含 view)
    r = client.put(f"/api/documents/{DOC_B}",
                   json={"title": "公开文档B", "content": "更新"},
                   headers=as_user(ZHANGSAN))
    assert r.status_code == 200
    assert client.get(f"/api/documents/{DOC_B}", headers=as_user(ZHANGSAN)).status_code == 200


def test_admin_manages_acl_and_bypasses(client):
    assert client.get(f"/api/documents/{DOC_SECRET}",
                      headers=as_user(ADMIN)).status_code == 200
    # 非管理员不能管理 ACL
    r = client.post("/api/acl", json={"directory_id": D_ROOT, "group_id": 1,
                                      "permission": "view", "effect": "allow"},
                    headers=as_user(ZHANGSAN))
    assert r.status_code == 403

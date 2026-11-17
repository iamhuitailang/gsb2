"""FastAPI 入口:目录树、文档 CRUD/移动、搜索、下载、ACL 管理、权限详情。

认证:X-User-Id 请求头(本地演示用)。
所有访问控制都经过 app.permissions 的同一套判定。
"""
import os

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db as dbmod
from . import seed as seedmod
from .permissions import check_directory, check_document, decision_dict

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def create_app(db_path=None, files_dir=None):
    app = FastAPI(title="本地知识库")
    app.state.db_path = db_path or os.environ.get(
        "KB_DB_PATH", os.path.join(BASE_DIR, "..", "data", "kb.db")
    )
    app.state.files_dir = files_dir or os.environ.get(
        "KB_FILES_DIR", os.path.join(BASE_DIR, "..", "data", "files")
    )
    os.makedirs(os.path.dirname(app.state.db_path), exist_ok=True)
    os.makedirs(app.state.files_dir, exist_ok=True)

    conn = dbmod.connect(app.state.db_path)
    dbmod.init_db(conn)
    seedmod.seed(conn, app.state.files_dir)
    conn.close()

    # ---- 依赖 ----
    def get_conn():
        c = dbmod.connect(app.state.db_path)
        try:
            yield c
        finally:
            c.close()

    def current_user(x_user_id: int = Header(...), conn=Depends(get_conn)):
        row = conn.execute("SELECT * FROM users WHERE id = ?", (x_user_id,)).fetchone()
        if row is None:
            raise HTTPException(401, "未知用户")
        return row

    def admin_user(user=Depends(current_user)):
        if not user["is_admin"]:
            raise HTTPException(403, "需要管理员权限")
        return user

    def get_document_or_404(conn, doc_id):
        doc = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise HTTPException(404, "文档不存在")
        return doc

    def get_directory_or_404(conn, dir_id):
        d = conn.execute("SELECT * FROM directories WHERE id = ?", (dir_id,)).fetchone()
        if d is None:
            raise HTTPException(404, "目录不存在")
        return d

    def forbid(decision):
        if not decision.allowed:
            raise HTTPException(403, decision.reason)

    # ---- 模型 ----
    class DirectoryIn(BaseModel):
        name: str
        parent_id: int | None = None

    class MoveIn(BaseModel):
        parent_id: int | None = None
        directory_id: int | None = None

    class DocumentIn(BaseModel):
        directory_id: int
        title: str
        content: str = ""

    class DocumentUpdate(BaseModel):
        title: str
        content: str

    class AclIn(BaseModel):
        directory_id: int
        group_id: int
        permission: str  # view | edit
        effect: str      # allow | deny

    class UserIn(BaseModel):
        name: str
        is_admin: bool = False

    class GroupIn(BaseModel):
        name: str

    class MemberIn(BaseModel):
        user_id: int

    # ---- 用户 / 组 ----
    @app.get("/api/me")
    def me(user=Depends(current_user)):
        return {"id": user["id"], "name": user["name"], "is_admin": bool(user["is_admin"])}

    @app.get("/api/users")
    def list_users(conn=Depends(get_conn), user=Depends(current_user)):
        rows = conn.execute("SELECT id, name, is_admin FROM users").fetchall()
        return [dict(r) for r in rows]

    @app.post("/api/users", status_code=201)
    def create_user(body: UserIn, conn=Depends(get_conn), admin=Depends(admin_user)):
        cur = conn.execute(
            "INSERT INTO users (name, is_admin) VALUES (?, ?)",
            (body.name, int(body.is_admin)),
        )
        conn.commit()
        return {"id": cur.lastrowid}

    @app.get("/api/groups")
    def list_groups(conn=Depends(get_conn), user=Depends(current_user)):
        rows = conn.execute("SELECT id, name FROM groups").fetchall()
        return [dict(r) for r in rows]

    @app.post("/api/groups", status_code=201)
    def create_group(body: GroupIn, conn=Depends(get_conn), admin=Depends(admin_user)):
        cur = conn.execute("INSERT INTO groups (name) VALUES (?)", (body.name,))
        conn.commit()
        return {"id": cur.lastrowid}

    @app.post("/api/groups/{group_id}/members", status_code=201)
    def add_member(group_id: int, body: MemberIn, conn=Depends(get_conn),
                   admin=Depends(admin_user)):
        conn.execute(
            "INSERT OR IGNORE INTO group_members (user_id, group_id) VALUES (?, ?)",
            (body.user_id, group_id),
        )
        conn.commit()
        return {"ok": True}

    # ---- 目录 ----
    def visible_directory_ids(conn, user):
        rows = conn.execute("SELECT id FROM directories").fetchall()
        return {
            r["id"]
            for r in rows
            if check_directory(conn, user, r["id"], "view").allowed
        }

    @app.get("/api/tree")
    def tree(conn=Depends(get_conn), user=Depends(current_user)):
        visible = visible_directory_ids(conn, user)
        rows = [dict(r) for r in conn.execute(
            "SELECT id, parent_id, name FROM directories").fetchall()]
        nodes = {r["id"]: {**r, "children": []} for r in rows if r["id"] in visible}
        roots = []
        for n in nodes.values():
            p = n["parent_id"]
            if p in nodes:
                nodes[p]["children"].append(n)
            else:
                roots.append(n)
        return roots

    @app.get("/api/directories/{dir_id}")
    def get_directory(dir_id: int, conn=Depends(get_conn), user=Depends(current_user)):
        d = get_directory_or_404(conn, dir_id)
        forbid(check_directory(conn, user, dir_id, "view"))
        visible = visible_directory_ids(conn, user)
        children = [dict(r) for r in conn.execute(
            "SELECT id, name FROM directories WHERE parent_id = ?", (dir_id,)).fetchall()
            if r["id"] in visible]
        docs = []
        for r in conn.execute(
                "SELECT id, title FROM documents WHERE directory_id = ?",
                (dir_id,)).fetchall():
            if check_document(conn, user, get_document_or_404(conn, r["id"]), "view").allowed:
                docs.append(dict(r))
        return {"id": d["id"], "name": d["name"], "parent_id": d["parent_id"],
                "children": children, "documents": docs}

    @app.post("/api/directories", status_code=201)
    def create_directory(body: DirectoryIn, conn=Depends(get_conn),
                         user=Depends(current_user)):
        if body.parent_id is not None:
            get_directory_or_404(conn, body.parent_id)
            forbid(check_directory(conn, user, body.parent_id, "edit"))
        elif not user["is_admin"]:
            raise HTTPException(403, "只有管理员能创建根目录")
        cur = conn.execute(
            "INSERT INTO directories (parent_id, name) VALUES (?, ?)",
            (body.parent_id, body.name),
        )
        conn.commit()
        return {"id": cur.lastrowid}

    @app.post("/api/directories/{dir_id}/move")
    def move_directory(dir_id: int, body: MoveIn, conn=Depends(get_conn),
                       user=Depends(current_user)):
        get_directory_or_404(conn, dir_id)
        forbid(check_directory(conn, user, dir_id, "edit"))
        if body.parent_id is not None:
            get_directory_or_404(conn, body.parent_id)
            forbid(check_directory(conn, user, body.parent_id, "edit"))
            # 防止把目录移到自己或后代下面
            cur = body.parent_id
            while cur is not None:
                if cur == dir_id:
                    raise HTTPException(400, "不能移动到自身或其子目录下")
                row = conn.execute(
                    "SELECT parent_id FROM directories WHERE id = ?", (cur,)).fetchone()
                cur = row["parent_id"] if row else None
        elif not user["is_admin"]:
            raise HTTPException(403, "只有管理员能把目录移动到根")
        conn.execute("UPDATE directories SET parent_id = ? WHERE id = ?",
                     (body.parent_id, dir_id))
        conn.commit()
        return {"ok": True}

    @app.get("/api/directories/{dir_id}/permission")
    def directory_permission(dir_id: int, action: str = Query("view", pattern="^(view|edit)$"),
                             conn=Depends(get_conn), user=Depends(current_user)):
        get_directory_or_404(conn, dir_id)
        return decision_dict(check_directory(conn, user, dir_id, action))

    # ---- 文档 ----
    @app.post("/api/documents", status_code=201)
    def create_document(body: DocumentIn, conn=Depends(get_conn),
                        user=Depends(current_user)):
        get_directory_or_404(conn, body.directory_id)
        forbid(check_directory(conn, user, body.directory_id, "edit"))
        cur = conn.execute(
            "INSERT INTO documents (directory_id, title, file_path) VALUES (?, ?, '')",
            (body.directory_id, body.title),
        )
        doc_id = cur.lastrowid
        path = os.path.join(app.state.files_dir, f"doc_{doc_id}.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(body.content)
        conn.execute("UPDATE documents SET file_path = ? WHERE id = ?", (path, doc_id))
        conn.commit()
        return {"id": doc_id}

    @app.get("/api/documents/{doc_id}")
    def get_document(doc_id: int, conn=Depends(get_conn), user=Depends(current_user)):
        doc = get_document_or_404(conn, doc_id)
        forbid(check_document(conn, user, doc, "view"))
        with open(doc["file_path"], encoding="utf-8") as f:
            content = f.read()
        return {"id": doc["id"], "title": doc["title"],
                "directory_id": doc["directory_id"], "content": content}

    @app.put("/api/documents/{doc_id}")
    def update_document(doc_id: int, body: DocumentUpdate, conn=Depends(get_conn),
                        user=Depends(current_user)):
        doc = get_document_or_404(conn, doc_id)
        forbid(check_document(conn, user, doc, "edit"))
        with open(doc["file_path"], "w", encoding="utf-8") as f:
            f.write(body.content)
        conn.execute(
            "UPDATE documents SET title = ?, updated_at = datetime('now') WHERE id = ?",
            (body.title, doc_id),
        )
        conn.commit()
        return {"ok": True}

    @app.delete("/api/documents/{doc_id}")
    def delete_document(doc_id: int, conn=Depends(get_conn), user=Depends(current_user)):
        doc = get_document_or_404(conn, doc_id)
        forbid(check_document(conn, user, doc, "edit"))
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        conn.commit()
        if os.path.exists(doc["file_path"]):
            os.remove(doc["file_path"])
        return {"ok": True}

    @app.post("/api/documents/{doc_id}/move")
    def move_document(doc_id: int, body: MoveIn, conn=Depends(get_conn),
                      user=Depends(current_user)):
        doc = get_document_or_404(conn, doc_id)
        forbid(check_document(conn, user, doc, "edit"))
        get_directory_or_404(conn, body.directory_id)
        forbid(check_directory(conn, user, body.directory_id, "edit"))
        conn.execute("UPDATE documents SET directory_id = ? WHERE id = ?",
                     (body.directory_id, doc_id))
        conn.commit()
        return {"ok": True}

    @app.get("/api/documents/{doc_id}/download")
    def download_document(doc_id: int, conn=Depends(get_conn), user=Depends(current_user)):
        doc = get_document_or_404(conn, doc_id)
        forbid(check_document(conn, user, doc, "view"))
        return FileResponse(doc["file_path"], media_type="text/markdown",
                            filename=f"{doc['title']}.md")

    @app.get("/api/documents/{doc_id}/permission")
    def document_permission(doc_id: int,
                            action: str = Query("view", pattern="^(view|edit)$"),
                            conn=Depends(get_conn), user=Depends(current_user)):
        doc = get_document_or_404(conn, doc_id)
        return decision_dict(check_document(conn, user, doc, action))

    # ---- 搜索(与列表/下载同一套判定) ----
    @app.get("/api/search")
    def search(q: str, conn=Depends(get_conn), user=Depends(current_user)):
        q_lower = q.lower()
        results = []
        for doc in conn.execute("SELECT * FROM documents").fetchall():
            if not check_document(conn, user, doc, "view").allowed:
                continue
            with open(doc["file_path"], encoding="utf-8") as f:
                content = f.read()
            if q_lower in doc["title"].lower() or q_lower in content.lower():
                idx = content.lower().find(q_lower)
                snippet = content[max(0, idx - 40):idx + 60] if idx >= 0 else ""
                results.append({"id": doc["id"], "title": doc["title"],
                                "directory_id": doc["directory_id"],
                                "snippet": snippet})
        return results

    # ---- ACL 管理(管理员) ----
    @app.get("/api/acl")
    def list_acl(directory_id: int, conn=Depends(get_conn), admin=Depends(admin_user)):
        rows = conn.execute(
            """SELECT a.id, a.directory_id, a.group_id, a.permission, a.effect,
                      g.name AS group_name
               FROM acl_entries a JOIN groups g ON g.id = a.group_id
               WHERE a.directory_id = ?""",
            (directory_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    @app.post("/api/acl", status_code=201)
    def create_acl(body: AclIn, conn=Depends(get_conn), admin=Depends(admin_user)):
        if body.permission not in ("view", "edit") or body.effect not in ("allow", "deny"):
            raise HTTPException(400, "permission 须为 view/edit,effect 须为 allow/deny")
        get_directory_or_404(conn, body.directory_id)
        cur = conn.execute(
            "INSERT INTO acl_entries (directory_id, group_id, permission, effect)"
            " VALUES (?, ?, ?, ?)",
            (body.directory_id, body.group_id, body.permission, body.effect),
        )
        conn.commit()
        return {"id": cur.lastrowid}

    @app.delete("/api/acl/{acl_id}")
    def delete_acl(acl_id: int, conn=Depends(get_conn), admin=Depends(admin_user)):
        conn.execute("DELETE FROM acl_entries WHERE id = ?", (acl_id,))
        conn.commit()
        return {"ok": True}

    # ---- 静态页面 ----
    static_dir = os.path.join(BASE_DIR, "static")
    if os.path.isdir(static_dir):
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

    return app


app = create_app()

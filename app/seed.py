"""样例数据:项目组能读父目录,只对「机密子目录」显式拒绝。

目录:
    资料库/                 <- 项目组 allow view
        公开文档A
        公开子目录/
            公开文档B
        机密子目录/           <- 项目组 deny view;设计组 allow view
            受限文档

用户:
    管理员(admin)
    张三 ∈ 项目组
    王五 ∈ 项目组 + 设计组   <- 用于演示"另一组的 allow 救不回 deny"
"""
import os


def _insert_document(conn, files_dir, directory_id, title, content):
    cur = conn.execute(
        "INSERT INTO documents (directory_id, title, file_path) VALUES (?, ?, '')",
        (directory_id, title),
    )
    doc_id = cur.lastrowid
    path = os.path.join(files_dir, f"doc_{doc_id}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    conn.execute("UPDATE documents SET file_path = ? WHERE id = ?", (path, doc_id))
    return doc_id


def seed(conn, files_dir):
    if conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]:
        return False

    os.makedirs(files_dir, exist_ok=True)

    cur = conn.execute("INSERT INTO users (name, is_admin) VALUES ('管理员', 1)")
    # admin_id = cur.lastrowid
    cur = conn.execute("INSERT INTO users (name, is_admin) VALUES ('张三', 0)")
    zhangsan = cur.lastrowid
    cur = conn.execute("INSERT INTO users (name, is_admin) VALUES ('王五', 0)")
    wangwu = cur.lastrowid

    cur = conn.execute("INSERT INTO groups (name) VALUES ('项目组')")
    g_project = cur.lastrowid
    cur = conn.execute("INSERT INTO groups (name) VALUES ('设计组')")
    g_design = cur.lastrowid

    conn.execute(
        "INSERT INTO group_members (user_id, group_id) VALUES (?, ?)", (zhangsan, g_project)
    )
    conn.execute(
        "INSERT INTO group_members (user_id, group_id) VALUES (?, ?)", (wangwu, g_project)
    )
    conn.execute(
        "INSERT INTO group_members (user_id, group_id) VALUES (?, ?)", (wangwu, g_design)
    )

    cur = conn.execute("INSERT INTO directories (parent_id, name) VALUES (NULL, '资料库')")
    d_root = cur.lastrowid
    cur = conn.execute(
        "INSERT INTO directories (parent_id, name) VALUES (?, '公开子目录')", (d_root,)
    )
    d_public = cur.lastrowid
    cur = conn.execute(
        "INSERT INTO directories (parent_id, name) VALUES (?, '机密子目录')", (d_root,)
    )
    d_secret = cur.lastrowid

    _insert_document(conn, files_dir, d_root, "公开文档A", "# 公开文档A\n\n项目周报汇总。\n")
    _insert_document(conn, files_dir, d_public, "公开文档B", "# 公开文档B\n\n项目周报模板。\n")
    _insert_document(conn, files_dir, d_secret, "受限文档", "# 受限文档\n\n薪酬调整方案(机密)。\n")

    # 项目组能读父目录;只对机密子目录显式拒绝查看。
    conn.execute(
        "INSERT INTO acl_entries (directory_id, group_id, permission, effect)"
        " VALUES (?, ?, 'view', 'allow')",
        (d_root, g_project),
    )
    conn.execute(
        "INSERT INTO acl_entries (directory_id, group_id, permission, effect)"
        " VALUES (?, ?, 'view', 'deny')",
        (d_secret, g_project),
    )
    # 设计组在机密子目录有 allow,用于演示 deny 优先(王五仍被拒绝)。
    conn.execute(
        "INSERT INTO acl_entries (directory_id, group_id, permission, effect)"
        " VALUES (?, ?, 'view', 'allow')",
        (d_secret, g_design),
    )

    conn.commit()
    return True

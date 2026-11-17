"""统一权限判定:列表、搜索、查看、下载、权限详情全部走这里。

规则:
1. 从目标目录一路向上到根,收集用户所在各组在每一级命中的 ACL。
2. 显式拒绝优先:链上任一级出现该用户任一组的 deny view -> 拒绝,
   另一组的 allow 无法挽救。
3. allow 继承:链上任一级有 allow view 或 allow edit -> 可看(编辑蕴含查看)。
4. 编辑需要 allow edit 且未被 deny view。
5. 默认无任何 allow 即不可见;管理员放行。
"""
from dataclasses import dataclass, field


@dataclass
class Decision:
    allowed: bool
    action: str
    reason: str
    chain: list = field(default_factory=list)   # 根 -> 叶,每级命中的条目
    decisive: dict | None = None                # 起决定作用的那条条目


def _ancestor_chain(conn, directory_id):
    """返回从根到目标目录的目录列表。"""
    chain = []
    cur = directory_id
    while cur is not None:
        row = conn.execute(
            "SELECT id, name, parent_id FROM directories WHERE id = ?", (cur,)
        ).fetchone()
        if row is None:
            break
        chain.append(row)
        cur = row["parent_id"]
    return list(reversed(chain))


def _user_group_ids(conn, user_id):
    rows = conn.execute(
        "SELECT group_id FROM group_members WHERE user_id = ?", (user_id,)
    ).fetchall()
    return {r["group_id"] for r in rows}


def check_directory(conn, user, directory_id, action):
    """对目录判定 action('view' 或 'edit'),返回 Decision。"""
    if user["is_admin"]:
        return Decision(True, action, "管理员拥有全部权限")

    group_ids = _user_group_ids(conn, user["id"])
    chain = _ancestor_chain(conn, directory_id)

    deny_hit = None      # (entry, directory)
    allow_hits = []      # [(entry, directory)]
    chain_detail = []
    for d in chain:
        entries = conn.execute(
            """SELECT a.id, a.directory_id, a.group_id, a.permission, a.effect,
                      g.name AS group_name
               FROM acl_entries a JOIN groups g ON g.id = a.group_id
               WHERE a.directory_id = ?""",
            (d["id"],),
        ).fetchall()
        matched = [dict(e) for e in entries if e["group_id"] in group_ids]
        chain_detail.append(
            {"directory_id": d["id"], "directory_name": d["name"], "entries": matched}
        )
        for e in matched:
            if e["effect"] == "deny" and e["permission"] == "view":
                deny_hit = (e, d)
            elif e["effect"] == "allow":
                allow_hits.append((e, d))

    if deny_hit:
        e, d = deny_hit
        return Decision(
            False,
            action,
            f"显式拒绝生效:组「{e['group_name']}」在目录「{d['name']}」被拒绝查看"
            f"(拒绝优先于其他组的允许)",
            chain_detail,
            {"entry": e, "directory_name": d["name"], "kind": "deny"},
        )

    if action == "view":
        for e, d in allow_hits:
            return Decision(
                True,
                "view",
                f"允许查看:继承自目录「{d['name']}」对组「{e['group_name']}」的 "
                f"{e['permission']} 授权",
                chain_detail,
                {"entry": e, "directory_name": d["name"], "kind": "allow"},
            )
        return Decision(False, "view", "没有任何可继承的授权", chain_detail, None)

    # action == 'edit'
    for e, d in allow_hits:
        if e["permission"] == "edit":
            return Decision(
                True,
                "edit",
                f"允许编辑:继承自目录「{d['name']}」对组「{e['group_name']}」的 edit 授权",
                chain_detail,
                {"entry": e, "directory_name": d["name"], "kind": "allow"},
            )
    return Decision(False, "edit", "没有可继承的编辑授权", chain_detail, None)


def check_document(conn, user, document, action):
    """对文档判定:按文档当前所在目录实时求值(移动后旧链接自动按新位置判断)。"""
    return check_directory(conn, user, document["directory_id"], action)


def decision_dict(decision: Decision) -> dict:
    return {
        "allowed": decision.allowed,
        "action": decision.action,
        "reason": decision.reason,
        "decisive": decision.decisive,
        "chain": decision.chain,
    }

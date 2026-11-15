"""样例交付数据：一个初始批 + 两批增量。

工单 TK-1001 的轨迹特意设计为：
  第 1 批（初始批）新建 → 第 2 批修改状态为「处理中」→ 第 3 批删除。
最终查询库中查不到它，但历史里能看到「修改」和「删除」两次变化。
"""


def ticket(tid, title, customer, status, priority, assignee, updated_at):
    return {
        "id": tid,
        "title": title,
        "customer": customer,
        "status": status,
        "priority": priority,
        "assignee": assignee,
        "updated_at": updated_at,
    }


def upsert(t):
    return {"op": "upsert", "ticket": t}


def delete(tid, reason):
    return {"op": "delete", "ticket_id": tid, "reason": reason}


BATCHES = [
    {
        "batch_no": 1,
        "kind": "full",
        "created_at": "2026-11-12T09:30:00+08:00",
        "note": "初始批：全量工单快照",
        "shards": [
            {
                "name": "b01-shard-01.json",
                "records": [
                    upsert(ticket("TK-1001", "打印机无法连接网络", "王女士", "待处理", "高", "刘洋", "2026-11-11 15:20")),
                    upsert(ticket("TK-1002", "账号被临时锁定", "陈先生", "处理中", "中", "赵敏", "2026-11-11 16:05")),
                    upsert(ticket("TK-1003", "发票抬头填写错误", "李女士", "已完成", "低", "刘洋", "2026-11-11 16:40")),
                ],
            },
            {
                "name": "b01-shard-02.json",
                "records": [
                    upsert(ticket("TK-1004", "退款进度查询", "周先生", "待处理", "中", "赵敏", "2026-11-11 17:10")),
                    upsert(ticket("TK-1005", "登录验证码收不到", "吴女士", "处理中", "高", "赵敏", "2026-11-11 17:35")),
                    upsert(ticket("TK-1006", "套餐变更咨询", "郑先生", "已完成", "低", "刘洋", "2026-11-11 18:00")),
                ],
            },
        ],
    },
    {
        "batch_no": 2,
        "kind": "incremental",
        "created_at": "2026-11-13T09:30:00+08:00",
        "note": "增量 1：新增 / 修改 / 删除混合",
        "shards": [
            {
                "name": "b02-shard-01.json",
                "records": [
                    # TK-1001 第一次变化：状态由「待处理」改为「处理中」
                    upsert(ticket("TK-1001", "打印机无法连接网络", "王女士", "处理中", "高", "刘洋", "2026-11-13 09:12")),
                    upsert(ticket("TK-1007", "会员积分未到账", "孙女士", "待处理", "中", "赵敏", "2026-11-13 09:20")),
                ],
            },
            {
                "name": "b02-shard-02.json",
                "records": [
                    delete("TK-1005", "用户已撤销咨询"),
                    upsert(ticket("TK-1006", "套餐变更咨询", "郑先生", "已完成", "中", "刘洋", "2026-11-13 10:05")),
                ],
            },
        ],
    },
    {
        "batch_no": 3,
        "kind": "incremental",
        "created_at": "2026-11-14T09:30:00+08:00",
        "note": "增量 2：删除 TK-1001 等",
        "shards": [
            {
                "name": "b03-shard-01.json",
                "records": [
                    # TK-1001 第二次变化：被删除（本批先发时不得生效）
                    delete("TK-1001", "与 TK-1007 重复，合并处理"),
                    upsert(ticket("TK-1002", "账号被临时锁定", "陈先生", "已解决", "中", "赵敏", "2026-11-14 09:10")),
                ],
            },
            {
                "name": "b03-shard-02.json",
                "records": [
                    delete("TK-1004", "超时自动关闭"),
                    upsert(ticket("TK-1008", "宽带移机申请", "冯先生", "待处理", "高", "刘洋", "2026-11-14 09:25")),
                    upsert(ticket("TK-1003", "发票抬头填写错误", "李女士", "已完成", "低", "赵敏", "2026-11-14 09:28")),
                ],
            },
        ],
    },
]


def batch_by_no(batch_no):
    for b in BATCHES:
        if b["batch_no"] == batch_no:
            return b
    raise KeyError(f"未知批号: {batch_no}")

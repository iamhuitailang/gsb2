"""样例文件清单与读取。

样例只从仓库内的 ``samples/`` 目录读取，文件名经过白名单匹配，
不接受路径片段，避免任意文件读取。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import SAMPLES_DIR

_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$")

OVERSIZE_SAMPLE = "16-reject-oversize.json"


def _oversize_text() -> str:
    """按需生成一份超出体积上限的样例，避免仓库里存放 600 KB 文件。"""

    document = {
        "schema_version": "1.0",
        "package": {
            "id": "oversize-demo",
            "name": "超出体积样例",
            "description": "超大描述 " + ("A" * 600_000),
            "revision": 1,
        },
        "default_action": "deny",
        "rules": [
            {
                "id": "allow-dns",
                "name": "允许内网 DNS 查询",
                "priority": 10,
                "action": "allow",
                "direction": "outbound",
                "protocols": ["udp"],
                "source_cidrs": ["10.20.0.0/16"],
                "destination_cidrs": ["10.20.0.53/32"],
                "destination_ports": [53],
            }
        ],
    }
    return json.dumps(document, ensure_ascii=False, indent=2) + "\n"


@dataclass(frozen=True)
class SampleMeta:
    filename: str
    title: str
    kind: str  # valid / reject
    expectation: str
    focus: str


_SAMPLE_CATALOG: tuple[SampleMeta, ...] = (
    SampleMeta(
        "01-valid-baseline.json",
        "基线策略包",
        "valid",
        "校验通过，可直接作为初始生效版本",
        "可信基线：DNS、HTTPS 出口与管理端口拒绝",
    ),
    SampleMeta(
        "02-valid-changed.json",
        "变更后的策略包",
        "valid",
        "先导入基线，再预览此包可看到差异",
        "预览差异：修改 1 条、新增 1 条、删除 1 条",
    ),
    SampleMeta(
        "10-reject-duplicate-key.json",
        "重复字段名",
        "reject",
        "解析阶段拒绝（duplicate_key）",
        "action 字段出现两次，后者不得静默覆盖前者",
    ),
    SampleMeta(
        "11-reject-unknown-field.json",
        "未知字段",
        "reject",
        "结构校验拒绝（unknown_field）",
        "package.owner 与 rule.log_level 不在契约内",
    ),
    SampleMeta(
        "12-reject-type-mismatch.json",
        "类型不符",
        "reject",
        "结构校验拒绝（type_mismatch）",
        "enabled / priority / protocols 类型错误",
    ),
    SampleMeta(
        "13-reject-conflict.json",
        "标识冲突与矛盾条件",
        "reject",
        "语义校验拒绝（duplicate_rule_id / conflicting_rules）",
        "同优先级条件重叠但动作相反；规则 id 重复",
    ),
    SampleMeta(
        "14-reject-unsupported-version.json",
        "不支持的版本",
        "reject",
        "结构校验拒绝（unsupported_schema_version）",
        "schema_version 为 2.0，不在支持列表",
    ),
    SampleMeta(
        "15-reject-deep-nesting.json",
        "嵌套过深",
        "reject",
        "解析阶段拒绝（depth_exceeded）",
        "规则内嵌入超过 8 层的数组",
    ),
    SampleMeta(
        "16-reject-oversize.json",
        "体积超限",
        "reject",
        "解析阶段拒绝（document_too_large）",
        "描述字段约 600 KB，超过 512 KiB 上限",
    ),
    SampleMeta(
        "17-reject-semantic.json",
        "语义错误",
        "reject",
        "语义校验拒绝（invalid_cidr / invalid_port_range / icmp_with_ports）",
        "主机位非零、端口区间倒置、ICMP 带端口",
    ),
)


def list_samples() -> list[dict[str, Any]]:
    return [
        {
            "filename": meta.filename,
            "title": meta.title,
            "kind": meta.kind,
            "expectation": meta.expectation,
            "focus": meta.focus,
            "available": True,
        }
        for meta in _SAMPLE_CATALOG
    ]


def read_sample(filename: str) -> dict[str, Any]:
    if not _NAME_RE.match(filename):
        raise ValueError("样例文件名不合法")
    meta = next((m for m in _SAMPLE_CATALOG if m.filename == filename), None)
    if meta is None:
        raise KeyError(filename)

    if filename == OVERSIZE_SAMPLE:
        text = _oversize_text()
    else:
        path = (SAMPLES_DIR / filename).resolve()
        if path.parent != SAMPLES_DIR.resolve() or not path.is_file():
            raise KeyError(filename)
        text = path.read_text(encoding="utf-8")

    return {
        "filename": filename,
        "title": meta.title,
        "kind": meta.kind,
        "expectation": meta.expectation,
        "focus": meta.focus,
        "text": text,
        "size": len(text.encode("utf-8")),
    }


def baseline_document() -> dict[str, Any]:
    return json.loads(read_sample("01-valid-baseline.json")["text"])

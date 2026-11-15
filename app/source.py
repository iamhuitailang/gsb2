"""来源模拟：把批次渲染成「清单 + 分片」，清单和分片可分别、乱序送达。

每次交付的清单记录本批文件数、每个文件名和 SHA-256 摘要。
"""
import hashlib
import json
from dataclasses import dataclass

from .samples import BATCHES, batch_by_no


def ticket_digest(rec):
    """单条记录的摘要，清单里的「摘要」列即按此口径计算。"""
    canonical = json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass
class Delivery:
    """一份待送出的清单或分片。"""

    batch_no: int
    kind: str  # "manifest" | "shard"
    filename: str
    body: bytes

    def as_json(self):
        return {
            "batch_no": self.batch_no,
            "kind": self.kind,
            "filename": self.filename,
            "body": json.loads(self.body),
        }


def build_manifest(batch):
    """生成本批清单（不含分片正文）。"""
    files = []
    for shard in batch["shards"]:
        body = json.dumps(shard["records"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        files.append(
            {
                "filename": shard["name"],
                "sha256": hashlib.sha256(body).hexdigest(),
                "size": len(body),
                "record_count": len(shard["records"]),
                "record_digests": [ticket_digest(r) for r in shard["records"]],
            }
        )
    return {
        "kind": "manifest",
        "batch_no": batch["batch_no"],
        "batch_kind": batch["kind"],
        "created_at": batch["created_at"],
        "note": batch["note"],
        "file_count": len(files),
        "files": files,
        "manifest_sha256": manifest_digest(batch["batch_no"], batch["kind"], files),
    }


def manifest_digest(batch_no, batch_kind, files):
    canonical = json.dumps(
        {"batch_no": batch_no, "batch_kind": batch_kind, "files": files},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def deliveries(batch_no):
    """返回该批的全部交付件：清单 + 所有分片。"""
    batch = batch_by_no(batch_no)
    out = [Delivery(batch_no, "manifest", f"batch-{batch_no:04d}-manifest.json", json.dumps(build_manifest(batch), ensure_ascii=False, indent=2).encode("utf-8"))]
    for shard in batch["shards"]:
        body = json.dumps(shard["records"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        out.append(Delivery(batch_no, "shard", shard["name"], body))
    return out


def all_delivery_specs():
    """给网页用：列出全部批次及其交付件，便于按钮逐个发送。"""
    result = []
    for b in BATCHES:
        manifest = build_manifest(b)
        items = [
            {
                "batch_no": b["batch_no"],
                "kind": "manifest",
                "filename": f"batch-{b['batch_no']:04d}-manifest.json",
                "summary": f"{manifest['file_count']} 个文件 / {sum(f['record_count'] for f in manifest['files'])} 条记录",
                "sha256": manifest["manifest_sha256"],
            }
        ]
        for f in manifest["files"]:
            items.append(
                {
                    "batch_no": b["batch_no"],
                    "kind": "shard",
                    "filename": f["filename"],
                    "summary": f"{f['record_count']} 条记录 / {f['size']} 字节",
                    "sha256": f["sha256"],
                }
            )
        result.append(
            {
                "batch_no": b["batch_no"],
                "kind": b["kind"],
                "note": b["note"],
                "created_at": b["created_at"],
                "items": items,
            }
        )
    return result

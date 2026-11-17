"""本地 JSON 持久化：策略库与分析历史。

设计要点：

* 全部数据保存在本地工作目录下的单个 JSON 文件，绝不发送到网络；
* 每条分析记录都保存评估时刻的**策略快照**（含策略全文与模式），
  之后删除、替换策略都不会改写历史，历史始终能看出当时用的是哪份规则；
* 文件损坏时不静默清空，而是把坏文件改名隔离后重新初始化，并返回提示。
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Optional

from .engine import ResourceRequest, evaluate_all
from .parser import parse_policy


class StorageError(Exception):
    pass


class Storage:
    def __init__(self, path: str):
        self.path = path
        self.data = {"policies": [], "records": []}
        self._load()

    # ---------- 底层读写 ----------
    def _load(self) -> None:
        if not os.path.exists(self.path):
            self._flush()
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict) or "policies" not in data or "records" not in data:
                raise ValueError("数据文件结构不符合预期")
            self.data = data
        except (json.JSONDecodeError, ValueError, OSError) as exc:
            quarantine = f"{self.path}.corrupt-{int(time.time())}"
            try:
                os.replace(self.path, quarantine)
            except OSError:
                quarantine = ""
            self.data = {"policies": [], "records": []}
            self._flush()
            raise StorageError(
                f"数据文件损坏，已隔离为 {quarantine or '（无法改名）'} 并重新初始化：{exc}"
            ) from exc

    def _flush(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    @staticmethod
    def new_id() -> str:
        return uuid.uuid4().hex[:12]

    # ---------- 策略管理 ----------
    def list_policies(self) -> list[dict]:
        return list(self.data["policies"])

    def get_policy(self, policy_id: str) -> Optional[dict]:
        for p in self.data["policies"]:
            if p["id"] == policy_id:
                return p
        return None

    def add_policy(self, name: str, text: str, mode: str = "enforce") -> dict:
        """新增策略。解析不过关直接抛错，绝不把问题规则当空策略入库。"""
        parsed = parse_policy(text)
        if not parsed.ok:
            raise StorageError("策略存在解析错误，已拒绝入库")
        policy = {
            "id": self.new_id(),
            "name": name.strip() or "未命名策略",
            "text": text,
            "mode": mode if mode in ("enforce", "report") else "enforce",
            "created_at": time.time(),
            "warnings": [i.to_dict() for i in parsed.warnings],
        }
        self.data["policies"].append(policy)
        self._flush()
        return policy

    def replace_policy(self, policy_id: str, name: str, text: str, mode: str) -> dict:
        """整份替换策略。历史记录保留旧快照，不被改写。"""
        parsed = parse_policy(text)
        if not parsed.ok:
            raise StorageError("策略存在解析错误，已拒绝替换")
        for p in self.data["policies"]:
            if p["id"] == policy_id:
                p["name"] = name.strip() or "未命名策略"
                p["text"] = text
                p["mode"] = mode if mode in ("enforce", "report") else "enforce"
                p["updated_at"] = time.time()
                p["warnings"] = [i.to_dict() for i in parsed.warnings]
                self._flush()
                return p
        raise StorageError(f"策略 {policy_id} 不存在")

    def delete_policy(self, policy_id: str) -> None:
        before = len(self.data["policies"])
        self.data["policies"] = [p for p in self.data["policies"] if p["id"] != policy_id]
        if len(self.data["policies"]) == before:
            raise StorageError(f"策略 {policy_id} 不存在")
        self._flush()

    # ---------- 分析与历史 ----------
    def analyze(self, policy_ids: list[str], request_dict: dict) -> dict:
        entries = []
        snapshots = []
        for pid in policy_ids:
            policy = self.get_policy(pid)
            if policy is None:
                raise StorageError(f"策略 {pid} 不存在或已被删除")
            parsed = parse_policy(policy["text"])
            if not parsed.ok:
                raise StorageError(f"策略「{policy['name']}」当前文本存在解析错误，无法判定")
            entries.append(
                {"id": policy["id"], "name": policy["name"], "mode": policy["mode"], "parsed": parsed}
            )
            # 关键：快照在判定时刻固定下来，后续删改策略不影响历史
            snapshots.append(
                {
                    "id": policy["id"],
                    "name": policy["name"],
                    "mode": policy["mode"],
                    "text": policy["text"],
                }
            )

        request = ResourceRequest(**request_dict)
        result = evaluate_all(entries, request)
        record = {
            "id": self.new_id(),
            "time": time.time(),
            "request": request.to_dict(),
            "decision": result.decision,
            "reason_summary": result.reason_summary,
            "resolved": result.resolved,
            "policy_snapshots": snapshots,
            "policy_decisions": [d.to_dict() for d in result.policy_decisions],
            "reports": [d.to_dict() for d in result.reports],
        }
        self.data["records"].append(record)
        self._flush()
        return record

    def list_records(
        self,
        decision: Optional[str] = None,
        resource_type: Optional[str] = None,
        policy_id: Optional[str] = None,
        mode: Optional[str] = None,
        keyword: Optional[str] = None,
    ) -> list[dict]:
        records = list(self.data["records"])
        if decision:
            records = [r for r in records if r["decision"] == decision]
        if resource_type:
            records = [r for r in records if r["request"]["resource_type"] == resource_type]
        if policy_id:
            records = [
                r for r in records
                if any(s["id"] == policy_id for s in r["policy_snapshots"])
            ]
        if mode:
            records = [
                r for r in records
                if any(s["mode"] == mode for s in r["policy_snapshots"])
            ]
        if keyword:
            kw = keyword.lower()
            records = [
                r for r in records
                if kw in r["reason_summary"].lower()
                or kw in json.dumps(r["request"], ensure_ascii=False).lower()
                or kw in json.dumps(r["policy_snapshots"], ensure_ascii=False).lower()
            ]
        # 新记录在前
        return sorted(records, key=lambda r: r["time"], reverse=True)

    def clear_records(self) -> None:
        self.data["records"] = []
        self._flush()

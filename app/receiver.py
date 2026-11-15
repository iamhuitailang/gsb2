"""接收台 + 本地查询库。

设计要点
--------
* 收件落盘：每个文件先写临时文件、fsync、再原子改名。进程在收件途中重启，
  已收到且校验过的文件仍在磁盘上，重启后可直接继续使用。
* 摘要核对：清单自身有 manifest_sha256；每个分片按清单里的 sha256 校验，
  并逐条比对清单中的记录摘要。
* 顺序生效：批号连续。后一批可以先收件（staged），但只有上一批生效后才
  依次 cascade 生效。同一批号只产生一条发布记录。
* 增量语义：upsert / delete。删除只影响当前查询库，历史永久保留。
"""
import hashlib
import json
import os
import threading
from datetime import datetime, timezone, timedelta

CST = timezone(timedelta(hours=8))


def now_iso():
    return datetime.now(CST).isoformat(timespec="seconds")


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def canonical(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class ReceiverError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Receiver:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.incoming = os.path.join(self.root, "incoming")
        self.library_path = os.path.join(self.root, "library.json")
        os.makedirs(self.incoming, exist_ok=True)
        self.lock = threading.RLock()
        self.publishes = []       # 发布记录，按批号唯一
        self.tickets = {}         # 当前查询库：id -> ticket
        self.history = []         # 全部变更历史
        self.seq = 0
        self._load()

    # ---------------- 持久化 ----------------
    def _load(self):
        if os.path.exists(self.library_path):
            with open(self.library_path, "rb") as fh:
                data = json.loads(fh.read().decode("utf-8"))
            self.publishes = data.get("publishes", [])
            self.tickets = data.get("tickets", {})
            self.history = data.get("history", [])
            self.seq = data.get("seq", 0)
        # 启动时补一次顺序生效（防止上次在「最后一个文件落盘」与「发布」之间崩溃）
        self._cascade_publish()

    def _persist_library(self):
        data = {
            "publishes": self.publishes,
            "tickets": self.tickets,
            "history": self.history,
            "seq": self.seq,
        }
        atomic_write(self.library_path, json.dumps(data, ensure_ascii=False, indent=1).encode("utf-8"))

    def _batch_dir(self, batch_no):
        return os.path.join(self.incoming, f"batch-{batch_no:04d}")

    def _read_received(self, batch_no):
        """读取某批已落盘的文件：文件名 -> bytes。"""
        d = self._batch_dir(batch_no)
        out = {}
        if not os.path.isdir(d):
            return out
        for name in sorted(os.listdir(d)):
            if name.endswith(".tmp"):
                continue
            p = os.path.join(d, name)
            if os.path.isfile(p):
                with open(p, "rb") as fh:
                    out[name] = fh.read()
        return out

    def _received_batches(self):
        if not os.path.isdir(self.incoming):
            return set()
        out = set()
        for name in os.listdir(self.incoming):
            if name.startswith("batch-") and os.path.isdir(os.path.join(self.incoming, name)):
                try:
                    out.add(int(name.split("-", 1)[1]))
                except ValueError:
                    pass
        return out

    def _write_incoming(self, batch_no, filename, body):
        d = self._batch_dir(batch_no)
        os.makedirs(d, exist_ok=True)
        atomic_write(os.path.join(d, filename), body)

    # ---------------- 收件 ----------------
    def ingest(self, batch_no, kind, filename, body):
        """收下一个文件（清单或分片）。可任意顺序、重复送达。"""
        with self.lock:
            batch_no = int(batch_no)
            if batch_no < 1:
                raise ReceiverError(400, "批号必须为正整数")
            filename = os.path.basename(filename)
            if not filename or filename.startswith(".") or "/" in filename or "\\" in filename:
                raise ReceiverError(400, "非法文件名")
            if kind not in ("manifest", "shard"):
                kind = "manifest" if filename.endswith("-manifest.json") else "shard"
            if kind == "shard" and filename.endswith("-manifest.json"):
                kind = "manifest"
            if isinstance(body, str):
                body = body.encode("utf-8")
            if not isinstance(body, (bytes, bytearray)):
                raise ReceiverError(400, "body 必须是字符串或字节")
            body = bytes(body)

            already_published = any(p["batch_no"] == batch_no for p in self.publishes)
            if already_published:
                return {
                    "accepted": False,
                    "duplicate": True,
                    "reason": f"第 {batch_no} 批已发布，重复送达不再产生新的发布记录",
                    "state": self.status(),
                }

            payload = None
            if kind == "manifest":
                try:
                    payload = json.loads(body.decode("utf-8"))
                except Exception as exc:
                    raise ReceiverError(400, f"清单不是合法 JSON：{exc}")
                if not isinstance(payload, dict) or payload.get("kind") != "manifest":
                    raise ReceiverError(400, "清单格式不正确")
                try:
                    manifest_batch = int(payload.get("batch_no"))
                except (TypeError, ValueError):
                    raise ReceiverError(400, "清单缺少合法批号")
                if manifest_batch != batch_no:
                    raise ReceiverError(400, "清单批号与送达批号不一致")
                if not isinstance(payload.get("files"), list):
                    raise ReceiverError(400, "清单缺少 files")
                filename = f"batch-{batch_no:04d}-manifest.json"
            else:
                try:
                    json.loads(body.decode("utf-8"))
                except Exception as exc:
                    raise ReceiverError(400, f"分片不是合法 JSON：{exc}")

            existing = self._read_received(batch_no)
            if filename in existing:
                if existing[filename] == body:
                    return {
                        "accepted": False,
                        "duplicate": True,
                        "reason": f"{filename} 内容一致，重复送达已忽略",
                        "state": self.status(),
                    }
                # 未发布前允许重送覆盖（例如修正损坏文件）
            self._write_incoming(batch_no, filename, body)
            published = self._cascade_publish()
            return {
                "accepted": True,
                "duplicate": False,
                "replaced": filename in existing,
                "published": published,
                "state": self.status(),
            }

    def _batch_info(self, batch_no):
        """解析某批：清单、已收文件、完整性/摘要校验结果。"""
        received = self._read_received(batch_no)
        manifest_name = f"batch-{batch_no:04d}-manifest.json"
        manifest = None
        manifest_error = None
        raw = received.get(manifest_name)
        if raw is not None:
            try:
                manifest = json.loads(raw.decode("utf-8"))
                if not isinstance(manifest, dict) or manifest.get("kind") != "manifest":
                    raise ValueError("kind 不是 manifest")
                if int(manifest.get("batch_no", -1)) != batch_no:
                    raise ValueError("清单批号不一致")
                expect = manifest.get("manifest_sha256")
                actual = manifest_digest(manifest.get("batch_no"), manifest.get("batch_kind"), manifest.get("files") or [])
                if expect != actual:
                    raise ValueError("清单自身摘要不符")
                if int(manifest.get("file_count", -1)) != len(manifest.get("files") or []):
                    raise ValueError("file_count 与 files 数量不一致")
            except Exception as exc:
                manifest_error = str(exc)
                manifest = None

        expected = []
        if manifest:
            expected = [f.get("filename") for f in manifest.get("files", [])]

        problems = []
        if manifest_error:
            problems.append(f"清单校验失败：{manifest_error}")

        verified_files = {}
        if manifest:
            for f in manifest.get("files", []):
                fname = f.get("filename")
                body = received.get(fname)
                if body is None:
                    continue
                if sha256_bytes(body) != f.get("sha256"):
                    problems.append(f"{fname} 摘要不符")
                    verified_files[fname] = False
                    continue
                try:
                    records = json.loads(body.decode("utf-8"))
                except Exception:
                    problems.append(f"{fname} 不是合法 JSON")
                    verified_files[fname] = False
                    continue
                if not isinstance(records, list):
                    problems.append(f"{fname} 内容不是记录列表")
                    verified_files[fname] = False
                    continue
                digests = [record_digest(r) for r in records]
                if digests != (f.get("record_digests") or []):
                    problems.append(f"{fname} 记录摘要与清单不一致")
                    verified_files[fname] = False
                    continue
                bad = [r for r in records if not record_is_valid(r)]
                if bad:
                    problems.append(f"{fname} 含 {len(bad)} 条无法识别的记录")
                    verified_files[fname] = False
                    continue
                verified_files[fname] = True
            extras = [n for n in received if n not in expected and n != manifest_name]
            if extras:
                problems.append("收到清单外的文件：" + ", ".join(sorted(extras)))
        missing = [n for n in expected if n not in received]
        complete = manifest is not None and not missing
        verified = complete and not problems and all(verified_files.get(n) for n in expected)
        published = next((p for p in self.publishes if p["batch_no"] == batch_no), None)

        file_status = {}
        if manifest:
            for f in manifest.get("files", []):
                fname = f.get("filename")
                if fname not in received:
                    file_status[fname] = "missing"
                elif verified_files.get(fname):
                    file_status[fname] = "verified"
                else:
                    file_status[fname] = "bad"

        return {
            "batch_no": batch_no,
            "manifest": manifest,
            "manifest_received": manifest is not None,
            "manifest_error": manifest_error,
            "expected_files": expected,
            "received_files": sorted(n for n in received if n != manifest_name),
            "received_manifest": manifest_name in received,
            "missing_files": missing,
            "file_status": file_status,
            "problems": problems,
            "complete": complete,
            "verified": verified,
            "published": published,
        }

    def _publishable(self, batch_no):
        info = self._batch_info(batch_no)
        return info["verified"]

    def _cascade_publish(self):
        """从「已发布的最大批号 + 1」开始顺序生效；遇到缺口停止。"""
        published_now = []
        while True:
            last = max((p["batch_no"] for p in self.publishes), default=0)
            nxt = last + 1
            if not self._publishable(nxt):
                break
            rec = self._apply_batch(nxt)
            published_now.append(rec)
        return published_now

    def _apply_batch(self, batch_no):
        info = self._batch_info(batch_no)
        manifest = info["manifest"]
        received = self._read_received(batch_no)
        batch_kind = manifest.get("batch_kind") or "incremental"
        counts = {"inserted": 0, "updated": 0, "deleted": 0, "unchanged": 0}
        records = []
        for f in manifest.get("files", []):
            for rec in json.loads(received[f["filename"]].decode("utf-8")):
                records.append(rec)

        # 已校验通过才可能走到这里；再兜底断言一次，避免发布半批
        for rec in records:
            if not record_is_valid(rec):
                raise ReceiverError(422, f"无法识别的记录：{rec!r}")

        # 在副本上应用，全部成功后才一次性提交，避免异常留下半个批次
        tickets = {} if batch_kind == "full" else dict(self.tickets)
        new_history = []
        seq = self.seq

        for rec in records:
            op = rec.get("op")
            if op == "upsert":
                t = dict(rec["ticket"])
                tid = t["id"]
                before = tickets.get(tid)
                tickets[tid] = t
                if before is None:
                    counts["inserted"] += 1
                    action = "create"
                elif canonical(before) == canonical(t):
                    counts["unchanged"] += 1
                    action = "update"
                else:
                    counts["updated"] += 1
                    action = "update"
                seq += 1
                new_history.append(_history_entry(seq, batch_no, action, tid, before, t))
            else:  # delete
                tid = rec["ticket_id"]
                before = tickets.pop(tid, None)
                if before is None:
                    counts["unchanged"] += 1
                else:
                    counts["deleted"] += 1
                seq += 1
                new_history.append(
                    _history_entry(seq, batch_no, "delete", tid, before, None, reason=rec.get("reason"))
                )

        published = {
            "batch_no": batch_no,
            "batch_kind": batch_kind,
            "published_at": now_iso(),
            "manifest_sha256": manifest.get("manifest_sha256"),
            "file_count": len(manifest.get("files", [])),
            "record_count": len(records),
            "counts": counts,
        }

        # 提交
        self.tickets = tickets
        self.history.extend(new_history)
        self.seq = seq
        self.publishes.append(published)
        self.publishes.sort(key=lambda p: p["batch_no"])
        self._persist_library()
        return published

    # ---------------- 查询 ----------------
    def status(self):
        with self.lock:
            last_published = max((p["batch_no"] for p in self.publishes), default=0)
            batches = sorted(self._received_batches() | {p["batch_no"] for p in self.publishes})
            infos = []
            for b in batches:
                info = self._batch_info(b)
                info["effective"] = bool(info["published"])
                received = self._read_received(b)
                if info["manifest"]:
                    info["batch_kind"] = info["manifest"].get("batch_kind")
                    info["note"] = info["manifest"].get("note")
                    info["created_at"] = info["manifest"].get("created_at")
                    info["file_count"] = info["manifest"].get("file_count")
                    total = 0
                    for f in info["manifest"].get("files", []):
                        body = received.get(f["filename"])
                        if body is None:
                            continue
                        try:
                            total += len(json.loads(body.decode("utf-8")))
                        except Exception:
                            pass
                    info["record_count"] = total
                else:
                    info["batch_kind"] = None
                    info["note"] = None
                    info["created_at"] = None
                    info["file_count"] = None
                    info["record_count"] = None
                # 状态标签
                if info["published"]:
                    info["state"] = "published"
                elif info["problems"]:
                    info["state"] = "problem"
                elif not info["received_manifest"]:
                    info["state"] = "awaiting_manifest"
                elif not info["complete"]:
                    info["state"] = "partial"
                elif b > last_published + 1:
                    info["state"] = "staged"
                else:
                    info["state"] = "ready"
                infos.append(info)
            infos.sort(key=lambda x: x["batch_no"])
            return {
                "batches": infos,
                "published_batches": [p["batch_no"] for p in self.publishes],
                "effective_batch": last_published,
                "next_batch": last_published + 1,
                "ticket_count": len(self.tickets),
                "server_time": now_iso(),
            }

    def list_tickets(self, q=None, status=None):
        with self.lock:
            items = list(self.tickets.values())
        if status:
            items = [t for t in items if t.get("status") == status]
        if q:
            ql = q.lower()
            items = [
                t
                for t in items
                if ql in t.get("id", "").lower()
                or ql in t.get("title", "").lower()
                or ql in t.get("customer", "").lower()
                or ql in t.get("assignee", "").lower()
            ]
        items.sort(key=lambda t: t["id"])
        return items

    def ticket_detail(self, tid):
        with self.lock:
            current = self.tickets.get(tid)
            hist = [h for h in self.history if h["ticket_id"] == tid]
            hist.sort(key=lambda h: h["seq"])
            return {"ticket_id": tid, "current": current, "history": hist, "exists": current is not None}

    def history_list(self):
        with self.lock:
            return sorted(self.history, key=lambda h: h["seq"], reverse=True)

    def reset(self):
        """清空收件箱、发布记录与查询库，回到演示初始状态。"""
        import shutil

        with self.lock:
            self.publishes = []
            self.tickets = {}
            self.history = []
            self.seq = 0
            if os.path.isdir(self.incoming):
                shutil.rmtree(self.incoming)
            os.makedirs(self.incoming, exist_ok=True)
            self._persist_library()


def record_digest(rec):
    return sha256_bytes(canonical(rec).encode("utf-8"))


def _history_entry(seq, batch_no, action, tid, before, after, reason=None):
    entry = {
        "seq": seq,
        "batch_no": batch_no,
        "action": action,
        "ticket_id": tid,
        "before": before,
        "after": after,
        "at": now_iso(),
    }
    if reason:
        entry["reason"] = reason
    return entry


def record_is_valid(rec):
    if not isinstance(rec, dict):
        return False
    if rec.get("op") == "upsert":
        return isinstance(rec.get("ticket"), dict) and bool(rec["ticket"].get("id"))
    if rec.get("op") == "delete":
        return bool(rec.get("ticket_id"))
    return False


def manifest_digest(batch_no, batch_kind, files):
    return sha256_bytes(canonical({"batch_no": batch_no, "batch_kind": batch_kind, "files": files}).encode("utf-8"))


def atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    try:
        fd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass

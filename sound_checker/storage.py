from __future__ import annotations

import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .audio import AudioReadError, load_audio, probe_audio, sha256_file
from .features import AudioFeatures, compute_features
from .matcher import DEFAULT_PARAMS, match_features


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def default_home() -> Path:
    return Path(os.environ.get("SOUND_CHECKER_HOME", "~/.sound-similarity-checker")).expanduser().resolve()


class Library:
    def __init__(self, home: str | Path | None = None) -> None:
        self.home = Path(home).expanduser().resolve() if home else default_home()
        self.blobs_dir = self.home / "blobs"
        self.generated_dir = self.home / "generated_samples"
        self.state_path = self.home / "state.json"
        self.blobs_dir.mkdir(parents=True, exist_ok=True)
        self.generated_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._feature_cache: dict[str, tuple[str, Any, AudioFeatures]] = {}
        self.state: dict[str, Any] = self._load_state()

    def _load_state(self) -> dict[str, Any]:
        if self.state_path.exists():
            try:
                data = json.loads(self.state_path.read_text(encoding="utf-8"))
                data.setdefault("files", {})
                data.setdefault("verdicts", {})
                data.setdefault("last_report", None)
                data.setdefault("params", {})
                return data
            except (json.JSONDecodeError, OSError):
                backup = self.state_path.with_suffix(".broken.json")
                try:
                    self.state_path.rename(backup)
                except OSError:
                    pass
        return {
            "version": 1,
            "created_at": utc_now(),
            "files": {},
            "verdicts": {},
            "params": {},
            "last_report": None,
        }

    def save(self) -> None:
        with self._lock:
            self.state["updated_at"] = utc_now()
            tmp = self.state_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, self.state_path)

    def public_state(self) -> dict[str, Any]:
        with self._lock:
            files = [self._public_file(r) for r in self.state["files"].values()]
            active = [f for f in files if f["active"]]
            removed = [f for f in files if not f["active"]]
            readable = [f for f in active if not f.get("error")]
            unreadable = [f for f in active if f.get("error")]
            return {
                "home": str(self.home),
                "files": sorted(active, key=lambda f: f.get("added_at", "")),
                "removed": sorted(removed, key=lambda f: f.get("removed_at") or ""),
                "readable_count": len(readable),
                "unreadable_count": len(unreadable),
                "verdicts": list(self.state["verdicts"].values()),
                "params": {**DEFAULT_PARAMS, **self.state.get("params", {})},
                "last_report": self.state.get("last_report"),
            }

    @staticmethod
    def _public_file(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": record["id"],
            "name": record.get("original_name") or Path(record.get("path", "")).name,
            "source": record.get("source"),
            "path": record.get("path"),
            "sha256": record.get("sha256"),
            "size": record.get("size"),
            "added_at": record.get("added_at"),
            "active": record.get("active", True),
            "removed_at": record.get("removed_at"),
            "metadata": record.get("metadata"),
            "error": record.get("error"),
        }

    def _path_id(self, path: Path) -> str:
        return "p_" + hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:16]

    def _blob_id(self, digest: str) -> str:
        return "u_" + digest[:16]

    def add_paths(self, raw_paths: list[str]) -> dict[str, list[dict[str, Any]]]:
        added: list[dict[str, Any]] = []
        duplicates: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        with self._lock:
            for raw in raw_paths:
                path = Path(os.path.expandvars(os.path.expanduser(raw.strip()))).resolve()
                file_id = self._path_id(path)
                existing = self.state["files"].get(file_id)
                if existing and existing.get("active") and not existing.get("error"):
                    duplicates.append(self._public_file(existing))
                    continue
                if existing and existing.get("active") and existing.get("error"):
                    record = self._index_path_record(file_id, path, existing.get("source", "path"))
                    record["added_at"] = existing.get("added_at", record["added_at"])
                    self.state["files"][file_id] = record
                    if record.get("error"):
                        errors.append(self._public_file(record))
                    else:
                        added.append(self._public_file(record))
                    continue
                if existing and not existing.get("active"):
                    record = self._index_path_record(file_id, path, existing.get("source", "path"))
                    record["active"] = True
                    record["removed_at"] = None
                    self.state["files"][file_id] = record
                    duplicates.append(self._public_file(record))
                    continue
                record = self._index_path_record(file_id, path, "path")
                self.state["files"][file_id] = record
                if record.get("error"):
                    errors.append(self._public_file(record))
                else:
                    added.append(self._public_file(record))
            self.save()
        return {"added": added, "duplicates": duplicates, "errors": errors}

    def add_upload(self, filename: str, content: bytes) -> dict[str, Any]:
        digest = hashlib.sha256(content).hexdigest()
        file_id = self._blob_id(digest)
        suffix = Path(filename).suffix.lower()
        if not suffix or len(suffix) > 12:
            suffix = ".bin"
        blob_path = self.blobs_dir / f"{digest[:24]}{suffix}"

        with self._lock:
            existing = self.state["files"].get(file_id)
            if existing and existing.get("active"):
                return {**self._public_file(existing), "duplicate": True}
            if not blob_path.exists():
                blob_path.write_bytes(content)
            record = self._index_path_record(file_id, blob_path, "upload", original_name=Path(filename).name, digest=digest)
            if existing and not existing.get("active"):
                record["added_at"] = existing.get("added_at", record["added_at"])
            self.state["files"][file_id] = record
            self.save()
            return {**self._public_file(record), "duplicate": bool(existing)}

    def add_generated_samples(self) -> dict[str, list[dict[str, Any]]]:
        from .samples import generate_sample_set

        paths = generate_sample_set(self.generated_dir)
        return self.add_paths([str(p) for p in paths])

    def _index_path_record(
        self,
        file_id: str,
        path: Path,
        source: str,
        original_name: str | None = None,
        digest: str | None = None,
    ) -> dict[str, Any]:
        now = utc_now()
        name = original_name or path.name
        try:
            stat = path.stat()
            if digest is None:
                digest = sha256_file(path)
            metadata = probe_audio(path)
            # Decode once now so unreadable files are surfaced immediately.
            load_audio(path)
            return {
                "id": file_id,
                "source": source,
                "path": str(path),
                "original_name": name,
                "sha256": digest,
                "size": stat.st_size,
                "added_at": now,
                "active": True,
                "removed_at": None,
                "metadata": metadata,
                "error": None,
            }
        except (OSError, AudioReadError, Exception) as exc:  # surface any decoder failure as unreadable
            return {
                "id": file_id,
                "source": source,
                "path": str(path),
                "original_name": name,
                "sha256": digest,
                "size": path.stat().st_size if path.exists() and path.is_file() else None,
                "added_at": now,
                "active": True,
                "removed_at": None,
                "metadata": None,
                "error": str(exc),
            }

    def remove_file(self, file_id: str, purge: bool = False) -> bool:
        with self._lock:
            record = self.state["files"].get(file_id)
            if not record:
                return False
            if purge:
                if record.get("source") == "upload":
                    try:
                        Path(record["path"]).unlink(missing_ok=True)
                    except OSError:
                        pass
                self.state["files"].pop(file_id, None)
                self._feature_cache.pop(file_id, None)
            else:
                record["active"] = False
                record["removed_at"] = utc_now()
                self._feature_cache.pop(file_id, None)
            self.save()
            return True

    def restore_file(self, file_id: str) -> bool:
        with self._lock:
            record = self.state["files"].get(file_id)
            if not record:
                return False
            record["active"] = True
            record["removed_at"] = None
            self.save()
            return True

    def retry_file(self, file_id: str) -> dict[str, Any] | None:
        with self._lock:
            record = self.state["files"].get(file_id)
            if not record:
                return None
            path = Path(record["path"])
            updated = self._index_path_record(
                file_id,
                path,
                record.get("source", "path"),
                original_name=record.get("original_name"),
            )
            updated["added_at"] = record.get("added_at", updated["added_at"])
            updated["active"] = True
            updated["removed_at"] = None
            self.state["files"][file_id] = updated
            self._feature_cache.pop(file_id, None)
            self.save()
            return self._public_file(updated)

    def get_record(self, file_id: str, include_removed: bool = False) -> dict[str, Any] | None:
        record = self.state["files"].get(file_id)
        if not record:
            return None
        if not include_removed and not record.get("active", True):
            return None
        return record

    def get_index(self, file_id: str) -> tuple[dict[str, Any], Any, AudioFeatures]:
        record = self.get_record(file_id)
        if record is None:
            raise KeyError(file_id)
        if record.get("error"):
            raise AudioReadError(record["error"])
        digest = record.get("sha256") or ""
        cached = self._feature_cache.get(file_id)
        if cached and cached[0] == digest:
            return record, cached[1], cached[2]
        audio = load_audio(record["path"])
        features = compute_features(audio.samples, audio.duration)
        self._feature_cache[file_id] = (digest, audio, features)
        return record, audio, features

    def get_peaks(self, file_id: str) -> dict[str, Any]:
        _, audio, _ = self.get_index(file_id)
        return audio.peaks

    def analyze(self, param_overrides: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            # Frame/FFT/mel constants are real implementation constants; only
            # classification thresholds are treated as user-tunable parameters.
            params = {**DEFAULT_PARAMS}
            for source in (self.state.get("params", {}), param_overrides or {}):
                for key in ("high_similarity", "uncertain_similarity"):
                    value = source.get(key)
                    if isinstance(value, (int, float)):
                        params[key] = float(value)
            params["high_similarity"] = min(0.95, max(0.70, params["high_similarity"]))
            params["uncertain_similarity"] = min(0.80, max(0.50, params["uncertain_similarity"]))
            if param_overrides:
                self.state["params"] = {
                    "high_similarity": params["high_similarity"],
                    "uncertain_similarity": params["uncertain_similarity"],
                }

            # External moves/deletions should appear in the unreadable group
            # instead of silently disappearing from metadata views.
            for record in self.state["files"].values():
                if record.get("active", True) and not record.get("error"):
                    if not Path(record["path"]).exists():
                        record["error"] = "文件不存在或已被移动"

            records = [
                r for r in self.state["files"].values()
                if r.get("active", True) and not r.get("error") and Path(r["path"]).exists()
            ]
            records.sort(key=lambda r: (r.get("original_name", ""), r["id"]))
            items: list[dict[str, Any]] = []

            for i, rec_a in enumerate(records):
                try:
                    _, audio_a, feat_a = self.get_index(rec_a["id"])
                except AudioReadError as exc:
                    rec_a["error"] = str(exc)
                    continue
                for rec_b in records[i + 1 :]:
                    try:
                        _, audio_b, feat_b = self.get_index(rec_b["id"])
                    except AudioReadError as exc:
                        rec_b["error"] = str(exc)
                        continue
                    matches = match_features(feat_a, feat_b, params)
                    visible = [m for m in matches if m["category"] != "different"]
                    if not visible and matches:
                        visible = [matches[0]]
                    for match in visible:
                        item = self._build_item(rec_a, rec_b, match, params)
                        self._attach_verdict(item)
                        items.append(item)

            category_rank = {"high": 0, "uncertain": 1, "different": 2}
            items.sort(
                key=lambda x: (
                    category_rank.get(x["category"], 3),
                    0 if (x.get("verdict") or {}).get("status") == "false_positive" else 1,
                    -x["score"],
                )
            )
            counts = {"high": 0, "uncertain": 0, "different": 0, "false_positive": 0, "confirmed": 0}
            for item in items:
                counts[item["category"]] = counts.get(item["category"], 0) + 1
                status = (item.get("verdict") or {}).get("status")
                if status in counts:
                    counts[status] += 1

            active_verdict_keys = {
                (item.get("verdict") or {}).get("key")
                for item in items
                if item.get("verdict")
            }
            active_verdict_keys.update(item["verdict_key"] for item in items)
            historical_verdicts: list[dict[str, Any]] = []
            for verdict in self.state["verdicts"].values():
                if verdict.get("key") in active_verdict_keys:
                    continue
                snapshot = verdict.get("snapshot")
                if snapshot:
                    historical_verdicts.append({
                        **snapshot,
                        "verdict": verdict,
                        "historical": True,
                    })
                    status = verdict.get("status")
                    if status in counts:
                        counts[status] += 1

            report = {
                "generated_at": utc_now(),
                "params": params,
                "file_count": len(records),
                "pair_count": len(records) * (len(records) - 1) // 2,
                "item_count": len(items),
                "counts": counts,
                "items": items,
                "historical_verdicts": historical_verdicts,
            }
            self.state["last_report"] = report
            self.save()
            return report

    def _build_item(
        self, rec_a: dict[str, Any], rec_b: dict[str, Any], match: dict[str, Any], params: dict[str, Any]
    ) -> dict[str, Any]:
        verdict_key = self.verdict_key(rec_a["id"], rec_b["id"], match)
        return {
            "verdict_key": verdict_key,
            "pair_key": f"{rec_a['id']}|{rec_b['id']}",
            "file_a": self._public_file(rec_a),
            "file_b": self._public_file(rec_b),
            **match,
        }

    @staticmethod
    def verdict_key(id_a: str, id_b: str, match: dict[str, Any]) -> str:
        offset_bin = int(round((float(match["b_start"]) - float(match["a_start"])) / 0.25))
        return f"v2|{id_a}|{id_b}|off{offset_bin:+d}"

    def _attach_verdict(self, item: dict[str, Any]) -> None:
        verdicts = self.state["verdicts"]
        verdict = verdicts.get(item["verdict_key"])
        if verdict is None:
            # Recover marks across small boundary/offset changes after rescans.
            pair_prefix = "v2|" + item["pair_key"] + "|"
            target_offset = float(item["b_start"]) - float(item["a_start"])
            best: dict[str, Any] | None = None
            best_dist = 0.45
            for key, saved in verdicts.items():
                if not key.startswith(pair_prefix):
                    continue
                sig = saved.get("signature") or {}
                saved_offset = float(sig.get("offset_seconds", 1e9))
                dist = abs(saved_offset - target_offset)
                if dist < best_dist:
                    best = saved
                    best_dist = dist
            verdict = best
        item["verdict"] = verdict

    def set_verdict(self, key: str, status: str | None, note: str = "") -> dict[str, Any]:
        with self._lock:
            if status in (None, "", "reset"):
                removed = self.state["verdicts"].pop(key, None)
                report = self.state.get("last_report") or {}
                for item in list(report.get("items", [])) + list(report.get("historical_verdicts", [])):
                    if (item.get("verdict") or {}).get("key") == key or item.get("verdict_key") == key:
                        item["verdict"] = None
                self._refresh_verdict_counts(report)
                self.save()
                return {"key": key, "verdict": None, "removed": removed is not None}
            if status not in {"false_positive", "confirmed"}:
                raise ValueError("status must be false_positive, confirmed, or reset")
            now = utc_now()
            existing = self.state["verdicts"].get(key, {})
            verdict = {
                "key": key,
                "status": status,
                "note": note,
                "updated_at": now,
                "created_at": existing.get("created_at", now),
                "signature": existing.get("signature", {}),
            }
            self.state["verdicts"][key] = verdict

            # Store a signature if this key is present in the latest report.
            report = self.state.get("last_report") or {}
            all_candidates = list(report.get("items", [])) + list(report.get("historical_verdicts", []))
            for item in all_candidates:
                attached_key = (item.get("verdict") or {}).get("key")
                if item.get("verdict_key") == key or attached_key == key:
                    verdict["signature"] = {
                        "pair_key": item.get("pair_key"),
                        "file_a_id": item["file_a"]["id"],
                        "file_b_id": item["file_b"]["id"],
                        "a_start": item["a_start"],
                        "a_end": item["a_end"],
                        "b_start": item["b_start"],
                        "b_end": item["b_end"],
                        "offset_seconds": round(item["b_start"] - item["a_start"], 3),
                        "category": item["category"],
                        "score": item["score"],
                    }
                    snapshot = {k: v for k, v in item.items() if k != "verdict"}
                    verdict["snapshot"] = snapshot
                    item["verdict"] = verdict
                    break
            self._refresh_verdict_counts(report)
            self.save()
            return {"key": key, "verdict": verdict}

    @staticmethod
    def _refresh_verdict_counts(report: dict[str, Any]) -> None:
        if not report:
            return
        items = list(report.get("items", [])) + list(report.get("historical_verdicts", []))
        counts = report.setdefault("counts", {})
        counts["false_positive"] = sum(
            1 for i in items if (i.get("verdict") or {}).get("status") == "false_positive"
        )
        counts["confirmed"] = sum(
            1 for i in items if (i.get("verdict") or {}).get("status") == "confirmed"
        )

    def export_payload(self, output_format: str = "json") -> bytes | str:
        report = self.state.get("last_report") or self.analyze()
        payload = {
            "tool": "local-similarity-checker",
            "exported_at": utc_now(),
            "library_home": str(self.home),
            "parameters": report["params"],
            "counts": report["counts"],
            "files": [self._public_file(r) for r in self.state["files"].values() if r.get("active", True)],
            "results": report["items"],
            "verdicts": list(self.state["verdicts"].values()),
        }
        if output_format == "json":
            return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        return self._to_csv(payload)

    @staticmethod
    def _to_csv(payload: dict[str, Any]) -> str:
        import csv
        import io

        buf = io.StringIO()
        cols = [
            "category", "score", "similarity", "file_a", "a_start", "a_end",
            "file_b", "b_start", "b_end", "duration", "aligned_events",
            "info_seconds", "static_score", "verdict", "note", "verdict_key",
        ]
        writer = csv.DictWriter(buf, fieldnames=cols)
        writer.writeheader()
        for item in payload["results"]:
            verdict = item.get("verdict") or {}
            writer.writerow({
                "category": item["category"],
                "score": item["score"],
                "similarity": item["similarity"],
                "file_a": item["file_a"]["path"],
                "a_start": item["a_start"],
                "a_end": item["a_end"],
                "file_b": item["file_b"]["path"],
                "b_start": item["b_start"],
                "b_end": item["b_end"],
                "duration": item["duration"],
                "aligned_events": item["aligned_events"],
                "info_seconds": item["info_seconds"],
                "static_score": item["static_score"],
                "verdict": verdict.get("status", ""),
                "note": verdict.get("note", ""),
                "verdict_key": item["verdict_key"],
            })
        return buf.getvalue()

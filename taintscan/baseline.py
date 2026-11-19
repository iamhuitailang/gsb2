"""Baseline persistence and comparison.

A baseline is a JSON document produced from a previous scan.  Comparison is
fingerprint-based, so moving code up or down in a file does not turn an old
finding into a "new" one.

Corrupt or incompatible baselines raise :class:`BaselineError` with a human
readable reason; they are never silently treated as empty.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

from .models import Finding

BASELINE_SCHEMA = "taintscan/baseline/1"
SUPPORTED_BASELINE_VERSIONS = frozenset({1})


class BaselineError(Exception):
    """Raised when a baseline cannot be read or is incompatible."""


@dataclass
class Baseline:
    version: int
    findings: dict[str, dict[str, Any]]
    root: str = ""

    # -- persistence ------------------------------------------------------

    @classmethod
    def from_findings(
        cls,
        findings: Iterable[Finding],
        root: str = "",
        version: int = 1,
    ) -> "Baseline":
        entries: dict[str, dict[str, Any]] = {}
        for finding in findings:
            if not finding.fingerprint:
                raise BaselineError(
                    f"finding at {finding.file}:{finding.line} has no fingerprint"
                )
            entries[finding.fingerprint] = {
                "rule_id": finding.rule_id,
                "severity": finding.severity.name,
                "file": finding.file,
                "line": finding.line,
                "sink": finding.sink,
                "source": finding.source,
                "source_file": finding.source_file,
                "source_line": finding.source_line,
                "flow": finding.flow,
            }
        return cls(version=version, findings=entries, root=root)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": BASELINE_SCHEMA,
            "version": self.version,
            "root": self.root,
            "fingerprint_algorithm": "sha256:24",
            "findings": [
                {"fingerprint": fp, **entry}
                for fp, entry in sorted(self.findings.items())
            ],
        }

    def save(self, path: str | Path) -> None:
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(self.to_dict(), ensure_ascii=False, indent=2, sort_keys=False)
        temporary = destination.with_name(destination.name + ".tmp")
        temporary.write_text(payload + "\n", encoding="utf-8")
        temporary.replace(destination)

    @classmethod
    def load(cls, path: str | Path) -> "Baseline":
        location = Path(path)
        try:
            raw = location.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise BaselineError(f"baseline not found: {location}") from exc
        except OSError as exc:
            raise BaselineError(f"cannot read baseline {location}: {exc}") from exc

        if not raw.strip():
            raise BaselineError(f"baseline is empty: {location}")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise BaselineError(
                f"baseline is not valid JSON ({location}): "
                f"{exc.msg} at line {exc.lineno} column {exc.colno}"
            ) from exc

        if not isinstance(data, dict):
            raise BaselineError(
                f"baseline root must be a JSON object, got {type(data).__name__}: {location}"
            )
        schema = data.get("schema")
        if schema != BASELINE_SCHEMA:
            raise BaselineError(
                f"unsupported baseline schema {schema!r} in {location}; "
                f"expected {BASELINE_SCHEMA!r}"
            )
        version = data.get("version")
        if not isinstance(version, int) or version not in SUPPORTED_BASELINE_VERSIONS:
            raise BaselineError(
                f"unsupported baseline version {version!r} in {location}; "
                f"supported: {sorted(SUPPORTED_BASELINE_VERSIONS)}"
            )
        algorithm = data.get("fingerprint_algorithm")
        if algorithm != "sha256:24":
            raise BaselineError(
                f"unsupported fingerprint algorithm {algorithm!r} in {location}; "
                "re-generate the baseline with this version of taintscan"
            )
        entries = data.get("findings")
        if not isinstance(entries, list):
            raise BaselineError(
                f"baseline 'findings' must be a list in {location}"
            )

        indexed: dict[str, dict[str, Any]] = {}
        for position, entry in enumerate(entries):
            if not isinstance(entry, dict):
                raise BaselineError(
                    f"baseline entry #{position} is not an object in {location}"
                )
            entry_fp = entry.get("fingerprint")
            if not isinstance(entry_fp, str) or len(entry_fp) < 8:
                raise BaselineError(
                    f"baseline entry #{position} has no valid fingerprint in {location}"
                )
            for field in ("rule_id", "file"):
                if not isinstance(entry.get(field), str):
                    raise BaselineError(
                        f"baseline entry #{position} is missing '{field}' in {location}"
                    )
            indexed[entry_fp] = entry

        return cls(
            version=version,
            findings=indexed,
            root=str(data.get("root") or ""),
        )

    def keys(self) -> frozenset[str]:
        return frozenset(self.findings)


@dataclass
class Comparison:
    new: list[Finding]
    existing: list[Finding]
    resolved: list[dict[str, Any]]

    def apply(self) -> None:
        for finding in self.new:
            finding.status = "new"
        for finding in self.existing:
            finding.status = "existing"

    def to_dict(self) -> dict[str, Any]:
        return {
            "new": len(self.new),
            "existing": len(self.existing),
            "resolved": len(self.resolved),
            "resolved_findings": self.resolved,
        }


def compare(findings: Iterable[Finding], baseline: Baseline) -> Comparison:
    known = baseline.findings
    new: list[Finding] = []
    existing: list[Finding] = []
    current_keys: set[str] = set()

    for finding in findings:
        key = finding.fingerprint
        current_keys.add(key)
        if key in known:
            finding.status = "existing"
            existing.append(finding)
        else:
            finding.status = "new"
            new.append(finding)

    resolved = [
        {"fingerprint": key, **entry}
        for key, entry in sorted(known.items())
        if key not in current_keys
    ]
    return Comparison(new=new, existing=existing, resolved=resolved)

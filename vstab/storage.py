"""项目 / 示例 / 导出目录等本地存储约定。"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
SAMPLES_DIR = ROOT_DIR / "samples"
PROJECTS_DIR = ROOT_DIR / "projects"
EXPORTS_DIR = ROOT_DIR / "exports"

for d in (SAMPLES_DIR, PROJECTS_DIR, EXPORTS_DIR):
    d.mkdir(parents=True, exist_ok=True)


def slugify(name: str) -> str:
    name = name.strip()
    name = re.sub(r"[\\/:*?\"<>|\s]+", "_", name)
    name = re.sub(r"_+", "_", name).strip("_")
    return name[:80] or "project"


def project_path(name: str) -> Path:
    if not name.endswith(".json"):
        name = f"{slugify(name)}.vstab.json"
    return PROJECTS_DIR / name


def save_project(data: dict[str, Any], name: str) -> Path:
    path = project_path(name)
    payload = dict(data)
    payload["saved_at"] = datetime.now().isoformat(timespec="seconds")
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    return path


def load_project(name_or_file: str) -> dict[str, Any]:
    p = Path(name_or_file)
    if not p.is_absolute() and not p.exists():
        p = project_path(name_or_file)
    if not p.exists():
        # 也允许直接传 projects 目录下的文件名
        p = PROJECTS_DIR / name_or_file
    return json.loads(p.read_text(encoding="utf-8"))


def list_projects() -> list[dict[str, Any]]:
    items = []
    for p in sorted(PROJECTS_DIR.glob("*.vstab.json"),
                    key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            items.append({
                "file": p.name,
                "name": data.get("name", p.name),
                "saved_at": data.get("saved_at", ""),
                "source": data.get("analysis", {}).get("source_path", ""),
            })
        except Exception:
            items.append({"file": p.name, "name": p.stem, "saved_at": "", "source": ""})
    return items


def unique_export_path(stem: str, suffix: str = "_stabilized", ext: str = ".mp4") -> Path:
    base = EXPORTS_DIR / f"{slugify(stem)}{suffix}"
    candidate = base.with_suffix(ext)
    n = 2
    while candidate.exists():
        candidate = EXPORTS_DIR / f"{slugify(stem)}{suffix}_{n}{ext}"
        n += 1
    return candidate

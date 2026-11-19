"""File discovery with deterministic ordering and sensible default excludes."""

from __future__ import annotations

import fnmatch
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

# Directories that never contain project source worth scanning by default.
DEFAULT_EXCLUDED_DIRS = frozenset(
    {
        # version control
        ".git",
        ".hg",
        ".svn",
        ".bzr",
        # Python caches / tooling
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".pytype",
        ".hypothesis",
        ".tox",
        ".nox",
        # virtual environments
        ".venv",
        "venv",
        "env",
        "virtualenv",
        ".virtualenv",
        "site-packages",
        # JS / build artefacts
        "node_modules",
        "build",
        "dist",
        ".eggs",
        # editors
        ".idea",
        ".vscode",
    }
)


@dataclass(frozen=True)
class DiscoveredFile:
    path: Path
    relpath: str


def _normalise_extra(value: str, root: Path) -> str:
    value = value.replace(os.sep, "/").strip()
    while value.startswith("./"):
        value = value[2:]
    if os.path.isabs(value):
        try:
            value = Path(value).resolve().relative_to(root).as_posix()
        except ValueError:
            # Outside the scan root; keep the absolute form so it simply
            # never matches instead of accidentally matching a suffix.
            return Path(value).resolve().as_posix()
    return value.rstrip("/")


def _is_excluded(relpath: str, parts: Sequence[str], extra: Iterable[str]) -> bool:
    for pattern in extra:
        if not pattern:
            continue
        if any(ch in pattern for ch in "*?["):
            if fnmatch.fnmatchcase(relpath, pattern) or fnmatch.fnmatchcase(
                parts[-1] if parts else "", pattern
            ):
                return True
            continue
        if relpath == pattern or relpath.startswith(pattern + "/"):
            return True
        # Also allow excluding by a directory/file name anywhere in the tree,
        # e.g. ``--exclude vendor`` should hide ``app/vendor/...`` too.
        if "/" not in pattern and pattern in parts:
            return True
    return False


def discover_files(root: Path | str, excludes: Sequence[str] = ()) -> list[DiscoveredFile]:
    """Return Python files below *root*, sorted by relative path.

    ``excludes`` entries may be relative paths, absolute paths, shell-style
    globs matched against the relative path, or bare directory/file names.
    Symlinked directories are not followed.
    """

    root = Path(root).resolve()
    if not root.exists():
        raise FileNotFoundError(f"scan path does not exist: {root}")
    if root.is_file():
        if root.suffix != ".py":
            raise ValueError(f"scan path is not a Python file: {root}")
        return [DiscoveredFile(root, root.name)]

    extra = [_normalise_extra(item, root) for item in excludes]
    found: list[DiscoveredFile] = []

    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        current = Path(dirpath)
        rel_dir = current.relative_to(root)
        # Prune default and user excludes before descending.  Sorting keeps
        # traversal (and therefore any error ordering) deterministic.
        kept: list[str] = []
        for name in sorted(dirnames):
            rel = (rel_dir / name).as_posix()
            if name in DEFAULT_EXCLUDED_DIRS:
                continue
            if _is_excluded(rel, rel.split("/"), extra):
                continue
            kept.append(name)
        dirnames[:] = kept

        for name in sorted(filenames):
            if not name.endswith(".py"):
                continue
            rel = (rel_dir / name).as_posix()
            if _is_excluded(rel, rel.split("/"), extra):
                continue
            found.append(DiscoveredFile(current / name, rel))

    found.sort(key=lambda item: item.relpath)
    return found

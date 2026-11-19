"""Safe, non-executing parsing helpers.

Nothing in this module imports or runs the analysed source; files are read as
text and handed to :func:`ast.parse`.
"""

from __future__ import annotations

import ast
import tokenize
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .models import Warning

# Refuse absurdly large files rather than exhausting memory.
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_SNIPPET_CHARS = 160


@dataclass
class ParsedFile:
    path: Path
    relpath: str
    source: str
    tree: ast.Module
    lines: list[str]


def read_source(path: Path) -> str:
    """Read Python source honouring PEP 263 encoding cookies and BOM."""

    size = path.stat().st_size
    if size > MAX_FILE_BYTES:
        raise ValueError(
            f"file is {size} bytes, larger than the {MAX_FILE_BYTES} byte limit"
        )
    with tokenize.open(path) as handle:
        return handle.read()


def parse_file(path: Path, relpath: str) -> tuple[Optional[ParsedFile], Optional[Warning]]:
    """Parse one file; return either a ParsedFile or a locatable warning.

    Errors are intentionally contained per file: the scanner keeps processing
    all other files and reports this one as a warning.
    """

    try:
        source = read_source(path)
    except (OSError, UnicodeDecodeError, SyntaxError, LookupError, ValueError) as exc:
        return None, _io_warning(relpath, exc)

    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        return None, Warning(
            file=relpath,
            line=exc.lineno or 1,
            column=max((exc.offset or 1) - 1, 0),
            kind="syntax-error",
            message=_syntax_message(exc),
        )
    except (ValueError, MemoryError, RecursionError) as exc:
        return None, Warning(
            file=relpath,
            line=1,
            column=0,
            kind="parse-error",
            message=f"{type(exc).__name__}: {exc}",
        )

    return (
        ParsedFile(
            path=path,
            relpath=relpath,
            source=source,
            tree=tree,
            lines=source.splitlines(),
        ),
        None,
    )


def _io_warning(relpath: str, exc: BaseException) -> Warning:
    if isinstance(exc, UnicodeDecodeError):
        kind = "decode-error"
        message = (
            f"cannot decode file as Python source: {exc.reason} "
            f"at byte {exc.start}"
        )
        line = 1
    elif isinstance(exc, SyntaxError):
        kind = "encoding-error"
        message = f"invalid encoding declaration: {exc.msg}"
        line = exc.lineno or 1
    else:
        kind = "io-error"
        message = f"{type(exc).__name__}: {exc}"
        line = 1
    return Warning(file=relpath, line=line, column=0, kind=kind, message=message)


def _syntax_message(exc: SyntaxError) -> str:
    text = exc.msg or "invalid syntax"
    if exc.text:
        text = f"{text}: {exc.text.strip()}"
    return text


def snippet_for(
    parsed: Optional[ParsedFile],
    node: ast.AST,
    fallback: str = "",
    max_chars: int = MAX_SNIPPET_CHARS,
) -> str:
    """Short, stable text for a node used in fingerprints and reports."""

    text = ""
    if parsed is not None:
        try:
            text = ast.get_source_segment(parsed.source, node) or ""
        except Exception:
            text = ""
    if not text:
        try:
            text = ast.unparse(node)
        except Exception:
            text = fallback
    text = " ".join(text.split())
    if len(text) > max_chars:
        text = text[: max_chars - 3] + "..."
    return text


def function_display(node: ast.AST, parents: tuple[str, ...] = ()) -> str:
    name = getattr(node, "name", type(node).__name__)
    return ".".join((*parents, name)) if parents else name


def node_text(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:  # pragma: no cover - exotic nodes
        return type(node).__name__


def is_constant_literal(node: ast.AST) -> bool:
    """True for expressions made only of literals and literal containers."""

    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return all(is_constant_literal(item) for item in node.elts)
    if isinstance(node, ast.Dict):
        return all(
            key is not None and is_constant_literal(key) and is_constant_literal(value)
            for key, value in zip(node.keys, node.values)
        )
    if isinstance(node, ast.JoinedStr):
        return all(
            isinstance(value, ast.Constant) for value in node.values
        )
    return False


def literal_values(node: ast.AST) -> Optional[list[ast.AST]]:
    """Elements of a literal tuple/list/set/dict, or None if not literal."""

    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return list(node.elts)
    if isinstance(node, ast.Dict):
        return [value for value in node.values if value is not None]
    return None

"""严格 JSON 解析器。

标准库 ``json.loads`` 会静默接受重复字段名（后者覆盖前者），也不便于在
解析前就限制嵌套深度。策略包是不可信输入，这里实现一个带路径诊断的
递归下降解析器，拒绝：

* 重复字段名
* 非法/截断的 JSON
* 超过深度、节点数、字符串长度的文档
* NaN / Infinity / 超大数字
* 非 UTF-8 字节、BOM、字符串中的裸控制字符
"""

from __future__ import annotations

import re
from typing import Any

from .config import (
    MAX_JSON_DEPTH,
    MAX_JSON_KEY_BYTES,
    MAX_JSON_NODES,
    MAX_JSON_STRING_BYTES,
)

_WS = " \t\n\r"
_BOM_CHAR = chr(0xFEFF)
_BOM_BYTES = b"\xef\xbb\xbf"
_NUMBER_RE = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ESCAPES = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
}


class JsonInputError(ValueError):
    """不可信 JSON 输入的结构错误，携带路径和稳定错误码。"""

    def __init__(
        self,
        code: str,
        message: str,
        path: str = "$",
        line: int | None = None,
        column: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path
        self.line = line
        self.column = column

    def as_detail(self) -> dict[str, Any]:
        detail: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "path": self.path,
        }
        if self.line is not None:
            detail["line"] = self.line
            detail["column"] = self.column
        return detail


def _child_path(base: str, key: str) -> str:
    if _IDENT_RE.match(key):
        return f"{base}.{key}"
    return f"{base}[{_json_quote(key)}]"


def _index_path(base: str, index: int) -> str:
    return f"{base}[{index}]"


def _json_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


class _Parser:
    def __init__(
        self,
        text: str,
        max_depth: int,
        max_nodes: int,
        max_string_bytes: int,
    ) -> None:
        self.text = text
        self.length = len(text)
        self.pos = 0
        self.max_depth = max_depth
        self.max_nodes = max_nodes
        self.max_string_bytes = max_string_bytes
        self.nodes = 0

    # ---- 基础工具 ----
    def _error(
        self, code: str, message: str, path: str, pos: int | None = None
    ) -> JsonInputError:
        position = self.pos if pos is None else pos
        line, column = self._line_column(position)
        return JsonInputError(code, message, path, line, column)

    def _line_column(self, position: int) -> tuple[int, int]:
        prefix = self.text[:position]
        line = prefix.count("\n") + 1
        last_newline = prefix.rfind("\n")
        return line, position - last_newline

    def _skip_ws(self) -> None:
        while self.pos < self.length and self.text[self.pos] in _WS:
            self.pos += 1

    def _peek(self) -> str | None:
        if self.pos >= self.length:
            return None
        return self.text[self.pos]

    def _count_node(self, path: str) -> None:
        self.nodes += 1
        if self.nodes > self.max_nodes:
            raise self._error(
                "too_many_nodes",
                f"JSON 节点数量超过上限 {self.max_nodes}",
                path,
            )

    # ---- 入口 ----
    def parse(self) -> Any:
        self._skip_ws()
        if self.pos >= self.length:
            raise self._error("empty_document", "策略文档为空", "$")
        value = self._parse_value("$", 0)
        self._skip_ws()
        if self.pos < self.length:
            raise self._error(
                "trailing_content",
                "JSON 文档结束后存在多余内容",
                "$",
            )
        return value

    def _parse_value(self, path: str, depth: int) -> Any:
        self._count_node(path)
        ch = self._peek()
        if ch is None:
            raise self._error("unexpected_end", "JSON 文档意外结束", path)
        if ch == "{":
            return self._parse_object(path, depth + 1)
        if ch == "[":
            return self._parse_array(path, depth + 1)
        if ch == '"':
            return self._parse_string(path, is_key=False)
        if ch == "-" or ch.isdigit():
            return self._parse_number(path)
        if self.text.startswith("true", self.pos):
            self.pos += 4
            return True
        if self.text.startswith("false", self.pos):
            self.pos += 5
            return False
        if self.text.startswith("null", self.pos):
            self.pos += 4
            return None
        raise self._error(
            "invalid_json",
            f"无法识别的 JSON 值，起始字符为 {ch!r}",
            path,
        )

    # ---- 容器 ----
    def _check_depth(self, path: str, depth: int) -> None:
        if depth > self.max_depth:
            raise self._error(
                "depth_exceeded",
                f"JSON 嵌套层级超过上限 {self.max_depth}",
                path,
            )

    def _parse_object(self, path: str, depth: int) -> dict[str, Any]:
        self._check_depth(path, depth)
        self.pos += 1  # {
        result: dict[str, Any] = {}
        self._skip_ws()
        if self._peek() == "}":
            self.pos += 1
            return result
        while True:
            self._skip_ws()
            if self._peek() != '"':
                raise self._error("invalid_json", "对象字段名必须是字符串", path)
            key_pos = self.pos
            key = self._parse_string(path, is_key=True)
            child = _child_path(path, key)
            if key in result:
                raise self._error(
                    "duplicate_key",
                    f"字段名 {key!r} 重复出现",
                    child,
                    key_pos,
                )
            self._skip_ws()
            if self._peek() != ":":
                raise self._error(
                    "invalid_json", f"字段 {key!r} 后缺少冒号", child
                )
            self.pos += 1
            self._skip_ws()
            result[key] = self._parse_value(child, depth)
            self._skip_ws()
            ch = self._peek()
            if ch == ",":
                self.pos += 1
                continue
            if ch == "}":
                self.pos += 1
                return result
            raise self._error(
                "invalid_json", "对象成员之间缺少逗号或对象未闭合", path
            )

    def _parse_array(self, path: str, depth: int) -> list[Any]:
        self._check_depth(path, depth)
        self.pos += 1  # [
        result: list[Any] = []
        self._skip_ws()
        if self._peek() == "]":
            self.pos += 1
            return result
        while True:
            self._skip_ws()
            result.append(self._parse_value(_index_path(path, len(result)), depth))
            self._skip_ws()
            ch = self._peek()
            if ch == ",":
                self.pos += 1
                continue
            if ch == "]":
                self.pos += 1
                return result
            raise self._error(
                "invalid_json", "数组元素之间缺少逗号或数组未闭合", path
            )

    # ---- 标量 ----
    def _parse_string(self, path: str, *, is_key: bool) -> str:
        start = self.pos
        self.pos += 1  # "
        chars: list[str] = []
        byte_count = 0
        if is_key:
            limit = min(MAX_JSON_KEY_BYTES, self.max_string_bytes)
        else:
            limit = self.max_string_bytes
        limit_label = "字段名" if is_key else "字符串值"

        while True:
            if self.pos >= self.length:
                raise self._error(
                    "unterminated_string", "字符串未闭合", path, start
                )
            ch = self.text[self.pos]
            if ch == '"':
                self.pos += 1
                return "".join(chars)
            if ch == "\\":
                char = self._parse_escape(path, start)
            else:
                if ord(ch) < 0x20:
                    raise self._error(
                        "control_character",
                        "字符串中包含未转义的控制字符",
                        path,
                    )
                char = ch
                self.pos += 1
            byte_count += len(char.encode("utf-8"))
            if byte_count > limit:
                raise self._error(
                    "string_too_large",
                    f"{limit_label}超过 {limit} 字节上限",
                    path,
                )
            chars.append(char)

    def _parse_escape(self, path: str, start: int) -> str:
        self.pos += 1  # backslash
        if self.pos >= self.length:
            raise self._error("invalid_escape", "转义序列不完整", path, start)
        esc = self.text[self.pos]
        if esc in _ESCAPES:
            self.pos += 1
            return _ESCAPES[esc]
        if esc != "u":
            raise self._error(
                "invalid_escape", f"不支持的转义字符 \\{esc}", path
            )
        code = self._read_hex4(path)
        if 0xD800 <= code <= 0xDBFF:
            if (
                self.pos + 1 < self.length
                and self.text[self.pos] == "\\"
                and self.text[self.pos + 1] == "u"
            ):
                # 只前进到第二个转义的 'u' 前，交给 _read_hex4 跳过它。
                self.pos += 1
                low = self._read_hex4(path)
                if not 0xDC00 <= low <= 0xDFFF:
                    raise self._error(
                        "invalid_escape", "代理对中的低位码点非法", path
                    )
                return chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00))
            raise self._error("invalid_escape", "孤立的高位代理字符", path)
        if 0xDC00 <= code <= 0xDFFF:
            raise self._error("invalid_escape", "孤立的低位代理字符", path)
        return chr(code)

    def _read_hex4(self, path: str) -> int:
        self.pos += 1  # u
        chunk = self.text[self.pos : self.pos + 4]
        if len(chunk) != 4 or any(c not in "0123456789abcdefABCDEF" for c in chunk):
            raise self._error("invalid_escape", "\\u 后必须跟随 4 位十六进制数", path)
        self.pos += 4
        return int(chunk, 16)

    def _parse_number(self, path: str) -> int | float:
        start = self.pos
        match = _NUMBER_RE.match(self.text, self.pos)
        if not match:
            raise self._error("invalid_number", "数字格式不合法", path)
        raw = match.group(0)
        self.pos = match.end()
        if len(raw) > 64:
            raise self._error("number_too_large", "数字字面量过长", path, start)
        try:
            if "." in raw or "e" in raw or "E" in raw:
                value = float(raw)
                if value != value or value in (float("inf"), float("-inf")):
                    raise ValueError("non-finite")
                return value
            return int(raw)
        except (ValueError, OverflowError):
            raise self._error("invalid_number", "数字超出可接受范围", path, start)


def loads_strict(
    data: bytes | str,
    *,
    max_bytes: int,
    max_depth: int = MAX_JSON_DEPTH,
    max_nodes: int = MAX_JSON_NODES,
    max_string_bytes: int = MAX_JSON_STRING_BYTES,
) -> Any:
    """解码并严格解析 JSON；失败时抛出 :class:`JsonInputError`。"""

    if isinstance(data, bytes):
        if len(data) > max_bytes:
            raise JsonInputError(
                "document_too_large",
                f"策略文档超过 {max_bytes} 字节上限",
            )
        if data.startswith(_BOM_BYTES):
            raise JsonInputError(
                "bom_not_allowed", "文档不能包含 UTF-8 BOM"
            )
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise JsonInputError(
                "invalid_encoding",
                "文档必须是合法 UTF-8 编码",
            ) from exc
    else:
        text = data
        if len(text.encode("utf-8")) > max_bytes:
            raise JsonInputError(
                "document_too_large",
                f"策略文档超过 {max_bytes} 字节上限",
            )
        if text.startswith(_BOM_CHAR):
            raise JsonInputError(
                "bom_not_allowed", "文档不能包含 UTF-8 BOM"
            )

    return _Parser(
        text,
        max_depth=max_depth,
        max_nodes=max_nodes,
        max_string_bytes=max_string_bytes,
    ).parse()

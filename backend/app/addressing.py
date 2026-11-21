"""Strict parsing and normalisation of addresses in proxy-related inputs.

Every value is preserved.  Values that cannot be interpreted without
guessing are reported as ``unknown``, ``empty`` or ``malformed`` instead of
being dropped, because dropping a hop silently changes the trust chain.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass, field
from typing import Literal

Kind = Literal["address", "unknown", "empty", "malformed"]

_UNKNOWN_TOKENS = {"unknown", "-"}
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
_BRACKETED_RE = re.compile(r"^\[(?P<addr>[^\]]*)\](?::(?P<port>.*))?$")


@dataclass
class ParsedAddress:
    """One address-looking value from a request."""

    raw: str
    kind: Kind
    address: str | None = None
    version: int | None = None
    port: int | None = None
    problem: str | None = None
    note: str | None = None

    def to_dict(self) -> dict:
        return {
            "raw": self.raw,
            "kind": self.kind,
            "address": self.address,
            "version": self.version,
            "port": self.port,
            "problem": self.problem,
            "note": self.note,
        }


@dataclass
class ParsedForwardedElement:
    """One comma separated element of an RFC 7239 ``Forwarded`` header."""

    raw: str
    kind: Kind
    address: str | None = None
    version: int | None = None
    port: int | None = None
    problem: str | None = None
    note: str | None = None
    params: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "raw": self.raw,
            "kind": self.kind,
            "address": self.address,
            "version": self.version,
            "port": self.port,
            "problem": self.problem,
            "note": self.note,
            "params": self.params,
        }


def _unquote(value: str) -> tuple[str | None, str | None]:
    """Remove one layer of quotes, returning ``(value, problem)``."""
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        inner = value[1:-1]
        if '"' in inner:
            return None, "引号内出现未转义的双引号"
        return inner, None
    if value.startswith('"') or value.endswith('"'):
        return None, "引号不配对"
    return value, None


def _valid_port(port: str) -> tuple[int | None, str | None]:
    if port == "":
        return None, "端口为空"
    if not port.isdigit():
        return None, f"端口 {port!r} 不是数字"
    number = int(port)
    if not 1 <= number <= 65535:
        return None, f"端口 {number} 超出 1-65535"
    return number, None


def _parse_ip(value: str) -> tuple[str | None, int | None, str | None, str | None]:
    if "%" in value:
        return None, None, "IPv6 区域标识（%zone）不能出现在转发地址中", None
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return None, None, "不是合法的 IPv4 或 IPv6 地址", None
    if ip.version == 6 and ip.ipv4_mapped is not None:
        return (
            str(ip.ipv4_mapped),
            4,
            None,
            "IPv4 映射的 IPv6 地址已规范化为 IPv4",
        )
    return str(ip), ip.version, None, None


def parse_address(raw: str) -> ParsedAddress:
    """Parse one address token from ``X-Forwarded-For``-like input."""
    text = "" if raw is None else str(raw)
    stripped = text.strip()

    if stripped == "":
        return ParsedAddress(raw=text, kind="empty", problem="空项")
    if _CONTROL_RE.search(text):
        return ParsedAddress(raw=text, kind="malformed", problem="包含控制字符")

    unquoted, quote_problem = _unquote(stripped)
    if quote_problem:
        return ParsedAddress(raw=text, kind="malformed", problem=quote_problem)
    assert unquoted is not None
    value = unquoted.strip()
    if value == "":
        return ParsedAddress(raw=text, kind="empty", problem="引号内为空")

    if value.lower() in _UNKNOWN_TOKENS:
        return ParsedAddress(raw=text, kind="unknown", problem="显式的未知值")

    if ";" in value or "," in value:
        return ParsedAddress(
            raw=text, kind="malformed", problem="含有分隔符，不是单个地址"
        )

    if "%" in value:
        return ParsedAddress(
            raw=text,
            kind="malformed",
            problem="IPv6 区域标识（%zone）不能出现在转发地址中",
        )

    bracket = _BRACKETED_RE.match(value)
    if bracket:
        inner = bracket.group("addr").strip()
        if inner == "":
            return ParsedAddress(raw=text, kind="malformed", problem="方括号内为空")
        try:
            literal = ipaddress.ip_address(inner)
        except ValueError:
            return ParsedAddress(
                raw=text, kind="malformed", problem="方括号内不是合法的 IPv6 地址"
            )
        if literal.version != 6:
            # Brackets are reserved for IPv6 literals; allowing "[1.2.3.4]"
            # would accept a form that real proxies do not emit.
            return ParsedAddress(
                raw=text, kind="malformed", problem="方括号只允许用于 IPv6 地址"
            )
        port_text = bracket.group("port")
        address, version, problem, note = _parse_ip(inner)
        if problem:
            return ParsedAddress(
                raw=text, kind="malformed", problem=f"方括号内{problem}"
            )
        port = None
        if port_text is not None:
            port, port_problem = _valid_port(port_text)
            if port_problem:
                return ParsedAddress(raw=text, kind="malformed", problem=port_problem)
        return ParsedAddress(
            raw=text,
            kind="address",
            address=address,
            version=version,
            port=port,
            note=note,
        )

    if value.startswith("[") or value.endswith("]"):
        return ParsedAddress(raw=text, kind="malformed", problem="方括号不配对")

    host = value
    port_text: str | None = None
    if value.count(":") == 1:
        host, _, port_text = value.partition(":")

    address, version, problem, note = _parse_ip(host)
    if problem:
        if ":" in value:
            return ParsedAddress(
                raw=text,
                kind="malformed",
                problem="无法区分的 IPv6/端口组合，IPv6 带端口时必须使用方括号",
            )
        return ParsedAddress(
            raw=text, kind="malformed", problem=f"{host!r} 不是 IP 地址"
        )

    port = None
    if port_text is not None:
        port, port_problem = _valid_port(port_text)
        if port_problem:
            return ParsedAddress(raw=text, kind="malformed", problem=port_problem)

    return ParsedAddress(
        raw=text,
        kind="address",
        address=address,
        version=version,
        port=port,
        note=note,
    )


def _split_quoted_list(
    value: str, separator: str = ","
) -> tuple[list[str], str | None]:
    """Split a header value on ``separator`` while respecting double quotes."""
    items: list[str] = []
    current: list[str] = []
    in_quotes = False
    escaped = False
    for char in value:
        if escaped:
            current.append(char)
            escaped = False
            continue
        if char == "\\" and in_quotes:
            current.append(char)
            escaped = True
            continue
        if char == '"':
            in_quotes = not in_quotes
            current.append(char)
            continue
        if char == separator and not in_quotes:
            items.append("".join(current))
            current = []
            continue
        current.append(char)
    if in_quotes:
        return items + ["".join(current)], "引号未闭合"
    items.append("".join(current))
    return items, None


def parse_forwarded_list(raw: str) -> list[ParsedAddress]:
    """Parse a comma separated address list, preserving every element."""
    text = "" if raw is None else str(raw)
    if text.strip() == "":
        return []
    parts, split_problem = _split_quoted_list(text, ",")
    if split_problem:
        return [
            ParsedAddress(raw=text, kind="malformed", problem=split_problem)
        ]
    return [parse_address(part) for part in parts]


def _parse_forwarded_params(text: str) -> tuple[dict[str, str], str | None]:
    params: dict[str, str] = {}
    pieces, split_problem = _split_quoted_list(text, ";")
    if split_problem:
        return params, split_problem
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        name, sep, value = piece.partition("=")
        name = name.strip().lower()
        value = value.strip()
        if not sep or not name or value == "":
            return params, f"参数 {piece!r} 不是 name=value 形式"
        if not _TOKEN_RE.match(name):
            return params, f"参数名 {name!r} 非法"
        if name in params:
            return params, f"参数 {name!r} 重复"
        unquoted, quote_problem = _unquote(value)
        if quote_problem:
            return params, f"参数 {name!r}: {quote_problem}"
        params[name] = unquoted if unquoted is not None else value
    return params, None


def _forwarded_port(params: dict[str, str]) -> int | None:
    port_text = params.get("port")
    if port_text is None or not port_text.isdigit():
        return None
    number = int(port_text)
    return number if 1 <= number <= 65535 else None


def parse_forwarded(raw: str) -> list[ParsedForwardedElement]:
    """Parse an RFC 7239 ``Forwarded`` header into one element per hop."""
    text = "" if raw is None else str(raw)
    if text.strip() == "":
        return []
    elements, split_problem = _split_quoted_list(text, ",")
    if split_problem:
        return [
            ParsedForwardedElement(
                raw=text, kind="malformed", problem=f"Forwarded 头{split_problem}"
            )
        ]

    parsed: list[ParsedForwardedElement] = []
    for element in elements:
        stripped = element.strip()
        if stripped == "":
            parsed.append(
                ParsedForwardedElement(
                    raw=element, kind="empty", problem="Forwarded 中的空元素"
                )
            )
            continue
        params, param_problem = _parse_forwarded_params(stripped)
        if param_problem:
            parsed.append(
                ParsedForwardedElement(
                    raw=element, kind="malformed", problem=param_problem
                )
            )
            continue
        if "for" not in params:
            parsed.append(
                ParsedForwardedElement(
                    raw=element,
                    kind="malformed",
                    problem="Forwarded 元素缺少 for= 参数",
                    params=params,
                )
            )
            continue
        for_value = params["for"]
        if for_value.startswith("_"):
            parsed.append(
                ParsedForwardedElement(
                    raw=element,
                    kind="unknown",
                    problem="for 参数为混淆值（以 _ 开头）",
                    params=params,
                )
            )
            continue
        address = parse_address(for_value)
        problem = address.problem
        if address.kind == "unknown":
            problem = problem or "for 参数为未知值"
        parsed.append(
            ParsedForwardedElement(
                raw=element,
                kind=address.kind,
                address=address.address,
                version=address.version,
                port=(
                    address.port
                    if address.port is not None
                    else _forwarded_port(params)
                ),
                problem=problem,
                note=address.note,
                params=params,
            )
        )
    return parsed


def describe_kind(kind: Kind) -> str:
    return {
        "address": "已识别地址",
        "unknown": "未知值",
        "empty": "空项",
        "malformed": "格式错误",
    }[kind]

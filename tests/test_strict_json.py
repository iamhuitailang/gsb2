"""严格 JSON 解析的输入校验测试。"""

from __future__ import annotations

import json

import pytest

from app.strict_json import JsonInputError, loads_strict

SMALL = 10_000


def test_accepts_valid_document() -> None:
    text = '{"a": 1, "b": [true, false, null], "c": "中文"}'
    assert loads_strict(text, max_bytes=SMALL) == {
        "a": 1,
        "b": [True, False, None],
        "c": "中文",
    }


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_rejects_non_standard_numeric_literals(literal: str) -> None:
    with pytest.raises(JsonInputError) as info:
        loads_strict(f'{{"v": {literal}}}', max_bytes=SMALL)
    assert info.value.code in {"invalid_json", "invalid_number"}


def test_rejects_duplicate_keys_at_any_depth() -> None:
    with pytest.raises(JsonInputError) as info:
        loads_strict('{"a": {"b": 1, "b": 2}}', max_bytes=SMALL)
    assert info.value.code == "duplicate_key"
    assert info.value.path == "$.a.b"
    assert info.value.line == 1


def test_duplicate_keys_do_not_silently_override() -> None:
    # 一旦允许覆盖，action 就能在浏览器里显示 allow、服务端执行 deny。
    with pytest.raises(JsonInputError):
        loads_strict('{"action": "allow", "action": "deny"}', max_bytes=SMALL)


def test_rejects_excessive_depth() -> None:
    text = "[" * 12 + "]" * 12
    with pytest.raises(JsonInputError) as info:
        loads_strict(text, max_bytes=SMALL)
    assert info.value.code == "depth_exceeded"


def test_rejects_too_many_nodes() -> None:
    text = json.dumps(list(range(200)))
    with pytest.raises(JsonInputError) as info:
        loads_strict(text, max_bytes=SMALL, max_nodes=50)
    assert info.value.code == "too_many_nodes"


def test_rejects_oversize_document() -> None:
    with pytest.raises(JsonInputError) as info:
        loads_strict('{"v": "' + "x" * 1000 + '"}', max_bytes=100)
    assert info.value.code == "document_too_large"


def test_rejects_oversize_string_value() -> None:
    text = json.dumps({"v": "x" * 3000})
    with pytest.raises(JsonInputError) as info:
        loads_strict(text, max_bytes=SMALL)
    assert info.value.code == "string_too_large"


def test_rejects_bom() -> None:
    with pytest.raises(JsonInputError) as info:
        loads_strict(b"\xef\xbb\xbf{}", max_bytes=SMALL)
    assert info.value.code == "bom_not_allowed"


def test_rejects_invalid_utf8() -> None:
    with pytest.raises(JsonInputError) as info:
        loads_strict(b'{"v": "\xff"}', max_bytes=SMALL)
    assert info.value.code == "invalid_encoding"


@pytest.mark.parametrize(
    "text",
    [
        '{"a": 1,}',
        '{"a" 1}',
        '{"a": 1} extra',
        '{"a": "unterminated}',
        '{"a": 01}',
        '',
    ],
)
def test_rejects_malformed_json(text: str) -> None:
    with pytest.raises(JsonInputError):
        loads_strict(text, max_bytes=SMALL)


def test_rejects_unescaped_control_character() -> None:
    with pytest.raises(JsonInputError) as info:
        loads_strict('{"v": "line\nbreak"}', max_bytes=SMALL)
    assert info.value.code == "control_character"


def test_rejects_lone_surrogate_escape() -> None:
    with pytest.raises(JsonInputError) as info:
        loads_strict('{"v": "\\ud800"}', max_bytes=SMALL)
    assert info.value.code == "invalid_escape"


def test_accepts_valid_surrogate_pair() -> None:
    assert loads_strict('{"v": "\\ud83d\\ude00"}', max_bytes=SMALL) == {
        "v": "😀"
    }


def test_error_reports_line_and_column() -> None:
    with pytest.raises(JsonInputError) as info:
        loads_strict('{\n  "a": 1,\n  "a": 2\n}', max_bytes=SMALL)
    assert info.value.line == 3

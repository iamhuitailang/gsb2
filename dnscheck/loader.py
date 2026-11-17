"""Load and strictly validate JSON scenario files.

Every malformed input raises ScenarioError with the file name, the step
index and the field involved, so problems are locatable instead of being
silently skipped.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

from .model import ModelError, Question, Record, Response


class ScenarioError(Exception):
    pass


@dataclass
class Config:
    max_ttl: int = 300
    negative_ttl: int = 60
    max_cname_depth: int = 8
    clock_start: float = 0.0


@dataclass
class QueryStep:
    question: Question
    upstream: Response | None


@dataclass
class AdvanceStep:
    seconds: float


@dataclass
class CleanupStep:
    pass


@dataclass
class Scenario:
    config: Config
    steps: list


def _fail(path, where, msg):
    raise ScenarioError(f"{path}: {where}: {msg}")


def _require(obj, key, where, path):
    if key not in obj:
        _fail(path, where, f"missing required field {key!r}")
    return obj[key]


def _check_int(value, where, field, path, minimum=None):
    if not isinstance(value, int) or isinstance(value, bool):
        _fail(path, where, f"field {field!r} must be an integer, got {value!r}")
    if minimum is not None and value < minimum:
        _fail(path, where, f"field {field!r} must be >= {minimum}, got {value}")
    return value


def _check_number(value, where, field, path, minimum=None):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        _fail(path, where, f"field {field!r} must be a number, got {value!r}")
    if minimum is not None and value < minimum:
        _fail(path, where, f"field {field!r} must be >= {minimum}, got {value}")
    return value


def _parse_record(raw, where, path):
    if not isinstance(raw, dict):
        _fail(path, where, "record must be an object")
    try:
        return Record(
            name=_require(raw, "name", where, path),
            rtype=_require(raw, "type", where, path),
            rclass=raw.get("class", "IN"),
            ttl=_check_int(_require(raw, "ttl", where, path), where, "ttl", path, minimum=0),
            data=_require(raw, "data", where, path),
        )
    except ModelError as e:
        _fail(path, where, str(e))


def _parse_question(raw, where, path, qid=0):
    if not isinstance(raw, dict):
        _fail(path, where, "question must be an object")
    try:
        return Question(
            name=_require(raw, "name", where, path),
            qtype=raw.get("type", "A"),
            qclass=raw.get("class", "IN"),
            qid=qid,
        )
    except ModelError as e:
        _fail(path, where, str(e))


def _parse_response(raw, where, path):
    if not isinstance(raw, dict):
        _fail(path, where, "upstream response must be an object")
    rid = _check_int(_require(raw, "id", where, path), where, "id", path)
    rcode = _require(raw, "rcode", where, path)
    question = None
    if "question" in raw and raw["question"] is not None:
        question = _parse_question(raw["question"], f"{where}.question", path)
    answers_raw = raw.get("answers", [])
    if not isinstance(answers_raw, list):
        _fail(path, f"{where}.answers", "must be a list")
    answers = [
        _parse_record(a, f"{where}.answers[{i}]", path) for i, a in enumerate(answers_raw)
    ]
    try:
        return Response(id=rid, rcode=rcode, question=question, answers=answers)
    except ModelError as e:
        _fail(path, where, str(e))


def _parse_step(raw, index, path):
    where = f"step {index}"
    if not isinstance(raw, dict):
        _fail(path, where, "step must be an object")
    op = _require(raw, "op", where, path)
    if op == "query":
        qid = _check_int(_require(raw, "id", where, path), where, "id", path)
        try:
            question = Question(
                name=_require(raw, "qname", where, path),
                qtype=raw.get("qtype", "A"),
                qclass=raw.get("qclass", "IN"),
                qid=qid,
            )
        except ModelError as e:
            _fail(path, where, str(e))
        upstream = None
        if "upstream" in raw and raw["upstream"] is not None:
            upstream = _parse_response(raw["upstream"], f"{where}.upstream", path)
        return QueryStep(question=question, upstream=upstream)
    if op == "advance":
        seconds = _check_number(
            _require(raw, "seconds", where, path), where, "seconds", path, minimum=0
        )
        return AdvanceStep(seconds=seconds)
    if op == "cleanup":
        return CleanupStep()
    _fail(path, where, f"unknown op {op!r} (expected 'query', 'advance' or 'cleanup')")


def load_scenario(path) -> Scenario:
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except json.JSONDecodeError as e:
        raise ScenarioError(f"{path}: invalid JSON at line {e.lineno}, column {e.colno}: {e.msg}")
    except OSError as e:
        raise ScenarioError(f"{path}: cannot read file: {e}")

    if not isinstance(raw, dict):
        _fail(path, "$", "top level must be a JSON object")

    cfg_raw = raw.get("config", {})
    if not isinstance(cfg_raw, dict):
        _fail(path, "config", "must be an object")
    config = Config()
    if "max_ttl" in cfg_raw:
        config.max_ttl = _check_int(cfg_raw["max_ttl"], "config", "max_ttl", path, minimum=1)
    if "negative_ttl" in cfg_raw:
        config.negative_ttl = _check_int(
            cfg_raw["negative_ttl"], "config", "negative_ttl", path, minimum=1
        )
    if "max_cname_depth" in cfg_raw:
        config.max_cname_depth = _check_int(
            cfg_raw["max_cname_depth"], "config", "max_cname_depth", path, minimum=0
        )
    if "clock_start" in cfg_raw:
        config.clock_start = _check_number(
            cfg_raw["clock_start"], "config", "clock_start", path, minimum=0
        )

    steps_raw = _require(raw, "steps", "$", path)
    if not isinstance(steps_raw, list):
        _fail(path, "steps", "must be a list")
    steps = [_parse_step(s, i, path) for i, s in enumerate(steps_raw)]
    return Scenario(config=config, steps=steps)

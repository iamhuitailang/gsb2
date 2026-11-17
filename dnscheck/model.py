"""Core data model: names, questions, records, responses."""
from __future__ import annotations

from dataclasses import dataclass, field

VALID_RCODES = {"NOERROR", "NXDOMAIN", "SERVFAIL"}
VALID_CLASSES = {"IN"}
VALID_TYPES = {"A", "AAAA", "CNAME"}


class ModelError(ValueError):
    """Raised when a DNS object fails structural validation."""


def normalize_name(name):
    """Canonical form for comparison: lower-case, no trailing dot.

    DNS names are case-insensitive and a fully-qualified name may or may
    not carry the trailing root dot; both spellings are the same name.
    """
    if not isinstance(name, str):
        raise ModelError(f"name must be a string, got {type(name).__name__}")
    n = name.strip().rstrip(".").lower()
    if not n:
        raise ModelError("name must not be empty")
    if len(n) > 253:
        raise ModelError(f"name too long ({len(n)} chars)")
    for label in n.split("."):
        if not label:
            raise ModelError(f"empty label in name {name!r}")
    return n


def _check(value, allowed, what):
    v = value.upper() if isinstance(value, str) else value
    if v not in allowed:
        raise ModelError(f"unsupported {what}: {value!r}")
    return v


@dataclass(frozen=True)
class Question:
    """A DNS question. `qid` is the transaction id of the query it came
    from; for a question section echoed inside a response it is unused."""

    name: str
    qtype: str = "A"
    qclass: str = "IN"
    qid: int = 0

    def __post_init__(self):
        object.__setattr__(self, "name", normalize_name(self.name))
        object.__setattr__(self, "qtype", _check(self.qtype, VALID_TYPES, "record type"))
        object.__setattr__(self, "qclass", _check(self.qclass, VALID_CLASSES, "record class"))
        if not isinstance(self.qid, int) or isinstance(self.qid, bool):
            raise ModelError("query id must be an integer")


@dataclass(frozen=True)
class Record:
    name: str
    rtype: str
    rclass: str
    ttl: int
    data: str

    def __post_init__(self):
        object.__setattr__(self, "name", normalize_name(self.name))
        object.__setattr__(self, "rtype", _check(self.rtype, VALID_TYPES, "record type"))
        object.__setattr__(self, "rclass", _check(self.rclass, VALID_CLASSES, "record class"))
        if not isinstance(self.ttl, int) or isinstance(self.ttl, bool) or self.ttl < 0:
            raise ModelError(f"ttl must be a non-negative integer, got {self.ttl!r}")
        if not isinstance(self.data, str) or not self.data:
            raise ModelError("record data must be a non-empty string")


@dataclass(frozen=True)
class Response:
    """A simulated upstream response."""

    id: int
    rcode: str
    question: Question | None
    answers: tuple = ()

    def __post_init__(self):
        if not isinstance(self.id, int) or isinstance(self.id, bool):
            raise ModelError("response id must be an integer")
        object.__setattr__(self, "rcode", _check(self.rcode, VALID_RCODES, "rcode"))
        if self.question is not None and not isinstance(self.question, Question):
            raise ModelError("response question must be a Question or null")
        object.__setattr__(self, "answers", tuple(self.answers))
        for r in self.answers:
            if not isinstance(r, Record):
                raise ModelError("answers must be Records")

"""Checks that a response actually corresponds to the request.

A response is only usable if its transaction id matches and its question
section echoes the exact question asked (name compared case-insensitively
and ignoring a trailing dot). Additionally every answer record must be
relevant: reachable from the queried name by following CNAMEs inside the
same response. An answer section that merely contains *some* address
record for an unrelated name is not acceptable.
"""
from __future__ import annotations

from .model import ModelError, normalize_name

_REACH_LIMIT = 32


def _reachable_names(question_name, answers):
    reachable = {question_name}
    frontier = {question_name}
    cname_targets = {}
    for r in answers:
        if r.rtype == "CNAME":
            try:
                cname_targets.setdefault(r.name, set()).add(normalize_name(r.data))
            except ModelError:
                continue
    for _ in range(_REACH_LIMIT):
        new = set()
        for n in frontier:
            new |= cname_targets.get(n, set()) - reachable
        if not new:
            break
        reachable |= new
        frontier = new
    return reachable


def validate_response(question, response):
    """Return a list of problems; empty means the response corresponds
    to the request."""
    problems = []

    if response.id != question.qid:
        problems.append(
            f"transaction id mismatch: query id {question.qid}, response id {response.id}"
        )

    rq = response.question
    if rq is None:
        problems.append("response carries no question section")
    else:
        if rq.name != question.name:
            problems.append(
                f"question name mismatch: asked {question.name}, response says {rq.name}"
            )
        if rq.qtype != question.qtype:
            problems.append(
                f"question type mismatch: asked {question.qtype}, response says {rq.qtype}"
            )
        if rq.qclass != question.qclass:
            problems.append(
                f"question class mismatch: asked {question.qclass}, response says {rq.qclass}"
            )

    reachable = _reachable_names(question.name, response.answers)
    for r in response.answers:
        if r.name not in reachable:
            problems.append(
                f"answer record for unrelated name {r.name} ({r.rtype}) is not relevant to the query"
            )
        if r.rclass != question.qclass:
            problems.append(
                f"answer record {r.name} ({r.rtype}) has class {r.rclass}, expected {question.qclass}"
            )

    return problems

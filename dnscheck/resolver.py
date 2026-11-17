"""Query resolution: cache lookup, upstream validation, CNAME chains."""
from __future__ import annotations

from dataclasses import dataclass

from .model import ModelError, normalize_name
from .validator import validate_response


@dataclass
class QueryResult:
    # CACHE_HIT | CACHE_HIT_NXDOMAIN | ACCEPT | REJECT | NXDOMAIN | SERVFAIL | NO_UPSTREAM
    status: str
    answers: tuple = ()
    reasons: tuple = ()
    stored: tuple = ()  # human-readable cache actions, for the CLI


def resolve_chain(start, qtype, qclass, lookup, max_depth):
    """Follow the CNAME chain from `start` until records of `qtype` appear.

    `lookup(name, rtype)` returns candidate records (from the response,
    the cache, or both). Returns (records, None) on success or
    (None, reason) on loop / excessive depth / missing target / conflict.
    """
    seen = {start}
    chain = []
    current = start
    for _ in range(max_depth + 1):
        directs = lookup(current, qtype)
        cnames = [] if qtype == "CNAME" else lookup(current, "CNAME")
        if directs and cnames:
            return None, f"conflicting records at {current}: both CNAME and {qtype} present"
        if directs:
            return chain + list(directs), None
        if len(cnames) > 1:
            try:
                targets = sorted({normalize_name(c.data) for c in cnames})
            except ModelError:
                targets = ["<invalid target>"]
            return None, f"conflicting CNAME records at {current}: {targets}"
        if not cnames:
            return None, f"chain incomplete: no {qtype} or CNAME record for {current}"
        cname = cnames[0]
        chain.append(cname)
        try:
            target = normalize_name(cname.data)
        except ModelError as e:
            return None, f"invalid CNAME target at {current}: {e}"
        if target in seen:
            return None, f"CNAME loop detected: {target} already visited"
        seen.add(target)
        current = target
    return None, f"CNAME chain too deep (limit {max_depth})"


class Resolver:
    def __init__(self, cache, max_cname_depth: int = 8):
        self._cache = cache
        self._max_depth = max_cname_depth

    def resolve(self, question, upstream=None) -> QueryResult:
        cache = self._cache
        qclass = question.qclass

        def cache_lookup(name, rtype):
            entry = cache.get((name, rtype))
            if entry is not None and entry.kind == "positive":
                return list(entry.records)
            return []

        # 1. Negative cache.
        neg = cache.get((question.name, question.qtype))
        if neg is not None and neg.kind == "nxdomain":
            return QueryResult(
                "CACHE_HIT_NXDOMAIN",
                reasons=(f"cached NXDOMAIN for {question.name} {question.qtype}",),
            )

        # 2. Positive answer assembled from cache alone.
        records, cache_err = resolve_chain(
            question.name, question.qtype, qclass, cache_lookup, self._max_depth
        )
        if records is not None:
            return QueryResult(
                "CACHE_HIT",
                answers=tuple(records),
                reasons=("complete answer chain served from cache",),
            )

        # 3. Upstream needed.
        if upstream is None:
            return QueryResult(
                "NO_UPSTREAM",
                reasons=(f"cache miss ({cache_err}); no upstream sample provided",),
            )

        problems = validate_response(question, upstream)
        if problems:
            return QueryResult("REJECT", reasons=tuple(problems))

        if upstream.rcode == "SERVFAIL":
            # Temporary failure: never cached, never touches existing entries.
            return QueryResult(
                "SERVFAIL",
                reasons=("upstream returned SERVFAIL (temporary failure); not cached",),
            )

        if upstream.rcode == "NXDOMAIN":
            stored = cache.store_negative((question.name, question.qtype))
            note = (
                "negative result cached"
                if stored
                else "existing valid positive answer kept; NXDOMAIN not cached"
            )
            return QueryResult("NXDOMAIN", reasons=(f"upstream NXDOMAIN; {note}",))

        # NOERROR: the whole chain must resolve, from this response plus
        # the cache, before anything is stored.
        def combined_lookup(name, rtype):
            recs = [
                r
                for r in upstream.answers
                if r.name == name and r.rtype == rtype and r.rclass == qclass
            ]
            return recs if recs else cache_lookup(name, rtype)

        records, err = resolve_chain(
            question.name, question.qtype, qclass, combined_lookup, self._max_depth
        )
        if records is None:
            # Incomplete or untrustworthy chains are not cached at all.
            return QueryResult("REJECT", reasons=(f"unusable answer chain: {err}",))

        groups = {}
        for r in records:
            groups.setdefault((r.name, r.rtype), []).append(r)
        stored = []
        for (name, rtype), recs in groups.items():
            ttl = min(r.ttl for r in recs)
            ok = cache.store_positive((name, rtype), tuple(recs), ttl)
            clamped = cache.clamp_ttl(ttl)
            clamp_note = f" (ttl clamped {ttl} -> {clamped})" if clamped < ttl else ""
            action = "cached" if ok else "kept existing fresher entry for"
            stored.append(f"{action} {rtype}/{name}{clamp_note}")
        return QueryResult(
            "ACCEPT",
            answers=tuple(records),
            reasons=("response matches query; answer chain complete",),
            stored=tuple(stored),
        )

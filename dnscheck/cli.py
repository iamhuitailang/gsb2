"""Command-line entry point: run a scenario file and explain every decision.

Output shows query names, record types and verdicts with reasons. Record
data (e.g. IP addresses) is only printed with --show-data, to keep logs
free of detail that is usually unnecessary.
"""
from __future__ import annotations

import argparse
import sys

from .cache import DnsCache
from .clock import Clock
from .loader import AdvanceStep, CleanupStep, QueryStep, ScenarioError, load_scenario
from .resolver import Resolver


def _fmt_answers(result, show_data):
    parts = []
    for r in result.answers:
        parts.append(f"{r.name} {r.rtype}" + (f" -> {r.data}" if show_data else ""))
    return "; ".join(parts)


def run_scenario(scenario, out, show_data=False):
    cfg = scenario.config
    clock = Clock(cfg.clock_start)
    cache = DnsCache(clock, max_ttl=cfg.max_ttl, negative_ttl=cfg.negative_ttl)
    resolver = Resolver(cache, max_cname_depth=cfg.max_cname_depth)

    counts = {}
    for i, step in enumerate(scenario.steps):
        if isinstance(step, AdvanceStep):
            clock.advance(step.seconds)
            print(f"[t={clock.now():>8.0f}] step {i}: ADVANCE +{step.seconds}s", file=out)
            continue
        if isinstance(step, CleanupStep):
            removed = cache.cleanup()
            print(
                f"[t={clock.now():>8.0f}] step {i}: CLEANUP removed {removed} expired entr"
                f"{'y' if removed == 1 else 'ies'}",
                file=out,
            )
            continue

        q = step.question
        result = resolver.resolve(q, step.upstream)
        counts[result.status] = counts.get(result.status, 0) + 1
        print(
            f"[t={clock.now():>8.0f}] step {i}: QUERY {q.name} {q.qtype} (id={q.qid})"
            f" -> {result.status}",
            file=out,
        )
        for reason in result.reasons:
            print(f"{'':>13}reason: {reason}", file=out)
        if result.answers:
            print(f"{'':>13}answer: {_fmt_answers(result, show_data)}", file=out)
        for note in result.stored:
            print(f"{'':>13}cache:  {note}", file=out)

    summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "no queries"
    print(f"summary: {summary}; cache entries at end: {len(cache)}", file=out)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="dnscheck",
        description="Offline DNS response cache and security-check tool. "
        "Runs a JSON scenario of queries and simulated upstream responses.",
    )
    parser.add_argument("scenario", help="path to a scenario JSON file")
    parser.add_argument(
        "--show-data",
        action="store_true",
        help="include record data (e.g. IP addresses) in the output",
    )
    args = parser.parse_args(argv)

    try:
        scenario = load_scenario(args.scenario)
    except ScenarioError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    return run_scenario(scenario, sys.stdout, show_data=args.show_data)


if __name__ == "__main__":
    sys.exit(main())

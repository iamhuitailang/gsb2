"""Sanity checks that the module graph imports and the demo data validates.

These are intentionally small; the behavioural suite lives in the other test
modules.  They exist so a broken import or demo payload fails fast.
"""

from __future__ import annotations

from app import __version__
from app.analyzer import OUTCOME_LABELS, RISK_BY_OUTCOME
from app.config import FIELD_ORDER, normalize_trust_config
from app.demos import DEMOS
from app.headers import normalize_headers


def test_outcome_metadata_is_complete():
    for key in OUTCOME_LABELS:
        assert key in RISK_BY_OUTCOME, key
        risk, label = RISK_BY_OUTCOME[key]
        assert risk in {"low", "high", "info", "unknown"}
        assert label


def test_all_demo_configs_validate_and_headers_normalise():
    for demo in DEMOS:
        _, config_errors, _ = normalize_trust_config(demo["config"])
        assert config_errors == [], (demo["slug"], config_errors)
        headers, header_errors = normalize_headers(demo["headers"])
        assert header_errors == [], (demo["slug"], header_errors)
        assert set(headers) == set(FIELD_ORDER)


def test_demo_slugs_are_unique():
    slugs = [demo["slug"] for demo in DEMOS]
    assert len(slugs) == len(set(slugs))


def test_version_is_set():
    assert __version__

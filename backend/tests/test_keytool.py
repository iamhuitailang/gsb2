"""Key rotation CLI tests: init, rotate with grace, retire, no secret output."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import keytool
from app.audit import AuditStore
from app.canonical import build_canonical
from app.config import build_settings, load_settings, utc_now
from app.verifier import PreparedRequest, VerificationError, compute_signature, verify_request


def run(*args: str) -> int:
    """Invoke the CLI; argparse SystemExit is not expected on valid options."""
    return keytool.main(list(args))


def test_init_writes_config_with_owner_only_permissions(tmp_path: Path, capsys):
    config = tmp_path / "config.local.json"
    assert run("--config", str(config), "init") == 0
    out = capsys.readouterr().out

    data = json.loads(config.read_text(encoding="utf-8"))
    secret = data["keys"][0]["secret"]
    assert secret not in out, "the CLI must never echo the secret"
    assert config.stat().st_mode & 0o077 == 0

    settings = load_settings(config)
    active = settings.active_key()
    assert active is not None
    assert active.key_id == "demo-local-01"


def test_init_refuses_to_overwrite_without_force(tmp_path: Path, capsys):
    config = tmp_path / "config.local.json"
    run("--config", str(config), "init")
    capsys.readouterr()
    assert run("--config", str(config), "init") == 1


def test_status_never_prints_secret(tmp_path: Path, capsys):
    config = tmp_path / "config.local.json"
    run("--config", str(config), "init")
    capsys.readouterr()
    secret = json.loads(config.read_text(encoding="utf-8"))["keys"][0]["secret"]

    assert run("--config", str(config), "status") == 0
    out = capsys.readouterr().out
    assert secret not in out
    assert "demo-local-01" in out


def test_rotate_creates_parallel_grace_then_retire(tmp_path: Path, capsys):
    config = tmp_path / "config.local.json"
    run("--config", str(config), "init")
    capsys.readouterr()

    old_id = json.loads(config.read_text(encoding="utf-8"))["keys"][0]["key_id"]
    assert run("--config", str(config), "rotate", "--grace-seconds", "600", "--new-key-id", "second") == 0
    settings = load_settings(config)
    by_id = {k["key_id"]: k for k in settings.public_key_summary()}
    assert set(by_id) == {old_id, "second"}
    assert by_id[old_id]["status"] == "grace"
    assert by_id["second"]["status"] == "active"

    # While in grace, the old key still verifies.
    now = utc_now()
    store = AuditStore(settings.database_path)
    old_key = settings.key_by_id(old_id)
    assert old_key is not None
    ts = int(now.timestamp())
    canonical = build_canonical(
        method="GET", path="/api/demo/ping", query="", timestamp=ts,
        nonce="rotate-nonce-0001", key_id=old_id, body=b"",
    )
    prepared = PreparedRequest(
        method="GET", path="/api/demo/ping", query="", timestamp=ts,
        nonce="rotate-nonce-0001", key_id=old_id,
        signature=compute_signature(old_key.secret, canonical.canonical_string),
        body=b"", source="test",
    )
    verify_request(settings, prepared, store, now=now, clock=ts)

    # After retiring, the same signed request is refused before HMAC work.
    assert run("--config", str(config), "retire-grace") == 0
    retired_settings = load_settings(config)
    retired_view = {k["key_id"]: k for k in retired_settings.public_key_summary()}
    assert retired_view[old_id]["status"] == "retired"
    with pytest.raises(VerificationError) as exc:
        verify_request(retired_settings, prepared, store, now=now, clock=ts)
    assert exc.value.code == "retired_key"


def test_rotate_with_zero_grace_immediately_retires(tmp_path: Path, capsys):
    config = tmp_path / "config.local.json"
    run("--config", str(config), "init")
    capsys.readouterr()
    old_id = json.loads(config.read_text(encoding="utf-8"))["keys"][0]["key_id"]
    assert run("--config", str(config), "rotate", "--grace-seconds", "0", "--new-key-id", "instant") == 0
    settings = load_settings(config)
    by_id = {k["key_id"]: k for k in settings.public_key_summary()}
    assert by_id[old_id]["status"] == "retired"
    assert by_id["instant"]["status"] == "active"


def test_rotate_rejects_duplicate_key_id(tmp_path: Path, capsys):
    config = tmp_path / "config.local.json"
    run("--config", str(config), "init")
    capsys.readouterr()
    # main() converts ConfigError to exit code 2 and prints to stderr.
    assert run("--config", str(config), "rotate", "--new-key-id", "demo-local-01") == 2
    assert "已存在" in capsys.readouterr().err


def test_rotate_rejects_out_of_range_grace(tmp_path: Path, capsys):
    config = tmp_path / "config.local.json"
    run("--config", str(config), "init")
    capsys.readouterr()
    assert run("--config", str(config), "rotate", "--grace-seconds", "999999") == 2
    assert "grace-seconds" in capsys.readouterr().err


def test_config_example_is_valid(tmp_path: Path):
    example = Path(__file__).resolve().parents[1] / "config.example.json"
    data = json.loads(example.read_text(encoding="utf-8"))
    # The template's placeholder secret is long enough for validation.
    build_settings(data, tmp_path / "config.local.json")

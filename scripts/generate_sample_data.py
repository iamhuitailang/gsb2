#!/usr/bin/env python3
"""Generate fictional legacy account data (digests only, never plaintext).

Writes data/legacy_accounts.jsonl. The fictional passwords exist ONLY in
this generator and the README (they are demo credentials, not real ones);
the generated file and the database contain digests only.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from authdemo import digest  # noqa: E402

# (username, fictional password, legacy version)
FICTIONAL_USERS = [
    ("alice", "alice-demo-pass-1", 1),
    ("bob", "bob-demo-pass-2", 2),
    ("carol", "carol-demo-pass-3", 3),
    ("dave", "dave-demo-pass-1", 1),
    ("erin", "erin-demo-pass-2", 2),
]


def make_digest(password: str, version: int) -> str:
    if version == 1:
        return digest.hash_v1(password)
    if version == 2:
        return digest.hash_v2(password)
    return digest.hash_current(password)


def main():
    out = os.path.join(os.path.dirname(__file__), "..", "data",
                       "legacy_accounts.jsonl")
    records = []
    for username, password, version in FICTIONAL_USERS:
        records.append({"username": username,
                        "digest": make_digest(password, version)})

    # Deliberately broken records to exercise import handling:
    records.append({"username": "frank", "digest": "v9:deadbeef"})       # unknown version
    records.append({"username": "grace", "digest": "v1:not-hex-at-all"}) # corrupt
    records.append({"username": "heidi"})                                # missing digest
    records.append({"username": "ivan", "version": 2,
                    "digest": digest.hash_v1("ivan-demo-pass-1")})       # inconsistent
    records.append({"digest": digest.hash_v1("no-name-pass")})           # missing username

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")
    print(f"wrote {len(records)} records to {out}")


if __name__ == "__main__":
    main()

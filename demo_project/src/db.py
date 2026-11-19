"""Demo database module — the DSN below is synthetic and does not connect anywhere."""

import os

# Synthetic DSN: user "demo", password-shaped value, host example.invalid.
DATABASE_URL = "postgresql://demo:S3cureDemoP4ssw0rd@db.example.invalid:5432/app"

# Placeholder password that the allow-list suppresses.
PLACEHOLDER_URL = "postgresql://app:changeme@localhost:5432/app"


def get_dsn() -> str:
    # Real deployments should read a secret from the environment, never a file.
    return os.environ.get("DATABASE_URL", DATABASE_URL)

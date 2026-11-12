"""Runtime configuration.

Everything can be overridden with environment variables so tests can point at
an isolated database.
"""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Where the SQLite file lives (tests override GAME_DB with a tmp path).
DB_PATH = Path(os.environ.get("GAME_DB", str(BASE_DIR / "data" / "game.db")))
DATABASE_URL = os.environ.get("GAME_DATABASE_URL", f"sqlite:///{DB_PATH}")

# Ingestion guards.
MAX_BATCH_EVENTS = 500
MAX_BODY_BYTES = 1 * 1024 * 1024  # 1 MiB raw request body

# Event schema versions this build understands. Anything else is rejected
# instead of being silently interpreted as the current version.
SUPPORTED_SCHEMA_VERSIONS = {"1.0"}

# Version of the processing rules (timeline rebuild + metric formulas).
# Bump this whenever rules change; stored summaries keep the old version until
# they are reprocessed, so old and new results stay distinguishable.
RULES_VERSION = "1.0.0"

"""Run the local API with ``python3 -m app`` from the ``backend`` folder."""

from __future__ import annotations

import os

import uvicorn

from .main import app

if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.environ.get("FORWARD_AUDIT_HOST", "127.0.0.1"),
        port=int(os.environ.get("FORWARD_AUDIT_PORT", "8000")),
        log_level="info",
    )

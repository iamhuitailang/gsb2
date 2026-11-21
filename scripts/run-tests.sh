#!/bin/sh
# Local verification helper: run the backend test suite.
set -e
cd "$(dirname "$0")/backend"
exec python3 -m pytest -q "$@"

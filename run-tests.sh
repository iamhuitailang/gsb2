#!/usr/bin/env sh
# Convenience test runner: same as `cd backend && python3 -m pytest -q`.
set -eu
cd "$(dirname "$0")/backend"
exec python3 -m pytest -q "$@"

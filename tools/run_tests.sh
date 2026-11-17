#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec python3 tools/run_tests.py "$@"

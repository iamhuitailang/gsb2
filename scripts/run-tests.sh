#!/bin/sh
# Convenience runner: unit tests, then sample regeneration.
set -e
cd "$(dirname "$0")/.."
node --test tests

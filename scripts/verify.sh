#!/bin/sh
# Build + verify helper. Run: sh scripts/verify.sh
set -e
cd "$(dirname "$0")/.."
"${NODE_BIN:-node}" scripts/build.mjs
echo "--- syntax check of generated modules ---"
for f in $(find dist -name '*.js'); do
  "${NODE_BIN:-node}" --check "$f" >/dev/null
done
echo "syntax ok"
echo "--- tests ---"
"${NODE_BIN:-node}" --test tests/

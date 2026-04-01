#!/bin/bash
# Smoke test: verify MetaMCP server handles JSON-RPC initialize, --help, --version
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

TMPCONFIG=""
TMPOUT=""
cleanup() { rm -f "$TMPCONFIG" "$TMPOUT"; }
trap cleanup EXIT

PASS=0
FAIL=0

check() {
  local label="$1" ok="$2"
  if [ "$ok" -eq 1 ]; then
    echo "OK: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label" >&2
    FAIL=$((FAIL + 1))
  fi
}

# Ensure build exists
if [ ! -f dist/index.js ]; then
  echo "FAIL: dist/index.js not found — run 'npm run build' first" >&2
  exit 1
fi

# 1. Verify shebang
HEAD=$(head -c 20 dist/index.js)
[[ "$HEAD" == "#!/usr/bin/env node"* ]] && check "shebang present" 1 || check "shebang present" 0

# 2. CLI flags
HELP_OUT=$(node dist/index.js --help 2>&1 || true)
echo "$HELP_OUT" | grep 'metamcp' > /dev/null && check "--help prints usage" 1 || check "--help prints usage" 0

VERSION_OUT=$(node dist/index.js --version 2>&1 || true)
echo "$VERSION_OUT" | grep '0.2.0' > /dev/null && check "--version prints 0.2.0" 1 || check "--version prints 0.2.0" 0

# 3. JSON-RPC initialize (MCP stdio transport: newline-delimited JSON-RPC)
TMPCONFIG=$(mktemp)
TMPOUT=$(mktemp)
echo '{"mcpServers":{}}' > "$TMPCONFIG"

INIT_REQ='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.1.0"}}}'

# Server stays alive after stdin EOF, so background + kill after response
( echo "$INIT_REQ"; sleep 1 ) | node dist/index.js --config "$TMPCONFIG" > "$TMPOUT" 2>/dev/null &
SERVER_PID=$!
sleep 3
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

RESPONSE=$(cat "$TMPOUT")

if [ -n "$RESPONSE" ]; then
  echo "$RESPONSE" | grep '"jsonrpc"' > /dev/null && check "JSON-RPC response valid" 1 || check "JSON-RPC response valid" 0
  echo "$RESPONSE" | grep '"serverInfo"' > /dev/null && check "response contains serverInfo" 1 || check "response contains serverInfo" 0
  echo "$RESPONSE" | grep '"metamcp"' > /dev/null && check "serverInfo.name is metamcp" 1 || check "serverInfo.name is metamcp" 0
else
  check "server returned a response" 0
fi

# Summary
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "Smoke test passed" || { echo "Smoke test FAILED" >&2; exit 1; }

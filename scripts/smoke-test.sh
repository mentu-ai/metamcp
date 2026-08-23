#!/bin/bash
# Smoke test: verify CLI flags, stdio MCP, and Streamable HTTP MCP.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

TMPDIR_PATH=""
HTTP_PID=""
AUTH_HTTP_PID=""

cleanup() {
  if [ -n "$HTTP_PID" ]; then kill "$HTTP_PID" 2>/dev/null || true; fi
  if [ -n "$AUTH_HTTP_PID" ]; then kill "$AUTH_HTTP_PID" 2>/dev/null || true; fi
  if [ -n "$TMPDIR_PATH" ]; then rm -rf "$TMPDIR_PATH"; fi
}
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

free_port() {
  node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});"
}

wait_for_health() {
  local base_url="$1"
  local err_file="$2"
  for _ in $(seq 1 100); do
    if curl -fsS "$base_url/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.05
  done
  echo "HTTP server did not become healthy" >&2
  cat "$err_file" >&2 || true
  return 1
}

mcp_post() {
  local base_url="$1"
  local body="$2"
  local out_file="$3"
  shift 3
  curl -sS -o "$out_file" -w "%{http_code}" \
    -X POST "$base_url/mcp" \
    -H "content-type: application/json" \
    -H "accept: application/json, text/event-stream" \
    "$@" \
    -d "$body"
}

if [ ! -f dist/index.js ]; then
  echo "FAIL: dist/index.js not found. Run 'npm run build' first" >&2
  exit 1
fi

TMPDIR_PATH="$(mktemp -d)"
CONFIG_FILE="$TMPDIR_PATH/mcp.json"
STDIO_OUT="$TMPDIR_PATH/stdio.out"
HTTP_OUT="$TMPDIR_PATH/http.out"
HTTP_ERR="$TMPDIR_PATH/http.err"
AUTH_HTTP_ERR="$TMPDIR_PATH/auth-http.err"
HTTP_BODY="$TMPDIR_PATH/http-body.json"

printf '{"mcpServers":{}}\n' > "$CONFIG_FILE"

HEAD="$(head -c 20 dist/index.js)"
[[ "$HEAD" == "#!/usr/bin/env node"* ]] && check "shebang present" 1 || check "shebang present" 0

HELP_OUT="$(node dist/index.js --help 2>&1 || true)"
echo "$HELP_OUT" | grep 'metamcp' >/dev/null && check "--help prints usage" 1 || check "--help prints usage" 0

EXPECTED_VERSION="$(node -p "require('./package.json').version")"
VERSION_OUT="$(node dist/index.js --version 2>&1 || true)"
echo "$VERSION_OUT" | grep "$EXPECTED_VERSION" >/dev/null && check "--version prints package version" 1 || check "--version prints package version" 0

if node dist/index.js --config >"$TMPDIR_PATH/missing-option.out" 2>&1; then
  check "missing option value fails closed" 0
else
  grep 'requires a value' "$TMPDIR_PATH/missing-option.out" >/dev/null && check "missing option value fails closed" 1 || check "missing option value fails closed" 0
fi

if node dist/index.js init --bogus >"$TMPDIR_PATH/invalid-init.out" 2>&1; then
  check "unknown init option fails closed" 0
else
  grep 'Unknown init option' "$TMPDIR_PATH/invalid-init.out" >/dev/null && check "unknown init option fails closed" 1 || check "unknown init option fails closed" 0
fi

if node dist/index.js add --bogus >"$TMPDIR_PATH/invalid-add.out" 2>&1; then
  check "unknown add option fails closed" 0
else
  grep 'Unknown add option' "$TMPDIR_PATH/invalid-add.out" >/dev/null && check "unknown add option fails closed" 1 || check "unknown add option fails closed" 0
fi

# Derive the protocol version from the SDK instead of hardcoding one that
# will silently age out of the supported list.
PROTOCOL_VERSION="$(node -p "require('@modelcontextprotocol/sdk/types.js').LATEST_PROTOCOL_VERSION")"
INIT_REQ="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"$PROTOCOL_VERSION\",\"capabilities\":{},\"clientInfo\":{\"name\":\"smoke-test\",\"version\":\"0.1.0\"}}}"

( echo "$INIT_REQ"; sleep 1 ) | node dist/index.js --config "$CONFIG_FILE" > "$STDIO_OUT" 2>/dev/null &
STDIO_PID=$!
sleep 3
kill "$STDIO_PID" 2>/dev/null || true
wait "$STDIO_PID" 2>/dev/null || true

if [ -s "$STDIO_OUT" ]; then
  grep '"jsonrpc"' "$STDIO_OUT" >/dev/null && check "stdio JSON-RPC response valid" 1 || check "stdio JSON-RPC response valid" 0
  grep '"serverInfo"' "$STDIO_OUT" >/dev/null && check "stdio response contains serverInfo" 1 || check "stdio response contains serverInfo" 0
  grep '"metamcp"' "$STDIO_OUT" >/dev/null && check "stdio serverInfo.name is metamcp" 1 || check "stdio serverInfo.name is metamcp" 0
else
  check "stdio server returned a response" 0
fi

HTTP_PORT="$(free_port)"
HTTP_URL="http://127.0.0.1:$HTTP_PORT"
node dist/index.js --transport http --host 127.0.0.1 --port "$HTTP_PORT" --config "$CONFIG_FILE" > /dev/null 2>"$HTTP_ERR" &
HTTP_PID=$!
wait_for_health "$HTTP_URL" "$HTTP_ERR" && check "HTTP healthz is ready" 1 || check "HTTP healthz is ready" 0

HTTP_INIT_STATUS="$(mcp_post "$HTTP_URL" "$INIT_REQ" "$HTTP_BODY")"
[ "$HTTP_INIT_STATUS" = "200" ] && check "HTTP initialize returns 200" 1 || check "HTTP initialize returns 200" 0
node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if (r.result.serverInfo.name !== 'metamcp') process.exit(1)" "$HTTP_BODY" \
  && check "HTTP initialize returns serverInfo" 1 || check "HTTP initialize returns serverInfo" 0

TOOLS_REQ='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
HTTP_TOOLS_STATUS="$(mcp_post "$HTTP_URL" "$TOOLS_REQ" "$HTTP_BODY")"
[ "$HTTP_TOOLS_STATUS" = "200" ] && check "HTTP tools/list returns 200" 1 || check "HTTP tools/list returns 200" 0
node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); const n=r.result.tools.map(t=>t.name).join(','); if (n !== 'mcp_discover,mcp_call,mcp_run') process.exit(1)" "$HTTP_BODY" \
  && check "HTTP tools/list returns the three-tool surface" 1 || check "HTTP tools/list returns the three-tool surface" 0

MODERN_DISCOVER_REQ='{"jsonrpc":"2.0","id":3,"method":"server/discover","params":{}}'
MODERN_DISCOVER_STATUS="$(mcp_post "$HTTP_URL" "$MODERN_DISCOVER_REQ" "$HTTP_BODY")"
[ "$MODERN_DISCOVER_STATUS" = "200" ] && check "HTTP modern server/discover returns 200" 1 || check "HTTP modern server/discover returns 200" 0
node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); if (!r.result.supportedVersions.includes('2026-07-28')) process.exit(1)" "$HTTP_BODY" \
  && check "HTTP modern server/discover reports the modern era" 1 || check "HTTP modern server/discover reports the modern era" 0

AUTH_PORT="$(free_port)"
AUTH_URL="http://127.0.0.1:$AUTH_PORT"
METAMCP_HTTP_BEARER_TOKEN="smoke-token" node dist/index.js --transport http --host 127.0.0.1 --port "$AUTH_PORT" --config "$CONFIG_FILE" > /dev/null 2>"$AUTH_HTTP_ERR" &
AUTH_HTTP_PID=$!
wait_for_health "$AUTH_URL" "$AUTH_HTTP_ERR" && check "auth HTTP healthz is ready" 1 || check "auth HTTP healthz is ready" 0

NO_AUTH_STATUS="$(mcp_post "$AUTH_URL" "$TOOLS_REQ" "$HTTP_BODY")"
[ "$NO_AUTH_STATUS" = "401" ] && check "HTTP tokenless request returns 401" 1 || check "HTTP tokenless request returns 401" 0

AUTH_STATUS="$(mcp_post "$AUTH_URL" "$TOOLS_REQ" "$HTTP_BODY" -H "authorization: Bearer smoke-token")"
[ "$AUTH_STATUS" = "200" ] && check "HTTP Authorization bearer accepted" 1 || check "HTTP Authorization bearer accepted" 0

X_TOKEN_STATUS="$(mcp_post "$AUTH_URL" "$TOOLS_REQ" "$HTTP_BODY" -H "x-metamcp-token: smoke-token")"
[ "$X_TOKEN_STATUS" = "200" ] && check "HTTP X-MetaMCP-Token accepted" 1 || check "HTTP X-MetaMCP-Token accepted" 0

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "Smoke test passed" || { echo "Smoke test FAILED" >&2; exit 1; }

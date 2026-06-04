#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${REGION:=global}"
: "${SERVICE_NAME:=metamcp-gateway}"
: "${DISPLAY_NAME:=MetaMCP Cloud Run Gateway}"
: "${TOOLSPEC:=gcp/agent-registry/toolspec.json}"

if [[ -z "${SERVER_URL:-}" ]]; then
  : "${CLOUD_RUN_REGION:=us-central1}"
  SERVER_URL="$(gcloud run services describe "$SERVICE_NAME" \
    --project "$PROJECT_ID" \
    --region "$CLOUD_RUN_REGION" \
    --format 'value(status.url)')/mcp"
fi

gcloud alpha agent-registry services create "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --location "$REGION" \
  --display-name "$DISPLAY_NAME" \
  --mcp-server-spec-type tool-spec \
  --mcp-server-spec-content "$TOOLSPEC" \
  --interfaces "url=$SERVER_URL,protocolBinding=JSONRPC"

echo "Registered MetaMCP in Agent Registry:"
echo "  resource: projects/$PROJECT_ID/locations/$REGION/mcpServers/$SERVICE_NAME"
echo "  url:      $SERVER_URL"

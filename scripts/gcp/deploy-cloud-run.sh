#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${REGION:=us-central1}"
: "${REPOSITORY:=metamcp}"
: "${SERVICE:=metamcp-gateway}"
: "${SERVICE_ACCOUNT:=metamcp-gateway}"
: "${MCP_CONFIG_SECRET:=metamcp-mcp-json}"
: "${HTTP_TOKEN_SECRET:=metamcp-http-token}"
: "${INVOKER_MEMBER:=}"

IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/$SERVICE:latest"
SA_EMAIL="$SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com"

gcloud artifacts repositories describe "$REPOSITORY" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPOSITORY" \
    --repository-format docker \
    --location "$REGION" \
    --project "$PROJECT_ID" \
    --description "MetaMCP container images"

gcloud builds submit \
  --project "$PROJECT_ID" \
  --tag "$IMAGE" \
  .

gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$SA_EMAIL" \
  --no-allow-unauthenticated \
  --port 8080 \
  --set-env-vars "METAMCP_TRANSPORT=http,METAMCP_HTTP_PATH=/mcp,METAMCP_CONFIG=/secrets/metamcp/mcp.json" \
  --set-secrets "/secrets/metamcp/mcp.json=$MCP_CONFIG_SECRET:latest,METAMCP_HTTP_BEARER_TOKEN=$HTTP_TOKEN_SECRET:latest"

if [[ -n "$INVOKER_MEMBER" ]]; then
  gcloud run services add-iam-policy-binding "$SERVICE" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --member "$INVOKER_MEMBER" \
    --role roles/run.invoker >/dev/null
fi

gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format 'value(status.url)'

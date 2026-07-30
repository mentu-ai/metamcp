#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${REGION:=us-central1}"
: "${SERVICE_ACCOUNT:=metamcp-gateway}"
: "${MCP_CONFIG_FILE:=.mcp.gcp.example.json}"
: "${MCP_CONFIG_SECRET:=metamcp-mcp-json}"
: "${HTTP_TOKEN_SECRET:=metamcp-http-token}"
: "${ADK_AGENT_SERVICE_ACCOUNT:=}"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SA_EMAIL="$SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com"

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  agentregistry.googleapis.com \
  --project "$PROJECT_ID"

gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SERVICE_ACCOUNT" \
    --project "$PROJECT_ID" \
    --display-name "MetaMCP Cloud Run gateway"

if gcloud secrets describe "$MCP_CONFIG_SECRET" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets versions add "$MCP_CONFIG_SECRET" --project "$PROJECT_ID" --data-file "$MCP_CONFIG_FILE"
else
  gcloud secrets create "$MCP_CONFIG_SECRET" --project "$PROJECT_ID" --data-file "$MCP_CONFIG_FILE"
fi

if ! gcloud secrets describe "$HTTP_TOKEN_SECRET" --project "$PROJECT_ID" >/dev/null 2>&1; then
  openssl rand -hex 32 | gcloud secrets create "$HTTP_TOKEN_SECRET" --project "$PROJECT_ID" --data-file -
fi

for secret in "$MCP_CONFIG_SECRET" "$HTTP_TOKEN_SECRET"; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --project "$PROJECT_ID" \
    --member "serviceAccount:$SA_EMAIL" \
    --role roles/secretmanager.secretAccessor >/dev/null
done

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:$SA_EMAIL" \
  --role roles/logging.logWriter >/dev/null

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role roles/cloudbuild.builds.builder >/dev/null

if [[ -n "$ADK_AGENT_SERVICE_ACCOUNT" ]]; then
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:$ADK_AGENT_SERVICE_ACCOUNT" \
    --role roles/run.invoker >/dev/null
fi

echo "Configured MetaMCP service account and secrets:"
echo "  service account: $SA_EMAIL"
echo "  config secret:   $MCP_CONFIG_SECRET"
echo "  token secret:    $HTTP_TOKEN_SECRET"
echo "  region:          $REGION"
if [[ -n "$ADK_AGENT_SERVICE_ACCOUNT" ]]; then
  echo "  invoker:         $ADK_AGENT_SERVICE_ACCOUNT"
fi

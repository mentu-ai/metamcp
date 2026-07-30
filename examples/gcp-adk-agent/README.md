# MetaMCP ADK Agent Registry Sample

This sample shows a Python Google ADK agent consuming MetaMCP through Google Agent Registry.

The registry entry points at a deployed MetaMCP Cloud Run service, and ADK resolves it as an `McpToolset`. The agent then sees the six MetaMCP gateway tools instead of every child MCP tool.

## Run Locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r examples/gcp-adk-agent/requirements.txt

export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_REGISTRY_LOCATION="global"
export METAMCP_MCP_SERVER_ID="metamcp-gateway"
export METAMCP_HTTP_BEARER_TOKEN="$(gcloud secrets versions access latest --secret metamcp-http-token --project "$GOOGLE_CLOUD_PROJECT")"
export METAMCP_CLOUD_RUN_AUDIENCE="https://metamcp-gateway-xxxxx-uc.a.run.app"

adk web examples/gcp-adk-agent
```

## Deploy the Agent to Cloud Run

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_LOCATION="us-central1"

adk deploy cloud_run \
  --project="$GOOGLE_CLOUD_PROJECT" \
  --region="$GOOGLE_CLOUD_LOCATION" \
  --service_name="metamcp-adk-agent" \
  examples/gcp-adk-agent \
  -- --no-allow-unauthenticated
```

Use `METAMCP_MCP_SERVER_RESOURCE` when your registry location or resource name does not match the default `projects/$GOOGLE_CLOUD_PROJECT/locations/global/mcpServers/$METAMCP_MCP_SERVER_ID`.

When the MetaMCP Cloud Run service is deployed with `--no-allow-unauthenticated`, set `METAMCP_CLOUD_RUN_AUDIENCE` to the Cloud Run service URL and grant the ADK agent runtime service account `roles/run.invoker` on the gateway service. The sample uses that audience to send the Cloud Run identity token in `X-Serverless-Authorization` and the MetaMCP app token in `Authorization`.

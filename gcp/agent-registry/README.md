# Agent Registry Registration

MetaMCP is registered as an external MCP server with a compact tool specification.

```bash
PROJECT_ID=my-project \
REGION=global \
CLOUD_RUN_REGION=us-central1 \
SERVICE_NAME=metamcp-gateway \
scripts/gcp/register-agent-registry.sh
```

The script runs:

```bash
gcloud alpha agent-registry services create metamcp-gateway \
  --project PROJECT_ID \
  --location global \
  --display-name "MetaMCP Cloud Run Gateway" \
  --mcp-server-spec-type tool-spec \
  --mcp-server-spec-content gcp/agent-registry/toolspec.json \
  --interfaces url=SERVER_URL,protocolBinding=JSONRPC
```

Agent Registry currently requires manually supplied tool specs for external MCP
servers. Keep `toolspec.json` below 10 KB and regenerate it when MetaMCP's public
tools change.

If the Cloud Run gateway is private, grant the ADK runtime identity
`roles/run.invoker` on the Cloud Run service and set `METAMCP_CLOUD_RUN_AUDIENCE`
in `examples/gcp-adk-agent`. The sample sends the Cloud Run identity token in
`X-Serverless-Authorization` and the MetaMCP app token in `Authorization`.

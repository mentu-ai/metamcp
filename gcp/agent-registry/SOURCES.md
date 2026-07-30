# Official Sources

These notes summarize the Google and MCP documentation used for the GCP gateway path.

- Agent Registry is a centralized catalog for discovering and governing MCP servers, tools, endpoints, and agents in Google Cloud.
  Source: https://docs.cloud.google.com/agent-registry/overview
- External MCP servers must be registered explicitly. Agent Registry does not introspect private external MCP servers automatically, so manual registration requires a `toolspec.json` file under 10 KB.
  Source: https://docs.cloud.google.com/agent-registry/register-mcp-servers
- Cloud Run supports hosting MCP servers with Streamable HTTP transport, not stdio transport.
  Source: https://docs.cloud.google.com/run/docs/host-mcp-servers
- ADK can resolve registered MCP servers through `AgentRegistry.get_mcp_toolset`.
  Source: https://adk.dev/integrations/agent-registry/
- ADK supports `header_provider` callbacks for headers sent to target MCP servers or agents.
  Source: https://docs.cloud.google.com/agent-registry/authenticate-toolsets
- Private Cloud Run callers can use `X-Serverless-Authorization` when an application already uses `Authorization` for its own auth.
  Source: https://docs.cloud.google.com/run/docs/authenticating/service-to-service

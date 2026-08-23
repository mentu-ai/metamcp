import os
from typing import Any

import google.auth
import google.oauth2.id_token
from google.auth.transport.requests import Request
from google.adk.agents.llm_agent import LlmAgent
from google.adk.integrations.agent_registry import AgentRegistry


def metamcp_header_provider(_: Any) -> dict[str, str]:
    gateway_token = os.environ.get("METAMCP_HTTP_BEARER_TOKEN")
    cloud_run_audience = os.environ.get("METAMCP_CLOUD_RUN_AUDIENCE")

    if cloud_run_audience:
        headers = {
            "X-Serverless-Authorization": f"Bearer {google.oauth2.id_token.fetch_id_token(Request(), cloud_run_audience)}",
        }
        if gateway_token:
            headers["Authorization"] = f"Bearer {gateway_token}"
        return headers

    if gateway_token:
        return {"Authorization": f"Bearer {gateway_token}"}

    credentials, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    if not credentials.valid:
        credentials.refresh(Request())
    return {"Authorization": f"Bearer {credentials.token}"}


project_id = os.environ["GOOGLE_CLOUD_PROJECT"]
registry_location = os.environ.get("GOOGLE_CLOUD_REGISTRY_LOCATION", "global")
server_id = os.environ.get("METAMCP_MCP_SERVER_ID", "metamcp-gateway")
mcp_server_name = os.environ.get(
    "METAMCP_MCP_SERVER_RESOURCE",
    f"projects/{project_id}/locations/{registry_location}/mcpServers/{server_id}",
)

registry = AgentRegistry(
    project_id=project_id,
    location=registry_location,
    header_provider=metamcp_header_provider,
)

metamcp_tools = registry.get_mcp_toolset(mcp_server_name=mcp_server_name)

root_agent = LlmAgent(
    name="metamcp_registry_agent",
    model=os.environ.get("ADK_MODEL", "gemini-2.5-flash"),
    description="ADK agent that consumes a governed MetaMCP Cloud Run gateway through Agent Registry.",
    instruction=(
        "You are a production AI engineer agent. Use MetaMCP to discover and call "
        "approved tools through mcp_discover, mcp_call, and mcp_run. Prefer "
        "small, observable tool calls. When a tool can mutate business data, explain "
        "the intended action before calling it and preserve Method traces and typed gaps."
    ),
    tools=[metamcp_tools],
)

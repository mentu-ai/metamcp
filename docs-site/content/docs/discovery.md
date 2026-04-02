---
title: "Discovery & Search"
category: "Concepts"
excerpt: "Tool discovery and hybrid search across child servers."
description: "How MetaMCP discovers tools from child servers, caches catalogs, and ranks results using keyword and semantic search."
---

## Catalog Architecture

When MetaMCP first connects to a child server, it calls `tools/list` on that server and caches the result. The catalog maps tool names to their JSON schemas and owning servers.

**Cache TTL:** 1 hour (`CATALOG_TTL_MS = 3_600_000` from `src/catalog.ts`). After expiry, the next request to that server triggers a fresh `tools/list` call.

**Cleanup interval:** Every 5 minutes (`CATALOG_CLEANUP_MS = 300_000`), the catalog removes entries for servers that are no longer connected.

The catalog is built lazily. Servers that have never been contacted have no catalog entries. When `mcp_discover` or `mcp_provision` runs a search, any server not yet in the catalog is spawned, its tools are fetched, and the results are cached.

## Keyword Scoring

Every search query is matched against tool names and descriptions using a simple scoring system.

| Match Type | Score | Constant |
|-----------|-------|----------|
| Exact name match | 10 | `SCORE_EXACT_NAME` |
| Name contains query | 5 | `SCORE_NAME_CONTAINS` |
| Description contains query | 2 | `SCORE_DESC_CONTAINS` |

Matching is case-insensitive. A tool can accumulate points from multiple match types. For example, a tool named `take_screenshot` with a description containing "screenshot" would score 5 (name contains) + 2 (description contains) = 7 for the query "screenshot".

Results are sorted by score in descending order. The default limit is the top 20 results (`DEFAULT_TOP_N`).

Keyword scoring is always available, with no external dependencies.

## Semantic Search

When a Voyage AI API key is configured, MetaMCP generates vector embeddings for tool descriptions and enables semantic search.

**Configuration:** Set either `VOYAGE_API_KEY` or `ANTHROPIC_API_KEY` as an environment variable. MetaMCP uses the Voyage AI embedding API.

**Model:** `voyage-3-lite`. Embeddings are generated for each tool's description when the catalog is first populated.

**Storage:** Embeddings are stored as raw `Float32Array` blobs in SQLite. The embedding dimensions are determined by the model.

**Query flow:**

1. The search query is embedded using the same model.
2. Candidate tools are retrieved (up to `VECTOR_CANDIDATE_LIMIT = 50`).
3. Cosine similarity is computed between the query embedding and each candidate's embedding.
4. Results are scored on a [0, 1] scale.

> **Tip:** Semantic search excels at finding tools when the query uses different terminology than the tool name. For example, searching "take a picture of the page" can match `browser_screenshot` even though the words are different.

## Hybrid Scoring Formula

When semantic search is available, results are ranked using a weighted combination of both signals.

```
finalScore = 0.6 * semanticScore + 0.4 * keywordScore
```

| Weight | Source | Constant |
|--------|--------|----------|
| 0.6 | Semantic similarity | `SEMANTIC_WEIGHT` |
| 0.4 | Keyword match | `KEYWORD_WEIGHT` |

Both scores are normalized to [0, 1] before combining. Keyword scores are normalized by dividing by the maximum possible score (an exact name match at 10).

When semantic search is unavailable (no API key configured), the system falls back to keyword-only ranking.

## Vector Store

Embeddings are persisted in a SQLite database for fast retrieval across sessions.

**Location:** `~/.metamcp/catalog.db`

**Table schema:**

| Column | Type | Description |
|--------|------|-------------|
| `server` | TEXT | Name of the owning server |
| `tool_name` | TEXT | Name of the tool |
| `description` | TEXT | Tool description text |
| `embedding` | BLOB | Raw Float32Array bytes |
| `updated_at` | INTEGER | Timestamp of last update |

The database uses WAL (Write-Ahead Logging) journal mode for concurrent read performance. Search uses brute-force cosine similarity, which is adequate at MetaMCP's scale (typically hundreds to low thousands of tools, not millions).

The schema is versioned with automatic migration when the format changes.

> **Note:** Deleting `~/.metamcp/catalog.db` is safe. MetaMCP regenerates embeddings on the next search. The only cost is a brief delay while embeddings are recomputed.

## Registry Search

When `mcp_provision` cannot find a matching capability among local servers, it searches the public npm registry for published MCP servers.

**Registry endpoint:** `https://registry.modelcontextprotocol.io/servers`

**Cache TTL:** 24 hours. Registry results are cached locally to avoid repeated network calls.

**Fallback list:** If the registry is unreachable, MetaMCP includes a built-in list of 20 well-known servers from 7 organizations:

| Namespace | Servers |
|-----------|---------|
| `@modelcontextprotocol` | filesystem, github, gitlab, google-maps, memory, postgres, slack, sqlite, brave-search, puppeteer, fetch, everything |
| `@anthropic` | sequential-thinking |
| `@playwright` | mcp |
| `@stripe` | mcp |
| `@sentry` | mcp-server |
| Community | mcp-server-docker, mcp-server-kubernetes, mcp-server-git, mcp-server-linear |

Registry search is only triggered by `mcp_provision`, not by `mcp_discover`. Discovery searches local catalogs only.

## Next Steps

- [Auto-Provisioning](/guides/auto-provisioning) for how `mcp_provision` installs and starts matched servers
- [The Four Tools](/concepts/the-four-tools) for how discovery fits into the overall tool surface

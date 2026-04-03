/**
 * gallery.ts — 100 curated MCP servers for one-click provisioning.
 *
 * Usage:
 *   metamcp add playwright        # fuzzy match, adds to .mcp.json
 *   metamcp add --list             # print all available servers
 *   metamcp add --category search  # filter by category
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface GalleryEntry {
  name: string;
  description: string;
  repository: string;
  category: string;
  language: string;
  command?: string;
  args?: string[];
}

export const GALLERY: GalleryEntry[] = [
  { name: '@modelcontextprotocol/server-puppeteer', description: 'Browser automation for web scraping and interaction', repository: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/puppeteer', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "@modelcontextprotocol/server-puppeteer"] },
  { name: '@modelcontextprotocol/server-memory', description: 'Knowledge graph-based persistent memory system for maintaining context', repository: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/memory', category: 'Knowledge & Memory', language: 'ts', command: 'npx', args: ["-y", "@modelcontextprotocol/server-memory"] },
  { name: '@modelcontextprotocol/server-filesystem', description: 'Direct local file system access.', repository: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/filesystem', category: 'File Systems', language: 'ts', command: 'npx', args: ["-y", "@modelcontextprotocol/server-filesystem"] },
  { name: '@modelcontextprotocol/server-fetch', description: 'Efficient web content fetching and processing for AI consumption', repository: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/fetch', category: 'Search & Data Extraction', language: 'py', command: 'uvx', args: ["@modelcontextprotocol/server-fetch"] },
  { name: '@modelcontextprotocol/server-git', description: 'Direct Git repository operations including reading, searching, and analyzing local repositories', repository: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/git', category: 'Version Control', language: 'py', command: 'uvx', args: ["@modelcontextprotocol/server-git"] },
  { name: '@modelcontextprotocol/server-postgres', description: 'PostgreSQL database integration with schema inspection and query capabilities', repository: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres', category: 'Databases', language: 'ts', command: 'npx', args: ["-y", "@modelcontextprotocol/server-postgres"] },
  { name: '@modelcontextprotocol/server-gitlab', description: 'GitLab platform integration for project management and CI/CD operations', repository: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gitlab', category: 'Version Control', language: 'ts', command: 'npx', args: ["-y", "@modelcontextprotocol/server-gitlab"] },
  { name: '@modelcontextprotocol/server-sqlite', description: 'SQLite database operations with built-in analysis features', repository: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite', category: 'Databases', language: 'py', command: 'uvx', args: ["@modelcontextprotocol/server-sqlite"] },
  { name: 'graphlit-mcp-server', description: 'Ingest anything from Slack, Discord, websites, Google Drive, Linear or GitHub into a Graphlit project - and then search ', repository: 'https://github.com/graphlit/graphlit-mcp-server', category: 'Knowledge & Memory', language: 'ts', command: 'npx', args: ["-y", "graphlit-mcp-server"] },
  { name: 'Skill_Seekers', description: 'Transform 17 source types (docs, GitHub repos, PDFs, videos, Jupyter, Confluence, Notion, Slack/Discord) into AI-ready s', repository: 'https://github.com/yusufkaraaslan/Skill_Seekers', category: 'Knowledge & Memory', language: 'py', command: 'uvx', args: ["Skill_Seekers"] },
  { name: 'mem0-mcp-selfhosted', description: 'Self-hosted mem0 MCP server for Claude Code with Qdrant vector search, Neo4j knowledge graph, and Ollama embeddings.', repository: 'https://github.com/elvismdev/mem0-mcp-selfhosted', category: 'Knowledge & Memory', language: 'py', command: 'uvx', args: ["mem0-mcp-selfhosted"] },
  { name: 'apistatuscheck-mcp-server', description: 'Check real-time operational status of 114+ cloud services and APIs (AWS, GitHub, Stripe, OpenAI, Vercel, etc.) directly ', repository: 'https://github.com/shibley/apistatuscheck-mcp-server', category: 'Monitoring', language: 'ts', command: 'npx', args: ["-y", "apistatuscheck-mcp-server"] },
  { name: 'mcp-server-rag-web-browser', description: 'An MCP server for Apify\'s open-source RAG Web Browser Actor to perform web searches, scrape URLs, and return content in', repository: 'https://github.com/apify/mcp-server-rag-web-browser', category: 'Search & Data Extraction', language: 'ts', command: 'npx', args: ["-y", "mcp-server-rag-web-browser"] },
  { name: 'DOMShell', description: 'Browse the web using filesystem commands (ls, cd, grep, click).', repository: 'https://github.com/apireno/DOMShell', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "DOMShell"] },
  { name: 'mcp-server-logs-sieve', description: 'Query, summarize, and trace logs in plain English across GCP Cloud Logging, AWS CloudWatch, Azure Log Analytics, Grafana', repository: 'https://github.com/Oluwatunmise-olat/mcp-server-logs-sieve', category: 'Monitoring', language: 'ts', command: 'npx', args: ["-y", "mcp-server-logs-sieve"] },
  { name: 'context-memory', description: 'Persistent, searchable context storage across Claude Code sessions using SQLite FTS5.', repository: 'https://github.com/ErebusEnigma/context-memory', category: 'Knowledge & Memory', language: 'py', command: 'uvx', args: ["context-memory"] },
  { name: 'knowledge-rag', description: 'Local RAG system for Claude Code with hybrid search (BM25 + semantic), cross-encoder reranking, markdown-aware chunking,', repository: 'https://github.com/lyonzin/knowledge-rag', category: 'Knowledge & Memory', language: 'py', command: 'uvx', args: ["knowledge-rag"] },
  { name: 'src-to-kb', description: 'Convert source code repositories into searchable knowledge bases with AI-powered search using GPT-5, intelligent chunkin', repository: 'https://github.com/vezlo/src-to-kb', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "src-to-kb"] },
  { name: 'agentkits-memory', description: 'Persistent memory for AI coding assistants with hybrid search (FTS5 + vector embeddings), session tracking, automatic co', repository: 'https://github.com/aitytech/agentkits-memory', category: 'Knowledge & Memory', language: 'ts', command: 'npx', args: ["-y", "agentkits-memory"] },
  { name: 'fetcher-mcp', description: 'MCP server for fetching web page content using Playwright headless browser, supporting Javascript rendering and intellig', repository: 'https://github.com/jae-jae/fetcher-mcp', category: 'Search & Data Extraction', language: 'ts', command: 'npx', args: ["-y", "fetcher-mcp"] },
  { name: '@modelcontextprotocol/server-everything', description: 'MCP server that exercises all the features of the MCP protocol', repository: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything', category: 'Other Tools and Integrations', language: 'ts', command: 'npx', args: ["-y", "@modelcontextprotocol/server-everything"] },
  { name: 'memvid-mcp-server', description: 'Python Streamable HTTP Server you can run locally to interact with [memvid](https://github.com/Olow304/memvid) storage a', repository: 'https://github.com/ferrants/memvid-mcp-server', category: 'Databases', language: 'py', command: 'uvx', args: ["memvid-mcp-server"] },
  { name: 'devplan-mcp-server', description: 'Generate comprehensive, paint-by-numbers development plans using the [ClaudeCode-DevPlanBuilder](https://github.com/mmor', repository: 'https://github.com/mmorris35/devplan-mcp-server', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "devplan-mcp-server"] },
  { name: 'pharaoh', description: 'Hosted MCP server that parses TypeScript and Python codebases into Neo4j knowledge graphs for blast radius analysis, dea', repository: 'https://github.com/0xUXDesign/pharaoh-mcp', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "pharaoh"] },
  { name: 'zettelkasten-mcp', description: 'A Model Context Protocol (MCP) server that implements the Zettelkasten knowledge management methodology, allowing you to', repository: 'https://github.com/entanglr/zettelkasten-mcp', category: 'Knowledge & Memory', language: 'py', command: 'uvx', args: ["zettelkasten-mcp"] },
  { name: 'local-faiss-mcp', description: 'Local FAISS vector database for RAG with document ingestion (PDF/TXT/MD/DOCX), semantic search, re-ranking, and CLI tool', repository: 'https://github.com/nonatofabio/local_faiss_mcp', category: 'Knowledge & Memory', language: 'py', command: 'uvx', args: ["local-faiss-mcp"] },
  { name: '@modelcontextprotocol/server-google-maps', description: 'Google Maps integration for location services, routing, and place details', repository: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/google-maps', category: 'Location Services', language: 'ts', command: 'npx', args: ["-y", "@modelcontextprotocol/server-google-maps"] },
  { name: 'dynatrace-mcp', description: 'Leverage AI-driven observability, security, and automation to analyze anomalies, logs, traces, events, metrics.', repository: 'https://github.com/dynatrace-oss/dynatrace-mcp', category: 'Monitoring', language: 'ts', command: 'npx', args: ["-y", "dynatrace-mcp"] },
  { name: 'agent-toolbox', description: 'Production-ready MCP server providing 13 tools for AI agents: web search, content extraction, screenshots, weather, fina', repository: 'https://github.com/Vincentwei1021/agent-toolbox', category: 'Search & Data Extraction', language: 'ts', command: 'npx', args: ["-y", "agent-toolbox"] },
  { name: 'firefox-devtools-mcp', description: 'Firefox browser automation via WebDriver BiDi for testing, scraping, and browser control.', repository: 'https://github.com/freema/firefox-devtools-mcp', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "firefox-devtools-mcp"] },
  { name: 'comet-mcp', description: 'Connect to Perplexity Comet browser for agentic web browsing, deep research, and real-time task monitoring.', repository: 'https://github.com/hanzili/comet-mcp', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "comet-mcp"] },
  { name: 'lumino-mcp-server', description: 'AI-powered SRE observability for Kubernetes and OpenShift with 40+ tools for Tekton pipeline debugging, log analysis, ro', repository: 'https://github.com/spre-sre/lumino-mcp-server', category: 'Cloud Platforms', language: 'py', command: 'uvx', args: ["lumino-mcp-server"] },
  { name: 'vscode-mcp-server', description: 'A MCP Server that allows AI such as Claude to read from the directory structure in a VS Code workspace, see problems pic', repository: 'https://github.com/juehang/vscode-mcp-server', category: 'Coding Agents', language: 'ts', command: 'npx', args: ["-y", "vscode-mcp-server"] },
  { name: 'email-mcp', description: 'Unified MCP server for email across Gmail (REST API), Outlook (Microsoft Graph), iCloud, and generic IMAP/SMTP.', repository: 'https://github.com/marlinjai/email-mcp', category: 'Communication', language: 'ts', command: 'npx', args: ["-y", "email-mcp"] },
  { name: 'skill-ninja-mcp-server', description: 'Agent Skill Ninja for MCP: Search, install, and manage AI agent skills (SKILL.md files) from GitHub repositories.', repository: 'https://github.com/aktsmm/skill-ninja-mcp-server', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "skill-ninja-mcp-server"] },
  { name: 'Opik-MCP', description: 'Use natural language to explore LLM observability, traces, and monitoring data captured by Opik.', repository: 'https://github.com/comet-ml/opik-mcp', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "Opik-MCP"] },
  { name: 'postmancer', description: 'A MCP server for replacing Rest Clients like Postman/Insomnia, by allowing your LLM to maintain and use api collections.', repository: 'https://github.com/hijaz/postmancer', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "postmancer"] },
  { name: 'mcp-server-markdown', description: 'Search, extract sections, list headings, and find code blocks across markdown files.', repository: 'https://github.com/ofershap/mcp-server-markdown', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "mcp-server-markdown"] },
  { name: 'llm-token-tracker', description: 'Token usage tracker for OpenAI and Claude APIs with MCP support, real-time session tracking, and accurate pricing for 20', repository: 'https://github.com/wn01011/llm-token-tracker', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "llm-token-tracker"] },
  { name: 'memviz', description: 'Visual explorer for [MCP Memory Service](https://github.com/doobidoo/mcp-memory-service) SQLite-vec databases.', repository: 'https://github.com/pfillion42/memviz', category: 'Knowledge & Memory', language: 'ts', command: 'npx', args: ["-y", "memviz"] },
  { name: 'agent-breadcrumbs', description: 'Unified agent work logging and observability across ChatGPT, Claude, Cursor, Codex, and OpenClaw with config-first schem', repository: 'https://github.com/ejcho623/agent-breadcrumbs', category: 'Monitoring', language: 'ts', command: 'npx', args: ["-y", "agent-breadcrumbs"] },
  { name: 'urlbox-mcp-server', description: '📇 🏠 A reliable MCP server for generating and managing screenshots, PDFs, and videos, performing AI-powered screenshot an', repository: 'https://github.com/urlbox/urlbox-mcp-server/', category: 'Search & Data Extraction', language: 'ts', command: 'npx', args: ["-y", "urlbox-mcp-server"] },
  { name: 'github-graphql-mcp-server', description: 'Unofficial GitHub MCP server that provides access to GitHub\'s GraphQL API, enabling more powerful and flexible queries ', repository: 'https://github.com/QuentinCody/github-graphql-mcp-server', category: 'Version Control', language: 'py', command: 'uvx', args: ["github-graphql-mcp-server"] },
  { name: 'mcp-aoai-web-browsing', description: 'A `minimal` server/client MCP implementation using Azure OpenAI and Playwright.', repository: 'https://github.com/kimtth/mcp-aoai-web-browsing', category: 'Browser Automation', language: 'py', command: 'uvx', args: ["mcp-aoai-web-browsing"] },
  { name: 'olostep-mcp-server', description: 'Web scraping, crawling, and search API.', repository: 'https://github.com/olostep/olostep-mcp-server', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "olostep-mcp-server"] },
  { name: 'browser-devtools-mcp', description: 'An MCP Server enables AI assistants to autonomously test, debug, and validate web applications.', repository: 'https://github.com/serkan-ozal/browser-devtools-mcp', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "browser-devtools-mcp"] },
  { name: 'winx-code-agent', description: 'A high-performance Rust reimplementation of WCGW for code agents, providing shell execution and advanced file management', repository: 'https://github.com/gabrielmaialva33/winx-code-agent', category: 'Coding Agents', language: 'rust' },
  { name: 'code-assistant', description: 'Coding agent with basic list, read, replace_in_file, write, execute_command and web search tools.', repository: 'https://github.com/stippi/code-assistant', category: 'Coding Agents', language: 'rust' },
  { name: 'copilot-mcp-server', description: 'MCP server that connects your IDE or AI assistant to GitHub Copilot CLI for code analysis, review, and batch processing', repository: 'https://github.com/x51xxx/copilot-mcp-server', category: 'Coding Agents', language: 'ts', command: 'npx', args: ["-y", "copilot-mcp-server"] },
  { name: 'octocode', description: 'Semantic code indexer with GraphRAG knowledge graph.', repository: 'https://github.com/Muvon/octocode', category: 'Developer Tools', language: 'rust' },
  { name: 'octocode-mcp', description: 'AI-powered developer assistant that enables advanced research, analysis and discovery across GitHub and NPM realms in re', repository: 'https://github.com/bgauryy/octocode-mcp', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "octocode-mcp"] },
  { name: 'octomind-mcp', description: 'lets your preferred AI agent create & run fully managed [Octomind](https://www.octomind.dev/) end-to-end tests from your', repository: 'https://github.com/OctoMind-dev/octomind-mcp', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "octomind-mcp"] },
  { name: 'mcp-server-scraper', description: 'Web scraping — extract clean markdown, links, and metadata from any URL.', repository: 'https://github.com/ofershap/mcp-server-scraper', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "mcp-server-scraper"] },
  { name: 'pylon-mcp', description: 'x402-native API gateway with 20+ capabilities (web-extract, web-search, translate, image-generate, screenshot, PDF, OCR,', repository: 'https://github.com/pylonapi/pylon-mcp', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "pylon-mcp"] },
  { name: 'just-mcp', description: 'Justfile integration that enables LLMs to execute any CLI or script commands with parameters safely and easily, with env', repository: 'https://github.com/promptexecution/just-mcp', category: 'Developer Tools', language: 'rust' },
  { name: 'srclight', description: 'Deep code indexing MCP server with SQLite FTS5, tree-sitter, and embeddings.', repository: 'https://github.com/srclight/srclight', category: 'Developer Tools', language: 'py', command: 'uvx', args: ["srclight"] },
  { name: 'memora', description: 'Persistent memory with knowledge graph visualization, semantic/hybrid search, cloud sync (S3/R2), and cross-session cont', repository: 'https://github.com/agentic-mcp-tools/memora', category: 'Knowledge & Memory', language: 'py', command: 'uvx', args: ["memora"] },
  { name: 'ApeRAG', description: 'Production-ready RAG platform combining Graph RAG, vector search, and full-text search.', repository: 'https://github.com/apecloud/ApeRAG', category: 'Knowledge & Memory', language: 'py', command: 'uvx', args: ["ApeRAG"] },
  { name: 'idapixl-web-research-mcp', description: 'AI-powered web research server with search, page fetching, and multi-source synthesis.', repository: 'https://github.com/idapixl/idapixl-web-research-mcp', category: 'Knowledge & Memory', language: 'ts', command: 'npx', args: ["-y", "idapixl-web-research-mcp"] },
  { name: 'Central-Memory-MCP', description: 'An Azure PaaS-hostable MCP server that provides a workspace-grounded knowledge graph for multiple developers using Azure', repository: 'https://github.com/MWGMorningwood/Central-Memory-MCP', category: 'Knowledge & Memory', language: 'ts', command: 'npx', args: ["-y", "Central-Memory-MCP"] },
  { name: 'novyx-mcp', description: 'Persistent AI agent memory with rollback, audit trails, semantic search, and knowledge graph.', repository: 'https://github.com/novyxlabs/novyx-core/tree/main/packages/novyx-mcp', category: 'Knowledge & Memory', language: 'py', command: 'uvx', args: ["novyx-mcp"] },
  { name: 'mcp-server', description: 'Retrieve context from your [Ragie](https://www.ragie.ai) (RAG) knowledge base connected to integrations like Google Driv', repository: 'https://github.com/ragieai/ragie-mcp-server', category: 'Knowledge & Memory', language: 'ts', command: 'npx', args: ["-y", "mcp-server"] },
  { name: 'smriti', description: 'Self-hosted knowledge store and memory layer for AI agents with knowledge graph, wiki-links, full-text search (FTS5), an', repository: 'https://github.com/smriti-AA/smriti', category: 'Knowledge & Memory', language: 'rust' },
  { name: 'devrag', description: 'Lightweight local RAG MCP server for semantic vector search over markdown documents.', repository: 'https://github.com/tomohiro-owada/devrag', category: 'Knowledge & Memory', language: 'go' },
  { name: 'mcp-status-observer', description: 'Model Context Protocol server for monitoring Operational Status of major digital platforms in Claude Desktop.', repository: 'https://github.com/imprvhub/mcp-status-observer', category: 'Monitoring', language: 'ts', command: 'npx', args: ["-y", "mcp-status-observer"] },
  { name: 'umami-mcp', description: 'Full-coverage MCP server for Umami Analytics API v2 — 66 tools for websites, stats, sessions, events, reports, users, te', repository: 'https://github.com/mikusnuz/umami-mcp', category: 'Monitoring', language: 'ts', command: 'npx', args: ["-y", "umami-mcp"] },
  { name: 'mcp-victoriametrics', description: 'Provides comprehensive integration with your [VictoriaMetrics instance APIs](https://docs.victoriametrics.com/victoriame', repository: 'https://github.com/VictoriaMetrics-Community/mcp-victoriametrics', category: 'Monitoring', language: 'go' },
  { name: 'aeo-cli', description: 'Audit URLs for AI crawler readiness — checks robots.txt, llms.txt, JSON-LD schema, and content density with 0-100 AEO sc', repository: 'https://github.com/hanselhansel/aeo-cli', category: 'Search & Data Extraction', language: 'py', command: 'uvx', args: ["aeo-cli"] },
  { name: 'openai-websearch-mcp', description: 'This is a Python-based MCP server that provides OpenAI `web_search` build-in tool.', repository: 'https://github.com/ConechoAI/openai-websearch-mcp/', category: 'Search & Data Extraction', language: 'py', command: 'uvx', args: ["openai-websearch-mcp"] },
  { name: 'brave-search-mcp', description: 'Web, Image, News, Video, and Local Point of Interest search capabilities using Brave\'s Search API', repository: 'https://github.com/mikechao/brave-search-mcp', category: 'Search & Data Extraction', language: 'ts', command: 'npx', args: ["-y", "brave-search-mcp"] },
  { name: 'mcp-local-rag', description: '"primitive" RAG-like web search model context protocol (MCP) server that runs locally.', repository: 'https://github.com/nkapila6/mcp-local-rag', category: 'Search & Data Extraction', language: 'py', command: 'uvx', args: ["mcp-local-rag"] },
  { name: 'mcp-server-webcrawl', description: 'Advanced search and retrieval for web crawler data.', repository: 'https://github.com/pragmar/mcp-server-webcrawl', category: 'Search & Data Extraction', language: 'py', command: 'uvx', args: ["mcp-server-webcrawl"] },
  { name: 'scrapercity-cli', description: 'B2B lead generation with 20+ tools including Apollo, Google Maps, email finder, email validator, mobile finder, skip tra', repository: 'https://github.com/scrapercity/scrapercity-cli', category: 'Search & Data Extraction', language: 'ts', command: 'npx', args: ["-y", "scrapercity-cli"] },
  { name: 'opengraph-io-mcp', description: 'OpenGraph.io API integration for extracting OG metadata, taking screenshots, scraping web content, querying sites with A', repository: 'https://github.com/securecoders/opengraph-io-mcp', category: 'Search & Data Extraction', language: 'ts', command: 'npx', args: ["-y", "opengraph-io-mcp"] },
  { name: 'vectorize-mcp-server', description: '[Vectorize](https://vectorize.io) MCP server for advanced retrieval, Private Deep Research, Anything-to-Markdown file ex', repository: 'https://github.com/vectorize-io/vectorize-mcp-server/', category: 'Search & Data Extraction', language: 'ts', command: 'npx', args: ["-y", "vectorize-mcp-server"] },
  { name: 'cyntrisec-cli', description: 'Local-first AWS security analyzer that discovers attack paths and generates remediations using graph theory.', repository: 'https://github.com/cyntrisec/cyntrisec-cli', category: 'Security', language: 'py', command: 'uvx', args: ["cyntrisec-cli"] },
  { name: 'skylos', description: 'Dead code detection, security scanning, and code quality analysis for Python, TypeScript, and Go.', repository: 'https://github.com/duriantaco/skylos', category: 'Security', language: 'py', command: 'uvx', args: ["skylos"] },
  { name: 'intercept-mcp', description: 'Multi-tier fallback chain for fetching web content as clean markdown.', repository: 'https://github.com/bighippoman/intercept-mcp', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "intercept-mcp"] },
  { name: 'playwright-plus-python-mcp', description: 'An MCP python server using Playwright for browser automation,more suitable for llm', repository: 'https://github.com/blackwhite084/playwright-plus-python-mcp', category: 'Browser Automation', language: 'py', command: 'uvx', args: ["playwright-plus-python-mcp"] },
  { name: 'browser-control-mcp', description: 'An MCP server paired with a browser extension that enables LLM clients to control the user\'s browser (Firefox).', repository: 'https://github.com/eyalzh/browser-control-mcp', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "browser-control-mcp"] },
  { name: 'Selenix-MCP-Server', description: 'MCP server bridging Claude Desktop with Selenix for browser automation and testing.', repository: 'https://github.com/markmircea/Selenix-MCP-Server', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "Selenix-MCP-Server"] },
  { name: 'chrome-mcp-secure', description: 'Security-hardened Chrome automation with post-quantum encryption (ML-KEM-768 + ChaCha20-Poly1305), secure credential vau', repository: 'https://github.com/Pantheon-Security/chrome-mcp-secure', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "chrome-mcp-secure"] },
  { name: 'web-search', description: 'An MCP server that enables free web searching using Google search results, with no API keys required.', repository: 'https://github.com/pskill9/web-search', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "web-search"] },
  { name: 'mcp-server-aws-sso', description: 'AWS Single Sign-On (SSO) integration enabling AI systems to securely interact with AWS resources by initiating SSO login', repository: 'https://github.com/aashari/mcp-server-aws-sso', category: 'Cloud Platforms', language: 'ts', command: 'npx', args: ["-y", "mcp-server-aws-sso"] },
  { name: 'mcp-rubber-duck', description: 'An MCP server that bridges to multiple OpenAI-compatible LLMs - your AI rubber duck debugging panel for explaining probl', repository: 'https://github.com/nesquikm/mcp-rubber-duck', category: 'Coding Agents', language: 'ts', command: 'npx', args: ["-y", "mcp-rubber-duck"] },
  { name: 'DesktopCommanderMCP', description: 'A swiss-army-knife that can manage/execute programs and read/write/search/edit code and text files.', repository: 'https://github.com/wonderwhy-er/DesktopCommanderMCP', category: 'Coding Agents', language: 'ts', command: 'npx', args: ["-y", "DesktopCommanderMCP"] },
  { name: 'ntfy-me-mcp', description: 'An ntfy MCP server for sending/fetching ntfy notifications to your self-hosted ntfy server from AI Agents 📤 (supports se', repository: 'https://github.com/gitmotion/ntfy-me-mcp', category: 'Communication', language: 'ts', command: 'npx', args: ["-y", "ntfy-me-mcp"] },
  { name: 'slack-mcp-server', description: 'Your complete Slack context for Claude—DMs, channels, threads, search.', repository: 'https://github.com/jtalk22/slack-mcp-server', category: 'Communication', language: 'ts', command: 'npx', args: ["-y", "slack-mcp-server"] },
  { name: 'whatsapp-mcp-stream', description: 'WhatsApp MCP server over Streamable HTTP with web admin UI (QR/status/settings), bidirectional media upload/download, an', repository: 'https://github.com/loglux/whatsapp-mcp-stream', category: 'Communication', language: 'ts', command: 'npx', args: ["-y", "whatsapp-mcp-stream"] },
  { name: 'mcp-dataverse', description: 'Microsoft Dataverse MCP server with 63 tools for entity CRUD, FetchXML/OData queries, metadata inspection, workflow exec', repository: 'https://github.com/codeurali/mcp-dataverse', category: 'Databases', language: 'ts', command: 'npx', args: ["-y", "mcp-dataverse"] },
  { name: 'agent-skill-loader', description: 'Dynamically load Claude Code skills into AI agents without copying files.', repository: 'https://github.com/back1ply/agent-skill-loader', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "agent-skill-loader"] },
  { name: 'cli', description: 'Endor lets your AI agents run services like MariaDB, Postgres, Redis, Memcached, Alpine, or Valkey in isolated sandboxes', repository: 'https://github.com/endorhq/cli', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "cli"] },
  { name: 'mcp-gitlab-jira', description: 'Unified MCP server for GitLab and Jira: manage projects, merge requests, files, releases and tickets with AI agents.', repository: 'https://github.com/HainanZhao/mcp-gitlab-jira', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "mcp-gitlab-jira"] },
  { name: 'claude-debugs-for-you', description: 'An MCP Server and VS Code Extension which enables (language agnostic) automatic debugging via breakpoints and expression', repository: 'https://github.com/jasonjmcghee/claude-debugs-for-you', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "claude-debugs-for-you"] },
  { name: 'fixgraph-mcp', description: 'Search and contribute to a community-verified knowledge base of 25,000+ engineering issues and fixes.', repository: 'https://github.com/jawdat6/fixgraph-mcp', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "fixgraph-mcp"] },
  { name: 'token-optimizer-mcp', description: 'Intelligent token optimization achieving 95%+ reduction through caching, compression, and 80+ smart tools for API optimi', repository: 'https://github.com/ooples/token-optimizer-mcp', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "token-optimizer-mcp"] },
  { name: 'mcp-openapi', description: 'MCP server that lets LLMs know everything about your OpenAPI specifications to discover, explain and generate code/mock ', repository: 'https://github.com/ReAPI-com/mcp-openapi', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "mcp-openapi"] },
  { name: 'mcp-package-version', description: 'An MCP Server to help LLMs suggest the latest stable package versions when writing code.', repository: 'https://github.com/sammcj/mcp-package-version', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "mcp-package-version"] },
  { name: 'mcp-server-boilerplate', description: 'Production-ready MCP server starter templates in TypeScript and Python.', repository: 'https://github.com/shellsage-ai/mcp-server-boilerplate', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "mcp-server-boilerplate"] },
  { name: 'claude-mermaid', description: 'A Mermaid diagram rendering MCP server for Claude Code with live reload functionality, supporting multiple export format', repository: 'https://github.com/veelenga/claude-mermaid/', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "claude-mermaid"] },
  // --- Essentials not in awesome-mcp-servers but critical for one-click ---
  { name: '@playwright/mcp', description: 'Browser automation with Playwright', repository: 'https://github.com/microsoft/playwright-mcp', category: 'Browser Automation', language: 'ts', command: 'npx', args: ["-y", "@playwright/mcp@latest"] },
  { name: '@stripe/mcp', description: 'Stripe payment integration', repository: 'https://github.com/stripe/agent-toolkit', category: 'Finance', language: 'ts', command: 'npx', args: ["-y", "@stripe/mcp"] },
  { name: '@sentry/mcp-server', description: 'Sentry error tracking and issue management', repository: 'https://github.com/getsentry/sentry-mcp', category: 'Monitoring', language: 'ts', command: 'npx', args: ["-y", "@sentry/mcp-server"] },
  { name: '@modelcontextprotocol/server-github', description: 'GitHub API integration', repository: 'https://github.com/modelcontextprotocol/servers', category: 'Version Control', language: 'ts', command: 'npx', args: ["-y", "@modelcontextprotocol/server-github"] },
  { name: 'mcp-server-docker', description: 'Docker container management', repository: 'https://github.com/ckreiling/mcp-server-docker', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "mcp-server-docker"] },
  { name: 'mcp-server-kubernetes', description: 'Kubernetes cluster management', repository: 'https://github.com/Flux159/mcp-server-kubernetes', category: 'Cloud Platforms', language: 'ts', command: 'npx', args: ["-y", "mcp-server-kubernetes"] },
  { name: 'mcp-server-linear', description: 'Linear project management', repository: 'https://github.com/jerhadf/linear-mcp-server', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "mcp-server-linear"] },
  { name: '@modelcontextprotocol/server-slack', description: 'Slack workspace integration', repository: 'https://github.com/modelcontextprotocol/servers', category: 'Communication', language: 'ts', command: 'npx', args: ["-y", "@modelcontextprotocol/server-slack"] },
  { name: '@modelcontextprotocol/server-brave-search', description: 'Brave search engine', repository: 'https://github.com/modelcontextprotocol/servers', category: 'Search & Data Extraction', language: 'ts', command: 'npx', args: ["-y", "@modelcontextprotocol/server-brave-search"] },
  { name: '@anthropic/server-sequential-thinking', description: 'Sequential thinking and reasoning', repository: 'https://github.com/anthropics/sequential-thinking', category: 'Coding Agents', language: 'ts', command: 'npx', args: ["-y", "@anthropic/server-sequential-thinking"] },
  { name: '@neondatabase/mcp-server-neon', description: 'Neon serverless Postgres — SQL queries, branches, schema management', repository: 'https://github.com/neondatabase/mcp-server-neon', category: 'Databases', language: 'ts', command: 'npx', args: ["-y", "@neondatabase/mcp-server-neon"] },
  { name: '@anthropic/cloudflare-mcp', description: 'Cloudflare Workers, KV, R2, and DNS management', repository: 'https://github.com/cloudflare/mcp-server-cloudflare', category: 'Cloud Platforms', language: 'ts', command: 'npx', args: ["-y", "@cloudflare/mcp-server-cloudflare"] },
  { name: '@supabase/mcp-server', description: 'Supabase Postgres, auth, storage, and edge functions', repository: 'https://github.com/supabase-community/supabase-mcp', category: 'Databases', language: 'ts', command: 'npx', args: ["-y", "@supabase/mcp-server"] },
  { name: 'ghidra-mcp', description: 'Ghidra reverse engineering — decompile, analyze, and triage binaries', repository: 'https://github.com/clearbluejar/ghidra-mcp', category: 'Security', language: 'py', command: 'uvx', args: ["ghidra-mcp"] },
  { name: 'discord-mcp', description: 'Discord messaging — send messages, manage channels, read history', repository: 'https://github.com/v-3/discord-mcp', category: 'Communication', language: 'ts', command: 'npx', args: ["-y", "discord-mcp"] },
  { name: '@airtable/mcp-server', description: 'Airtable structured data — records, tables, and views', repository: 'https://github.com/airtable/airtable-mcp-server', category: 'Data Platforms', language: 'ts', command: 'npx', args: ["-y", "@airtable/mcp-server"] },
  { name: 'resend-mcp', description: 'Email delivery via Resend API', repository: 'https://github.com/resend/mcp-send-email', category: 'Communication', language: 'ts', command: 'npx', args: ["-y", "resend-mcp"] },
  { name: '@anthropic/perplexity-mcp', description: 'AI-powered web search with citations via Perplexity', repository: 'https://github.com/ppl-ai/modelcontextprotocol', category: 'Search & Data Extraction', language: 'ts', command: 'npx', args: ["-y", "@anthropic/perplexity-mcp"] },
  { name: '@paddle/mcp-server', description: 'Paddle billing — subscriptions, invoices, and payments', repository: 'https://github.com/PaddleHQ/paddle-mcp-server', category: 'Finance', language: 'ts', command: 'npx', args: ["-y", "@paddle/mcp-server"] },
  { name: 'context7-mcp', description: 'Up-to-date library documentation — resolve libraries and query docs', repository: 'https://github.com/upstash/context7', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "@upstash/context7-mcp"] },
  { name: '@aws/mcp-server', description: 'AWS cloud operations — EC2, S3, Lambda, IAM', repository: 'https://github.com/awslabs/mcp', category: 'Cloud Platforms', language: 'ts', command: 'npx', args: ["-y", "@aws/mcp-server"] },
  { name: 'xcodebuild-mcp', description: 'Xcode build, test, and project management for iOS/macOS', repository: 'https://github.com/nicklawls/XcodeBuildMCP', category: 'Developer Tools', language: 'ts', command: 'npx', args: ["-y", "xcodebuild-mcp"] },
];


interface McpJsonFile {
  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
}

function deriveServerKey(name: string): string {
  // @playwright/mcp → playwright
  // @sentry/mcp-server → sentry
  // @modelcontextprotocol/server-memory → memory
  // mcp-server-docker → docker
  // If scoped, try the scope name first (strip @)
  const scopeMatch = name.match(/^@([^/]+)\//);
  if (scopeMatch) {
    const scope = scopeMatch[1];
    const pkg = name.slice(scopeMatch[0].length);
    // For @scope/mcp or @scope/mcp-server, use the scope
    if (pkg === 'mcp' || pkg === 'mcp-server') return scope;
    // For @modelcontextprotocol/server-X, use X
    if (scope === 'modelcontextprotocol' && pkg.startsWith('server-')) return pkg.slice(7);
    // For @anthropic/server-X, use X
    if (pkg.startsWith('server-')) return pkg.slice(7);
    // Otherwise use the package part, stripped
    return pkg.replace(/^(mcp-server-|server-)/, '').replace(/-mcp(-server)?$/, '') || scope;
  }
  return name
    .replace(/^(mcp-server-|server-)/, '')
    .replace(/-mcp(-server)?$/, '')
    || name;
}

export async function runGalleryAdd(args: string[]): Promise<void> {
  const listMode = args.includes('--list') || args.includes('-l');
  const jsonMode = args.includes('--json');
  const catIdx = args.indexOf('--category');
  const catFilter = catIdx >= 0 ? args[catIdx + 1]?.toLowerCase() : null;
  const configIdx = args.indexOf('--config');
  const configPath = configIdx >= 0 ? args[configIdx + 1] : undefined;

  // Collect positional args (server names to add)
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { if (a !== '--list' && a !== '--json' && a !== '-l') i++; continue; }
    if (a === '-l') continue;
    names.push(a.toLowerCase());
  }

  let entries = GALLERY;
  if (catFilter) {
    entries = entries.filter(e => e.category.toLowerCase().includes(catFilter));
  }

  // List mode
  if (listMode || names.length === 0) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    } else {
      const cats = new Map<string, GalleryEntry[]>();
      for (const e of entries) {
        const list = cats.get(e.category) ?? [];
        list.push(e);
        cats.set(e.category, list);
      }
      for (const [cat, list] of cats) {
        process.stderr.write(`\n  ${cat} (${list.length})\n`);
        for (const e of list) {
          const badge = e.language === 'ts' ? '📇' : e.language === 'py' ? '🐍' : e.language === 'go' ? '🏎️' : '  ';
          process.stderr.write(`    ${badge} ${e.name.padEnd(45)} ${e.description.slice(0, 60)}\n`);
        }
      }
      process.stderr.write(`\n  ${entries.length} servers available. Usage: metamcp add <name> [<name>...]\n\n`);
    }
    return;
  }

  // Find matches
  const matched: GalleryEntry[] = [];
  for (const query of names) {
    const exact = entries.find(e => e.name.toLowerCase() === query || deriveServerKey(e.name).toLowerCase() === query);
    if (exact) { matched.push(exact); continue; }
    const partial = entries.filter(e =>
      e.name.toLowerCase().includes(query) ||
      deriveServerKey(e.name).toLowerCase().includes(query) ||
      e.description.toLowerCase().includes(query)
    );
    if (partial.length === 1) { matched.push(partial[0]); continue; }
    if (partial.length > 1) {
      process.stderr.write(`Ambiguous query "${query}" matches ${partial.length} servers:\n`);
      for (const p of partial.slice(0, 5)) process.stderr.write(`  - ${p.name}: ${p.description.slice(0, 60)}\n`);
      if (partial.length > 5) process.stderr.write(`  ... and ${partial.length - 5} more\n`);
      continue;
    }
    process.stderr.write(`No match for "${query}"\n`);
  }

  if (matched.length === 0) { process.exit(1); }

  // Load or create .mcp.json
  const cfgPath = configPath ? resolve(configPath) : resolve(process.cwd(), '.mcp.json');
  let config: McpJsonFile = { mcpServers: {} };
  if (existsSync(cfgPath)) {
    try { config = JSON.parse(readFileSync(cfgPath, 'utf-8')) as McpJsonFile; } catch { /* fresh */ }
  }
  if (!config.mcpServers) config.mcpServers = {};

  const added: string[] = [];
  const skipped: string[] = [];

  for (const entry of matched) {
    const key = deriveServerKey(entry.name);
    if (config.mcpServers[key]) {
      skipped.push(key);
      continue;
    }
    const serverEntry: { command?: string; args?: string[]; env?: Record<string, string> } = {};
    if (entry.command) serverEntry.command = entry.command;
    if (entry.args) serverEntry.args = entry.args;
    config.mcpServers[key] = serverEntry;
    added.push(key);
  }

  writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n');

  // Check for companion skills
  const skillHints: string[] = [];
  try {
    // Dynamic import is fine since runGalleryAdd is sync but top-level await is available
    const { SkillCatalog } = await import('./skill-catalog.js');
    const catalog = new SkillCatalog();
    for (const key of added) {
      const skills = catalog.getSkillsForServer(key);
      if (skills.length > 0) {
        skillHints.push(`  ${key} → skill: ${skills.map(s => s.name).join(', ')}`);
      }
    }
  } catch { /* skill catalog not available */ }

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ added, skipped, configPath: cfgPath, skills: skillHints }) + '\n');
  } else {
    if (added.length) process.stderr.write(`Added ${added.length} server(s): ${added.join(', ')}\n`);
    if (skipped.length) process.stderr.write(`Skipped (already configured): ${skipped.join(', ')}\n`);
    if (skillHints.length) {
      process.stderr.write(`\nCompanion skills detected:\n`);
      for (const hint of skillHints) process.stderr.write(`${hint}\n`);
      process.stderr.write(`These skills teach agents how to use these servers effectively.\n`);
    }
    process.stderr.write(`Config: ${cfgPath}\n`);
  }
}

import type { Metadata } from "next";
import { buildSearchIndex } from "@/lib/search-index";
import DocsHomePage from "@/components/DocsHomePage";

export const metadata: Metadata = {
  title: "MetaMCP Docs — Meta-MCP Server for Tool Aggregation",
  description:
    "Documentation for MetaMCP, the meta-MCP server that collapses N child servers into 4 tools with connection pooling, hybrid search, and V8 sandbox.",
  openGraph: {
    title: "MetaMCP Docs — Meta-MCP Server for Tool Aggregation",
    description:
      "Documentation for MetaMCP, the meta-MCP server that collapses N child servers into 4 tools with connection pooling, hybrid search, and V8 sandbox.",
    url: "https://metamcp.org",
    siteName: "MetaMCP Docs",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "MetaMCP Docs — Meta-MCP Server for Tool Aggregation",
    description:
      "Documentation for MetaMCP, the meta-MCP server that collapses N child servers into 4 tools.",
  },
  alternates: {
    canonical: "https://metamcp.org",
  },
};

export default function Home() {
  const searchEntries = buildSearchIndex();
  return <DocsHomePage searchEntries={searchEntries} />;
}

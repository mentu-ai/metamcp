"use client";

import Link from "next/link";
import { useTheme } from "./ThemeProvider";
import SearchModal from "./SearchModal";
import {
  Layers,
  Server,
  Shield,
  Rocket,
  Code,
  Sparkles,
  Puzzle,
  Monitor,
  Settings,
  BookOpen,
  PenLine,
  FileText,
  Search,
  Sun,
  Moon,
} from "lucide-react";

interface SearchEntry {
  slug: string;
  href: string;
  title: string;
  section: string;
  excerpt: string;
}

/* ── Gradient palettes ── */

const products = [
  {
    title: "4 Meta-Tools",
    description:
      "Collapse N child MCP servers into 4 tools. Your LLM sees ~1,000 schema tokens.",
    href: "/what-is-metamcp",
    gradient: [
      "radial-gradient(ellipse at 20% 30%, rgba(0,143,253,0.5), transparent 55%)",
      "radial-gradient(ellipse at 80% 70%, rgba(71,181,255,0.5), transparent 50%)",
      "radial-gradient(ellipse at 50% 50%, rgba(0,143,253,0.1), transparent 70%)",
      "linear-gradient(135deg, #bfdbfe 0%, #dbeafe 100%)",
    ],
    darkGradient: [
      "radial-gradient(ellipse at 20% 30%, rgba(0,143,253,0.4), transparent 55%)",
      "radial-gradient(ellipse at 80% 70%, rgba(71,181,255,0.3), transparent 50%)",
      "radial-gradient(ellipse at 50% 50%, rgba(0,112,212,0.15), transparent 70%)",
      "linear-gradient(135deg, #0c2d4a 0%, #0a1929 100%)",
    ],
  },
  {
    title: "Connection Pool",
    description:
      "Lazy spawning, LIFO eviction, circuit breaker, and bounded pool management.",
    href: "/concepts/connection-pool",
    gradient: [
      "radial-gradient(ellipse at 25% 25%, rgba(34,211,238,0.6), transparent 55%)",
      "radial-gradient(ellipse at 75% 75%, rgba(147,197,253,0.7), transparent 50%)",
      "radial-gradient(ellipse at 50% 50%, rgba(96,165,250,0.15), transparent 70%)",
      "linear-gradient(135deg, #bae6fd 0%, #dbeafe 100%)",
    ],
    darkGradient: [
      "radial-gradient(ellipse at 25% 25%, rgba(34,211,238,0.35), transparent 55%)",
      "radial-gradient(ellipse at 75% 75%, rgba(59,130,246,0.3), transparent 50%)",
      "radial-gradient(ellipse at 50% 50%, rgba(37,99,235,0.15), transparent 70%)",
      "linear-gradient(135deg, #0c4a6e 0%, #172554 100%)",
    ],
  },
  {
    title: "V8 Sandbox",
    description:
      "Isolated code execution with 16 security protections. Compose across servers in one call.",
    href: "/concepts/sandbox",
    gradient: [
      "radial-gradient(ellipse at 30% 20%, rgba(251,191,36,0.7), transparent 55%)",
      "radial-gradient(ellipse at 70% 80%, rgba(251,146,60,0.6), transparent 50%)",
      "radial-gradient(ellipse at 50% 50%, rgba(245,158,11,0.15), transparent 70%)",
      "linear-gradient(135deg, #fde68a 0%, #fed7aa 100%)",
    ],
    darkGradient: [
      "radial-gradient(ellipse at 30% 20%, rgba(245,158,11,0.4), transparent 55%)",
      "radial-gradient(ellipse at 70% 80%, rgba(234,88,12,0.3), transparent 50%)",
      "radial-gradient(ellipse at 50% 50%, rgba(180,83,9,0.15), transparent 70%)",
      "linear-gradient(135deg, #451a03 0%, #422006 100%)",
    ],
  },
];

const featured = [
  {
    title: "Quick Start",
    description: "Set up MetaMCP and make your first tool call in under 5 minutes.",
    href: "/quick-start",
    tag: "Quickstart",
    tagIcon: "guide" as const,
    thumbGradient: "linear-gradient(135deg, #bfdbfe, #dbeafe)",
    thumbDarkGradient: "linear-gradient(135deg, #0c2d4a, #0a1929)",
    iconIndex: 0,
  },
  {
    title: "Code Mode",
    description: "Compose multi-server workflows in a single mcp_execute call.",
    href: "/guides/code-mode",
    tag: "Guide",
    tagIcon: "guide" as const,
    thumbGradient: "linear-gradient(135deg, #6ee7b7, #a7f3d0)",
    thumbDarkGradient: "linear-gradient(135deg, #064e3b, #022c22)",
    iconIndex: 1,
  },
  {
    title: "Auto-Provisioning",
    description: "Describe what you need. MetaMCP finds, installs, and configures the right server.",
    href: "/guides/auto-provisioning",
    tag: "New",
    tagIcon: "new" as const,
    thumbGradient: "linear-gradient(135deg, #fde68a, #fecaca)",
    thumbDarkGradient: "linear-gradient(135deg, #451a03, #450a0a)",
    iconIndex: 2,
  },
  {
    title: "The Four Tools",
    description: "mcp_discover, mcp_provision, mcp_call, and mcp_execute explained.",
    href: "/concepts/the-four-tools",
    tag: "Reference",
    tagIcon: "ref" as const,
    thumbGradient: "linear-gradient(135deg, #bae6fd, #bfdbfe)",
    thumbDarkGradient: "linear-gradient(135deg, #0c4a6e, #0c2d4a)",
    iconIndex: 3,
  },
  {
    title: "Claude Desktop",
    description: "Set up MetaMCP as your MCP proxy in Claude Desktop.",
    href: "/guides/claude-desktop",
    tag: "Guide",
    tagIcon: "guide" as const,
    thumbGradient: "linear-gradient(135deg, #bfdbfe, #a5d8ff)",
    thumbDarkGradient: "linear-gradient(135deg, #0a1929, #0c2d4a)",
    iconIndex: 4,
  },
  {
    title: "Configuration",
    description: "The .mcp.json format, server entries, environment variables, and CLI flags.",
    href: "/configuration",
    tag: "Reference",
    tagIcon: "ref" as const,
    thumbGradient: "linear-gradient(135deg, #d9f99d, #bbf7d0)",
    thumbDarkGradient: "linear-gradient(135deg, #365314, #14532d)",
    iconIndex: 5,
  },
];

const explore = [
  {
    title: "Concepts",
    description: "Architecture, tools, pool, and sandbox",
    href: "/concepts/architecture",
    gradient: [
      "radial-gradient(ellipse at 30% 40%, rgba(0,143,253,0.45), transparent 55%)",
      "radial-gradient(ellipse at 70% 30%, rgba(71,181,255,0.4), transparent 50%)",
      "radial-gradient(ellipse at 50% 80%, rgba(191,219,254,0.4), transparent 60%)",
      "linear-gradient(160deg, #bfdbfe 0%, #dbeafe 50%, #eff6ff 100%)",
    ],
    darkGradient: [
      "radial-gradient(ellipse at 30% 40%, rgba(0,112,212,0.4), transparent 55%)",
      "radial-gradient(ellipse at 70% 30%, rgba(0,143,253,0.3), transparent 50%)",
      "radial-gradient(ellipse at 50% 80%, rgba(0,70,130,0.25), transparent 60%)",
      "linear-gradient(160deg, #0c2d4a 0%, #0a1929 100%)",
    ],
  },
  {
    title: "Guides",
    description: "Setup, configuration, and integration",
    href: "/guides/adding-servers",
    gradient: [
      "radial-gradient(ellipse at 25% 35%, rgba(147,197,253,0.7), transparent 55%)",
      "radial-gradient(ellipse at 75% 65%, rgba(186,230,253,0.6), transparent 50%)",
      "radial-gradient(ellipse at 50% 50%, rgba(191,219,254,0.3), transparent 65%)",
      "linear-gradient(160deg, #bae6fd 0%, #dbeafe 50%, #e0f2fe 100%)",
    ],
    darkGradient: [
      "radial-gradient(ellipse at 25% 35%, rgba(37,99,235,0.45), transparent 55%)",
      "radial-gradient(ellipse at 75% 65%, rgba(59,130,246,0.3), transparent 50%)",
      "radial-gradient(ellipse at 50% 50%, rgba(30,64,175,0.2), transparent 65%)",
      "linear-gradient(160deg, #172554 0%, #0c4a6e 100%)",
    ],
  },
  {
    title: "Reference",
    description: "Tool schemas, CLI flags, and config",
    href: "/reference/tool-reference",
    gradient: [
      "radial-gradient(ellipse at 60% 30%, rgba(134,239,172,0.5), transparent 55%)",
      "radial-gradient(ellipse at 30% 70%, rgba(186,230,253,0.6), transparent 50%)",
      "radial-gradient(ellipse at 80% 80%, rgba(190,242,100,0.35), transparent 55%)",
      "linear-gradient(160deg, #bae6fd 0%, #d9f99d 50%, #bbf7d0 100%)",
    ],
    darkGradient: [
      "radial-gradient(ellipse at 60% 30%, rgba(22,163,74,0.35), transparent 55%)",
      "radial-gradient(ellipse at 30% 70%, rgba(37,99,235,0.3), transparent 50%)",
      "radial-gradient(ellipse at 80% 80%, rgba(101,163,13,0.2), transparent 55%)",
      "linear-gradient(160deg, #0c4a6e 0%, #14532d 100%)",
    ],
  },
];

/* ── Icon components ── */
function TagIcon({ type }: { type: string }) {
  const cls = "w-3 h-3";
  if (type === "new") return <Sparkles className={cls} />;
  if (type === "ref") return <FileText className={cls} />;
  return <BookOpen className={cls} />;
}

function ProductIcon({ index, isDark }: { index: number; isDark: boolean }) {
  const cls = `w-6 h-6 ${isDark ? "text-white/90" : "text-black/70"}`;
  if (index === 0) return <Layers className={cls} />;
  if (index === 1) return <Server className={cls} />;
  return <Shield className={cls} />;
}

function ThumbIcon({ index, isDark }: { index: number; isDark: boolean }) {
  const cls = `w-4 h-4 ${isDark ? "text-white/80" : "text-black/60"}`;
  const icons = [
    <Rocket key={0} className={cls} />,
    <Code key={1} className={cls} />,
    <Sparkles key={2} className={cls} />,
    <Puzzle key={3} className={cls} />,
    <Monitor key={4} className={cls} />,
    <Settings key={5} className={cls} />,
  ];
  return icons[index] || icons[0];
}

function ExploreIcon({ index, isDark }: { index: number; isDark: boolean }) {
  const cls = `w-7 h-7 ${isDark ? "text-white/80" : "text-black/65"}`;
  if (index === 0) return <BookOpen className={cls} />;
  if (index === 1) return <PenLine className={cls} />;
  return <FileText className={cls} />;
}

export default function DocsHomePage({
  searchEntries,
}: {
  searchEntries: SearchEntry[];
}) {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";

  return (
    <>
      <SearchModal entries={searchEntries} />

      {/* ── Header ── */}
      <header className="fixed top-0 left-0 right-0 z-30 h-14 bg-bg-100 border-b border-border-200 flex items-center px-4 lg:px-6">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <span className="text-text-100 font-semibold text-lg">MetaMCP</span>
        </Link>

        <nav className="hidden sm:flex items-center gap-6 ml-8 text-sm">
          <Link href="/what-is-metamcp" className="text-text-300 hover:text-text-100 transition-colors">Docs</Link>
          <Link href="/concepts/architecture" className="text-text-300 hover:text-text-100 transition-colors">Concepts</Link>
          <a href="https://github.com/mentu-ai/metamcp" target="_blank" rel="noopener noreferrer" className="text-text-300 hover:text-text-100 transition-colors">GitHub</a>
        </nav>

        <div className="flex items-center gap-3 ml-auto">
          <button
            onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
            className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-text-400 bg-[var(--bg-hover)] border border-border-100 hover:border-border-300 transition-colors"
          >
            <Search className="w-3.5 h-3.5" />
            <span>Search docs</span>
            <kbd className="text-[10px] text-text-400 border border-border-200 rounded px-1 py-0.5 font-mono ml-2">⌘K</kbd>
          </button>

          <button onClick={toggle} className="p-1.5 rounded-lg text-text-300 hover:text-text-100 hover:bg-bg-hover transition-colors" aria-label="Toggle theme">
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          <a
            href="https://github.com/mentu-ai/metamcp"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden md:inline-flex items-center gap-2 text-sm font-medium px-4 py-1.5 rounded-full text-white transition-all hover:opacity-90 hover:scale-[1.02]"
            style={{
              background: "var(--accent-primary)",
              boxShadow: "0 4px 16px rgba(37, 99, 235, 0.25)",
            }}
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            View on GitHub
          </a>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="pt-14">
        {/* ── Hero ── */}
        <section className="max-w-5xl mx-auto px-6 lg:px-8 pt-16 pb-12 text-center">
          <h1 className="text-4xl sm:text-5xl font-semibold text-text-100 tracking-tight mb-4">
            MetaMCP
          </h1>
          <p className="text-lg text-text-300 max-w-2xl mx-auto mb-10">
            OS for MCP servers. 4 tools, infinite capability.
          </p>
          <button
            onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
            className="mx-auto flex items-center gap-3 w-full max-w-md px-4 py-3 rounded-xl text-sm text-text-400 bg-bg-200 border border-border-200 hover:border-border-300 transition-colors"
          >
            <Search className="w-4 h-4 shrink-0" />
            <span>Search the docs</span>
            <kbd className="ml-auto text-[10px] border border-border-200 rounded px-1.5 py-0.5 font-mono">⌘K</kbd>
          </button>
        </section>

        {/* ── Product areas (3 cards) ── */}
        <section className="max-w-5xl mx-auto px-6 lg:px-8 pb-16">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {products.map((p, i) => (
              <Link
                key={p.href}
                href={p.href}
                className="group relative overflow-hidden rounded-2xl border border-border-100 transition-all hover:shadow-lg hover:-translate-y-0.5"
                style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}
              >
                <div
                  className="h-36 flex items-center justify-center"
                  style={{ background: (isDark ? p.darkGradient : p.gradient).join(", ") }}
                >
                  <div
                    className="w-12 h-12 rounded-2xl flex items-center justify-center shadow-sm"
                    style={{
                      background: isDark ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.85)",
                      backdropFilter: "blur(8px)",
                    }}
                  >
                    <ProductIcon index={i} isDark={isDark} />
                  </div>
                </div>
                <div className="p-5 bg-bg-100">
                  <h3 className="font-medium text-text-100 group-hover:text-accent-primary transition-colors mb-1.5">
                    {p.title}
                  </h3>
                  <p className="text-sm text-text-300 leading-relaxed">{p.description}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* ── Featured ── */}
        <section className="max-w-5xl mx-auto px-6 lg:px-8 pb-16">
          <h2 className="text-lg font-medium text-text-100 mb-6">Featured</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {featured.map((card) => (
              <Link
                key={card.href}
                href={card.href}
                className="group flex gap-4 p-4 rounded-xl border border-border-100 bg-bg-100 transition-all hover:shadow-md hover:-translate-y-px"
                style={{ boxShadow: "0 1px 6px rgba(0,0,0,0.04)" }}
              >
                <div
                  className="w-[72px] h-[72px] rounded-xl shrink-0 flex items-center justify-center"
                  style={{ background: isDark ? card.thumbDarkGradient : card.thumbGradient }}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center"
                    style={{
                      background: isDark ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.8)",
                    }}
                  >
                    <ThumbIcon index={card.iconIndex} isDark={isDark} />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-text-100 group-hover:text-accent-primary transition-colors text-[15px]">
                    {card.title}
                  </h3>
                  <p className="text-sm text-text-300 mt-1 leading-relaxed line-clamp-2">{card.description}</p>
                  <span className="inline-flex items-center gap-1.5 mt-2.5 text-xs text-text-400">
                    <TagIcon type={card.tagIcon} />
                    {card.tag}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* ── Explore ── */}
        <section className="max-w-5xl mx-auto px-6 lg:px-8 pb-20">
          <h2 className="text-lg font-medium text-text-100 mb-6">Explore</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {explore.map((card, i) => (
              <Link key={card.href} href={card.href} className="group">
                <div
                  className="h-48 rounded-2xl flex items-center justify-center mb-3 transition-all group-hover:scale-[1.02] group-hover:shadow-lg"
                  style={{
                    background: (isDark ? card.darkGradient : card.gradient).join(", "),
                    boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
                  }}
                >
                  <div
                    className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm"
                    style={{
                      background: isDark ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.85)",
                      backdropFilter: "blur(8px)",
                    }}
                  >
                    <ExploreIcon index={i} isDark={isDark} />
                  </div>
                </div>
                <h3 className="font-medium text-text-100 group-hover:text-accent-primary transition-colors">
                  {card.title}
                </h3>
                <p className="text-sm text-text-300 mt-0.5">{card.description}</p>
              </Link>
            ))}
          </div>
        </section>

        {/* ── Footer ── */}
        <footer className="border-t border-border-100 py-8 text-center text-xs text-text-400">
          MetaMCP. Open source under Apache-2.0.
        </footer>
      </main>
    </>
  );
}

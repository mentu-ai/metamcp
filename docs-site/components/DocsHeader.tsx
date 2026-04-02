"use client";

import Link from "next/link";
import { useTheme } from "./ThemeProvider";

export default function DocsHeader({
  onMenuToggle,
}: {
  onMenuToggle: () => void;
}) {
  const { theme, toggle } = useTheme();

  return (
    <header className="fixed top-0 left-0 right-0 z-30 h-14 bg-bg-100 border-b border-border-200 flex items-center px-4 lg:px-6">
      {/* Mobile menu button */}
      <button
        onClick={onMenuToggle}
        className="lg:hidden mr-3 p-1.5 rounded-lg text-text-300 hover:text-text-100 hover:bg-bg-hover transition-colors"
        aria-label="Toggle sidebar"
      >
        <svg
          className="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
      </button>

      {/* Logo */}
      <Link href="/" className="flex items-center gap-2.5 mr-8 shrink-0">
        <span className="text-text-100 font-semibold text-lg whitespace-nowrap">
          MetaMCP Docs
        </span>
      </Link>

      {/* Nav links */}
      <nav className="hidden sm:flex items-center gap-6 text-sm">
        <Link href="/what-is-metamcp" className="text-text-300 hover:text-text-100 transition-colors">
          Docs
        </Link>
        <Link href="/concepts/architecture" className="text-text-300 hover:text-text-100 transition-colors">
          Concepts
        </Link>
        <a href="https://github.com/mentu-ai/metamcp" target="_blank" rel="noopener noreferrer" className="text-text-300 hover:text-text-100 transition-colors">
          GitHub
        </a>
      </nav>

      {/* Right actions */}
      <div className="flex items-center gap-3 ml-auto">
        {/* Search trigger — icon on mobile, full bar on sm+ */}
        <button
          onClick={() =>
            document.dispatchEvent(
              new KeyboardEvent("keydown", { key: "k", metaKey: true })
            )
          }
          className="sm:hidden p-1.5 rounded-lg text-text-300 hover:text-text-100 hover:bg-bg-hover transition-colors"
          aria-label="Search"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </button>
        <button
          onClick={() =>
            document.dispatchEvent(
              new KeyboardEvent("keydown", { key: "k", metaKey: true })
            )
          }
          className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-text-400 bg-[var(--bg-hover)] border border-border-100 hover:border-border-300 transition-colors"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <span>Search</span>
          <kbd className="text-[10px] text-text-400 border border-border-200 rounded px-1 py-0.5 font-mono ml-2">
            ⌘K
          </kbd>
        </button>

        {/* Theme toggle */}
        <button
          onClick={toggle}
          className="p-1.5 rounded-lg text-text-300 hover:text-text-100 hover:bg-bg-hover transition-colors"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
            </svg>
          )}
        </button>

        {/* GitHub CTA */}
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
  );
}

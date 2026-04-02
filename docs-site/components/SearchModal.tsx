"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

interface SearchEntry {
  slug: string;
  href: string;
  title: string;
  section: string;
  excerpt: string;
}

export default function SearchModal({ entries }: { entries: SearchEntry[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const results = query.trim()
    ? entries.filter((e) => {
        const q = query.toLowerCase();
        return (
          e.title.toLowerCase().includes(q) ||
          e.section.toLowerCase().includes(q) ||
          e.excerpt.toLowerCase().includes(q)
        );
      })
    : [];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const navigate = useCallback(
    (entry: SearchEntry) => {
      setOpen(false);
      setQuery("");
      router.push(entry.href);
    },
    [router]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIndex]) {
      navigate(results[selectedIndex]);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100]"
      onClick={() => {
        setOpen(false);
        setQuery("");
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Dialog */}
      <div className="relative flex justify-center pt-[15vh] px-4">
        <div
          className="w-full max-w-lg bg-bg-300 rounded-2xl shadow-2xl border border-border-200 overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Search input */}
          <div className="flex items-center gap-3 px-4 border-b border-border-100">
            <svg
              className="w-4 h-4 text-text-400 shrink-0"
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
            <input
              ref={inputRef}
              type="text"
              placeholder="Search docs..."
              className="flex-1 py-3.5 text-sm bg-transparent outline-none text-text-100 placeholder:text-text-400"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <kbd className="text-[10px] text-text-400 border border-border-200 rounded px-1.5 py-0.5 font-mono">
              ESC
            </kbd>
          </div>

          {/* Results */}
          {query.trim() && (
            <div className="max-h-80 overflow-y-auto py-2">
              {results.length === 0 ? (
                <p className="px-4 py-6 text-sm text-text-400 text-center">
                  No results for &ldquo;{query}&rdquo;
                </p>
              ) : (
                results.map((entry, i) => (
                  <button
                    key={entry.slug}
                    className={`w-full text-left px-4 py-2.5 flex flex-col gap-0.5 transition-colors ${
                      i === selectedIndex
                        ? "bg-accent-primary/[0.08]"
                        : "hover:bg-bg-hover"
                    }`}
                    onClick={() => navigate(entry)}
                    onMouseEnter={() => setSelectedIndex(i)}
                  >
                    <span className="text-sm font-medium text-text-100">
                      {entry.title}
                    </span>
                    <span className="text-xs text-text-400">
                      {entry.section}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}

          {/* Empty state */}
          {!query.trim() && (
            <div className="px-4 py-6 text-sm text-text-400 text-center">
              Type to search across all documentation
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

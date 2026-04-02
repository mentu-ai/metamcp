"use client";

import { useEffect, useState } from "react";

interface Heading {
  depth: number;
  text: string;
  id: string;
}

export default function DocsTableOfContents({
  headings,
}: {
  headings: Heading[];
}) {
  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 }
    );

    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter(Boolean) as HTMLElement[];

    elements.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav className="hidden xl:block w-56 shrink-0 sticky top-20 self-start max-h-[calc(100vh-6rem)] overflow-y-auto">
      <p className="text-[11px] font-semibold text-text-300 uppercase tracking-widest mb-4 pl-3">
        On this page
      </p>
      <ul className="space-y-0.5">
        {headings.map((heading) => {
          const isActive = activeId === heading.id;
          return (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                className={`block text-[13px] leading-snug py-1.5 transition-colors ${
                  heading.depth === 3 ? "pl-6" : "pl-3"
                } ${
                  isActive
                    ? "text-accent-primary font-medium border-l-2 border-accent-primary"
                    : "text-text-300 hover:text-text-100"
                }`}
              >
                {heading.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

"use client";

import { useEffect, useRef } from "react";

/**
 * Renders pre-processed HTML from local markdown files only.
 * Content is sourced from trusted local .md files in content/ —
 * never from user input or external sources.
 */
export default function ProseContent({ html }: { html: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pres = container.querySelectorAll("pre");

    pres.forEach((pre) => {
      if (pre.querySelector(".copy-btn")) return;

      pre.style.position = "relative";

      // Language label
      const lang = pre.getAttribute("data-language");
      if (lang) {
        const langLabel = document.createElement("span");
        langLabel.className = "lang-label";
        langLabel.textContent = lang;
        pre.appendChild(langLabel);
      }

      // Copy button
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      btn.title = "Copy code";

      btn.addEventListener("click", () => {
        const code = pre.querySelector("code");
        const text = code?.textContent || pre.textContent || "";
        navigator.clipboard.writeText(text).then(() => {
          btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
          btn.classList.add("copied");
          setTimeout(() => {
            btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
            btn.classList.remove("copied");
          }, 2000);
        });
      });

      pre.appendChild(btn);
    });

    // Tab switching
    const tabBtns = container.querySelectorAll<HTMLButtonElement>(".tab-btn");
    tabBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-tab-target");
        const tabsContainer = btn.closest(".tabs-container");
        if (!tabsContainer || !target) return;

        tabsContainer
          .querySelectorAll(".tab-btn")
          .forEach((b) => b.classList.remove("tab-btn-active"));
        tabsContainer
          .querySelectorAll(".tab-panel")
          .forEach((p) => p.classList.remove("tab-panel-active"));

        btn.classList.add("tab-btn-active");
        tabsContainer
          .querySelector(`[data-tab-panel="${target}"]`)
          ?.classList.add("tab-panel-active");
      });
    });
  }, [html]);

  return (
    <div
      ref={containerRef}
      className="docs-prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

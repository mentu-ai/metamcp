import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import type { Element, Root as HastRoot } from "hast";
import { getPathForSlug } from "./docs-nav";

const contentDir = path.join(process.cwd(), "content", "docs");

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

export interface DocPage {
  slug: string;
  title: string;
  excerpt: string;
  description: string;
  content: string;
  htmlContent: string;
  headings: Heading[];
  copyContent: string;
}

function extractHeadings(tree: HastRoot): Heading[] {
  const headings: Heading[] = [];
  visit(tree, "element", (node: Element) => {
    if (node.tagName === "h2" || node.tagName === "h3") {
      const id = (node.properties?.id as string) || "";
      let text = "";
      visit(node, "text", (textNode: { value: string }) => {
        text += textNode.value;
      });
      if (id && text) {
        headings.push({ depth: node.tagName === "h2" ? 2 : 3, text, id });
      }
    }
  });
  return headings;
}

/** Custom rehype plugin to transform ```diagram and ```pipeline blocks into styled HTML */
function rehypeDiagrams() {
  return (tree: HastRoot) => {
    // Collect replacements first, apply after traversal
    const replacements: { parent: Element | HastRoot; index: number; replacement: Element }[] = [];

    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "pre") return;

      const codeEl = node.children.find(
        (c): c is Element => (c as Element).tagName === "code"
      ) as Element | undefined;
      if (!codeEl) return;

      const classes = (codeEl.properties?.className as string[]) || [];
      const isDiagram = classes.includes("language-diagram");
      const isPipeline = classes.includes("language-pipeline");
      if (!isDiagram && !isPipeline) return;

      // Extract raw text
      let raw = "";
      visit(codeEl, "text", (t: { value: string }) => { raw += t.value; });
      const lines = raw.split("\n").filter((l) => l.trim() !== "");

      if (isDiagram) {
        const children: Element[] = [];
        let i = 0;
        while (i < lines.length) {
          const line = lines[i];
          const connectorMatch = line.match(/^\s*\|\s*(.*)$/);
          const arrowMatch = line.match(/^\s*v\s*$/);

          if (connectorMatch || arrowMatch) {
            let label = connectorMatch ? connectorMatch[1].trim() : "";
            i++;
            while (i < lines.length) {
              const next = lines[i];
              if (next.match(/^\s*v\s*$/)) { i++; continue; }
              const nextConn = next.match(/^\s*\|\s*(.*)$/);
              if (nextConn) {
                if (nextConn[1].trim()) label = nextConn[1].trim();
                i++;
                continue;
              }
              break;
            }
            const connChildren: Element[] = [
              { type: "element", tagName: "div", properties: { className: "flow-connector-line" }, children: [] },
            ];
            if (label) {
              connChildren.push({
                type: "element", tagName: "span",
                properties: { className: "flow-connector-label" },
                children: [{ type: "text", value: label }],
              });
            }
            connChildren.push(
              { type: "element", tagName: "div", properties: { className: "flow-connector-line" }, children: [] },
              { type: "element", tagName: "div", properties: { className: "flow-connector-arrow" }, children: [{ type: "text", value: "▼" }] },
            );
            children.push({
              type: "element", tagName: "div",
              properties: { className: "flow-connector" },
              children: connChildren,
            });
          } else {
            children.push({
              type: "element", tagName: "div",
              properties: { className: "flow-node" },
              children: [{ type: "text", value: line.trim() }],
            });
            i++;
          }
        }

        // Replace pre in-place
        node.tagName = "div";
        node.properties = { className: "flow-diagram" };
        node.children = children;
      } else if (isPipeline) {
        const stages: { title: string; desc: string }[] = [];
        for (let j = 0; j < lines.length; j += 2) {
          stages.push({
            title: lines[j]?.trim() || "",
            desc: lines[j + 1]?.trim() || "",
          });
        }
        const stageEls: Element[] = stages.map((s) => ({
          type: "element" as const,
          tagName: "div",
          properties: { className: "pipeline-stage" },
          children: [
            {
              type: "element" as const, tagName: "div",
              properties: { className: "pipeline-stage-title" },
              children: [{ type: "text" as const, value: s.title }],
            },
            {
              type: "element" as const, tagName: "div",
              properties: { className: "pipeline-stage-desc" },
              children: [{ type: "text" as const, value: s.desc }],
            },
          ],
        }));

        node.tagName = "div";
        node.properties = { className: "pipeline-diagram" };
        node.children = stageEls;
      }
    });
  };
}

/** Custom rehype plugin to transform <!-- tabs --> / <!-- /tabs --> into tabbed containers */
function rehypeTabs() {
  return (tree: HastRoot) => {
    processTabsInNode(tree);
  };
}

function processTabsInNode(parent: Element | HastRoot) {
  const children = parent.children;
  if (!children) return;

  // Recurse into child elements first
  for (const child of children) {
    if ("children" in child && child.type === "element") {
      processTabsInNode(child);
    }
  }

  let i = 0;
  while (i < children.length) {
    const child = children[i];

    // Find <!-- tabs --> marker
    if (
      child.type === "raw" &&
      (child as { value: string }).value.trim() === "<!-- tabs -->"
    ) {
      // Find matching <!-- /tabs -->
      let endIdx = -1;
      for (let j = i + 1; j < children.length; j++) {
        const c = children[j];
        if (
          c.type === "raw" &&
          (c as { value: string }).value.trim() === "<!-- /tabs -->"
        ) {
          endIdx = j;
          break;
        }
      }

      if (endIdx === -1) {
        i++;
        continue;
      }

      // Extract content between markers
      const tabContent = children.slice(i + 1, endIdx);

      // Split by headings (h2 or h3)
      const tabs: { label: string; id: string; content: (typeof children)[number][] }[] = [];
      let currentTab: (typeof tabs)[number] | null = null;

      for (const node of tabContent) {
        if (
          node.type === "element" &&
          (node.tagName === "h2" || node.tagName === "h3")
        ) {
          let text = "";
          visit(node, "text", (t: { value: string }) => {
            text += t.value;
          });
          const id =
            (node.properties?.id as string) ||
            text
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "");

          currentTab = { label: text, id, content: [] };
          tabs.push(currentTab);
        } else if (currentTab) {
          // Skip <hr> separators between tabs
          if (node.type === "element" && node.tagName === "hr") continue;
          currentTab.content.push(node);
        }
      }

      if (tabs.length === 0) {
        i++;
        continue;
      }

      // Build tab buttons
      const tabButtons: Element[] = tabs.map((tab, idx) => ({
        type: "element" as const,
        tagName: "button",
        properties: {
          className: idx === 0 ? "tab-btn tab-btn-active" : "tab-btn",
          "data-tab-target": tab.id,
          type: "button",
        },
        children: [{ type: "text" as const, value: tab.label }],
      }));

      // Build tab panels
      const tabPanels: Element[] = tabs.map((tab, idx) => ({
        type: "element" as const,
        tagName: "div",
        properties: {
          className: idx === 0 ? "tab-panel tab-panel-active" : "tab-panel",
          "data-tab-panel": tab.id,
        },
        children: tab.content as Element[],
      }));

      const tabContainer: Element = {
        type: "element",
        tagName: "div",
        properties: { className: "tabs-container" },
        children: [
          {
            type: "element",
            tagName: "div",
            properties: { className: "tabs-bar" },
            children: tabButtons,
          },
          ...tabPanels,
        ],
      };

      // Replace range [i .. endIdx] with tabContainer
      children.splice(i, endIdx - i + 1, tabContainer);
    }

    i++;
  }
}

/** Custom rehype plugin to transform blockquotes into styled callouts */
function rehypeCallouts() {
  return (tree: HastRoot) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "blockquote") return;

      const firstP = node.children.find(
        (c): c is Element => (c as Element).tagName === "p"
      );
      if (!firstP) return;

      const firstStrong = firstP.children.find(
        (c): c is Element => (c as Element).tagName === "strong"
      );
      if (!firstStrong) return;

      let strongText = "";
      visit(firstStrong, "text", (t: { value: string }) => {
        strongText += t.value;
      });

      const calloutTypes: Record<string, { type: string; icon: string }> = {
        "Tip:": { type: "tip", icon: "💡" },
        "Warning:": { type: "warning", icon: "⚠️" },
        "Note:": { type: "note", icon: "ℹ️" },
        "Important:": { type: "warning", icon: "⚠️" },
      };

      const match = calloutTypes[strongText.trim()];
      if (!match) return;

      node.tagName = "div";
      node.properties = {
        ...node.properties,
        className: `callout callout-${match.type}`,
        "data-callout": match.type,
      };

      firstP.children = firstP.children.filter((c) => c !== firstStrong);
      if (firstP.children[0] && "value" in firstP.children[0]) {
        firstP.children[0].value = (
          firstP.children[0].value as string
        ).replace(/^\s+/, "");
      }

      node.children.unshift({
        type: "element",
        tagName: "span",
        properties: { className: "callout-icon" },
        children: [{ type: "text", value: match.icon }],
      });
    });
  };
}

/** Custom rehype plugin to transform <!-- cards --> / <!-- /cards --> into styled card grids */
function rehypeCardGrid() {
  return (tree: HastRoot) => {
    processCardGridInNode(tree);
  };
}

function processCardGridInNode(parent: Element | HastRoot) {
  const children = parent.children;
  if (!children) return;

  for (const child of children) {
    if ("children" in child && child.type === "element") {
      processCardGridInNode(child);
    }
  }

  let i = 0;
  while (i < children.length) {
    const child = children[i];

    if (
      child.type === "raw" &&
      (child as { value: string }).value.trim() === "<!-- cards -->"
    ) {
      let endIdx = -1;
      for (let j = i + 1; j < children.length; j++) {
        const c = children[j];
        if (
          c.type === "raw" &&
          (c as { value: string }).value.trim() === "<!-- /cards -->"
        ) {
          endIdx = j;
          break;
        }
      }

      if (endIdx === -1) {
        i++;
        continue;
      }

      const cardContent = children.slice(i + 1, endIdx);
      const cards: { title: string; desc: string; href: string }[] = [];
      let currentCard: { title: string; desc: string; href: string } | null = null;

      for (const node of cardContent) {
        if (
          node.type === "element" &&
          (node.tagName === "h3" || node.tagName === "h4")
        ) {
          if (currentCard) cards.push(currentCard);
          let text = "";
          visit(node, "text", (t: { value: string }) => {
            text += t.value;
          });
          currentCard = { title: text, desc: "", href: "#" };
        } else if (currentCard && node.type === "element" && node.tagName === "p") {
          // Check if paragraph contains only a link (href line)
          const linkChild = node.children.find(
            (c): c is Element => (c as Element).tagName === "a"
          ) as Element | undefined;
          if (linkChild && node.children.length === 1) {
            currentCard.href = (linkChild.properties?.href as string) || "#";
          } else {
            let text = "";
            visit(node, "text", (t: { value: string }) => {
              text += t.value;
            });
            if (text.trim()) currentCard.desc = text.trim();
          }
        }
      }
      if (currentCard) cards.push(currentCard);

      if (cards.length === 0) {
        i++;
        continue;
      }

      const cardElements: Element[] = cards.map((card) => ({
        type: "element" as const,
        tagName: "a",
        properties: { className: "card-grid-item", href: card.href },
        children: [
          {
            type: "element" as const,
            tagName: "div",
            properties: { className: "card-grid-title" },
            children: [{ type: "text" as const, value: card.title }],
          },
          {
            type: "element" as const,
            tagName: "div",
            properties: { className: "card-grid-desc" },
            children: [{ type: "text" as const, value: card.desc }],
          },
        ],
      }));

      const gridContainer: Element = {
        type: "element",
        tagName: "div",
        properties: { className: "card-grid" },
        children: cardElements,
      };

      children.splice(i, endIdx - i + 1, gridContainer);
    }

    i++;
  }
}

/** Cached unified processor — creating this per-call is very slow (shiki init) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedProcessor: any = null;

function getProcessor() {
  if (!cachedProcessor) {
    cachedProcessor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: true })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .use(rehypeDiagrams as any)
      .use(rehypeSlug)
      .use(rehypePrettyCode, {
        theme: {
          light: "github-light",
          dark: "github-dark-dimmed",
        },
        keepBackground: false,
        defaultLang: "plaintext",
      })
      .use(rehypeAutolinkHeadings, {
        behavior: "wrap",
        properties: { className: "heading-anchor" },
      })
      .use(rehypeCallouts)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .use(rehypeTabs as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .use(rehypeCardGrid as any)
      .use(rehypeStringify, { allowDangerousHtml: true });
  }
  return cachedProcessor;
}

export async function getDocPage(slug: string): Promise<DocPage | null> {
  const filePath = path.join(contentDir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const fileContent = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(fileContent);

  const file = await getProcessor().process(content);
  const htmlContent = String(file);

  const headingProcessor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug);

  const headingTree = headingProcessor.runSync(
    headingProcessor.parse(content)
  ) as HastRoot;
  const headings = extractHeadings(headingTree);

  const urlPath = getPathForSlug(slug);
  const copyContent = `---
title: ${data.title || slug}
url: https://metamcp.org${urlPath}
description: ${data.description || data.excerpt || ""}
---

${content}`;

  return {
    slug,
    title: data.title || slug,
    excerpt: data.excerpt || "",
    description: data.description || data.excerpt || "",
    content,
    htmlContent,
    headings,
    copyContent,
  };
}

/** Get all doc slugs from the flat docs directory */
export function getDocSlugs(): string[] {
  if (!fs.existsSync(contentDir)) return [];
  return fs
    .readdirSync(contentDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

/** Cached doc entries — avoids re-reading all markdown files on every navigation */
let cachedDocEntries: { slug: string; title: string; section: string; excerpt: string }[] | null = null;

/** Get basic info for all docs (used by search) */
export function getAllDocEntries(): {
  slug: string;
  title: string;
  section: string;
  excerpt: string;
}[] {
  if (cachedDocEntries) return cachedDocEntries;
  if (!fs.existsSync(contentDir)) return [];

  const files = fs.readdirSync(contentDir).filter((f) => f.endsWith(".md"));
  const entries: {
    slug: string;
    title: string;
    section: string;
    excerpt: string;
  }[] = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const filePath = path.join(contentDir, file);
    const fileContent = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(fileContent);

    entries.push({
      slug,
      title: data.title || slug,
      section: data.category || "Docs",
      excerpt: content.slice(0, 400).replace(/[#*`\[\]]/g, "").trim(),
    });
  }

  cachedDocEntries = entries;
  return entries;
}

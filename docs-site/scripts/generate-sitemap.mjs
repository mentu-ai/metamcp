#!/usr/bin/env node

/**
 * Build-time sitemap generator for metamcp.org
 * Reads navigation structure and generates public/sitemap.xml
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTENT_DIR = path.join(ROOT, "content", "docs");
const OUT_FILE = path.join(ROOT, "public", "sitemap.xml");
const SITE_URL = "https://metamcp.org";

// Mirror the navigation structure from docs-nav.ts
const navigation = [
  {
    prefix: "",
    stripPrefix: undefined,
    slugs: ["what-is-metamcp", "install", "quick-start", "configuration"],
    priority: 0.9,
  },
  {
    prefix: "concepts",
    stripPrefix: undefined,
    slugs: ["architecture", "the-four-tools", "connection-pool", "circuit-breaker", "sandbox", "discovery"],
    priority: 0.8,
  },
  {
    prefix: "guides",
    stripPrefix: undefined,
    slugs: ["adding-servers", "code-mode", "auto-provisioning", "claude-desktop", "claude-code"],
    priority: 0.8,
  },
  {
    prefix: "reference",
    stripPrefix: undefined,
    slugs: ["tool-reference", "cli-reference", "config-schema", "troubleshooting", "contributing"],
    priority: 0.7,
  },
];

function getUrlSlug(contentSlug, stripPrefix) {
  if (stripPrefix && contentSlug.startsWith(stripPrefix)) {
    return contentSlug.slice(stripPrefix.length);
  }
  return contentSlug;
}

function getLastmod(contentSlug) {
  const filePath = path.join(CONTENT_DIR, `${contentSlug}.md`);
  try {
    const stat = fs.statSync(filePath);
    return stat.mtime.toISOString().split("T")[0];
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}

function buildEntries() {
  const entries = [];

  // Homepage
  entries.push({
    url: SITE_URL,
    lastmod: new Date().toISOString().split("T")[0],
    changefreq: "weekly",
    priority: 1.0,
  });

  for (const group of navigation) {
    for (const slug of group.slugs) {
      const urlSlug = getUrlSlug(slug, group.stripPrefix);
      const urlPath = group.prefix
        ? `/${group.prefix}/${urlSlug}`
        : `/${urlSlug}`;

      entries.push({
        url: `${SITE_URL}${urlPath}`,
        lastmod: getLastmod(slug),
        changefreq: "weekly",
        priority: group.priority,
      });
    }
  }

  return entries;
}

function generateSitemap(entries) {
  const urls = entries
    .map(
      (e) => `  <url>
    <loc>${e.url}</loc>
    <lastmod>${e.lastmod}</lastmod>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

const entries = buildEntries();
const xml = generateSitemap(entries);
fs.writeFileSync(OUT_FILE, xml, "utf-8");
console.log(`Sitemap generated: ${entries.length} URLs → ${OUT_FILE}`);

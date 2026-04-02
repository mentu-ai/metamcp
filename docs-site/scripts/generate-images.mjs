#!/usr/bin/env node

/**
 * Generate MetaMCP branded images: favicon, apple-icon, OG image, Twitter image.
 * Uses sharp for PNG generation from SVG.
 *
 * Run: node scripts/generate-images.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Dynamically import sharp (devDependency)
let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error("sharp is required: npm install -D sharp");
  process.exit(1);
}

// ── SVG Templates ──

function iconSvg(size) {
  const rx = Math.round(size * 0.1875); // 6/32
  const fontSize = Math.round(size * 0.6875); // 22/32
  const textY = Math.round(size * 0.71875); // 23/32
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${rx}" fill="#2563eb"/>
  <text x="${size / 2}" y="${textY}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="${fontSize}" fill="white">M</text>
</svg>`;
}

function ogSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a1929"/>
      <stop offset="100%" stop-color="#172554"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#60a5fa"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <!-- Accent line -->
  <rect x="80" y="200" width="60" height="4" rx="2" fill="url(#accent)"/>
  <!-- Icon -->
  <rect x="80" y="80" width="64" height="64" rx="12" fill="#2563eb"/>
  <text x="112" y="125" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="44" fill="white">M</text>
  <!-- Title -->
  <text x="80" y="275" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="72" fill="white">MetaMCP</text>
  <!-- Subtitle -->
  <text x="80" y="340" font-family="system-ui, -apple-system, sans-serif" font-weight="400" font-size="32" fill="#94a3b8">OS for MCP servers. 4 tools, infinite capability.</text>
  <!-- URL -->
  <text x="80" y="560" font-family="system-ui, -apple-system, sans-serif" font-weight="400" font-size="22" fill="#64748b">metamcp.org</text>
  <!-- Stats badges -->
  <rect x="80" y="400" width="180" height="44" rx="8" fill="rgba(59,130,246,0.15)"/>
  <text x="170" y="428" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="18" fill="#60a5fa">4 Meta-Tools</text>
  <rect x="280" y="400" width="200" height="44" rx="8" fill="rgba(59,130,246,0.15)"/>
  <text x="380" y="428" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="18" fill="#60a5fa">Connection Pool</text>
  <rect x="500" y="400" width="180" height="44" rx="8" fill="rgba(59,130,246,0.15)"/>
  <text x="590" y="428" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-weight="600" font-size="18" fill="#60a5fa">V8 Sandbox</text>
</svg>`;
}

// ── Generate Files ──

async function generate() {
  // 1. Favicon (32x32 PNG, converted to ICO-like PNG)
  const favicon32 = await sharp(Buffer.from(iconSvg(32)))
    .png()
    .toBuffer();

  // For favicon.ico, we use a 32x32 PNG wrapped as ICO
  // Modern browsers accept PNG favicons, so we write a 32x32 PNG
  const favicon16 = await sharp(Buffer.from(iconSvg(16)))
    .png()
    .toBuffer();

  // Write ICO file (simple: just the 32x32 PNG as favicon)
  // Most modern browsers handle PNG favicons fine
  fs.writeFileSync(path.join(ROOT, "app", "favicon.ico"), favicon32);
  console.log("  favicon.ico (32x32)");

  // 2. Apple icon (180x180)
  const appleIcon = await sharp(Buffer.from(iconSvg(180)))
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(ROOT, "app", "apple-icon.png"), appleIcon);
  console.log("  apple-icon.png (180x180)");

  // 3. OG image (1200x630)
  const ogImage = await sharp(Buffer.from(ogSvg()))
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(ROOT, "app", "opengraph-image.png"), ogImage);
  console.log("  opengraph-image.png (1200x630)");

  // 4. Twitter image (same as OG)
  fs.writeFileSync(path.join(ROOT, "app", "twitter-image.png"), ogImage);
  console.log("  twitter-image.png (1200x630)");

  console.log("\nAll images generated.");
}

console.log("Generating MetaMCP branded images...\n");
generate().catch((err) => {
  console.error(err);
  process.exit(1);
});

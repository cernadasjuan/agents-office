#!/usr/bin/env node
// Renders scripts/launcher/icon.svg to every PNG size macOS's .iconset format wants, then packs
// it into scripts/launcher/AgentsOffice.icns with `iconutil` (ships with macOS, no new runtime
// dependency). This is a maintenance tool, run by hand whenever icon.svg changes — the launcher
// build (scripts/build-launcher-app.sh) only ever copies the committed .icns into the app
// bundle, so installing the launcher never needs Chromium or this script.
//
// Usage: node scripts/launcher/generate-icon.mjs
//
// Needs the `playwright` dev dependency installed (`npx playwright install chromium`, see
// README.md) — the same one-time step `pnpm smoke` already documents.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SVG_PATH = path.join(HERE, 'icon.svg');
const ICNS_PATH = path.join(HERE, 'AgentsOffice.icns');

// Base size, @2x size, or both: iconutil wants every one of these present.
const SIZES = [
  { file: 'icon_16x16.png', px: 16 },
  { file: 'icon_16x16@2x.png', px: 32 },
  { file: 'icon_32x32.png', px: 32 },
  { file: 'icon_32x32@2x.png', px: 64 },
  { file: 'icon_128x128.png', px: 128 },
  { file: 'icon_128x128@2x.png', px: 256 },
  { file: 'icon_256x256.png', px: 256 },
  { file: 'icon_256x256@2x.png', px: 512 },
  { file: 'icon_512x512.png', px: 512 },
  { file: 'icon_512x512@2x.png', px: 1024 },
];

const svg = fs.readFileSync(SVG_PATH, 'utf8');
const html = `<!doctype html><html><head><style>
  * { margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; background: transparent; }
  svg { display: block; width: 100%; height: 100%; }
</style></head><body>${svg}</body></html>`;

const iconsetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-iconset-')) + '/AgentsOffice.iconset';
fs.mkdirSync(iconsetDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(html, { waitUntil: 'load' });
  for (const { file, px } of SIZES) {
    await page.setViewportSize({ width: px, height: px });
    await page.screenshot({ path: path.join(iconsetDir, file), omitBackground: true });
  }
} finally {
  await browser.close();
}

execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', ICNS_PATH], { stdio: 'inherit' });
fs.rmSync(path.dirname(iconsetDir), { recursive: true, force: true });
console.log(`Wrote ${ICNS_PATH}`);

#!/usr/bin/env node
// Headless WebGL smoke test for the office (issue #89, AC2/AC3). Opt-in only: lives outside
// tests/*.test.ts, so `pnpm test` never runs it; run it by hand with `pnpm smoke`. One short
// browser run, no parallel matrix: a laptop shutdown on 2026-11-19 came from a heavier check.
//
// Starts the dev server against a fixture agent list, never real ~/.claude data, with
// BROWSER=none (vite's own server.open would otherwise open a real window), opens it in one
// headless Chromium page, and fails on any page error or a console error. Never touches port
// 5173: that is Gabriel's own office, if one is running.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const PORT = 5190; // never 5173: that port is Gabriel's own running office.
const LOCK_DIR = '/tmp/agents-office-browser.lock';
const OWNER = `smoke-test-${process.pid}`;
const SERVER_READY_TIMEOUT_MS = 20000;
const BROWSER_NAV_TIMEOUT_MS = 15000;

function log(line) {
  console.log(`[smoke] ${line}`);
}

/** The one-agent-at-a-time browser lock from the agents-office fork brief, in Node: an
 * mkdir that fails if the lock is already held, a trap-equivalent release in `finally`, and
 * only the owner of the lock ever removes it. */
async function withBrowserLock(fn) {
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw new Error('timed out waiting for the browser lock');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  fs.writeFileSync(path.join(LOCK_DIR, 'owner'), OWNER);
  try {
    return await fn();
  } finally {
    try {
      if (fs.readFileSync(path.join(LOCK_DIR, 'owner'), 'utf8') === OWNER) {
        fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      }
    } catch {
      // Already gone; nothing to release.
    }
  }
}

/** A fixture agent list under a fresh HOME, the same session-file shape
 * `server/agentDetector.ts` and `tests/agent-detection.test.ts` already use. The session's
 * `pid` is this very script's pid, so the detector's liveness check needs no real agent
 * process running anywhere. */
function writeFixtureAgents(home) {
  const cwd = path.join(home, 'fixture-project');
  const sessions = path.join(home, '.claude', 'sessions');
  const projectDir = path.join(home, '.claude', 'projects', cwd.split(path.sep).join('-'));
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const sessionId = 'smoke-session-1';
  fs.writeFileSync(
    path.join(sessions, `${sessionId}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd,
      startedAt: Date.now(),
      name: 'Smoke Fixture',
      nameSource: 'auto',
      status: 'idle',
    }),
  );
  const line = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'idle' }] } });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${line}\n`);
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (typeof response.status === 'number') return;
    } catch {
      // Not up yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} did not come up within ${timeoutMs}ms`);
}

/** Opens one headless page, lets the office load and poll once, and collects every page
 * error and console error. `?layout=building#view=overview&zoom=20&room=office` also
 * exercises the issue #89 view hooks on the same run, at no extra browser cost: the building
 * layout is the one that actually has a room named "office" for `#room=` to frame. */
async function runBrowserCheck(port) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
    });
    await page.goto(`http://127.0.0.1:${port}/?layout=building#view=overview&zoom=20&room=office`, { waitUntil: 'load', timeout: BROWSER_NAV_TIMEOUT_MS });
    await page.waitForSelector('#ui-panel', { timeout: 10000 });
    await page.waitForTimeout(1000); // the first agent poll and the first render settle here
    return errors;
  } finally {
    await browser.close();
  }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-smoke-'));
  writeFixtureAgents(home);

  const vitePath = path.join(repoRoot, 'node_modules', '.bin', 'vite');
  if (!fs.existsSync(vitePath)) throw new Error(`vite not found at ${vitePath}; run pnpm install first`);

  const server = spawn(vitePath, ['--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`, SERVER_READY_TIMEOUT_MS);
    log(`server up on port ${PORT}, fixture HOME ${home}`);

    const errors = await withBrowserLock(() => runBrowserCheck(PORT));
    if (errors.length > 0) {
      log(`${errors.length} page error(s):`);
      for (const error of errors) log(`  ${error}`);
      process.exitCode = 1;
      return;
    }
    log('no page errors; the office opened clean.');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(home, { recursive: true, force: true });
    if (process.exitCode) {
      log('server output follows:');
      log(serverOutput);
    }
  }
}

main().catch((error) => {
  console.error('[smoke] failed:', error);
  process.exitCode = 1;
});

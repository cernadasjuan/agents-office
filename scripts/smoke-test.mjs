#!/usr/bin/env node
// Headless WebGL smoke test for the office (issue #89, AC2/AC3). Opt-in only: lives outside
// tests/*.test.ts, so `pnpm test` never runs it; run it by hand with `pnpm smoke`. One short
// browser run, no parallel matrix: a laptop shutdown on 2026-11-19 came from a heavier check.
//
// Starts the dev server against a fixture agent list, never real ~/.claude or ~/.codex data,
// with BROWSER=none (vite's own server.open would otherwise open a real window) and a
// minimal, allow-listed environment, on an OS-assigned free port (never a fixed one, never
// 5173: that is Gabriel's own office, if one is running). Opens it in one headless Chromium
// page, and fails on any page error or a console error.
//
// Review (#157): this used to poll a fixed port's root page and assume whatever answered was
// its own spawned server. A real office already on that port would have made the just-spawned
// child exit at once (--strictPort) while the test kept polling and happily passed against the
// real server, with real data, never having exercised the fixture at all. It now asks the OS
// for a free port, keeps checking the child process is still alive, and only accepts an
// answer from /api/agents that carries the fixture's own marker agent.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const LOCK_DIR = '/tmp/agents-office-browser.lock';
const OWNER = `smoke-test-${process.pid}`;
const SERVER_READY_TIMEOUT_MS = 20000;
const BROWSER_NAV_TIMEOUT_MS = 15000;
const FIXTURE_AGENT_NAME = 'Smoke Fixture';
/** Env vars the spawned server actually needs; everything else is left out on purpose
 * (review #157, fix 5), so a variable set on the caller's machine (a stray `CODEX_HOME`,
 * for example) can never leak into what is meant to be an isolated fixture run. */
const ALLOWED_ENV_KEYS = ['PATH', 'NODE_OPTIONS', 'TMPDIR', 'LANG', 'LC_ALL'];

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
 * process running anywhere. The display name, `FIXTURE_AGENT_NAME`, is the marker the
 * readiness check below looks for in `/api/agents`: it is never hashed by the server
 * projection, unlike the id, so it survives to the client as plain text. */
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
      name: FIXTURE_AGENT_NAME,
      nameSource: 'auto',
      status: 'idle',
    }),
  );
  const line = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'idle' }] } });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${line}\n`);
}

/** Reads the port vite bound from its own "Local: http://127.0.0.1:<port>/" stdout line.
 * `--port 0` asks the OS for a free one, so there is never a fixed port to collide with. */
function waitForBoundPort(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`vite did not print its bound port within ${timeoutMs}ms`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/https?:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        server.stdout.off('data', onData);
        resolve(Number(match[1]));
      }
    };
    server.stdout.on('data', onData);
    server.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`vite exited before printing a bound port (code ${code}, signal ${signal})`));
    });
  });
}

/**
 * Polls `/api/agents` until it sees the fixture's own marker agent, confirmed live (review
 * #157, fix 3): this is never satisfied by any other server, real or otherwise, since only
 * this run's own fixture HOME ever reports an agent named `FIXTURE_AGENT_NAME`. Also fails
 * fast the moment the spawned child itself exits, rather than continuing to poll a port some
 * other process might now be answering on instead.
 */
async function waitForFixtureServer(port, server, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`the spawned server exited early (code ${server.exitCode}, signal ${server.signalCode}) before answering with the fixture marker`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agents`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const agents = await response.json();
        if (Array.isArray(agents) && agents.some((agent) => agent?.name === FIXTURE_AGENT_NAME)) return;
      }
    } catch {
      // Not up yet, or not yet serving the fixture; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no server on port ${port} answered /api/agents with the fixture marker within ${timeoutMs}ms`);
}

/** The one Chromium install command this playwright version actually needs for
 * `chromium.launch()` (verified directly: `chromium.executablePath()` resolves under the
 * `chromium-*` cache folder, not `chromium_headless_shell-*`, even in headless mode). */
const INSTALL_COMMAND = 'npx playwright install chromium';

function ensureChromiumInstalled() {
  const executablePath = chromium.executablePath();
  if (fs.existsSync(executablePath)) return;
  throw new Error(`Chromium is not installed for playwright (looked for ${executablePath}). Run: ${INSTALL_COMMAND}`);
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
  ensureChromiumInstalled();

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-smoke-'));
  writeFixtureAgents(home);

  const vitePath = path.join(repoRoot, 'node_modules', '.bin', 'vite');
  if (!fs.existsSync(vitePath)) throw new Error(`vite not found at ${vitePath}; run pnpm install first`);

  const env = Object.fromEntries(ALLOWED_ENV_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  env.HOME = home;
  // Never the caller's own Codex sessions: a stray real CODEX_HOME must not leak into what
  // is meant to be an isolated fixture run (review #157). This path need not exist; the
  // Codex source already treats a missing home as "no Codex sessions" and reports nothing.
  env.CODEX_HOME = path.join(home, '.codex');
  env.BROWSER = 'none';

  const server = spawn(vitePath, ['--port', '0', '--strictPort'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

  try {
    const port = await waitForBoundPort(server, SERVER_READY_TIMEOUT_MS);
    await waitForFixtureServer(port, server, SERVER_READY_TIMEOUT_MS);
    log(`fixture server confirmed live on port ${port}, HOME ${home}`);

    const errors = await withBrowserLock(() => runBrowserCheck(port));
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, beforeEach, mock, test } from 'node:test';
import { createServer } from 'vite';
import type { DetectedAgent } from '../server/agentDetector.js';
import { agentDetectorPlugin } from '../server/vitePlugin.js';
import { codexSource, RECENT_WINDOW_MS } from '../server/codexSource.js';
import { projectAgents } from '../server/seam.js';

// Redirect discovery to a synthetic home. The real ~/.codex is never read.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-codex-test-'));
const codexHome = path.join(fixture, '.codex');
const dayDir = path.join(codexHome, 'sessions', '2026', '11', '18');
const homeMock = mock.method(os, 'homedir', () => fixture);
const savedCodexHome = process.env.CODEX_HOME;
delete process.env.CODEX_HOME;

after(() => {
  homeMock.mock.restore();
  if (savedCodexHome !== undefined) process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(fixture, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(codexHome, { recursive: true, force: true });
});

const PROJECT_CWD = '/private/work/billing-service';

function meta(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { timestamp: '2026-11-18T10:00:00Z', ordinal: 0, type: 'session_meta',
    payload: { id, session_id: id, cwd: PROJECT_CWD, cli_version: '0.169.0', source: 'exec', ...extra } };
}

function functionCall(name: string, args: Record<string, unknown>, namespace?: string): Record<string, unknown> {
  return { type: 'response_item', payload: { type: 'function_call', name, ...(namespace ? { namespace } : {}),
    arguments: JSON.stringify(args), call_id: 'call-1' } };
}

function commandDone(command: string[]): Record<string, unknown> {
  return { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command } } };
}

function assistantText(): Record<string, unknown> {
  return { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } };
}

function writeRollout(name: string, records: Array<Record<string, unknown> | string>, ageMs = 0, dir = dayDir): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-18T10-00-00-${name}.jsonl`);
  const text = records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n');
  fs.writeFileSync(file, `${text}\n`);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
}

test('no Codex home: the source returns nothing', async () => {
  assert.deepEqual(await codexSource().scan(), []);
});

test('a recent rollout becomes one codex agent named after its project folder', async () => {
  writeRollout('thread-a', [meta('thread-a'), functionCall('shell', { command: ['bash', '-lc', 'pnpm test'] })]);

  const [agent, ...rest] = await codexSource().scan();

  assert.equal(rest.length, 0);
  assert.equal(agent.provider, 'codex');
  assert.equal(agent.name, 'billing-service');
  assert.equal(agent.activity, 'testing');
  assert.equal(agent.id, 'codex:thread-a');
});

test('activity follows the newest Codex item', async () => {
  const cases: Array<[string, Array<Record<string, unknown>>, string]> = [
    ['completed shell command', [commandDone(['/bin/zsh', '-lc', 'git push origin main'])], 'deploying'],
    ['read-only shell command', [commandDone(['/bin/zsh', '-lc', 'rg foo src | head'])], 'researching'],
    ['assistant text after a tool call', [functionCall('shell', { command: ['ls'] }), assistantText()], 'idle'],
    ['turn complete', [functionCall('shell', { command: ['ls'] }), { type: 'event_msg', payload: { type: 'task_complete' } }], 'idle'],
    ['turn aborted', [{ type: 'event_msg', payload: { type: 'turn_aborted' } }], 'idle'],
    ['turn started', [{ type: 'event_msg', payload: { type: 'task_started' } }], 'planning'],
    ['user input request', [functionCall('request_user_input', { questions: [] })], 'meeting'],
    ['plan update', [functionCall('update_plan', { plan: [] })], 'planning'],
    ['file change', [{ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: {} } } }], 'implementing'],
    ['read-only MCP call', [{ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', readOnlyHint: true } } }], 'researching'],
    ['web search', [{ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'web.search' } } }], 'researching'],
    ['wrapped exec script is not evaluated', [{ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'pnpm test' } }], 'implementing'],
    ['token counts are skipped', [functionCall('shell', { command: ['pytest'] }), { type: 'event_msg', payload: { type: 'token_count' } }], 'testing'],
  ];
  for (const [label, records, expected] of cases) {
    fs.rmSync(codexHome, { recursive: true, force: true });
    writeRollout('thread-a', [meta('thread-a'), ...records]);
    const [agent] = await codexSource().scan();
    assert.equal(agent?.activity, expected, label);
  }
});

test('a stale rollout is not shown', async () => {
  writeRollout('thread-old', [meta('thread-old'), functionCall('shell', { command: ['ls'] })], RECENT_WINDOW_MS + 60_000);

  assert.deepEqual(await codexSource().scan(), []);
});

test('malformed and unknown lines are ignored', async () => {
  writeRollout('thread-a', [
    meta('thread-a'),
    functionCall('shell', { command: ['bash', '-lc', 'git diff'] }),
    '{not json',
    '[1, 2, 3]',
    JSON.stringify({ type: 'response_item', payload: 'text' }),
    JSON.stringify({ type: 'brand_new_record', payload: { type: 'mystery' } }),
  ]);

  const agents = await codexSource().scan();

  assert.equal(agents.length, 1);
  assert.equal(agents[0].activity, 'reviewing');
});

test('a rollout without a valid session header is skipped', async () => {
  writeRollout('no-header', [functionCall('shell', { command: ['ls'] })]);
  writeRollout('bad-header', ['{broken', functionCall('shell', { command: ['ls'] })]);

  assert.deepEqual(await codexSource().scan(), []);
});

test('a session without a cwd is named codex', async () => {
  writeRollout('thread-a', [{ type: 'session_meta', payload: { id: 'thread-a' } }, assistantText()]);

  const [agent] = await codexSource().scan();

  assert.equal(agent.name, 'codex');
});

test('a spawned child keeps its own identity, links to a recent parent, and ignores inherited parent records', async () => {
  writeRollout('parent', [meta('parent'), functionCall('shell', { command: ['ls'] })]);
  writeRollout('child', [
    meta('child', { parent_thread_id: 'parent', subagent_history_start_ordinal: 3 }),
    { ...meta('parent'), ordinal: 1 },
    { ...functionCall('shell', { command: ['bash', '-lc', 'git push'] }), ordinal: 2 },
  ]);

  const byId = new Map((await codexSource().scan()).map((agent) => [agent.id, agent]));

  assert.equal(byId.size, 2);
  assert.equal(byId.get('codex:child')?.parentId, 'codex:parent');
  assert.notEqual(byId.get('codex:child')?.activity, 'deploying');
  assert.equal(byId.get('codex:parent')?.parentId, undefined);
});

test('a child whose parent is not recent has no parent link', async () => {
  writeRollout('child', [meta('child', { source: { subagent: { thread_spawn: { parent_thread_id: 'gone' } } } }), assistantText()]);

  const [agent] = await codexSource().scan();

  assert.equal(agent.parentId, undefined);
});

test('a symlinked rollout outside the sessions folder is not read', async () => {
  const outside = path.join(fixture, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const target = writeRollout('escaped', [meta('escaped'), assistantText()], 0, outside);
  fs.mkdirSync(dayDir, { recursive: true });
  fs.symlinkSync(target, path.join(dayDir, 'rollout-2026-11-18T10-00-00-link.jsonl'));
  fs.symlinkSync(outside, path.join(codexHome, 'sessions', '2026', 'linked-dir'));

  assert.deepEqual(await codexSource().scan(), []);
});

test('the projection marks codex agents and leaks no paths or raw thread IDs', async () => {
  const file = writeRollout('thread-secret', [meta('thread-secret'), functionCall('shell', { command: ['bash', '-lc', 'pnpm test'] })]);

  const projected = projectAgents(await codexSource().scan(), (raw) => `public-${raw.length}`);
  const body = JSON.stringify(projected);

  assert.equal(projected[0].provider, 'codex');
  assert.equal(projected[0].name, 'billing-service');
  for (const secret of [PROJECT_CWD, file, fixture, 'thread-secret', 'pnpm test']) {
    assert.equal(body.includes(secret), false, secret);
  }
});

const claudeRecord: DetectedAgent = { id: 'claude-session', name: 'claude-agent', pid: 1, cwd: '/private', startedAt: 1, alive: true, activity: 'researching' };

async function fetchAgents(home: string): Promise<Array<Record<string, unknown>>> {
  const root = fs.mkdtempSync(path.join(fixture, 'vite-'));
  const server = await createServer({ root, configFile: false, envFile: false,
    plugins: [agentDetectorPlugin({ detect: () => [claudeRecord], codexHome: home })],
    server: { host: '127.0.0.1', port: 0, open: false, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' });
  try {
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: '/api/agents' }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    return JSON.parse(body);
  } finally {
    await server.close();
  }
}

test('the API shows Claude and Codex agents side by side, and Claude alone without a Codex home', async () => {
  writeRollout('thread-a', [meta('thread-a'), functionCall('shell', { command: ['bash', '-lc', 'pnpm test'] })]);

  const mixed = await fetchAgents(codexHome);
  assert.deepEqual(mixed.map((agent) => [agent.name, agent.activity, agent.provider]),
    [['claude-agent', 'researching', undefined], ['billing-service', 'testing', 'codex']]);

  const claudeOnly = await fetchAgents(path.join(fixture, 'no-codex-here'));
  assert.deepEqual(claudeOnly.map((agent) => agent.name), ['claude-agent']);
});

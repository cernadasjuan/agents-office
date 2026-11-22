import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, type ViteDevServer } from 'vite';
import { agentDetectorPlugin } from '../server/vitePlugin.js';
import type { DetectedAgent } from '../server/agentDetector.js';
import type { OfficePlugin } from '../server/seam.js';
import { createPeekPlugin } from '../plugins/peek/index.js';
import { PeekReader } from '../plugins/peek/transcript.js';

// Synthetic transcripts in a temp folder. No test reads the user's ~/.claude.
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-peek-endpoint-'));
const FAKE_GHP = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const say = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const useTool = (name: string, input: Record<string, unknown>) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] } });
const alphaFile = path.join(fixtures, 'alpha.jsonl');
const betaFile = path.join(fixtures, 'beta.jsonl');
fs.writeFileSync(alphaFile, `${say(`alpha says hello with ${FAKE_GHP}`)}\n`);
fs.writeFileSync(betaFile, `${say('beta private line')}\n`);

const records: DetectedAgent[] = [
  { id: 'raw-alpha', name: 'alpha', pid: 1, cwd: fixtures, startedAt: 1, alive: true, activity: 'implementing', transcriptPath: alphaFile },
  { id: 'raw-beta', name: 'beta', pid: 2, cwd: fixtures, startedAt: 1, alive: true, activity: 'implementing', transcriptPath: betaFile },
];

const resources: Array<{ server: ViteDevServer; root: string }> = [];
after(async () => {
  for (const { server, root } of resources) {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
  fs.rmSync(fixtures, { recursive: true, force: true });
});

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

async function office(plugins: OfficePlugin[], detected: DetectedAgent[] = records) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agents-office-peek-server-'));
  const server = await createServer({
    root, configFile: false, envFile: false,
    plugins: [agentDetectorPlugin({ detect: () => detected, codexHome: null, plugins })],
    server: { host: '127.0.0.1', port: 0, open: false, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'silent',
  });
  resources.push({ server, root });
  await server.listen();
  const port = (server.httpServer!.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const request = (urlPath: string, method = 'GET', headers: Record<string, string> = { Origin: origin }): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  const agents = async () => {
    const reply = await request('/api/agents');
    return { body: reply.body, list: JSON.parse(reply.body) as Array<{ id: string; name: string }> };
  };
  return { request, origin, agents };
}

const peekPlugin = () => createPeekPlugin(new PeekReader());

test('with the plugin on, the peek view answers for the one agent asked, masked and capped', async () => {
  const { request, agents } = await office([peekPlugin()]);
  const { list } = await agents();
  const alpha = list.find((agent) => agent.name === 'alpha')!;
  const reply = await request(`/api/views/peek?agent=${alpha.id}`);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['cache-control'], 'no-store');
  const peek = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(peek).sort(), ['assets', 'lines', 'repos', 'skills']);
  assert.equal(peek.lines.length, 1);
  assert.match(peek.lines[0].text, /^alpha says hello with \[secret\]$/);
  for (const hidden of [FAKE_GHP, 'beta private line', fixtures, 'raw-alpha']) assert.equal(reply.body.includes(hidden), false, hidden);
});

test('no transcript text in /api/agents or /api/world, with the plugin on or off', async () => {
  for (const plugins of [[peekPlugin()], []]) {
    const { request, agents } = await office(plugins);
    const { body } = await agents();
    const world = (await request('/api/world')).body;
    for (const text of ['alpha says', 'beta private', 'hello', FAKE_GHP.slice(0, 8)]) {
      assert.equal(body.includes(text), false, `agents: ${text}`);
      assert.equal(world.includes(text), false, `world: ${text}`);
    }
  }
});

test('the peek view passes the same local checks: another origin 403, POST 405', async () => {
  const { request, agents } = await office([peekPlugin()]);
  const { list } = await agents();
  const url = `/api/views/peek?agent=${list[0].id}`;
  for (const Origin of ['https://evil.example', 'http://localhost:1', 'null']) {
    assert.equal((await request(url, 'GET', { Origin })).status, 403, Origin);
  }
  assert.equal((await request(url, 'POST')).status, 405);
  assert.equal((await request(url, 'GET', { Origin: 'http://127.0.0.1:1', Host: 'evil.example' })).status, 403);
});

test('an unknown or malformed agent id gets 404 or 400, and an unknown view 404', async () => {
  const { request, agents } = await office([peekPlugin()]);
  await agents();
  assert.equal((await request(`/api/views/peek?agent=${'a'.repeat(64)}`)).status, 404);
  assert.equal((await request('/api/views/peek?agent=raw-alpha')).status, 400);
  assert.equal((await request('/api/views/peek')).status, 400);
  assert.equal((await request(`/api/views/other?agent=${'a'.repeat(64)}`)).status, 404);
});

test('without the plugin, the peek view answers 404 and reads nothing', async () => {
  const { request, agents } = await office([]);
  const { list } = await agents();
  const reply = await request(`/api/views/peek?agent=${list[0].id}`);
  assert.equal(reply.status, 404);
  assert.equal(reply.body.includes('alpha'), false);
});

test('a failing view gives 500 without details', async () => {
  const broken: OfficePlugin = { name: 'peek', views: [{ name: 'peek', read: () => { throw new Error(`boom ${fixtures}`); } }] };
  const { request, agents } = await office([broken]);
  const { list } = await agents();
  const reply = await request(`/api/views/peek?agent=${list[0].id}`);
  assert.equal(reply.status, 500);
  assert.equal(reply.body.includes(fixtures), false);
});

test('?lines=100 answers up to the tail (issue #81 AC5), masked and capped the same as the default', async () => {
  const manyFile = path.join(fixtures, 'many.jsonl');
  fs.writeFileSync(manyFile, Array.from({ length: 50 }, (_, i) => say(`line ${i}`)).join('\n') + '\n');
  const withMany: DetectedAgent[] = [...records, { id: 'raw-many', name: 'many', pid: 3, cwd: fixtures, startedAt: 1, alive: true, activity: 'implementing', transcriptPath: manyFile }];
  const { request, agents } = await office([peekPlugin()], withMany);
  const { list } = await agents();
  const target = list.find((agent) => agent.name === 'many')!;
  const short = JSON.parse((await request(`/api/views/peek?agent=${target.id}`)).body);
  assert.equal(short.lines.length, 10);
  const tail = JSON.parse((await request(`/api/views/peek?agent=${target.id}&lines=100`)).body);
  assert.equal(tail.lines.length, 50);
  assert.equal(tail.lines[0].text, 'line 0');
  // Out of range (negative, far past the tail cap, or not a number): the normal default, not an error.
  for (const bad of ['-5', '99999', 'abc']) {
    const reply = JSON.parse((await request(`/api/views/peek?agent=${target.id}&lines=${bad}`)).body);
    assert.equal(reply.lines.length, 10, bad);
  }
});

test('/api/bubbles answers a short, masked event for every agent with something new, keyed by public id', async () => {
  const { request, agents } = await office([peekPlugin()]);
  const { list } = await agents();
  const alpha = list.find((agent) => agent.name === 'alpha')!;
  const beta = list.find((agent) => agent.name === 'beta')!;
  const reply = await request('/api/bubbles');
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['cache-control'], 'no-store');
  const bubbles = JSON.parse(reply.body) as Record<string, { kind: string; text: string }>;
  assert.deepEqual(bubbles[alpha.id], { kind: 'text', text: 'alpha says hello with [secret]' });
  assert.deepEqual(bubbles[beta.id], { kind: 'text', text: 'beta private line' });
  for (const hidden of [FAKE_GHP, fixtures, 'raw-alpha']) assert.equal(reply.body.includes(hidden), false, hidden);
  // Nothing new since the first ask: the second answer is empty (issue #81 AC1: "the next poll
  // sees it", not every poll resending the same line).
  assert.deepEqual(JSON.parse((await request('/api/bubbles')).body), {});
});

test('/api/bubbles passes the same local checks, and without a bubble source answers 404 (AC6)', async () => {
  const { request } = await office([peekPlugin()]);
  for (const Origin of ['https://evil.example', 'http://localhost:1']) {
    assert.equal((await request('/api/bubbles', 'GET', { Origin })).status, 403, Origin);
  }
  assert.equal((await request('/api/bubbles', 'POST')).status, 405);

  const { request: withoutPlugin } = await office([]);
  assert.equal((await withoutPlugin('/api/bubbles')).status, 404);
});

test('/api/bubbles: one agent failing drops only that agent, never the whole answer', async () => {
  const broken: OfficePlugin = {
    name: 'peek',
    bubbles: { read: (observation) => { if (observation.name === 'alpha') throw new Error('boom'); return { kind: 'text', text: 'beta still answers' }; } },
  };
  const { request, agents } = await office([broken]);
  const { list } = await agents();
  const beta = list.find((agent) => agent.name === 'beta')!;
  const reply = JSON.parse((await request('/api/bubbles')).body);
  assert.deepEqual(reply[beta.id], { kind: 'text', text: 'beta still answers' });
  assert.equal(Object.keys(reply).length, 1);
});

// --- Review items 1 and 2, through the real /api/bubbles endpoint: last words, not first;
// a tool-call bubble carries nothing from its own input. ---

test('/api/bubbles: a tool call never carries input-derived detail — a hostile fixture per tool', async () => {
  const hostile = path.join(fixtures, 'hostile.jsonl');
  fs.writeFileSync(hostile, [
    useTool('Read', { file_path: '/private/clients/customer-plan.md' }),
  ].join('\n') + '\n');
  const withHostile: DetectedAgent[] = [{ id: 'raw-hostile', name: 'hostile', pid: 3, cwd: fixtures, startedAt: 1, alive: true, activity: 'implementing', transcriptPath: hostile }];
  const { request, agents } = await office([peekPlugin()], withHostile);
  const { list } = await agents();
  const id = list[0].id;
  assert.deepEqual(JSON.parse((await request('/api/bubbles')).body)[id], { kind: 'tool', text: 'Reading a file' });

  fs.appendFileSync(hostile, useTool('Bash', { command: 'git commit -m "secret plan, do not tell anyone"' }) + '\n');
  assert.deepEqual(JSON.parse((await request('/api/bubbles')).body)[id], { kind: 'tool', text: 'Running a command' });

  fs.appendFileSync(hostile, useTool('Bash', { command: `curl -H "Authorization: Bearer ${FAKE_GHP}" https://internal.example/x` }) + '\n');
  const bashReply = await request('/api/bubbles');
  assert.deepEqual(JSON.parse(bashReply.body)[id], { kind: 'tool', text: 'Running a command' });
  assert.equal(bashReply.body.includes(FAKE_GHP), false);
  assert.equal(bashReply.body.includes('internal.example'), false);

  fs.appendFileSync(hostile, useTool('WebFetch', { url: 'https://docs.example.com/private/customer-plan?token=abc123' }) + '\n');
  const webReply = await request('/api/bubbles');
  assert.deepEqual(JSON.parse(webReply.body)[id], { kind: 'tool', text: 'Fetching a page' });
  assert.equal(webReply.body.includes('docs.example.com'), false);
  assert.equal(webReply.body.includes('customer-plan'), false);
});

test('/api/bubbles: a text bubble keeps the last words, not the first, within the 40-character cap', async () => {
  const longFile = path.join(fixtures, 'long.jsonl');
  fs.writeFileSync(longFile, `${say('the opening sentence rambles on for quite a while before THE ACTUAL LAST WORDS appear right here')}\n`);
  const withLong: DetectedAgent[] = [{ id: 'raw-long', name: 'long', pid: 4, cwd: fixtures, startedAt: 1, alive: true, activity: 'implementing', transcriptPath: longFile }];
  const { request, agents } = await office([peekPlugin()], withLong);
  const { list } = await agents();
  const reply = JSON.parse((await request('/api/bubbles')).body)[list[0].id];
  assert.ok(reply.text.length <= 40, reply.text);
  assert.ok(reply.text.endsWith('ACTUAL LAST WORDS appear right here'), reply.text);
  assert.equal(reply.text.includes('opening sentence'), false, reply.text);
});

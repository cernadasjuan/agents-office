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

async function office(plugins: OfficePlugin[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agents-office-peek-server-'));
  const server = await createServer({
    root, configFile: false, envFile: false,
    plugins: [agentDetectorPlugin({ detect: () => records, codexHome: null, plugins })],
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

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, type ViteDevServer } from 'vite';
import { observe, projectAgents, projectWorld, type Observation, type OfficePlugin } from '../server/seam.js';
import { parsePluginNames, pluginEntry } from '../server/plugins.js';
import { agentDetectorPlugin } from '../server/vitePlugin.js';
import type { DetectedAgent } from '../server/agentDetector.js';

const publicId = (raw: string) => `h(${raw})`;

function observation(overrides: Partial<Observation> = {}): Observation {
  return { id: 'raw-session', provider: 'claude', name: 'agent', activity: 'researching',
    internal: { pid: 4242, cwd: '/private/project', sessionId: 'raw-session' }, display: {}, ...overrides };
}

test('the agent projection copies only whitelisted, cleaned fields', () => {
  const [agent] = projectAgents([observation({
    name: `evil\u0007${'x'.repeat(100)}`,
    activity: 'hacking',
    provider: 'codex',
    display: { attention: 'panic' as never, waitMinutes: -3, groupKey: 'workspace-7', groupLabel: 'Team\nA',
      badges: ['sally', 'BAD BADGE', '../x'], issues: [{ number: 31, title: 'Seam' }, { number: -1, title: 'bad' }],
      roomKey: 'mission-1' },
  })], publicId);

  assert.equal(agent.name.length, 60);
  assert.ok(!agent.name.includes('\u0007'));
  assert.equal(agent.activity, 'implementing');
  assert.equal(agent.provider, 'codex');
  assert.equal('attention' in agent, false);
  assert.equal('waitMinutes' in agent, false);
  assert.deepEqual(agent.group, { id: 'h(group:workspace-7)', label: 'Team A' });
  assert.deepEqual(agent.badges, ['sally']);
  assert.deepEqual(agent.issues, [{ number: 31, title: 'Seam' }]);
  assert.equal(agent.room, 'h(room:mission-1)');
  assert.equal(JSON.stringify(agent).includes('/private/project'), false);
  assert.equal(JSON.stringify(agent).includes('4242'), false);
});

test('an issue card keeps only a cleaned short repository token', () => {
  const [agent] = projectAgents([observation({ display: { issues: [
    { number: 1, title: 'a', repo: 'agents-office' },
    { number: 2, title: 'b', repo: 'owner/inner/short.name' },
    { number: 3, title: 'c', repo: '<img src=x>' },
    { number: 4, title: 'd', repo: '..' },
    { number: 5, title: 'e', repo: 'x'.repeat(41) },
  ] } })], publicId);

  assert.deepEqual(agent.issues, [
    { number: 1, title: 'a', repo: 'agents-office' },
    { number: 2, title: 'b', repo: 'short.name' },
    { number: 3, title: 'c' },
    { number: 4, title: 'd' },
    { number: 5, title: 'e' },
  ]);
});

test('an issue card keeps a label color only as a cleaned 6-hex token', () => {
  const cleaned = (color: unknown) => projectAgents([observation({ display: { issues: [
    { number: 1, title: 'a', color: color as string },
  ] } })], publicId)[0].issues![0].color;

  assert.equal(cleaned('D73A4A'), 'd73a4a');
  assert.equal(cleaned('#0e8a16'), '0e8a16');
  for (const bad of ['red', 'fff', '1234567', '<b>abcdef', 'abcdef;', 0xabcdef, null]) {
    assert.equal(cleaned(bad), undefined, `refused: ${String(bad)}`);
  }
});

test('a plain Claude agent keeps the original three fields', () => {
  assert.deepEqual(Object.keys(projectAgents([observation()], publicId)[0]).sort(), ['activity', 'id', 'name']);
});

test('a failing or slow plugin step drops only its own output', async () => {
  const core = { id: 'core', scan: () => [observation()] };
  const broken = { id: 'broken', scan: () => { throw new Error('boom'); } };
  const marker = { id: 'marker', enrich: (list: Observation[]) => { list[0].display.badges = ['seen']; } };
  const hanging = { id: 'hanging', enrich: () => new Promise<void>(() => undefined) };

  const result = await observe(core, [broken], [hanging, marker]);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].display.badges, ['seen']);
});

test('a core source failure is an error', async () => {
  await assert.rejects(observe({ id: 'core', scan: () => { throw new Error('boom'); } }, [], []));
});

test('the world projection cleans rooms and boards and hashes their keys', () => {
  const world = projectWorld([{ rooms: [{ key: 'm-1', kind: 'mission', title: 'War\troom', state: 'locked',
    sleepers: [{ id: 'J-1', endedAt: '2026-11-18T19:40:00Z' }, { id: '' }, { id: 'J-2' }],
    walls: { statement: 'Ship it', issues: [{ number: 7, title: 'Fix', state: 'closed' }], kanban: [{ column: 'Doing', cards: [{ number: 8, title: 'Card' }] }] } }],
    boards: [{ key: 'b', title: 'Board', columns: [{ name: 'Todo', cards: [{ number: 1.5, title: 'bad' }] }] }] }],
  ['missions', 'Bad Name'], publicId);

  assert.deepEqual(world.plugins, ['missions']);
  assert.equal(world.rooms[0].id, 'h(room:m-1)');
  assert.equal(world.rooms[0].title, 'War room');
  // A blank id is dropped; a raw journey id is hashed (never sent raw); a time-of-day is cut to the day
  assert.deepEqual(world.rooms[0].sleepers, [{ id: 'h(sleeper:m-1:J-1)', endedAt: '2026-11-18' }, { id: 'h(sleeper:m-1:J-2)' }]);
  assert.equal(world.rooms[0].state, 'locked');
  assert.deepEqual(world.rooms[0].walls.kanban, [{ column: 'Doing', cards: [{ number: 8, title: 'Card' }] }]);
  assert.deepEqual(world.boards[0].columns[0].cards, []);
});

test('plugin names cannot leave the plugins folder', () => {
  assert.deepEqual(parsePluginNames('herdr, ../etc,missions,herdr,BAD'), ['herdr', 'missions']);
  assert.equal(pluginEntry('/tmp/plugins', '../escape'), null);
  assert.equal(pluginEntry('/tmp/plugins', 'missing'), null);
});

// --- HTTP: the world endpoint has the same boundary as the agent endpoint ---

const resources: Array<{ server: ViteDevServer; root: string }> = [];
after(async () => {
  for (const { server, root } of resources) {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

const record: DetectedAgent = { id: 'private-session', name: 'agent', pid: 1, cwd: '/private', startedAt: 1, alive: true, activity: 'meeting' };
const testPlugin: OfficePlugin = {
  name: 'test-plugin',
  enrichers: [{ id: 'attention', enrich: (list) => { for (const agent of list) agent.display.attention = 'waiting'; } }],
  world: [{ id: 'rooms', world: () => ({ rooms: [{ key: 'mission-x', kind: 'mission', title: 'Mission X', state: 'open' }] }) }],
};

async function server() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agents-office-seam-test-'));
  const vite = await createServer({ root, configFile: false, envFile: false,
    plugins: [agentDetectorPlugin({ detect: () => [record], plugins: [testPlugin], codexHome: null })],
    server: { host: '127.0.0.1', port: 0, open: false, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' });
  resources.push({ server: vite, root });
  await vite.listen();
  const port = (vite.httpServer!.address() as AddressInfo).port;
  return (route: string, headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.end();
    });
}

test('plugins add whitelisted agent fields and world rooms over HTTP, behind the same checks', async () => {
  const request = await server();

  const agents = JSON.parse((await request('/api/agents')).body);
  assert.equal(agents[0].attention, 'waiting');
  const world = JSON.parse((await request('/api/world')).body);
  assert.deepEqual(world.plugins, ['test-plugin']);
  assert.equal(world.rooms[0].title, 'Mission X');
  assert.equal((await request('/api/world', { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await request('/api/world', {}, 'POST')).status, 405);
  assert.equal((await request('/api/world', { Host: 'evil.example' })).status, 403);
});

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { agentDetectorPlugin } from '../server/vitePlugin.js';
import type { DetectedAgent } from '../server/agentDetector.js';
import defaultConfig from '../vite.config.js';

// The injected detector supplies synthetic records. No test reads user sessions.
const records: DetectedAgent[] = [
  {
    id: 'private-parent-session', name: 'synthetic-project', pid: 12345,
    cwd: '/private/customer/project', startedAt: 1234567890, alive: true,
    activity: 'researching',
  },
  {
    id: 'private-child-session', name: 'synthetic-subagent', pid: 12345,
    cwd: '/private/customer/project', startedAt: 1234567890, alive: true,
    activity: 'implementing', parentId: 'private-parent-session',
  },
];

const resources: Array<{ server: ViteDevServer; root: string }> = [];
after(async () => {
  for (const { server, root } of resources) {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function fixtureServer(detect = () => records, beforePlugin?: Plugin, relaxViteHostCheck = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agents-office-api-test-'));
  const server = await createServer({
    root,
    configFile: false,
    envFile: false,
    plugins: [...(beforePlugin ? [beforePlugin] : []), agentDetectorPlugin(detect)],
    server: { host: '127.0.0.1', port: 0, open: false, watch: null, ws: false,
      ...(relaxViteHostCheck ? { allowedHosts: true } : {}) },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'silent',
  });
  resources.push({ server, root });
  await server.listen();
  const port = (server.httpServer!.address() as AddressInfo).port;
  const request = (headers: Record<string, string> = {}, method = 'GET'): Promise<Response> =>
    new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/agents', method, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  return { request, origin: `http://127.0.0.1:${port}` };
}

// This exercises the real HTTP middleware/projection, including parent IDs.
test('local polling returns minimal display fields and stable opaque identities', async () => {
  const { request, origin } = await fixtureServer();
  const first = await request({ Origin: origin });
  assert.equal(first.status, 200);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(first.headers['x-content-type-options'], 'nosniff');
  const agents = JSON.parse(first.body);
  assert.equal(agents.length, 2);
  assert.deepEqual(Object.keys(agents[0]).sort(), ['activity', 'id', 'name']);
  assert.deepEqual(Object.keys(agents[1]).sort(), ['activity', 'id', 'name', 'parentId']);
  assert.equal(agents[0].name, records[0].name);
  assert.equal(agents[0].activity, records[0].activity);
  assert.match(agents[0].id, /^[a-f0-9]{64}$/);
  assert.equal(agents[1].parentId, agents[0].id);
  assert.notEqual(agents[0].id, agents[1].id);
  for (const secret of [records[0].cwd, records[0].id, records[1].id, '12345', '1234567890']) {
    assert.equal(first.body.includes(secret), false);
  }
  assert.deepEqual(JSON.parse((await request()).body), agents);
  const anotherServer = await fixtureServer();
  assert.notEqual(JSON.parse((await anotherServer.request()).body)[0].id, agents[0].id);
});

test('other browser origins, including another localhost port, cannot read the API', async () => {
  let detectorCalls = 0;
  const { request } = await fixtureServer(() => { detectorCalls++; return records; });
  for (const Origin of ['https://evil.example', 'http://localhost:1', 'http://127.0.0.1:1', 'null', 'malformed']) {
    assert.equal((await request({ Origin })).status, 403);
  }
  assert.equal(detectorCalls, 0);
});

test('Vite rejects an unapproved Host before the API handler', async () => {
  let detectorCalls = 0;
  const { request } = await fixtureServer(() => { detectorCalls++; return records; });
  assert.equal((await request({ Host: 'evil.example' })).status, 403);
  assert.equal(detectorCalls, 0);
});

test('non-loopback clients are rejected before session detection', async () => {
  let detectorCalls = 0;
  const simulateRemoteClient: Plugin = {
    name: 'synthetic-remote-client',
    configureServer(server) {
      server.middlewares.use((_req, _res, next) => {
        // Simulate a non-loopback socket while keeping the test server local.
        Object.defineProperty(_req.socket, 'remoteAddress', { configurable: true, value: '198.51.100.10' });
        next();
      });
    },
  };
  const { request } = await fixtureServer(() => { detectorCalls++; return records; }, simulateRemoteClient);
  const response = await request();
  assert.equal(response.status, 403);
  assert.equal(detectorCalls, 0);
});

test('non-GET requests do not trigger detection', async () => {
  let detectorCalls = 0;
  const { request } = await fixtureServer(() => { detectorCalls++; return records; });
  const response = await request({}, 'POST');
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'GET');
  assert.equal(detectorCalls, 0);
});

test('internal errors do not disclose paths or exceptions', async () => {
  const { request } = await fixtureServer(() => { throw new Error('/private/customer/secret exception'); });
  const response = await request();
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.body), { error: 'Unable to detect agents' });
  assert.equal(response.body.includes('/private'), false);
});

test('unsafe listen hosts are rejected even when passed as overrides', async () => {
  for (const host of [true, '0.0.0.0', '::', '192.168.1.10', 'evil.example']) {
    await assert.rejects(createServer({
      root: os.tmpdir(), configFile: false, envFile: false,
      plugins: [agentDetectorPlugin(() => records)],
      server: { host, open: false, watch: null, ws: false },
      optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent',
    }), /must listen on localhost/);
  }
});


test('the repository default configuration binds only to loopback', async () => {
  assert.equal(defaultConfig.server?.host, '127.0.0.1');
  const root = await mkdtemp(path.join(os.tmpdir(), 'agents-office-default-config-test-'));
  const server = await createServer({
    ...defaultConfig,
    root,
    configFile: false,
    envFile: false,
    // Retain the default host and plugin; never request the real detector route.
    server: { ...defaultConfig.server, port: 0, open: false, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'silent',
  });
  resources.push({ server, root });
  await server.listen();
  assert.equal((server.httpServer!.address() as AddressInfo).address, '127.0.0.1');
});


test('the API rejects a nonlocal Host even if Vite host validation is relaxed', async () => {
  let detectorCalls = 0;
  const { request } = await fixtureServer(() => { detectorCalls++; return records; }, undefined, true);
  const requests: Array<Record<string, string>> = [
    { Host: 'evil.example' },
    { Host: 'evil.example', Origin: 'http://evil.example' },
    { Host: '192.168.1.10' },
  ];
  for (const headers of requests) {
    const response = await request(headers);
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body), { error: 'Local host only' });
  }
  assert.equal(detectorCalls, 0);
});

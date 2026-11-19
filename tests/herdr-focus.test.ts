import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, type ViteDevServer } from 'vite';
import { agentDetectorPlugin } from '../server/vitePlugin.js';
import type { DetectedAgent } from '../server/agentDetector.js';
import { createHerdrPlugin, type Runner } from '../plugins/herdr/index.js';
import { projectAgents, type Observation } from '../server/seam.js';

// Synthetic sessions and a fake herdr. No test runs the real herdr or reads user sessions.
const records: DetectedAgent[] = [
  { id: 'raw-main', name: 'project-a', pid: 101, cwd: '/private/a', startedAt: 1, alive: true, activity: 'implementing' },
  { id: 'raw-sub', name: 'sub', pid: 101, cwd: '/private/a', startedAt: 1, alive: true, activity: 'researching', parentId: 'raw-main' },
  { id: 'raw-outside', name: 'outside', pid: 303, cwd: '/private/b', startedAt: 1, alive: true, activity: 'idle' },
];

const TABS = JSON.stringify({ result: { tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'fix login' }] } });
const WORKSPACES = JSON.stringify({ result: { workspaces: [{ workspace_id: 'w1', label: 'Backend' }] } });
const ENV_BY_PID: Record<number, string> = {
  101: 'claude HERDR_PANE_ID=w1:p1 HERDR_TAB_ID=w1:t1 HERDR_WORKSPACE_ID=w1',
  303: 'claude TERM=xterm',
};

interface Call { file: string; args: string[]; timeout: number }

interface FakeHerdr {
  env?: Record<number, string>;
  pane?: Record<string, unknown> | null;
  agentFocusFails?: boolean;
}

function fakeHerdr(state: FakeHerdr = {}) {
  const calls: Call[] = [];
  const run: Runner = async (file, args, options) => {
    calls.push({ file, args, timeout: options.timeout });
    if (file === 'ps') {
      const env = state.env ?? ENV_BY_PID;
      const pids = args[args.length - 1].split(',').map(Number);
      return pids.filter((pid) => env[pid]).map((pid) => `  ${pid} ${env[pid]}\n`).join('');
    }
    if (file !== 'herdr') throw new Error(`unexpected command ${file}`);
    const [noun, verb] = args;
    if (noun === 'tab' && verb === 'list') return TABS;
    if (noun === 'workspace' && verb === 'list') return WORKSPACES;
    if (noun === 'pane' && verb === 'get') {
      const pane = state.pane === undefined ? { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent: 'claude' } : state.pane;
      if (pane === null) throw new Error('pane_not_found');
      return JSON.stringify({ id: 'cli:pane:get', result: { type: 'pane', pane } });
    }
    if (noun === 'agent' && verb === 'focus') {
      if (state.agentFocusFails) throw new Error('agent_not_found');
      return '{}';
    }
    if (noun === 'tab' && verb === 'focus') return '{}';
    throw new Error(`unexpected herdr ${args.join(' ')}`);
  };
  const writes = () => calls.filter((call) => call.file === 'herdr' && call.args[1] === 'focus');
  return { run, calls, writes };
}

function sessions(): Observation[] {
  return [
    { id: 's1', provider: 'claude', name: 'project-a', activity: 'implementing', internal: { pid: 101 }, display: {} },
    { id: 's1-sub', parentId: 's1', provider: 'claude', name: '>> sub', activity: 'researching', internal: { pid: 101 }, display: {} },
    { id: 's3', provider: 'claude', name: 'outside', activity: 'idle', internal: { pid: 303 }, display: {} },
  ];
}

async function enrichWith(plugin: ReturnType<typeof createHerdrPlugin>, observations = sessions()) {
  for (const enricher of plugin.enrichers ?? []) await enricher.enrich(observations);
  return observations;
}

// --- Plugin: opt-in, advertising and the action itself ---

test('without the opt-in the herdr plugin has no action and advertises none', async () => {
  const previous = process.env.AGENTS_OFFICE_HERDR_FOCUS;
  delete process.env.AGENTS_OFFICE_HERDR_FOCUS;
  try {
    const plugin = createHerdrPlugin({ run: fakeHerdr().run });
    assert.equal(plugin.actions, undefined);
    const observations = await enrichWith(plugin);
    for (const agent of observations) assert.equal(agent.display.actions, undefined);
  } finally {
    if (previous !== undefined) process.env.AGENTS_OFFICE_HERDR_FOCUS = previous;
  }
});

test('AGENTS_OFFICE_HERDR_FOCUS=1 turns the focus action on', () => {
  const previous = process.env.AGENTS_OFFICE_HERDR_FOCUS;
  process.env.AGENTS_OFFICE_HERDR_FOCUS = '1';
  try {
    assert.deepEqual(createHerdrPlugin({ run: fakeHerdr().run }).actions?.map((action) => action.name), ['focus']);
  } finally {
    if (previous === undefined) delete process.env.AGENTS_OFFICE_HERDR_FOCUS;
    else process.env.AGENTS_OFFICE_HERDR_FOCUS = previous;
  }
});

test('with focus on, only agents with a herdr pane advertise focus (a subagent through its parent)', async () => {
  const plugin = createHerdrPlugin({ run: fakeHerdr().run, focus: true });
  const [main, sub, outside] = await enrichWith(plugin);
  assert.deepEqual(main.display.actions, ['focus']);
  assert.deepEqual(sub.display.actions, ['focus']);
  assert.equal(outside.display.actions, undefined);
});

test('a pane id outside the strict pattern gets no action', async () => {
  const herdr = fakeHerdr({ env: { 101: 'claude HERDR_PANE_ID=w1;rm HERDR_TAB_ID=w1:t1 HERDR_WORKSPACE_ID=w1' } });
  const plugin = createHerdrPlugin({ run: herdr.run, focus: true });
  const [main] = await enrichWith(plugin);
  assert.equal(main.display.actions, undefined);
});

test('focus re-checks the pane, then runs herdr agent focus with the exact argv', async () => {
  const herdr = fakeHerdr();
  const plugin = createHerdrPlugin({ run: herdr.run, focus: true });
  const [main] = await enrichWith(plugin);
  herdr.calls.length = 0;
  assert.equal(await plugin.actions![0].run(main), 'done');
  assert.deepEqual(herdr.calls.map((call) => [call.file, ...call.args]), [
    ['ps', 'eww', '-o', 'pid=,command=', '-p', '101'],
    ['herdr', 'pane', 'get', 'w1:p1'],
    ['herdr', 'agent', 'focus', 'w1:p1'],
  ]);
  for (const call of herdr.calls) assert.ok(call.timeout > 0 && call.timeout <= 2000);
});

test('a pane with no detected agent falls back to herdr tab focus', async () => {
  const herdr = fakeHerdr({ pane: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' } });
  const plugin = createHerdrPlugin({ run: herdr.run, focus: true });
  const [main] = await enrichWith(plugin);
  assert.equal(await plugin.actions![0].run(main), 'done');
  assert.deepEqual(herdr.writes().map((call) => call.args), [['tab', 'focus', 'w1:t1']]);
});

test('a failing agent focus falls back to herdr tab focus', async () => {
  const herdr = fakeHerdr({ agentFocusFails: true });
  const plugin = createHerdrPlugin({ run: herdr.run, focus: true });
  const [main] = await enrichWith(plugin);
  assert.equal(await plugin.actions![0].run(main), 'done');
  assert.deepEqual(herdr.writes().map((call) => call.args), [['agent', 'focus', 'w1:p1'], ['tab', 'focus', 'w1:t1']]);
});

test('focus refuses when the pane is gone, moved tab, or now holds another process', async () => {
  const cases: FakeHerdr[] = [
    { pane: null },
    { pane: { pane_id: 'w1:p1', tab_id: 'w2:t9', workspace_id: 'w2', agent: 'claude' } },
  ];
  for (const state of cases) {
    const herdr = fakeHerdr(state);
    const plugin = createHerdrPlugin({ run: herdr.run, focus: true });
    const [main] = await enrichWith(plugin);
    assert.equal(await plugin.actions![0].run(main), 'gone');
    assert.equal(herdr.writes().length, 0);
  }
  const env = { ...ENV_BY_PID };
  const herdr = fakeHerdr({ env });
  const plugin = createHerdrPlugin({ run: herdr.run, focus: true });
  const [main, , outside] = await enrichWith(plugin);
  env[101] = 'claude HERDR_PANE_ID=w1:p7 HERDR_TAB_ID=w1:t1 HERDR_WORKSPACE_ID=w1';
  assert.equal(await plugin.actions![0].run(main), 'gone');
  assert.equal(await plugin.actions![0].run(outside), 'gone');
  assert.equal(herdr.writes().length, 0);
});

// --- Projection whitelist ---

test('the projection passes only known actions that the server enabled', () => {
  const agent: Observation = { id: 'a', provider: 'claude', name: 'a', activity: 'idle', internal: {},
    display: { actions: ['focus', 'send-keys', 'focus'] as never } };
  const id = (raw: string) => `id-${raw}`;
  assert.deepEqual(projectAgents([agent], id, new Set(['focus']))[0].actions, ['focus']);
  assert.equal('actions' in projectAgents([agent], id)[0], false);
  assert.equal('actions' in projectAgents([agent], id, new Set(['send-keys']))[0], false);
  const bad: Observation = { ...agent, display: { actions: 'focus' as never } };
  assert.equal('actions' in projectAgents([bad], id, new Set(['focus']))[0], false);
});

// --- HTTP route ---

const resources: Array<{ server: ViteDevServer; root: string }> = [];
after(async () => {
  for (const { server, root } of resources) {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

async function officeServer(options: { focus: boolean; herdr?: ReturnType<typeof fakeHerdr> }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agents-office-focus-test-'));
  const auditLogPath = path.join(root, 'audit.jsonl');
  const herdr = options.herdr ?? fakeHerdr();
  const server = await createServer({
    root, configFile: false, envFile: false,
    plugins: [agentDetectorPlugin({ detect: () => records, codexHome: null, auditLogPath,
      plugins: [createHerdrPlugin({ run: herdr.run, focus: options.focus })] })],
    server: { host: '127.0.0.1', port: 0, open: false, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'silent',
  });
  resources.push({ server, root });
  await server.listen();
  const port = (server.httpServer!.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const request = (urlPath: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: init.method ?? 'GET', headers: init.headers ?? {} }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });

  const agents = async () => JSON.parse((await request('/api/agents', { headers: { Origin: origin } })).body) as Array<{ id: string; name: string; actions?: string[] }>;
  const token = async () => JSON.parse((await request('/api/actions/token', { headers: { Origin: origin } })).body).token as string;
  const focus = (body: string, headers: Record<string, string> = {}) => request('/api/actions/focus', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers },
  });
  const auditLines = async () => {
    try {
      return (await readFile(auditLogPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { request, origin, agents, token, focus, auditLines, auditLogPath, herdr };
}

async function ready(office: Awaited<ReturnType<typeof officeServer>>) {
  const list = await office.agents();
  const main = list.find((agent) => agent.name === 'fix login')!;
  const token = await office.token();
  const valid = { Origin: office.origin, 'X-Agents-Office-Token': token };
  return { list, main, token, valid };
}

test('without the opt-in no write route exists, no token is served and agents carry no actions', async () => {
  const office = await officeServer({ focus: false });
  const list = await office.agents();
  assert.ok(list.length === 3);
  for (const agent of list) assert.equal(agent.actions, undefined);
  const post = await office.focus(JSON.stringify({ agent: list[0].id }), { Origin: office.origin });
  assert.ok([404, 405].includes(post.status), `status ${post.status}`);
  const tokenReply = await office.request('/api/actions/token', { headers: { Origin: office.origin } });
  assert.equal(/"token"/.test(tokenReply.body), false);
  assert.equal(office.herdr.writes().length, 0);
  assert.deepEqual(await office.auditLines(), []);
});

test('with the opt-in, agents with a pane advertise focus and the GET routes keep their checks', async () => {
  const office = await officeServer({ focus: true });
  const list = await office.agents();
  assert.deepEqual(list.find((agent) => agent.name === 'fix login')?.actions, ['focus']);
  assert.deepEqual(list.find((agent) => agent.name === 'sub')?.actions, ['focus']);
  assert.equal(list.find((agent) => agent.name === 'outside')?.actions, undefined);
  const body = JSON.stringify(list);
  // The PID (101) must not appear as a value; the bare digits can occur inside a random hex id.
  for (const secret of ['w1:p1', 'w1:t1', 'raw-main', ':101', '"pid"']) assert.equal(body.includes(secret), false);
  assert.equal((await office.request('/api/agents', { method: 'POST', headers: { Origin: office.origin } })).status, 405);
  assert.equal((await office.request('/api/agents', { headers: { Origin: 'http://localhost:1' } })).status, 403);
  assert.equal((await office.request('/api/actions/token', { headers: { Origin: 'http://localhost:1' } })).status, 403);
  const token = await office.token();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(body.includes(token), false);
  const page = await office.request('/', { headers: { Accept: 'text/html' } });
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
});

test('a valid focus request calls herdr with the exact argv and writes one audit line', async () => {
  const office = await officeServer({ focus: true });
  const { main, token, valid } = await ready(office);
  office.herdr.calls.length = 0;
  const reply = await office.focus(JSON.stringify({ agent: main.id }), valid);
  assert.equal(reply.status, 200, reply.body);
  assert.deepEqual(JSON.parse(reply.body), { ok: true });
  assert.deepEqual(office.herdr.writes().map((call) => [call.file, ...call.args]), [['herdr', 'agent', 'focus', 'w1:p1']]);
  const lines = await office.auditLines();
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['action', 'agent', 'result', 'time']);
  assert.equal(lines[0].action, 'focus');
  assert.equal(lines[0].agent, main.id);
  assert.equal(lines[0].result, 'done');
  const raw = await readFile(office.auditLogPath, 'utf8');
  assert.equal(raw.includes(token), false);
  assert.equal(raw.includes('w1:p1'), false);
  assert.equal((await stat(office.auditLogPath)).mode & 0o077, 0);
});

test('a missing or wrong token is refused with 403 and herdr is not called', async () => {
  const office = await officeServer({ focus: true });
  const { main, token } = await ready(office);
  const body = JSON.stringify({ agent: main.id });
  assert.equal((await office.focus(body, { Origin: office.origin })).status, 403);
  assert.equal((await office.focus(body, { Origin: office.origin, 'X-Agents-Office-Token': 'a'.repeat(64) })).status, 403);
  assert.equal((await office.focus(body, { Origin: office.origin, 'X-Agents-Office-Token': token.slice(1) })).status, 403);
  assert.equal(office.herdr.writes().length, 0);
  const lines = await office.auditLines();
  assert.equal(lines.length, 3);
  for (const line of lines) assert.equal(JSON.stringify(line).includes(token), false);
});

test('a wrong or missing Origin is refused with 403 on POST', async () => {
  const office = await officeServer({ focus: true });
  const { main, token } = await ready(office);
  const body = JSON.stringify({ agent: main.id });
  for (const Origin of ['https://evil.example', 'http://localhost:1', 'null']) {
    assert.equal((await office.focus(body, { Origin, 'X-Agents-Office-Token': token })).status, 403);
  }
  assert.equal((await office.focus(body, { 'X-Agents-Office-Token': token })).status, 403);
  assert.equal((await office.focus(body, { Origin: office.origin, 'X-Agents-Office-Token': token, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(office.herdr.writes().length, 0);
});

test('a body that is not JSON is refused with 415', async () => {
  const office = await officeServer({ focus: true });
  const { main, valid } = await ready(office);
  const body = JSON.stringify({ agent: main.id });
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    assert.equal((await office.focus(body, { ...valid, 'Content-Type': type })).status, 415);
  }
  assert.equal(office.herdr.writes().length, 0);
});

test('an oversized body is refused with 413', async () => {
  const office = await officeServer({ focus: true });
  const { main, valid } = await ready(office);
  const reply = await office.focus(JSON.stringify({ agent: main.id, pad: 'x'.repeat(2048) }), valid);
  assert.equal(reply.status, 413);
  assert.equal(office.herdr.writes().length, 0);
});

test('an unknown agent or a malformed body never reaches herdr', async () => {
  const office = await officeServer({ focus: true });
  const { list, valid } = await ready(office);
  assert.equal((await office.focus(JSON.stringify({ agent: 'f'.repeat(64) }), valid)).status, 404);
  const outside = list.find((agent) => agent.name === 'outside')!;
  assert.equal((await office.focus(JSON.stringify({ agent: outside.id }), valid)).status, 404);
  for (const body of ['not json', '[]', '{}', JSON.stringify({ agent: 'w1:p1' }), JSON.stringify({ agent: list[0].id, pane: 'w1:p1' })]) {
    assert.equal((await office.focus(body, valid)).status, 400, body);
  }
  assert.equal(office.herdr.writes().length, 0);
  const lines = await office.auditLines();
  assert.equal(lines.some((line) => JSON.stringify(line).includes('w1:p1')), false);
});

test('a pane that changed since the last poll is refused with 409', async () => {
  const herdr = fakeHerdr({ pane: null });
  const office = await officeServer({ focus: true, herdr });
  const { main, valid } = await ready(office);
  const reply = await office.focus(JSON.stringify({ agent: main.id }), valid);
  assert.equal(reply.status, 409);
  assert.equal(herdr.writes().length, 0);
  assert.equal((await office.auditLines())[0].result, 'gone');
});

test('more than 10 focus requests in a minute get 429', async () => {
  const office = await officeServer({ focus: true });
  const { main, valid } = await ready(office);
  const body = JSON.stringify({ agent: main.id });
  for (let i = 0; i < 10; i++) assert.equal((await office.focus(body, valid)).status, 200);
  assert.equal((await office.focus(body, valid)).status, 429);
  assert.equal(office.herdr.writes().length, 10);
});

test('the focus route answers POST only', async () => {
  const office = await officeServer({ focus: true });
  const { valid } = await ready(office);
  const reply = await office.request('/api/actions/focus', { headers: valid });
  assert.equal(reply.status, 405);
  assert.equal(reply.headers.allow, 'POST');
});

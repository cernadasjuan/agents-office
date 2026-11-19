import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHerdrPlugin, parseHerdrEnv, type Runner } from '../plugins/herdr/index.js';
import { projectAgents, type Observation } from '../server/seam.js';

const TABS = JSON.stringify({ id: 'cli:tab:list', result: { type: 'tab_list', tabs: [
  { tab_id: 'w1:t1', workspace_id: 'w1', label: 'fix login', number: 1, focused: true, pane_count: 1, agent_status: 'idle' },
  { tab_id: 'w2:t1', workspace_id: 'w2', label: 'write docs', number: 1, focused: false, pane_count: 1, agent_status: 'idle' },
] } });
const WORKSPACES = JSON.stringify({ id: 'cli:workspace:list', result: { type: 'workspace_list', workspaces: [
  { workspace_id: 'w1', label: 'Backend', number: 1, focused: true, active_tab_id: 'w1:t1', tab_count: 1, pane_count: 1, agent_status: 'idle' },
  { workspace_id: 'w2', label: 'Docs', number: 2, focused: false, active_tab_id: 'w2:t1', tab_count: 1, pane_count: 1, agent_status: 'idle' },
] } });

const ENV_BY_PID: Record<number, string> = {
  101: 'claude --resume x HOME=/Users/me API_TOKEN=sk-secret-value HERDR_PANE_ID=w1:p1 HERDR_TAB_ID=w1:t1 HERDR_WORKSPACE_ID=w1 PATH=/usr/bin',
  202: 'claude HERDR_WORKSPACE_ID=w2 GITHUB_TOKEN=ghp_hidden HERDR_TAB_ID=w2:t1 HERDR_PANE_ID=w2:p1',
  303: 'claude TERM=xterm-256color',
};

interface Call { file: string; args: string[]; timeout: number }

function fakeRunner(overrides: Partial<Record<'ps' | 'tab' | 'workspace', () => Promise<string>>> = {}) {
  const calls: Call[] = [];
  const run: Runner = async (file, args, options) => {
    calls.push({ file, args, timeout: options.timeout });
    if (file === 'ps') {
      if (overrides.ps) return overrides.ps();
      const pids = args[args.length - 1].split(',').map(Number);
      return pids.filter((pid) => ENV_BY_PID[pid]).map((pid) => `  ${pid} ${ENV_BY_PID[pid]}\n`).join('');
    }
    if (file === 'herdr' && args[0] === 'tab') return overrides.tab ? overrides.tab() : TABS;
    if (file === 'herdr' && args[0] === 'workspace') return overrides.workspace ? overrides.workspace() : WORKSPACES;
    throw new Error(`unexpected command ${file}`);
  };
  return { run, calls };
}

function sessions(): Observation[] {
  return [
    { id: 's1', provider: 'claude', name: 'project-a', activity: 'implementing', internal: { pid: 101 }, display: {} },
    { id: 's1-sub', parentId: 's1', provider: 'claude', name: '>> Explore code', activity: 'researching', internal: { pid: 101 }, display: {} },
    { id: 's2', provider: 'claude', name: 'project-b', activity: 'idle', internal: { pid: 202 }, display: {} },
    { id: 's3', provider: 'claude', name: 'outside-herdr', activity: 'idle', internal: { pid: 303 }, display: {} },
  ];
}

async function enrich(run: Runner, observations = sessions(), now = () => 0) {
  const plugin = createHerdrPlugin({ run, now });
  for (const enricher of plugin.enrichers ?? []) await enricher.enrich(observations);
  return observations;
}

test('the plugin is named herdr and has one enricher', () => {
  const plugin = createHerdrPlugin({ run: fakeRunner().run });
  assert.equal(plugin.name, 'herdr');
  assert.equal(plugin.enrichers?.length, 1);
});

test('a session in herdr gets the tab name and the workspace group, its subagent the same group', async () => {
  const [main, sub, other, outside] = await enrich(fakeRunner().run);
  assert.equal(main.name, 'fix login');
  assert.deepEqual(main.display, { groupKey: 'w1', groupLabel: 'Backend' });
  assert.equal(sub.name, '>> Explore code');
  assert.deepEqual(sub.display, { groupKey: 'w1', groupLabel: 'Backend' });
  assert.equal(other.name, 'write docs');
  assert.deepEqual(other.display, { groupKey: 'w2', groupLabel: 'Docs' });
  assert.equal(outside.name, 'outside-herdr');
  assert.deepEqual(outside.display, {});
});

test('the commands are fixed, read-only and have a timeout', async () => {
  const { run, calls } = fakeRunner();
  await enrich(run);
  for (const call of calls) {
    assert.ok(call.timeout > 0 && call.timeout <= 2000);
    if (call.file === 'ps') {
      assert.deepEqual(call.args.slice(0, 4), ['eww', '-o', 'pid=,command=', '-p']);
      assert.match(call.args[4], /^\d+(,\d+)*$/);
    }
    else assert.ok(['tab list', 'workspace list'].includes(call.args.join(' ')), call.args.join(' '));
  }
});

test('herdr missing changes nothing', async () => {
  const missing = Object.assign(new Error('spawn herdr ENOENT'), { code: 'ENOENT' });
  const { run } = fakeRunner({ tab: () => Promise.reject(missing), workspace: () => Promise.reject(missing) });
  assert.deepEqual(await enrich(run), sessions());
});

test('ps failure changes nothing', async () => {
  const { run } = fakeRunner({ ps: () => Promise.reject(new Error('ps timed out')) });
  assert.deepEqual(await enrich(run), sessions());
});

test('garbage herdr output changes nothing', async () => {
  for (const garbage of ['not json', '{}', '{"result":{"tabs":"x"}}', 'null', '[]']) {
    const { run } = fakeRunner({ tab: async () => garbage });
    assert.deepEqual(await enrich(run), sessions(), garbage);
  }
});

test('a timeout in herdr changes nothing', async () => {
  const timedOut = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
  const { run } = fakeRunner({ workspace: () => Promise.reject(timedOut) });
  assert.deepEqual(await enrich(run), sessions());
});

test('a tab unknown to herdr changes nothing for that session', async () => {
  const { run } = fakeRunner({ tab: async () => JSON.stringify({ result: { tabs: [] } }) });
  assert.deepEqual(await enrich(run), sessions());
});

test('only the three herdr variables are parsed from the process environment', () => {
  const env = parseHerdrEnv(ENV_BY_PID[101]);
  assert.deepEqual(env, { paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1' });
  assert.equal(parseHerdrEnv(ENV_BY_PID[303]), null);
  assert.equal(parseHerdrEnv('HERDR_TAB_ID=$(rm -rf /) HERDR_WORKSPACE_ID=w1'), null);
});

test('no other environment value reaches the observations or the API', async () => {
  const observations = await enrich(fakeRunner().run);
  const dump = JSON.stringify(observations);
  for (const secret of ['sk-secret-value', 'ghp_hidden', '/Users/me', 'xterm-256color', 'API_TOKEN', 'PATH=']) {
    assert.ok(!dump.includes(secret), secret);
  }
  const api = JSON.stringify(projectAgents(observations, (raw) => `h(${raw.length})`));
  for (const raw of ['w1:p1', 'w1:t1', '"w1"', 'w2']) assert.ok(!api.includes(raw), raw);
});

test('herdr lists are cached for 10 s and the process environment per PID', async () => {
  const { run, calls } = fakeRunner();
  let clock = 0;
  const plugin = createHerdrPlugin({ run, now: () => clock });
  const [enricher] = plugin.enrichers ?? [];
  await enricher.enrich(sessions());
  const first = calls.length;
  clock = 3000;
  await enricher.enrich(sessions());
  assert.equal(calls.length, first);
  clock = 10_500;
  await enricher.enrich(sessions());
  assert.equal(calls.filter((call) => call.file === 'herdr').length, 4);
  assert.equal(calls.filter((call) => call.file === 'ps').length, 1);
});

test('one ps call covers every new session PID', async () => {
  const { run, calls } = fakeRunner();
  await enrich(run);
  const ps = calls.filter((call) => call.file === 'ps');
  assert.equal(ps.length, 1);
  assert.deepEqual(ps[0].args[4].split(',').sort(), ['101', '202', '303']);
});

test('an environment line that spans several output lines stays with its PID', async () => {
  const { run } = fakeRunner({ ps: async () => '  101 claude NOTE=line1\nline2 HERDR_PANE_ID=w1:p1 HERDR_TAB_ID=w1:t1 HERDR_WORKSPACE_ID=w1\n  202 claude\n' });
  const [main, , other] = await enrich(run);
  assert.equal(main.name, 'fix login');
  assert.equal(other.name, 'project-b');
});

test('observations without a PID or from another provider are left alone', async () => {
  const { run, calls } = fakeRunner();
  const observations: Observation[] = [
    { id: 'x', provider: 'claude', name: 'no-pid', activity: 'idle', internal: {}, display: {} },
    { id: 'y', provider: 'codex', name: 'codex', activity: 'idle', internal: { pid: 101 }, display: {} },
  ];
  const before = structuredClone(observations);
  await enrich(run, observations);
  assert.deepEqual(observations, before);
  assert.equal(calls.filter((call) => call.file === 'ps').length, 0);
});

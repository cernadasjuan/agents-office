import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { AgentPoller } from '../src/agents/AgentPoller.js';
import type { AgentManager } from '../src/agents/AgentManager.js';

const manager = { getAgents: () => [], addAgent: () => undefined, setActivity: () => undefined, removeAgent: () => undefined } as unknown as AgentManager;

afterEach(() => mock.restoreAll());

test('a poll does not start while the previous poll is still running', async () => {
  const pending: Array<(value: Response) => void> = [];
  const fetchMock = mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => { pending.push(resolve); }));
  const poller = new AgentPoller(manager) as unknown as { poll(): Promise<void> };

  const first = poller.poll();
  const second = poller.poll();
  for (const resolve of pending) resolve(new Response('[]'));
  await Promise.all([first, second]);

  assert.equal(fetchMock.mock.callCount(), 1);
});

test('a poll gives the request a time limit', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('[]'));
  const poller = new AgentPoller(manager) as unknown as { poll(): Promise<void> };

  await poller.poll();

  const init = fetchMock.mock.calls[0].arguments[1] as RequestInit | undefined;
  assert.ok(init?.signal instanceof AbortSignal);
});

type PollerInternals = { poll(): Promise<void>; pollHealth: { loaded: boolean; lastSuccessAt: number | null; failures: number } };

function pollerAt(clock: { now: number }, onUpdate?: () => void, onHealth?: () => void): PollerInternals {
  const poller = new AgentPoller(manager, () => clock.now);
  Reflect.set(poller, 'onUpdate', onUpdate ?? null);
  Reflect.set(poller, 'onHealth', onHealth ?? null);
  return poller as unknown as PollerInternals;
}

test('before the first answer the poller reports that it is still loading', () => {
  const poller = pollerAt({ now: 0 });

  assert.deepEqual(poller.pollHealth, { loaded: false, lastSuccessAt: null, failures: 0 });
});

test('the first answer counts as an update, also for an empty office', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('[]'));
  let updates = 0;
  const poller = pollerAt({ now: 1000 }, () => updates++);

  await poller.poll();
  await poller.poll();

  assert.equal(updates, 1);
  assert.deepEqual(poller.pollHealth, { loaded: true, lastSuccessAt: 1000, failures: 0 });
});

test('failed polls count up, keep the last success time, and a good answer resets the count', async () => {
  const clock = { now: 1000 };
  let answer: () => Promise<Response> = async () => new Response('[]');
  mock.method(globalThis, 'fetch', () => answer());
  let reports = 0;
  const poller = pollerAt(clock, undefined, () => reports++);

  await poller.poll();
  answer = async () => { throw new TypeError('Failed to fetch'); };
  clock.now = 4000;
  await poller.poll();
  answer = async () => new Response('boom', { status: 500 });
  clock.now = 7000;
  await poller.poll();
  answer = async () => new Response('not json');
  await poller.poll();

  assert.deepEqual(poller.pollHealth, { loaded: true, lastSuccessAt: 1000, failures: 3 });
  assert.equal(reports, 4, 'every finished poll reports its health');

  answer = async () => new Response('[]');
  clock.now = 10_000;
  await poller.poll();
  assert.deepEqual(poller.pollHealth, { loaded: true, lastSuccessAt: 10_000, failures: 0 });
});

test('a malformed 200 body counts as a failure and does not reset poll health', async () => {
  const clock = { now: 1000 };
  let answer: () => Promise<Response> = async () => new Response(JSON.stringify({ error: 'boom' }));
  mock.method(globalThis, 'fetch', () => answer());
  const poller = pollerAt(clock);

  await poller.poll();
  assert.deepEqual(poller.pollHealth, { loaded: false, lastSuccessAt: null, failures: 1 });

  clock.now = 4000;
  await poller.poll();
  assert.deepEqual(poller.pollHealth, { loaded: false, lastSuccessAt: null, failures: 2 }, 'repeated bad bodies keep counting, not reset to 1 forever');
});

test('a good empty answer after bad bodies still counts as the first answer', async () => {
  let answer: () => Promise<Response> = async () => new Response(JSON.stringify({ error: 'boom' }));
  mock.method(globalThis, 'fetch', () => answer());
  let updates = 0;
  const poller = pollerAt({ now: 1000 }, () => updates++);

  await poller.poll();
  answer = async () => new Response('[]');
  await poller.poll();

  assert.equal(updates, 1, 'the first good answer is still treated as the first answer, even after bad bodies');
  assert.deepEqual(poller.pollHealth, { loaded: true, lastSuccessAt: 1000, failures: 0 });
});

test('a poll skipped because one is still running does not report a failure', async () => {
  mock.method(globalThis, 'fetch', () => new Promise<Response>(() => undefined));
  let reports = 0;
  const poller = pollerAt({ now: 0 }, undefined, () => reports++);

  void poller.poll();
  await poller.poll();

  assert.equal(reports, 0);
  assert.equal(poller.pollHealth.failures, 0);
});

test('a stuck field in the answer reaches the new agent\'s extras', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([{ id: 'a', name: 'agent', activity: 'implementing', stuck: true }])));
  const addAgent = mock.fn();
  const stuckManager = { getAgents: () => [], addAgent, setActivity: () => undefined, removeAgent: () => undefined } as unknown as AgentManager;
  const poller = new AgentPoller(stuckManager) as unknown as { poll(): Promise<void> };

  await poller.poll();

  assert.equal(addAgent.mock.callCount(), 1);
  assert.deepEqual(addAgent.mock.calls[0].arguments[0].extras, { stuck: true });
});

// --- Floor filtering (issue #118 AC4, lazy render) ---

test('without a focus floor, every agent is added regardless of its floor (every layout that is not floor-aware)', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
    { id: 'a', name: 'agent', activity: 'implementing', floor: 'agents-office' },
    { id: 'b', name: 'agent', activity: 'implementing', floor: 'widget-service' },
  ])));
  const addAgent = mock.fn();
  const manager = { getAgents: () => [], addAgent, setActivity: () => undefined, removeAgent: () => undefined } as unknown as AgentManager;
  const poller = new AgentPoller(manager) as unknown as { poll(): Promise<void> };

  await poller.poll();

  assert.equal(addAgent.mock.callCount(), 2);
});

test('with a focus floor, only an agent on that floor is added', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
    { id: 'a', name: 'agent', activity: 'implementing', floor: 'agents-office' },
    { id: 'b', name: 'agent', activity: 'implementing', floor: 'widget-service' },
  ])));
  const addAgent = mock.fn();
  const manager = { getAgents: () => [], addAgent, setActivity: () => undefined, removeAgent: () => undefined } as unknown as AgentManager;
  const poller = new AgentPoller(manager, () => Date.now(), 'agents-office') as unknown as { poll(): Promise<void> };

  await poller.poll();

  assert.equal(addAgent.mock.callCount(), 1);
  assert.equal(addAgent.mock.calls[0].arguments[0].id, 'a');
});

test('with a focus floor, an agent with no floor field is treated as general, not dropped and not shown everywhere', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
    { id: 'a', name: 'agent', activity: 'implementing' },
  ])));
  const addAgent = mock.fn();
  const manager = { getAgents: () => [], addAgent, setActivity: () => undefined, removeAgent: () => undefined } as unknown as AgentManager;

  const onGeneral = new AgentPoller(manager, () => Date.now(), 'general') as unknown as { poll(): Promise<void> };
  await onGeneral.poll();
  assert.equal(addAgent.mock.callCount(), 1);

  addAgent.mock.resetCalls();
  const onOtherFloor = new AgentPoller(manager, () => Date.now(), 'agents-office') as unknown as { poll(): Promise<void> };
  await onOtherFloor.poll();
  assert.equal(addAgent.mock.callCount(), 0);
});

test('an agent that leaves the focused floor is removed, even though it is still in the raw answer', async () => {
  let floor = 'agents-office';
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([{ id: 'a', name: 'agent', activity: 'implementing', floor }])));
  const addAgent = mock.fn();
  const removeAgent = mock.fn();
  const manager = { getAgents: () => [], addAgent, setActivity: () => undefined, removeAgent } as unknown as AgentManager;
  const poller = new AgentPoller(manager, () => Date.now(), 'agents-office') as unknown as { poll(): Promise<void> };

  await poller.poll();
  assert.equal(addAgent.mock.callCount(), 1);

  floor = 'widget-service';
  await poller.poll();
  assert.equal(removeAgent.mock.callCount(), 1);
});

test('with a focus floor, an agent on another floor that queues for Gabriel is still added (issue #192: one lobby office, not one per floor)', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
    { id: 'a', name: 'agent', activity: 'implementing', floor: 'agents-office' },
    { id: 'b', name: 'agent', activity: 'meeting', floor: 'widget-service', attention: 'waiting', waitMinutes: 3 },
    { id: 'c', name: 'agent', activity: 'idle', floor: 'widget-service', attention: 'your-turn', waitMinutes: 5 },
    { id: 'd', name: 'agent', activity: 'implementing', floor: 'widget-service' },
  ])));
  const addAgent = mock.fn();
  const manager = { getAgents: () => [], addAgent, setActivity: () => undefined, removeAgent: () => undefined } as unknown as AgentManager;
  const poller = new AgentPoller(manager, () => Date.now(), 'agents-office') as unknown as { poll(): Promise<void> };

  await poller.poll();

  assert.deepEqual(addAgent.mock.calls.map((call) => call.arguments[0].id), ['a', 'b', 'c']);
});

test('a cold wait from another floor is still dropped: only a fresh or aging wait queues into the lobby', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
    { id: 'cold', name: 'agent', activity: 'meeting', floor: 'widget-service', attention: 'waiting', waitMinutes: 2 * 24 * 60 },
  ])));
  const addAgent = mock.fn();
  const manager = { getAgents: () => [], addAgent, setActivity: () => undefined, removeAgent: () => undefined } as unknown as AgentManager;
  const poller = new AgentPoller(manager, () => Date.now(), 'agents-office') as unknown as { poll(): Promise<void> };

  await poller.poll();

  assert.equal(addAgent.mock.callCount(), 0);
});

test('a cross-floor queued agent leaving its wait (and its floor) is removed, same as any other agent', async () => {
  let agent = { id: 'a', name: 'agent', activity: 'meeting', floor: 'widget-service', attention: 'waiting', waitMinutes: 3 };
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([agent])));
  const addAgent = mock.fn();
  const removeAgent = mock.fn();
  const manager = { getAgents: () => [], addAgent, setActivity: () => undefined, removeAgent } as unknown as AgentManager;
  const poller = new AgentPoller(manager, () => Date.now(), 'agents-office') as unknown as { poll(): Promise<void> };

  await poller.poll();
  assert.equal(addAgent.mock.callCount(), 1);

  agent = { ...agent, activity: 'implementing', attention: undefined as never, waitMinutes: undefined as never };
  await poller.poll();
  assert.equal(removeAgent.mock.callCount(), 1, 'no longer waiting and on another floor: it leaves the lobby queue and stays off this floor');
});

test('onAgents (start) receives the raw, unfiltered answer even while a focus floor is set', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
    { id: 'a', name: 'agent', activity: 'implementing', floor: 'agents-office' },
    { id: 'b', name: 'agent', activity: 'implementing', floor: 'widget-service' },
  ])));
  const manager = { getAgents: () => [], addAgent: () => undefined, setActivity: () => undefined, removeAgent: () => undefined } as unknown as AgentManager;
  const poller = new AgentPoller(manager, () => Date.now(), 'agents-office') as unknown as { poll(): Promise<void> };
  let received: Array<{ id: string }> = [];
  Reflect.set(poller, 'onAgents', (agents: Array<{ id: string }>) => { received = agents; });

  await poller.poll();

  assert.deepEqual(received.map((a) => a.id), ['a', 'b']);
});

test('a skills field in the answer reaches the new agent\'s extras (issue #166 review: EXTRA_KEYS must carry it)', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
    { id: 'a', name: 'agent', activity: 'implementing', skills: ['write-a-skill', 'klever-mr'] },
  ])));
  const addAgent = mock.fn();
  const skillsManager = { getAgents: () => [], addAgent, setActivity: () => undefined, removeAgent: () => undefined } as unknown as AgentManager;
  const poller = new AgentPoller(skillsManager) as unknown as { poll(): Promise<void> };

  await poller.poll();

  assert.equal(addAgent.mock.callCount(), 1);
  assert.deepEqual(addAgent.mock.calls[0].arguments[0].extras, { skills: ['write-a-skill', 'klever-mr'] });
});

test('tools and lastEquipSource fields in the answer reach the new agent\'s extras (issue #167 round 2: EXTRA_KEYS must carry them)', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
    { id: 'a', name: 'agent', activity: 'implementing', tools: ['Bash', 'Read'], lastEquipSource: 'tool' },
  ])));
  const addAgent = mock.fn();
  const toolsManager = { getAgents: () => [], addAgent, setActivity: () => undefined, removeAgent: () => undefined } as unknown as AgentManager;
  const poller = new AgentPoller(toolsManager) as unknown as { poll(): Promise<void> };

  await poller.poll();

  assert.equal(addAgent.mock.callCount(), 1);
  assert.deepEqual(addAgent.mock.calls[0].arguments[0].extras, { tools: ['Bash', 'Read'], lastEquipSource: 'tool' });
});

test('an orchestrating field in the answer reaches the new agent\'s extras (issue #168 review: EXTRA_KEYS must carry it)', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
    { id: 'a', name: 'agent', activity: 'idle', attention: 'your-turn', waitMinutes: 3, orchestrating: true },
  ])));
  const addAgent = mock.fn();
  const orchestratingManager = { getAgents: () => [], addAgent, setActivity: () => undefined, removeAgent: () => undefined } as unknown as AgentManager;
  const poller = new AgentPoller(orchestratingManager) as unknown as { poll(): Promise<void> };

  await poller.poll();

  assert.equal(addAgent.mock.callCount(), 1);
  assert.deepEqual(addAgent.mock.calls[0].arguments[0].extras, { attention: 'your-turn', waitMinutes: 3, orchestrating: true });
});

// --- Guard (review on #183, the third PR with this exact bug): every key projectAgents can
// emit must be in EXTRA_KEYS, or the poller silently drops it and no client code ever sees it. ---

test('every key projectAgents (server/seam.ts) can emit on a live agent is carried by EXTRA_KEYS', async () => {
  const { projectAgents } = await import('../server/seam.js');
  const { EXTRA_KEYS } = await import('../src/agents/AgentPoller.js');
  const publicId = (raw: string) => raw;
  const enabledActions = new Set(['focus']);
  const [agent] = projectAgents([{
    id: 'a', parentId: 'p', provider: 'codex', name: 'agent', activity: 'implementing',
    internal: {},
    display: {
      attention: 'your-turn', orchestrating: true, waitMinutes: 3, groupKey: 'g', groupLabel: 'Group',
      badges: ['sally'], skills: ['write-a-skill'], tools: ['Bash'], lastEquipSource: 'tool',
      issues: [{ number: 1, title: 'a' }], roomKey: 'r',
      actions: ['focus'], role: 'librarian', stuck: true, floor: 'agents-office',
    },
  }], publicId, enabledActions);

  const coreKeys = new Set(['id', 'name', 'activity']);
  const emittedExtraKeys = Object.keys(agent).filter((key) => !coreKeys.has(key));
  const missing = emittedExtraKeys.filter((key) => !(EXTRA_KEYS as readonly string[]).includes(key));
  assert.deepEqual(missing, [], `projectAgents can emit ${JSON.stringify(missing)}, which EXTRA_KEYS never carries to the client`);
});

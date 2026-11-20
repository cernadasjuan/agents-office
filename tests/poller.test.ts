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

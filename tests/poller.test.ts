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

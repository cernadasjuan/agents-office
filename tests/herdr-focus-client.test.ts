import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AgentInfo } from '../src/agents/AgentData.js';
import { FocusClient, focusCardAction, type FetchLike } from '../plugins/herdr/client.js';
import { AgentCard, registerCardAction, resetCardRegistry } from '../src/ui/AgentCard.js';
import { SelectionState } from '../src/scene/Selection.js';

function installDocument(t: TestContext): HTMLElement {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  t.after(() => {
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'document');
  });
  return dom.window.document.body;
}

interface Sent { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }

function fakeFetch(replies: Array<{ status: number; body?: unknown }>): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, init: init as Sent['init'] });
    const reply = replies.shift() ?? { status: 500 };
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body ?? {} };
  };
  return { fetch, sent };
}

const ID = 'a'.repeat(64);
const focusable: AgentInfo = { id: ID, name: 'fix login', activity: 'implementing', extras: { actions: ['focus'] } };
const plain: AgentInfo = { id: 'b'.repeat(64), name: 'other', activity: 'idle' };

test('the focus client fetches the token, then posts only the public id with the token header', async () => {
  const { fetch, sent } = fakeFetch([{ status: 200, body: { token: 't'.repeat(64) } }, { status: 200, body: { ok: true } }]);
  const message = await new FocusClient(fetch).focus(ID);
  assert.equal(message, 'Focused in herdr');
  assert.equal(sent[0].url, '/api/actions/token');
  assert.equal(sent[1].url, '/api/actions/focus');
  assert.equal(sent[1].init?.method, 'POST');
  assert.equal(sent[1].init?.headers?.['Content-Type'], 'application/json');
  assert.equal(sent[1].init?.headers?.['X-Agents-Office-Token'], 't'.repeat(64));
  assert.deepEqual(JSON.parse(sent[1].init!.body!), { agent: ID });
});

test('a refused token is fetched again once (server restart), then the request is retried', async () => {
  const { fetch, sent } = fakeFetch([
    { status: 200, body: { token: 'old' } }, { status: 403 },
    { status: 200, body: { token: 'new' } }, { status: 200, body: { ok: true } },
  ]);
  assert.equal(await new FocusClient(fetch).focus(ID), 'Focused in herdr');
  assert.equal(sent.length, 4);
  assert.equal(sent[3].init?.headers?.['X-Agents-Office-Token'], 'new');
});

test('each failure gives a short text result', async () => {
  const cases: Array<[number, string]> = [[404, 'Agent not found in herdr'], [409, 'The herdr pane is gone'],
    [429, 'Too many focus requests, wait a minute'], [502, 'Focus failed']];
  for (const [status, text] of cases) {
    const { fetch } = fakeFetch([{ status: 200, body: { token: 't' } }, { status }]);
    assert.equal(await new FocusClient(fetch).focus(ID), text);
  }
  const { fetch } = fakeFetch([{ status: 404 }]);
  assert.equal(await new FocusClient(fetch).focus(ID), 'Focus is not enabled');
});

test('the focus card action applies only to agents that advertise focus, main or subagent', () => {
  const action = focusCardAction(new FocusClient(fakeFetch([]).fetch));
  assert.equal(action.label, 'Focus in herdr');
  assert.equal(action.available(focusable), true);
  assert.equal(action.available({ ...focusable, extras: { parentId: 'p', actions: ['focus'] } }), true);
  assert.equal(action.available(plain), false);
  assert.equal(action.available({ ...focusable, extras: {} }), false);
});

test('the action posts only on run (the click) and returns the result text', async () => {
  const { fetch, sent } = fakeFetch([{ status: 200, body: { token: 't' } }, { status: 200, body: { ok: true } }]);
  const action = focusCardAction(new FocusClient(fetch));
  assert.equal(sent.length, 0, 'nothing is sent before the click');
  assert.equal(await action.run(focusable), 'Focused in herdr');
  assert.deepEqual(JSON.parse(sent[1].init!.body!), { agent: ID });
});

test('the herdr plugin puts its button in the agent card, not in a card of its own', async (t) => {
  const body = installDocument(t);
  const selection = new SelectionState();
  body.innerHTML = '<div id="ui-panel"></div>';
  const card = new AgentCard(body, { anchor: body.querySelector<HTMLElement>('#ui-panel')!, selection });
  registerCardAction(focusCardAction(new FocusClient(fakeFetch([]).fetch)));
  t.after(() => resetCardRegistry());
  card.render([focusable, plain]);
  selection.select(ID);
  const buttons = [...body.querySelectorAll<HTMLButtonElement>('#agent-inspector .inspector-actions button')];
  assert.deepEqual(buttons.map((button) => button.textContent), ['Focus in herdr']);
  assert.equal(body.querySelector('#herdr-focus-card'), null);
  selection.select(plain.id);
  assert.equal(body.querySelectorAll('#agent-inspector .inspector-actions button').length, 0);
});

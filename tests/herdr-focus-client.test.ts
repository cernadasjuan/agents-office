import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AgentInfo } from '../src/agents/AgentData.js';
import { FocusClient, HerdrFocusCard, type FetchLike } from '../plugins/herdr/client.js';

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

test('the button shows only for a selected agent that advertises focus', (t) => {
  const body = installDocument(t);
  const card = new HerdrFocusCard(body, new FocusClient(fakeFetch([]).fetch));
  const button = () => body.querySelector<HTMLButtonElement>('#herdr-focus-card button')!;
  const root = () => body.querySelector<HTMLElement>('#herdr-focus-card')!;
  card.update([focusable, plain], null);
  assert.equal(root().hidden, true);
  card.update([focusable, plain], plain.id);
  assert.equal(root().hidden, true);
  card.update([focusable, plain], ID);
  assert.equal(root().hidden, false);
  assert.equal(button().textContent, 'Focus in herdr');
  card.update([{ ...focusable, extras: {} }], ID);
  assert.equal(root().hidden, true);
});

test('a click posts the focus request and shows the result as text', async (t) => {
  const body = installDocument(t);
  const { fetch, sent } = fakeFetch([{ status: 200, body: { token: 't' } }, { status: 200, body: { ok: true } }]);
  const card = new HerdrFocusCard(body, new FocusClient(fetch));
  card.update([{ ...focusable, name: '<img src=x onerror=alert(1)>' }], ID);
  assert.equal(body.querySelector('img'), null);
  await card.click();
  assert.deepEqual(JSON.parse(sent[1].init!.body!), { agent: ID });
  const toast = body.querySelector<HTMLElement>('#herdr-focus-toast')!;
  assert.equal(toast.hidden, false);
  assert.equal(toast.textContent, 'Focused in herdr');
  assert.equal(toast.children.length, 0);
});

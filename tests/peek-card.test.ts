import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AgentInfo } from '../src/agents/AgentData.js';
import { SelectionState } from '../src/scene/Selection.js';
import { AgentCard, registerCardPanel, resetCardRegistry, type CardPanel } from '../src/ui/AgentCard.js';
import { PEEK_URL, PeekPanel, type PeekFetch } from '../plugins/peek/client.js';

function setup(t: TestContext, panel?: CardPanel) {
  const dom = new JSDOM('<!doctype html><html><body><div id="ui-panel"></div></body></html>');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  t.after(() => {
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'document');
    resetCardRegistry();
  });
  if (panel) registerCardPanel(panel);
  const selection = new SelectionState();
  const card = new AgentCard(dom.window.document.body, { anchor: dom.window.document.getElementById('ui-panel')!, selection });
  const root = () => dom.window.document.getElementById('agent-inspector')!;
  return { card, selection, root };
}

const alpha: AgentInfo = { id: 'a'.repeat(64), name: 'alpha', activity: 'implementing', extras: { badges: ['amelia'] } };
const beta: AgentInfo = { id: 'b'.repeat(64), name: 'beta', activity: 'researching' };

const peekBody = {
  lines: [{ kind: 'tool', text: 'Bash · git commit' }, { kind: 'text', text: '<img src=x onerror=alert(1)> Should I merge?' }],
  question: 'Should I merge?',
  assets: [
    { kind: 'issue', label: 'agents-office#80', url: 'https://github.com/gabriel-amyot/agents-office/issues/80' },
    { kind: 'jira', label: 'KTP-1', url: 'javascript:alert(1)' },
  ],
  skills: ['tdd', 'crit:crit'],
  repos: ['agents-office'],
};

function fakeFetch(bodies: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchFn: PeekFetch = async (url) => {
    calls.push(url);
    const id = new URL(url, 'http://x').searchParams.get('agent') ?? '';
    const body = bodies[id];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
  return { calls, fetchFn };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a card panel shows only while available; without one the card is unchanged', (t) => {
  let on = false;
  const panel: CardPanel = { id: 'demo', available: () => on, render: (_agent, root) => { root.textContent = 'demo panel'; } };
  const { card, selection, root } = setup(t, panel);
  card.render([alpha]);
  selection.select(alpha.id);
  assert.equal(root().textContent?.includes('demo panel'), false);
  on = true;
  card.render([alpha]);
  assert.equal(root().textContent?.includes('demo panel'), true);
});

test('with peek on, the card shows the pinned question, Recent, Assets and Equipment for the selected agent', async (t) => {
  const { calls, fetchFn } = fakeFetch({ [alpha.id]: peekBody });
  const { card, selection, root } = setup(t, new PeekPanel({ fetch: fetchFn, isOn: () => true }));
  card.render([alpha, beta]);
  selection.select(alpha.id);
  await flush();
  assert.deepEqual(calls, [`${PEEK_URL}?agent=${alpha.id}`], 'one request, only for the selected agent');
  const q = (selector: string) => root().querySelector<HTMLElement>(selector);
  assert.equal(q('.peek-question')?.textContent, 'Should I merge?');
  const headings = [...root().querySelectorAll('.peek h4')].map((h) => h.textContent);
  assert.deepEqual(headings, ['Recent', 'Assets', 'Equipment']);
  const recent = [...root().querySelectorAll('.peek-recent li')].map((li) => li.textContent);
  assert.deepEqual(recent, ['Bash · git commit', '<img src=x onerror=alert(1)> Should I merge?']);
  assert.equal(root().querySelector('img'), null, 'text stays text');
  const links = [...root().querySelectorAll<HTMLAnchorElement>('.peek-assets a')];
  assert.deepEqual(links.map((a) => [a.textContent, a.href, a.rel]), [
    ['agents-office#80', 'https://github.com/gabriel-amyot/agents-office/issues/80', 'noopener noreferrer'],
  ]);
  assert.equal(root().querySelector('.peek-assets')?.textContent?.includes('KTP-1'), true, 'an unsafe URL stays plain text');
  const equipment = root().querySelector('.peek-equipment')?.textContent ?? '';
  for (const item of ['tdd', 'crit:crit', 'amelia', 'agents-office']) assert.ok(equipment.includes(item), item);
});

test('with peek off, the card has no peek sections and sends no request', async (t) => {
  const { calls, fetchFn } = fakeFetch({ [alpha.id]: peekBody });
  const { card, selection, root } = setup(t, new PeekPanel({ fetch: fetchFn, isOn: () => false }));
  card.render([alpha]);
  selection.select(alpha.id);
  await flush();
  assert.deepEqual(calls, []);
  assert.equal(root().querySelector('.peek'), null);
});

test('a late answer for the previous agent never shows on the new one', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchFn: PeekFetch = async (url) => {
    if (url.includes(alpha.id)) await gate;
    return { ok: true, status: 200, json: async () => (url.includes(alpha.id) ? peekBody : { lines: [{ kind: 'text', text: 'beta line' }], assets: [], skills: [], repos: [] }) };
  };
  const { card, selection, root } = setup(t, new PeekPanel({ fetch: fetchFn, isOn: () => true }));
  card.render([alpha, beta]);
  selection.select(alpha.id);
  selection.select(beta.id);
  await flush();
  release();
  await flush();
  const recent = [...root().querySelectorAll('.peek-recent li')].map((li) => li.textContent);
  assert.deepEqual(recent, ['beta line']);
});

test('polls refresh the peek at most every few seconds, and the Recent text can be hidden', async (t) => {
  let now = 0;
  const { calls, fetchFn } = fakeFetch({ [alpha.id]: peekBody });
  const panel = new PeekPanel({ fetch: fetchFn, isOn: () => true, now: () => now });
  const { card, selection, root } = setup(t, panel);
  card.render([alpha]);
  selection.select(alpha.id);
  await flush();
  card.render([alpha]);
  await flush();
  assert.equal(calls.length, 1);
  now = 5000;
  card.render([alpha]);
  await flush();
  assert.equal(calls.length, 2);

  panel.setTextHidden(true);
  assert.equal(root().querySelector<HTMLElement>('.peek-recent')?.hidden, true);
  assert.equal(root().querySelector<HTMLElement>('.peek-question')?.hidden, true);
  assert.equal(root().querySelector<HTMLElement>('.peek-assets')?.hidden, false);
});

test('a failed request shows a short note, not an error', async (t) => {
  const fetchFn: PeekFetch = async () => { throw new Error('offline'); };
  const { card, selection, root } = setup(t, new PeekPanel({ fetch: fetchFn, isOn: () => true }));
  card.render([alpha]);
  selection.select(alpha.id);
  await flush();
  assert.match(root().querySelector('.peek')?.textContent ?? '', /Recent lines are not available/);
});

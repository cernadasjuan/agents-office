import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { WorldSessionStory } from '../src/extensions.js';
import { SelectionState } from '../src/scene/Selection.js';
import { TombstoneCard } from '../src/ui/TombstoneCard.js';

/**
 * The tombstone card (issue #127) reuses the agent card's look (same CSS
 * classes, same dock spot) without reusing its code: a tombstone carries no
 * activity, wait or actions. The two cards share one selection, so whichever
 * id matches (an agent's or a tombstone's) is the only one that opens.
 */

function installDocument(t: TestContext): { document: Document; anchor: HTMLElement } {
  const dom = new JSDOM('<!doctype html><html><body><div id="ui-panel"></div></body></html>');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  t.after(() => {
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'document');
  });
  return { document: dom.window.document, anchor: dom.window.document.getElementById('ui-panel')! };
}

function makeCard(t: TestContext) {
  const { document, anchor } = installDocument(t);
  const selection = new SelectionState();
  const card = new TombstoneCard(document.body, { anchor, selection });
  const root = () => document.getElementById('tombstone-inspector')!;
  const text = (selector: string) => root().querySelector<HTMLElement>(selector)?.textContent ?? null;
  return { card, selection, root, text };
}

test('the card stays closed without a selection and opens on a tombstone selection', (t) => {
  const { card, selection, root, text } = makeCard(t);
  card.render([{ id: 'tomb-1', endedAt: '2026-11-18' }]);
  assert.equal(root().hidden, true);
  selection.select('tomb-1');
  assert.equal(root().hidden, false);
  assert.equal(text('.inspector-name'), 'Ended session');
  assert.equal(text('.inspector-facts dd'), '2026-11-18');
});

test('a tombstone with no known end date shows "unknown" rather than a blank', (t) => {
  const { card, selection, text } = makeCard(t);
  card.render([{ id: 'tomb-1' }]);
  selection.select('tomb-1');
  assert.equal(text('.inspector-facts dd'), 'unknown');
});

test('selecting an id that is not a known tombstone (an agent, most likely) keeps the card closed', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([{ id: 'tomb-1' }]);
  selection.select('agent-1');
  assert.equal(root().hidden, true);
});

test('the close button clears the selection and the card closes', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([{ id: 'tomb-1' }]);
  selection.select('tomb-1');
  root().querySelector<HTMLButtonElement>('.inspector-close')!.click();
  assert.equal(selection.selected, null);
  assert.equal(root().hidden, true);
});

test('a poll with fresh tombstone data updates an open card in place', (t) => {
  const { card, selection, text } = makeCard(t);
  card.render([{ id: 'tomb-1', endedAt: '2026-11-18' }]);
  selection.select('tomb-1');
  card.render([{ id: 'tomb-1', endedAt: '2026-11-19' }]);
  assert.equal(text('.inspector-facts dd'), '2026-11-19');
});

// --- Issue #159: the engraved name becomes the card's own title ---

test('a tombstone with a known session name shows it as the card title', (t) => {
  const { card, selection, text } = makeCard(t);
  card.render([{ id: 'tomb-1', name: 'tidy-otter' }]);
  selection.select('tomb-1');
  assert.equal(text('.inspector-name'), 'tidy-otter');
});

// --- Issue #160: the tombstone card tells the session's story ---

function story(overrides: Partial<ReturnType<typeof baseStory>> = {}) {
  return { ...baseStory(), ...overrides };
}

function baseStory(): WorldSessionStory {
  return {
    intent: 'Fix the git situation safely',
    personas: ['Amelia', 'Quinn'],
    counts: { done: 2, open: 1, abandoned: 0 },
    doneList: ['Cleared stale revert sequencer', 'Merged origin/main'],
    handoffs: ['2026-11-17-handoff.md'],
    issues: [{ label: 'gabriel-amyot/agents-office#160', url: 'https://github.com/gabriel-amyot/agents-office/issues/160' }],
  };
}

test('AC: the card shows the task, persona, intent, done list, handoffs and issue links', (t) => {
  const { card, selection, root, text } = makeCard(t);
  card.render([{ id: 'tomb-1', name: 'tidy-otter', story: story() }]);
  selection.select('tomb-1');
  assert.equal(text('.inspector-facts dd:nth-of-type(2)'), 'Amelia, Quinn');
  assert.equal(text('.inspector-intent'), 'Fix the git situation safely');
  const doneItems = [...root().querySelectorAll('.inspector-done li')].map((li) => li.textContent);
  assert.deepEqual(doneItems, ['2 done · 1 open · 0 abandoned', 'Cleared stale revert sequencer', 'Merged origin/main']);
  assert.deepEqual([...root().querySelectorAll('.inspector-handoffs li')].map((li) => li.textContent), ['2026-11-17-handoff.md']);
  const link = root().querySelector<HTMLAnchorElement>('.inspector-issues a')!;
  assert.equal(link.href, 'https://github.com/gabriel-amyot/agents-office/issues/160');
  assert.equal(link.textContent, 'gabriel-amyot/agents-office#160');
});

test('AC: a session with no linked issue yet shows an explicit row, not blank space', (t) => {
  const { card, selection, text } = makeCard(t);
  card.render([{ id: 'tomb-1', name: 'tidy-otter', story: story({ issues: [] }) }]);
  selection.select('tomb-1');
  assert.equal(text('.inspector-issues p'), 'No issue yet.');
});

test('AC: a missing archived record says so plainly, not with blank sections', (t) => {
  const { card, selection, root, text } = makeCard(t);
  card.render([{ id: 'tomb-1', name: 'agents-office-2026-11-18' }]);
  selection.select('tomb-1');
  assert.equal(text('.inspector-no-record'), 'No session record found.');
  assert.equal(root().querySelector<HTMLElement>('.inspector-story')?.hidden, true);
  assert.equal(root().querySelector<HTMLElement>('.inspector-done')?.hidden, true);
});

test('review round 2: an unresolved issue ref still shows, as plain text, never "No issue yet"', (t) => {
  const { card, selection, root, text } = makeCard(t);
  card.render([{ id: 'tomb-1', name: 'tidy-otter', story: story({ issues: [{ label: 'agents-office#160' }, { label: 'KTP-951' }] }) }]);
  selection.select('tomb-1');
  const items = [...root().querySelectorAll('.inspector-issues li')];
  assert.deepEqual(items.map((li) => li.textContent), ['agents-office#160', 'KTP-951']);
  assert.equal(items.every((li) => li.querySelector('a') === null), true, 'an unresolved ref is plain text, not a link');
  assert.equal(text('.inspector-issues p'), null);
});

test('a session with no personas shows a plain dash, not blank', (t) => {
  const { card, selection, text } = makeCard(t);
  card.render([{ id: 'tomb-1', name: 'tidy-otter', story: story({ personas: [] }) }]);
  selection.select('tomb-1');
  assert.equal(text('.inspector-facts dd:nth-of-type(2)'), '—');
});

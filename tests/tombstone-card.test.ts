import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
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

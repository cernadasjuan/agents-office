import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { SelectionState } from '../src/scene/Selection.js';
import { MissionIssuesCard } from '../src/ui/MissionIssuesCard.js';

/**
 * The mission issues card (issue #146) reuses the agent/tombstone card's look
 * (same CSS classes, same dock spot) and selection. A click on a war room's
 * issue board selects `issues:<room id>`; this card shows that room's issues
 * as real links when a repo is known, plain text otherwise.
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
  const card = new MissionIssuesCard(document.body, { anchor, selection });
  const root = () => document.getElementById('mission-issues-inspector')!;
  return { card, selection, root };
}

test('the card stays closed without a selection and opens on an issues-board selection', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([{ id: 'room-1', title: 'Office roadmap', issues: [{ number: 46, repo: 'gabriel-amyot/agents-office', title: 'Roadmap', state: 'open' }] }]);
  assert.equal(root().hidden, true);
  selection.select('issues:room-1');
  assert.equal(root().hidden, false);
  assert.equal(root().querySelector('.inspector-name')?.textContent, 'Office roadmap');
});

test('an issue with a repo is a real link; one with no repo is plain text', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([{ id: 'room-1', title: 'Office roadmap', issues: [
    { number: 46, repo: 'gabriel-amyot/agents-office', title: 'Roadmap', state: 'open' },
    { number: 7, title: 'Local only', state: 'closed' },
  ] }]);
  selection.select('issues:room-1');
  const items = [...root().querySelectorAll('li')];
  assert.equal(items.length, 2);
  const link = items[0].querySelector('a');
  assert.ok(link, 'the repo-carrying issue is a link');
  assert.equal(link!.href, 'https://github.com/gabriel-amyot/agents-office/issues/46');
  assert.equal(link!.target, '_blank');
  assert.equal(link!.textContent, 'gabriel-amyot/agents-office#46 Roadmap');
  assert.equal(items[1].querySelector('a'), null, 'no repo, no link');
  assert.equal(items[1].textContent, '#7 Local only');
});

test('a mission with no issues shows an empty state, not an error', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([{ id: 'room-1', title: 'Office roadmap', issues: [] }]);
  selection.select('issues:room-1');
  assert.equal(root().hidden, false);
  assert.match(root().textContent ?? '', /No linked issues/);
});

test('selecting an id that is not a known issues board (an agent or a tombstone) keeps the card closed', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([{ id: 'room-1', title: 'Office roadmap', issues: [] }]);
  selection.select('agent-1');
  assert.equal(root().hidden, true);
  selection.select('tomb-1');
  assert.equal(root().hidden, true);
});

test('the close button clears the selection and the card closes', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([{ id: 'room-1', title: 'Office roadmap', issues: [] }]);
  selection.select('issues:room-1');
  root().querySelector<HTMLButtonElement>('.inspector-close')!.click();
  assert.equal(selection.selected, null);
  assert.equal(root().hidden, true);
});

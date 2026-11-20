import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AgentInfo } from '../src/agents/AgentData.js';
import { SelectionState } from '../src/scene/Selection.js';
import {
  AgentCard, CARD_MAX_ISSUES, CARD_WIDTH_PX, figureShiftPx, registerCardAction, registerIssueLinker,
  resetCardRegistry, type CardAction,
} from '../src/ui/AgentCard.js';

function installDocument(t: TestContext): { document: Document; anchor: HTMLElement } {
  const dom = new JSDOM('<!doctype html><html><body><div id="ui-panel"></div></body></html>');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  t.after(() => {
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'document');
    resetCardRegistry();
  });
  return { document: dom.window.document, anchor: dom.window.document.getElementById('ui-panel')! };
}

function makeCard(t: TestContext) {
  const { document, anchor } = installDocument(t);
  const selection = new SelectionState();
  const card = new AgentCard(document.body, { anchor, selection });
  const root = () => document.getElementById('agent-inspector')!;
  const text = (selector: string) => root().querySelector<HTMLElement>(selector)?.textContent ?? null;
  return { document, card, selection, root, text };
}

const main: AgentInfo = {
  id: 'main-1', name: 'fix login', activity: 'meeting',
  extras: {
    attention: 'waiting', waitMinutes: 12, group: { id: 'g1', label: 'personal' },
    badges: ['amelia', 'quinn'], issues: [{ number: 78, title: 'Agent card' }, { number: 75, title: 'Bands' }],
  },
};
const sub: AgentInfo = { id: 'sub-1', name: '>> explore', activity: 'researching', extras: { parentId: 'main-1' } };
const codex: AgentInfo = { id: 'codex-1', name: 'codex run', activity: 'implementing', extras: { provider: 'codex' } };

test('the card stays closed without a selection and opens at once on a selection', (t) => {
  const { card, selection, root, text } = makeCard(t);
  card.render([main, sub]);
  assert.equal(root().hidden, true);
  selection.select('main-1');
  assert.equal(root().hidden, false, 'opens in the same task as the click, well within 200 ms');
  assert.equal(text('.inspector-name'), 'fix login');
});

test('the close button clears the selection and the card closes', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([main]);
  selection.select('main-1');
  root().querySelector<HTMLButtonElement>('.inspector-close')!.click();
  assert.equal(selection.selected, null);
  assert.equal(root().hidden, true);
});

test('a cleared selection (Esc) closes the card', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([main]);
  selection.select('main-1');
  selection.clear();
  assert.equal(root().hidden, true);
});

test('the card shows name, activity, attention band and wait, workspace, provider, personas', (t) => {
  const { card, selection, text, root } = makeCard(t);
  card.render([main, sub, codex]);
  selection.select('main-1');
  assert.equal(text('.inspector-activity'), 'Waiting for you');
  assert.equal(text('.inspector-wait'), 'Waiting for you · 12 min');
  assert.equal(text('.inspector-band'), 'fresh');
  assert.equal(text('.inspector-workspace'), 'personal');
  assert.equal(text('.inspector-provider'), 'Claude Code');
  assert.deepEqual([...root().querySelectorAll('.inspector-personas li')].map((li) => li.textContent), ['amelia', 'quinn']);

  selection.select('codex-1');
  assert.equal(text('.inspector-provider'), 'Codex');
  assert.equal(text('.inspector-activity'), 'Implementing');
  assert.equal(root().querySelector<HTMLElement>('.inspector-wait')!.hidden, true, 'no wait without attention');
  assert.equal(root().querySelector<HTMLElement>('.inspector-band')!.hidden, true);
  assert.equal(text('.inspector-workspace'), 'No workspace');
  assert.equal(text('.inspector-personas'), 'No personas');
});

test('the subagents list selects a subagent, and a subagent card links back to its parent', (t) => {
  const { card, selection, root, text } = makeCard(t);
  card.render([main, sub]);
  selection.select('main-1');
  const rows = [...root().querySelectorAll<HTMLButtonElement>('.inspector-subagents button')];
  assert.deepEqual(rows.map((row) => row.textContent), ['>> explore · Researching']);
  rows[0].click();
  assert.equal(selection.selected, 'sub-1');
  assert.equal(text('.inspector-subagents'), 'No subagents');
  const parent = root().querySelector<HTMLButtonElement>('.inspector-parent button')!;
  assert.equal(parent.textContent, 'fix login');
  parent.click();
  assert.equal(selection.selected, 'main-1');
});

test('issues: newest first as the API sends them, at most 10, else "No linked issues"', (t) => {
  const { card, selection, root, text } = makeCard(t);
  const many = Array.from({ length: 12 }, (_, i) => ({ number: 100 - i, title: `issue ${100 - i}` }));
  card.render([{ ...main, extras: { ...main.extras, issues: many } }, codex]);
  selection.select('main-1');
  const items = [...root().querySelectorAll('.inspector-issues li')].map((li) => li.textContent);
  assert.equal(CARD_MAX_ISSUES, 10);
  assert.equal(items.length, 10);
  assert.equal(items[0], '#100 issue 100');
  assert.equal(items[9], '#91 issue 91');
  selection.select('codex-1');
  assert.equal(root().querySelectorAll('.inspector-issues li').length, 0);
  assert.equal(text('.inspector-issues'), 'No linked issues');
});

test('a registered issue linker turns an issue into an https link; other URLs stay text', (t) => {
  const { card, selection, root } = makeCard(t);
  registerIssueLinker((issue) => issue.number === 78 ? 'https://github.com/o/agents-office/issues/78'
    : issue.number === 75 ? 'javascript:alert(1)' : null);
  card.render([main]);
  selection.select('main-1');
  const links = [...root().querySelectorAll<HTMLAnchorElement>('.inspector-issues a')];
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://github.com/o/agents-office/issues/78');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(links[0].textContent, '#78 Agent card');
});

test('all text goes through textContent: markup in names and titles stays text', (t) => {
  const { card, selection, root } = makeCard(t);
  const evil = '<img src=x onerror=alert(1)>';
  card.render([{ ...main, name: evil, extras: { ...main.extras, badges: [evil], issues: [{ number: 1, title: evil }], group: { id: 'g', label: evil } } },
    { ...sub, name: evil }]);
  selection.select('main-1');
  assert.equal(root().querySelector('img'), null);
  assert.equal(root().querySelector('.inspector-name')!.textContent, evil);
});

test('a click on another agent swaps the content in place without closing the card', (t) => {
  const { card, selection, root, text } = makeCard(t);
  card.render([main, codex]);
  selection.select('main-1');
  const before = root();
  let closed = false;
  new (before.ownerDocument.defaultView!.MutationObserver)(() => { if (before.hidden) closed = true; })
    .observe(before, { attributes: true, attributeFilter: ['hidden'] });
  selection.select('codex-1');
  assert.equal(root(), before, 'the same element');
  assert.equal(before.hidden, false);
  assert.equal(closed, false);
  assert.equal(text('.inspector-name'), 'codex run');
});

test('a poll updates the open card in place', (t) => {
  const { card, selection, root, text } = makeCard(t);
  card.render([main]);
  selection.select('main-1');
  const before = root();
  card.render([{ ...main, name: 'fix login v2', extras: { ...main.extras, waitMinutes: 40 } }]);
  assert.equal(root(), before);
  assert.equal(before.hidden, false);
  assert.equal(text('.inspector-name'), 'fix login v2');
  assert.equal(text('.inspector-wait'), 'Waiting for you · 40 min');
  assert.equal(text('.inspector-band'), 'aging');
});

test('without a registered action the card has no action button and no error', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([{ ...main, extras: { ...main.extras, actions: ['focus'] } }]);
  selection.select('main-1');
  assert.equal(root().querySelectorAll('.inspector-actions button').length, 0);
  assert.equal(root().querySelector<HTMLElement>('.inspector-actions')!.hidden, true);
});

test('a registered action shows only for agents it applies to, and a click shows its result as text', async (t) => {
  const { card, selection, root } = makeCard(t);
  const ran: string[] = [];
  const action: CardAction = {
    id: 'focus', label: 'Focus in herdr',
    available: (agent) => agent.extras?.actions?.includes('focus') === true,
    run: async (agent) => { ran.push(agent.id); return '<b>Focused</b>'; },
  };
  registerCardAction(action);
  card.render([{ ...main, extras: { ...main.extras, actions: ['focus'] } }, codex]);
  selection.select('codex-1');
  assert.equal(root().querySelectorAll('.inspector-actions button').length, 0);
  selection.select('main-1');
  const button = root().querySelector<HTMLButtonElement>('.inspector-actions button')!;
  assert.equal(button.textContent, 'Focus in herdr');
  assert.deepEqual(ran, [], 'nothing runs without the click');
  await card.runAction('focus');
  assert.deepEqual(ran, ['main-1']);
  const status = root().querySelector<HTMLElement>('.inspector-status')!;
  assert.equal(status.textContent, '<b>Focused</b>');
  assert.equal(status.querySelector('b'), null);
});

test('key F (issue #85): without a selection, nothing is ready and no error', (t) => {
  const { card } = makeCard(t);
  card.render([main]);
  assert.equal(card.keyboardFocus(), false);
});

test('key F: ready is true only once the selected agent offers the action, and no action runs', async (t) => {
  const { card, selection } = makeCard(t);
  const ran: string[] = [];
  registerCardAction({ id: 'focus', label: 'Focus in herdr', available: (agent) => agent.extras?.actions?.includes('focus') === true, run: async (agent) => { ran.push(agent.id); return 'ok'; } });
  card.render([main, { ...main, id: 'no-action', extras: undefined }]);

  selection.select('no-action');
  assert.equal(card.keyboardFocus(), false, 'no action offered for this agent');

  selection.select('main-1');
  assert.equal(card.keyboardFocus(), false, 'main has no actions in its extras');

  card.render([{ ...main, extras: { ...main.extras, actions: ['focus'] } }]);
  assert.equal(card.keyboardFocus(), true, 'the focus action is ready');
  assert.deepEqual(ran, [], 'S7: a keystroke never runs the write action, only a click does');
});

test('the card docks left of the panel, 360 px wide', (t) => {
  const { card, selection, root, document } = makeCard(t);
  const anchor = document.getElementById('ui-panel')!;
  anchor.getBoundingClientRect = () => ({ left: 900, top: 16, right: 1220, bottom: 400, width: 320, height: 384, x: 900, y: 16, toJSON: () => ({}) });
  Object.defineProperty(document.defaultView!, 'innerWidth', { value: 1236, configurable: true });
  card.render([main]);
  selection.select('main-1');
  assert.equal(CARD_WIDTH_PX, 360);
  assert.equal(root().style.width, '360px');
  assert.equal(root().style.right, `${1236 - 900 + 8}px`);
  assert.equal(root().style.top, '16px');
});

test('figureShiftPx centers the figure in the free area left of the card', () => {
  // 1280 px wide, card from 520 to 880: free area 0..520, its center 260, the canvas center 640.
  assert.equal(figureShiftPx(1280, 520), 380);
  // No card room: no shift.
  assert.equal(figureShiftPx(1280, 1400), 0);
  // A card too far left to leave a useful free area: no shift.
  assert.equal(figureShiftPx(800, 100), 0);
});

test('the card reports the shift for the camera from its docked position', (t) => {
  const { card, document } = makeCard(t);
  const anchor = document.getElementById('ui-panel')!;
  anchor.getBoundingClientRect = () => ({ left: 900, top: 16, right: 1220, bottom: 400, width: 320, height: 384, x: 900, y: 16, toJSON: () => ({}) });
  Object.defineProperty(document.defaultView!, 'innerWidth', { value: 1280, configurable: true });
  // Card left edge: 900 - 8 - 360 = 532, free center 266, shift 640 - 266.
  assert.equal(card.cameraShiftPx(), 374);
});

test('an issue with a known repository reads repo#N; without it, #N', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([{ ...main, extras: { ...main.extras, issues: [{ number: 12, title: '' }, { number: 78, title: 'Agent card', repo: 'agents-office' }] } }]);
  selection.select('main-1');
  assert.deepEqual([...root().querySelectorAll('.inspector-issues li')].map((li) => li.textContent), ['#12', 'agents-office#78 Agent card']);
});

test('an unchanged poll keeps the action and subagent buttons, so keyboard focus survives', (t) => {
  const { card, selection, root, document } = makeCard(t);
  registerCardAction({ id: 'focus', label: 'Focus in herdr', available: () => true, run: async () => 'ok' });
  card.render([main, sub]);
  selection.select('main-1');
  const button = root().querySelector<HTMLButtonElement>('.inspector-actions button')!;
  const subButton = root().querySelector<HTMLButtonElement>('.inspector-subagents button')!;
  button.focus();
  card.render([{ ...main, extras: { ...main.extras, waitMinutes: 13 } }, { ...sub }]);
  assert.equal(root().querySelector('.inspector-actions button'), button);
  assert.equal(root().querySelector('.inspector-subagents button'), subButton);
  assert.equal(document.activeElement, button);
});

test('the card docks again when the panel changes size (collapse or expand)', (t) => {
  const { card, selection, root, document } = makeCard(t);
  const anchor = document.getElementById('ui-panel')!;
  let left = 900;
  anchor.getBoundingClientRect = () => ({ left, top: 16, right: 1220, bottom: 400, width: 1220 - left, height: 384, x: left, y: 16, toJSON: () => ({}) });
  Object.defineProperty(document.defaultView!, 'innerWidth', { value: 1236, configurable: true });
  card.render([main]);
  selection.select('main-1');
  assert.equal(root().style.right, '344px');
  left = 1150;
  card.redock();
  assert.equal(root().style.right, '94px');
});

test('a finished subagent reads "Done" in its card and in the parent list; an idle main agent does not', (t) => {
  const { card, selection, root, text } = makeCard(t);
  const finished: AgentInfo = { ...sub, activity: 'idle' };
  const restingMain: AgentInfo = { id: 'main-2', name: 'parked', activity: 'idle' };
  card.render([main, finished, restingMain]);
  selection.select('main-1');
  assert.deepEqual([...root().querySelectorAll('.inspector-subagents button')].map((row) => row.textContent), ['>> explore · Done']);
  selection.select('sub-1');
  assert.equal(text('.inspector-activity'), 'Done');
  selection.select('main-2');
  assert.equal(text('.inspector-activity'), 'Taking a break');
});

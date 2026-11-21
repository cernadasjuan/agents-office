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
  assert.equal(text('.inspector-personas'), 'No personas or skills');
});

test('issue #171: the card shows a short, stable id and a provider mark next to the provider text', (t) => {
  const { card, selection, text, root } = makeCard(t);
  card.render([main, codex]);
  selection.select('main-1');
  assert.equal(text('.inspector-id'), `#${main.id.slice(0, 8)}`);
  assert.equal(root().querySelectorAll('.inspector-provider svg').length, 1, 'a mark, not a downloaded image');
  assert.equal(root().querySelector('.inspector-provider img'), null, 'never a downloaded brand asset');

  selection.select('codex-1');
  assert.equal(text('.inspector-id'), `#${codex.id.slice(0, 8)}`);
  assert.equal(text('.inspector-provider'), 'Codex', 'the text never disappears, only the mark changes shape');
  assert.equal(root().querySelectorAll('.inspector-provider svg').length, 1);
});

test('issue #166: the "Persona / Skills" row lists personas, then every skill used this session', (t) => {
  const withSkills: AgentInfo = {
    id: 'skilled-1', name: 'reviewer', activity: 'reviewing',
    extras: { badges: ['quinn'], skills: ['code-review', 'simplify'] },
  };
  const { card, selection, root } = makeCard(t);
  card.render([withSkills]);
  selection.select('skilled-1');
  const items = [...root().querySelectorAll('.inspector-personas li')];
  assert.deepEqual(items.map((li) => li.textContent), ['quinn', 'code-review', 'simplify']);
  assert.equal(items[0]!.classList.contains('skill'), false, 'a persona badge is not styled as a skill');
  assert.equal(items[1]!.classList.contains('skill'), true);
  assert.equal(items[2]!.classList.contains('skill'), true);
});

test('issue #166: without the skills plugin, the row falls back to personas only (graceful degradation)', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([main]); // main has badges, no skills field at all
  selection.select('main-1');
  const items = [...root().querySelectorAll('.inspector-personas li')];
  assert.deepEqual(items.map((li) => li.textContent), ['amelia', 'quinn']);
  assert.equal(items.every((li) => !li.classList.contains('skill')), true);
});

test('an idle agent with a your-turn wait shows "Your turn" in the header, not "Taking a break" (issue #168)', (t) => {
  const { card, selection, text } = makeCard(t);
  const idleYourTurn: AgentInfo = { id: 'idle-1', name: 'idle-1', activity: 'idle', extras: { attention: 'your-turn', waitMinutes: 5 } };
  card.render([idleYourTurn]);
  selection.select('idle-1');
  assert.equal(text('.inspector-activity'), 'Your turn', 'the override wins over the raw idle activity, the same as the panel row and the label');
  assert.equal(text('.inspector-wait'), 'Your turn · 5 min');
});

// --- Issue #170 review: labels have pointer-events none, so a hover title there never shows.
// The card's status line is the always-reachable fallback. ---

test('a fresh block shows the beacon hint in the card; an aging block does not (issue #170 review)', (t) => {
  const { card, selection, root, text } = makeCard(t);
  const fresh: AgentInfo = { id: 'fresh-1', name: 'fresh-1', activity: 'implementing', extras: { attention: 'waiting', waitMinutes: 4 } };
  const aging: AgentInfo = { id: 'aging-1', name: 'aging-1', activity: 'implementing', extras: { attention: 'waiting', waitMinutes: 120 } };
  card.render([fresh, aging]);

  selection.select('fresh-1');
  assert.ok((text('.inspector-beacon-hint') ?? '').length > 0, 'the beacon is on: the hint explains it without opening the legend');
  assert.equal(root().querySelector<HTMLElement>('.inspector-beacon-hint')!.hidden, false);

  selection.select('aging-1');
  assert.equal(root().querySelector<HTMLElement>('.inspector-beacon-hint')!.hidden, true, 'no beacon at this age: no hint either');
});

test('an orchestrating your-turn never shows the beacon hint, even with a fresh wait (issue #168, #170 review)', (t) => {
  const { card, selection, root } = makeCard(t);
  const orchestrating: AgentInfo = { id: 'orc-1', name: 'orc-1', activity: 'idle', extras: { attention: 'your-turn', waitMinutes: 2, orchestrating: true } };
  card.render([orchestrating]);
  selection.select('orc-1');
  assert.equal(root().querySelector<HTMLElement>('.inspector-beacon-hint')!.hidden, true, 'orchestrating never calls for you: no beacon, no hint');
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

test('key F (issue #85 fix): without a ready action, pulseFocus does nothing and no error', (t) => {
  const { card } = makeCard(t);
  card.render([main]);
  card.pulseFocus();
});

test('key F fix: pulseFocus highlights the ready action button for about 1.5s, and never runs it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { card, selection, root } = makeCard(t);
  const ran: string[] = [];
  registerCardAction({ id: 'focus', label: 'Focus in herdr', available: (agent) => agent.extras?.actions?.includes('focus') === true, run: async (agent) => { ran.push(agent.id); return 'ok'; } });
  card.render([{ ...main, extras: { ...main.extras, actions: ['focus'] } }]);
  selection.select('main-1');

  const button = root().querySelector<HTMLButtonElement>('.inspector-actions button')!;
  assert.equal(button.classList.contains('pulse'), false, 'no pulse before F');

  card.pulseFocus();
  assert.equal(button.classList.contains('pulse'), true, 'F highlights the button');
  assert.notEqual(root().ownerDocument.activeElement, button, 'F never moves DOM focus onto the button (Enter must not then send it)');
  assert.deepEqual(ran, [], 'S7: a keystroke never runs the write action, only a click does');

  t.mock.timers.tick(1500);
  assert.equal(button.classList.contains('pulse'), false, 'the highlight clears after about 1.5s');
  assert.deepEqual(ran, [], 'still never ran');
});

test('key F fix: a second F while the pulse is active restarts the 1.5s window instead of stacking timers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { card, selection, root } = makeCard(t);
  registerCardAction({ id: 'focus', label: 'Focus in herdr', available: () => true, run: async () => 'ok' });
  card.render([main]);
  selection.select('main-1');
  const button = root().querySelector<HTMLButtonElement>('.inspector-actions button')!;

  card.pulseFocus();
  t.mock.timers.tick(1000);
  card.pulseFocus();
  t.mock.timers.tick(1000);
  assert.equal(button.classList.contains('pulse'), true, 'the second F kept the highlight going past the first window');

  t.mock.timers.tick(500);
  assert.equal(button.classList.contains('pulse'), false);
});

test('key F (#214): triageFocus runs the ready action directly, no click needed', async (t) => {
  const { card, selection } = makeCard(t);
  const ran: string[] = [];
  registerCardAction({ id: 'focus', label: 'Focus in herdr', available: (agent) => agent.extras?.actions?.includes('focus') === true, run: async (agent) => { ran.push(agent.id); return 'Focused in herdr'; } });
  card.render([{ ...main, extras: { ...main.extras, actions: ['focus'] } }]);
  selection.select('main-1');

  await card.triageFocus();
  assert.deepEqual(ran, ['main-1'], 'F sends the same request the button click would');
});

test('key F (#214): without a ready action, triageFocus does nothing and no error', async (t) => {
  const { card } = makeCard(t);
  card.render([main]);
  await card.triageFocus();
});

test('key F (#214 review): a second F while the first request is still in flight does not send a duplicate', async (t) => {
  const { card, selection } = makeCard(t);
  const ran: string[] = [];
  let resolveFirst: (value: string) => void = () => {};
  const pending = new Promise<string>((resolve) => { resolveFirst = resolve; });
  registerCardAction({
    id: 'focus',
    label: 'Focus in herdr',
    available: (agent) => agent.extras?.actions?.includes('focus') === true,
    run: async (agent) => { ran.push(agent.id); return pending; },
  });
  card.render([{ ...main, extras: { ...main.extras, actions: ['focus'] } }]);
  selection.select('main-1');

  const first = card.triageFocus();
  const second = card.triageFocus(); // simulates a held key's auto-repeat, or a fast double-tap
  resolveFirst('Focused in herdr');
  await Promise.all([first, second]);
  assert.deepEqual(ran, ['main-1'], 'only one request went out while the first was pending');
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

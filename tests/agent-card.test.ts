import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AgentInfo } from '../src/agents/AgentData.js';
import { SelectionState } from '../src/scene/Selection.js';
import {
  AgentCard, CARD_EQUIP_MAX, CARD_MAX_ISSUES, CARD_WIDTH_PX, figureShiftPx, registerCardAction, registerIssueLinker,
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

test('the card shows name, activity, attention band and wait, workspace, provider, persona column', (t) => {
  const { card, selection, text, root } = makeCard(t);
  card.render([main, sub, codex]);
  selection.select('main-1');
  assert.equal(text('.inspector-activity'), 'Waiting for you · 12 min');
  assert.equal(root().querySelector<HTMLElement>('.inspector-wait')!.hidden, true, 'the header already carries the elapsed time; the wait line never repeats it');
  assert.equal(text('.inspector-band'), 'fresh');
  assert.equal(text('.inspector-workspace'), 'personal');
  assert.equal(text('.inspector-provider'), 'Claude Code');
  assert.deepEqual([...root().querySelectorAll('.equip-col-persona li')].map((li) => li.textContent), ['amelia', 'quinn']);

  selection.select('codex-1');
  assert.equal(text('.inspector-provider'), 'Codex');
  assert.equal(text('.inspector-activity'), 'Implementing');
  assert.equal(root().querySelector<HTMLElement>('.inspector-wait')!.hidden, true, 'no wait without attention');
  assert.equal(root().querySelector<HTMLElement>('.inspector-band')!.hidden, true);
  assert.equal(text('.inspector-workspace'), 'No workspace');
  assert.equal(text('.equip-col-persona .equip-empty'), 'No persona');
  assert.equal(text('.equip-col-skills .equip-empty'), 'No skills');
  assert.equal(text('.equip-col-repos .equip-empty'), 'No repos');
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

test('AC1: Persona, Skills and Repos are three separate columns, each with its own icon, no other place repeats the text', (t) => {
  const withEquipment: AgentInfo = {
    id: 'skilled-1', name: 'reviewer', activity: 'reviewing',
    extras: { badges: ['quinn', 'sally'], skills: ['code-review', 'simplify', 'write-a-skill'], repos: ['agents-office'] },
  };
  const { card, selection, root } = makeCard(t);
  card.render([withEquipment]);
  selection.select('skilled-1');

  const personaItems = [...root().querySelectorAll('.equip-col-persona li')];
  const skillItems = [...root().querySelectorAll('.equip-col-skills li')];
  const repoItems = [...root().querySelectorAll('.equip-col-repos li')];
  assert.deepEqual(personaItems.map((li) => li.textContent), ['quinn', 'sally']);
  assert.deepEqual(skillItems.map((li) => li.textContent), ['code-review', 'simplify', 'write-a-skill']);
  assert.deepEqual(repoItems.map((li) => li.textContent), ['agents-office']);
  assert.equal(skillItems.every((li) => li.classList.contains('skill')), true, 'skills keep the gear-dot style');
  assert.equal(personaItems.every((li) => !li.classList.contains('skill')), true, 'a persona badge is not styled as a skill');

  assert.equal(root().querySelectorAll('.equip-col-persona svg.persona-mark').length, 1);
  assert.equal(root().querySelectorAll('.equip-col-skills .skill-mark').length, 1);
  assert.equal(root().querySelectorAll('.equip-col-repos svg.repo-mark').length, 1);

  // No other place on the card repeats this text (AC1, AC4: the old merged list is gone).
  assert.equal(root().querySelector('.inspector-personas'), null);
});

test('issue #166: without the skills plugin, the Skills column shows its own empty state (graceful degradation)', (t) => {
  const { card, selection, root, text } = makeCard(t);
  card.render([main]); // main has badges, no skills or repos field at all
  selection.select('main-1');
  assert.deepEqual([...root().querySelectorAll('.equip-col-persona li')].map((li) => li.textContent), ['amelia', 'quinn']);
  assert.equal(text('.equip-col-skills .equip-empty'), 'No skills');
  assert.equal(text('.equip-col-repos .equip-empty'), 'No repos');
});

test('AC2: columns grow independently — 4 skills and 0 repos never misalign', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([{ ...main, extras: { ...main.extras, skills: ['a', 'b', 'c', 'd'], repos: [] } }]);
  selection.select('main-1');
  assert.equal(root().querySelectorAll('.equip-col-skills li').length, 4);
  assert.equal(root().querySelector('.equip-col-repos .equip-empty')!.textContent, 'No repos');
});

test('AC3: overflow caps a column at CARD_EQUIP_MAX rows with a final "+N more" row', (t) => {
  const { card, selection, root } = makeCard(t);
  const skills = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  card.render([{ ...main, extras: { ...main.extras, skills } }]);
  selection.select('main-1');
  assert.equal(CARD_EQUIP_MAX, 4);
  const items = [...root().querySelectorAll('.equip-col-skills li')];
  assert.equal(items.length, 5, '4 rows plus one "+N more" row');
  assert.deepEqual(items.slice(0, 4).map((li) => li.textContent), ['a', 'b', 'c', 'd']);
  assert.equal(items[4]!.textContent, '+3 more');
  assert.equal(items[4]!.classList.contains('equip-more'), true);
});

test('a column row carries the full label as a hover title, for a truncated cell (column rule: no wrapping)', (t) => {
  const { card, selection, root } = makeCard(t);
  card.render([{ ...main, extras: { ...main.extras, skills: ['a-very-long-skill-name-that-would-wrap'] } }]);
  selection.select('main-1');
  const item = root().querySelector<HTMLLIElement>('.equip-col-skills li')!;
  assert.equal(item.title, 'a-very-long-skill-name-that-would-wrap');
});

test('AC7: the Repos column shows its own empty state when peek is off (no spinner, no gap)', (t) => {
  const { card, selection, text } = makeCard(t);
  card.render([main]); // no extras.repos at all, same as peek never having loaded
  selection.select('main-1');
  assert.equal(text('.equip-col-repos .equip-empty'), 'No repos');
});

test('an idle agent with a your-turn wait shows "Your turn" in the header, not "Taking a break" (issue #168)', (t) => {
  const { card, selection, text, root } = makeCard(t);
  const idleYourTurn: AgentInfo = { id: 'idle-1', name: 'idle-1', activity: 'idle', extras: { attention: 'your-turn', waitMinutes: 5 } };
  card.render([idleYourTurn]);
  selection.select('idle-1');
  assert.equal(text('.inspector-activity'), 'Your turn · 5 min', 'the override wins over the raw idle activity, the same as the panel row and the label');
  assert.equal(root().querySelector<HTMLElement>('.inspector-wait')!.hidden, true);
});

// Issue #216 follow-up (Sally, IDE usability review): the duplicate-text bug was never
// specific to 'your-turn' with no waitMinutes — AC6 only ever tested that one case. Every
// attention state built the same sentence twice (header bare, wait line the same sentence
// plus a time suffix), so the two lines always shared an identical leading phrase. One test
// per state below, covering both the "no waitMinutes" and the "has waitMinutes" shape for
// each: the wait line must stay hidden and empty in every one, since the header alone now
// carries the complete sentence.
for (const [label, attention, waitMinutes, expectedActivity] of [
  ['your-turn, no wait', 'your-turn', undefined, 'Your turn'],
  ['your-turn, with wait', 'your-turn', 5, 'Your turn · 5 min'],
  ['waiting, no wait', 'waiting', undefined, 'Waiting for you'],
  ['waiting, with wait', 'waiting', 40, 'Waiting for you · 40 min'],
] as const) {
  test(`AC6 (#216 follow-up): "${label}" renders its sentence exactly once, never in both the header and the wait line`, (t) => {
    const { card, selection, root } = makeCard(t);
    const agent: AgentInfo = { id: 'state-1', name: 'state-1', activity: 'idle', extras: { attention, waitMinutes } };
    card.render([agent]);
    selection.select('state-1');
    assert.equal(root().querySelectorAll('.inspector-activity, .inspector-wait').length, 2, 'both elements still exist');
    assert.equal(root().querySelector('.inspector-activity')!.textContent, expectedActivity);
    const wait = root().querySelector<HTMLElement>('.inspector-wait')!;
    assert.equal(wait.hidden, true, 'the wait line never repeats the header, with or without an elapsed time');
    assert.equal(wait.textContent, '', 'and carries no text while hidden');
    const occurrences = [...root().querySelectorAll('.inspector-activity, .inspector-wait')]
      .filter((el) => !(el as HTMLElement).hidden).map((el) => el.textContent).join('|');
    const phrase = attention === 'your-turn' ? 'Your turn' : 'Waiting for you';
    assert.equal((occurrences.match(new RegExp(phrase, 'g')) ?? []).length, 1, `"${phrase}" appears exactly once among the visible elements`);
  });
}

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
  assert.equal(text('.inspector-activity'), 'Waiting for you · 40 min', 'the header picks up the new waitMinutes on the next poll');
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

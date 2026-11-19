import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { AgentPanel, isDemoMode, setupPanelCollapse, type AgentPanelOptions } from '../src/ui/AgentPanel.js';
import type { AgentInfo } from '../src/agents/AgentData.js';

function installDocument(t: TestContext): HTMLElement {
  const dom = new JSDOM('<!doctype html><html><body><div id="ui-panel"><button id="toggle"></button><div id="agent-list"></div></div></body></html>');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  t.after(() => {
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'document');
  });
  return dom.window.document.getElementById('agent-list')!;
}

function makePanel(t: TestContext, options: AgentPanelOptions = {}): { list: HTMLElement; panel: AgentPanel } {
  const list = installDocument(t);
  return { list, panel: new AgentPanel(list, options) };
}

const waiting = (id: string, waitMinutes?: number): AgentInfo => ({ id, name: id, activity: 'meeting', extras: { attention: 'waiting', waitMinutes } });
const yourTurn = (id: string, waitMinutes?: number): AgentInfo => ({ id, name: id, activity: 'idle', extras: { attention: 'your-turn', waitMinutes } });
const working = (id: string, parentId?: string): AgentInfo => ({ id, name: id, activity: 'implementing', extras: parentId ? { parentId } : undefined });
const idle = (id: string): AgentInfo => ({ id, name: id, activity: 'idle' });

function rowIds(list: HTMLElement, group: string): string[] {
  return [...list.querySelectorAll<HTMLElement>(`.triage-group[data-group="${group}"] .agent-card`)].map((row) => row.dataset.agentId!);
}

function groupOf(list: HTMLElement, group: string): HTMLElement {
  return list.querySelector<HTMLElement>(`.triage-group[data-group="${group}"]`)!;
}

function card(list: HTMLElement, id: string): HTMLElement {
  return list.querySelector<HTMLElement>(`.agent-card[data-agent-id="${id}"]`)!;
}

test('agents go to the group of what the user must do, in a fixed group order', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([idle('i1'), working('w1'), yourTurn('y1', 3), waiting('n1', 12)]);

  const groups = [...list.querySelectorAll<HTMLElement>('.triage-group')].map((group) => group.dataset.group);
  assert.deepEqual(groups, ['needs-you', 'your-turn', 'working', 'idle', 'cold']);
  assert.deepEqual(rowIds(list, 'needs-you'), ['n1']);
  assert.deepEqual(rowIds(list, 'your-turn'), ['y1']);
  assert.deepEqual(rowIds(list, 'working'), ['w1']);
  assert.deepEqual(rowIds(list, 'idle'), ['i1']);
});

test('needs you and your turn sort fresh before aging, the longest wait first inside each band', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([waiting('n1', 2), waiting('n2', 30), waiting('n3'), waiting('n4', 12), waiting('n5', 90), yourTurn('y1', 1), yourTurn('y2', 40)]);

  assert.deepEqual(rowIds(list, 'needs-you'), ['n4', 'n1', 'n3', 'n5', 'n2']);
  assert.deepEqual(rowIds(list, 'your-turn'), ['y1', 'y2']);
});

test('cold waits leave needs you and your turn for a collapsed Cold group at the bottom, with a count', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([waiting('n1', 5), waiting('old-block', 2 * 24 * 60), yourTurn('old-turn', 24 * 60), yourTurn('y1', 30), idle('i1')]);

  const groups = [...list.querySelectorAll<HTMLElement>('.triage-group')].map((group) => group.dataset.group);
  assert.equal(groups[groups.length - 1], 'cold');
  assert.deepEqual(rowIds(list, 'needs-you'), ['n1']);
  assert.deepEqual(rowIds(list, 'your-turn'), ['y1']);
  assert.deepEqual(rowIds(list, 'cold'), ['old-block', 'old-turn']);
  const cold = groupOf(list, 'cold');
  assert.equal(cold.hidden, false, 'a cold wait never vanishes');
  assert.equal(cold.classList.contains('collapsed'), true);
  assert.equal(cold.querySelector('.triage-group-header')?.textContent, '▸ Cold · 2');
  assert.equal(list.querySelector<HTMLElement>('.triage-chip[data-group="cold"]')?.textContent, '2 cold');
  assert.equal(card(list, 'old-block').querySelector('.agent-wait')?.textContent, '2 d');
});

test('a needs-you row shows the name, the wait and the activity', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([{ id: 'n1', name: 'Fix login', activity: 'meeting', extras: { attention: 'waiting', waitMinutes: 12 } }]);
  const row = card(list, 'n1');

  assert.equal(row.querySelector('.agent-name')?.textContent, 'Fix login');
  assert.equal(row.querySelector('.agent-wait')?.textContent, '12 min');
  assert.equal(row.querySelector('.agent-activity')?.textContent, 'Waiting for you');
});

test('subagents nest under their parent in working, indented', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([working('sub-b', 'b'), working('a'), working('b'), working('sub-a', 'a'), working('sub-x', 'gone')]);

  assert.deepEqual(rowIds(list, 'working'), ['a', 'sub-a', 'b', 'sub-b', 'sub-x']);
  assert.equal(card(list, 'sub-a').classList.contains('subagent'), true);
  assert.equal(card(list, 'sub-b').classList.contains('subagent'), true);
  assert.equal(card(list, 'a').classList.contains('subagent'), false);
  assert.equal(card(list, 'sub-x').classList.contains('subagent'), false, 'a subagent without its parent in the group is not indented');
});

test('your turn collapses by default above 5 agents, idle always collapses, working stays open', (t) => {
  const { list, panel } = makePanel(t);
  const five = ['y1', 'y2', 'y3', 'y4', 'y5'].map((id) => yourTurn(id, 1));
  panel.render([...five, working('w1'), idle('i1')]);
  assert.equal(groupOf(list, 'your-turn').classList.contains('collapsed'), false);
  assert.equal(groupOf(list, 'working').classList.contains('collapsed'), false);
  assert.equal(groupOf(list, 'idle').classList.contains('collapsed'), true);

  panel.render([...five, yourTurn('y6', 1), working('w1'), idle('i1')]);
  const group = groupOf(list, 'your-turn');
  assert.equal(group.classList.contains('collapsed'), true);
  assert.match(group.querySelector('.triage-group-header')!.textContent!, /6/);
});

test('a group the user opens stays open across updates', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([idle('i1'), idle('i2')]);
  groupOf(list, 'idle').querySelector<HTMLElement>('.triage-group-header')!.click();
  assert.equal(groupOf(list, 'idle').classList.contains('collapsed'), false);

  panel.render([idle('i1'), idle('i2'), idle('i3')]);
  assert.equal(groupOf(list, 'idle').classList.contains('collapsed'), false);
});

test('the chips count each group, and an empty group shows no chip and no section', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([waiting('n1', 1), waiting('n2', 2), yourTurn('y1'), working('w1'), working('w2'), working('s1', 'w1'), idle('i1')]);

  const chips = [...list.querySelectorAll<HTMLElement>('.triage-chip')].filter((chip) => !chip.hidden).map((chip) => chip.textContent);
  assert.deepEqual(chips, ['2 need you', '1 your turn', '3 working', '1 idle']);

  panel.render([working('w1')]);
  const visible = [...list.querySelectorAll<HTMLElement>('.triage-chip')].filter((chip) => !chip.hidden).map((chip) => chip.textContent);
  assert.deepEqual(visible, ['1 working']);
  assert.equal(groupOf(list, 'needs-you').hidden, true);
});

test('a click on a chip opens its group', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([idle('i1')]);
  const chip = list.querySelector<HTMLElement>('.triage-chip[data-group="idle"]')!;
  chip.click();
  assert.equal(groupOf(list, 'idle').classList.contains('collapsed'), false);
});

test('updates keep the row elements, the order changes in place and the scroll stays', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([waiting('n1', 1), waiting('n2', 5), working('w1')]);
  const n1 = card(list, 'n1');
  const w1 = card(list, 'w1');
  list.scrollTop = 40;

  panel.render([waiting('n1', 9), waiting('n2', 6), { ...working('w1'), activity: 'testing' }]);

  assert.equal(card(list, 'n1'), n1);
  assert.equal(card(list, 'w1'), w1);
  assert.deepEqual(rowIds(list, 'needs-you'), ['n1', 'n2']);
  assert.equal(w1.querySelector('.agent-activity')?.textContent, 'Running tests');
  assert.equal(list.scrollTop, 40);
});

test('a row moves to its new group as the same element', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([working('a')]);
  const row = card(list, 'a');
  panel.render([waiting('a', 3)]);
  assert.equal(card(list, 'a'), row);
  assert.deepEqual(rowIds(list, 'needs-you'), ['a']);
  assert.deepEqual(rowIds(list, 'working'), []);
});

test('rows follow agents that arrive and leave', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([idle('a'), idle('b')]);
  panel.render([idle('b')]);
  assert.equal(list.querySelectorAll('.agent-card').length, 1);
});

test('markup in names, badges and activities stays text', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([{ id: 'a', name: '<b>A</b>', activity: 'implementing', extras: { badges: ['<i>Sally</i>'] } }]);
  assert.equal(list.querySelector('b'), null);
  assert.equal(list.querySelector('i'), null);
  assert.equal(card(list, 'a').querySelector('.agent-name')?.textContent, '<b>A</b>');
  assert.equal(card(list, 'a').querySelector('.agent-badge')?.textContent, '<i>Sally</i>');
});

test('codex agents show their provider tag and personas show as chips', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([
    { id: 'c', name: 'C', activity: 'implementing', extras: { provider: 'codex' } },
    { id: 'p', name: 'P', activity: 'implementing', extras: { badges: ['Architect', 'Dev'] } },
    working('plain'),
  ]);
  assert.equal(card(list, 'c').querySelector('.agent-provider')?.textContent, 'codex');
  assert.deepEqual([...card(list, 'p').querySelectorAll('.agent-badge')].map((chip) => chip.textContent), ['Architect', 'Dev']);
  assert.equal(card(list, 'plain').querySelector('.agent-provider'), null);
  assert.equal(card(list, 'plain').querySelector('.agent-badge'), null);
});

test('without attention data every agent is working or idle, as before', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([working('w1'), idle('i1')]);
  assert.deepEqual(rowIds(list, 'working'), ['w1']);
  assert.deepEqual(rowIds(list, 'idle'), ['i1']);
  assert.equal(groupOf(list, 'needs-you').hidden, true);
  assert.equal(groupOf(list, 'your-turn').hidden, true);
});

test('a click on a row selects the agent', (t) => {
  const selected: string[] = [];
  const { list, panel } = makePanel(t, { onSelect: (id) => selected.push(id) });
  panel.render([working('a'), waiting('b', 2)]);
  card(list, 'b').click();
  card(list, 'a').querySelector<HTMLElement>('.agent-name')!.click();
  assert.deepEqual(selected, ['b', 'a']);
});

test('the selected row is marked and the mark moves with the selection', (t) => {
  const { list, panel } = makePanel(t, { onSelect: () => undefined });
  panel.render([idle('a'), idle('b')]);

  panel.setSelected('a');
  assert.equal(card(list, 'a').classList.contains('selected'), true);
  panel.setSelected('b');
  assert.equal(card(list, 'a').classList.contains('selected'), false);
  assert.equal(card(list, 'b').classList.contains('selected'), true);
  panel.setSelected(null);
  assert.equal(list.querySelectorAll('.selected').length, 0);
});

test('a row for an agent that is already selected arrives marked', (t) => {
  const { list, panel } = makePanel(t, { onSelect: () => undefined });
  panel.setSelected('a');
  panel.render([idle('a')]);
  assert.equal(card(list, 'a').classList.contains('selected'), true);
});

test('without a select handler a row does nothing and is not marked clickable', (t) => {
  const { list, panel } = makePanel(t);
  panel.render([idle('a')]);
  const row = card(list, 'a');
  row.click();
  assert.equal(row.classList.contains('selectable'), false);
});

test('by default rows have no activity menu', (t) => {
  const { list, panel } = makePanel(t, { onPick: () => undefined });
  panel.render([working('a'), idle('b')]);
  assert.equal(list.querySelector('select'), null);
});

test('demo mode shows the activity menu, and a menu change picks without selecting', (t) => {
  const picks: Array<[string, string]> = [];
  const selected: string[] = [];
  const { list, panel } = makePanel(t, { demo: true, onPick: (id, activity) => picks.push([id, activity]), onSelect: (id) => selected.push(id) });
  panel.render([working('a')]);
  const menu = list.querySelector('select')!;
  assert.equal(menu.value, 'implementing');

  menu.value = 'testing';
  menu.dispatchEvent(new menu.ownerDocument.defaultView!.Event('change', { bubbles: true }));
  menu.click();

  assert.deepEqual(picks, [['a', 'testing']]);
  assert.deepEqual(selected, []);
});

test('in demo mode an update moves the menu value in place, unless the menu has focus', (t) => {
  const { list, panel } = makePanel(t, { demo: true, onPick: () => undefined });
  panel.render([working('a')]);
  const menu = list.querySelector('select')!;
  panel.render([{ ...working('a'), activity: 'researching' }]);
  assert.equal(list.querySelector('select'), menu);
  assert.equal(menu.value, 'researching');

  menu.focus();
  panel.render([{ ...working('a'), activity: 'testing' }]);
  assert.equal(menu.value, 'researching');
});

test('?demo=1 turns demo mode on, anything else leaves it off', () => {
  assert.equal(isDemoMode('?demo=1'), true);
  assert.equal(isDemoMode('?layout=activity&demo=1'), true);
  assert.equal(isDemoMode(''), false);
  assert.equal(isDemoMode('?demo=0'), false);
  assert.equal(isDemoMode('?demo=true'), false);
});

test('the collapse button hides the panel body and the choice is remembered', (t) => {
  installDocument(t);
  const root = document.getElementById('ui-panel')!;
  const button = document.getElementById('toggle')!;
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };

  setupPanelCollapse(root, button, storage);
  assert.equal(root.classList.contains('collapsed'), false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');

  button.click();
  assert.equal(root.classList.contains('collapsed'), true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');

  const fresh = document.createElement('div');
  const freshButton = document.createElement('button');
  setupPanelCollapse(fresh, freshButton, storage);
  assert.equal(fresh.classList.contains('collapsed'), true, 'a reload starts collapsed');
  freshButton.click();
  assert.equal(fresh.classList.contains('collapsed'), false);
});

test('the collapse works without storage', (t) => {
  installDocument(t);
  const root = document.getElementById('ui-panel')!;
  const button = document.getElementById('toggle')!;
  setupPanelCollapse(root, button, undefined);
  button.click();
  assert.equal(root.classList.contains('collapsed'), true);
});

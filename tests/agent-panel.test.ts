import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { AgentPanel } from '../src/ui/AgentPanel.js';

function installDocument(t: TestContext): HTMLElement {
  const dom = new JSDOM('<!doctype html><html><body><div id="agent-list"></div></body></html>');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  t.after(() => {
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'document');
  });
  return dom.window.document.getElementById('agent-list')!;
}

test('an activity change updates the existing menu in place', (t) => {
  const list = installDocument(t);
  const panel = new AgentPanel(list, () => undefined);
  panel.render([{ id: 'a', name: 'Agent A', activity: 'implementing' }]);
  const menu = list.querySelector('select')!;

  panel.render([{ id: 'a', name: 'Agent A', activity: 'researching' }]);

  assert.equal(list.querySelector('select'), menu);
  assert.equal(menu.value, 'researching');
});

test('a menu that has focus keeps the value the user is choosing', (t) => {
  const list = installDocument(t);
  const panel = new AgentPanel(list, () => undefined);
  panel.render([{ id: 'a', name: 'Agent A', activity: 'implementing' }]);
  const menu = list.querySelector('select')!;
  menu.focus();

  panel.render([{ id: 'a', name: 'Agent A', activity: 'researching' }]);

  assert.equal(menu.value, 'implementing');
});

test('cards follow agents that arrive and leave, and names stay plain text', (t) => {
  const list = installDocument(t);
  const panel = new AgentPanel(list, () => undefined);
  panel.render([{ id: 'a', name: '<b>A</b>', activity: 'idle' }, { id: 'b', name: 'B', activity: 'idle' }]);
  panel.render([{ id: 'b', name: 'B', activity: 'idle' }]);

  assert.equal(list.querySelectorAll('.agent-card').length, 1);
  assert.equal(list.querySelector('.agent-name')?.textContent, 'B');
  panel.render([{ id: 'c', name: '<b>C</b>', activity: 'idle' }]);
  assert.equal(list.querySelector('b'), null);
});

test('choosing an activity reports the agent and the activity', (t) => {
  const list = installDocument(t);
  const picks: Array<[string, string]> = [];
  const panel = new AgentPanel(list, (id, activity) => picks.push([id, activity]));
  panel.render([{ id: 'a', name: 'Agent A', activity: 'idle' }]);
  const menu = list.querySelector('select')!;

  menu.value = 'testing';
  menu.dispatchEvent(new document.defaultView!.Event('change'));

  assert.deepEqual(picks, [['a', 'testing']]);
});

test('a click on the card name selects the agent, a menu change does not', (t) => {
  const list = installDocument(t);
  const selected: string[] = [];
  const panel = new AgentPanel(list, () => undefined, (id) => selected.push(id));
  panel.render([{ id: 'a', name: 'Agent A', activity: 'idle' }]);

  list.querySelector<HTMLElement>('.agent-name')!.click();
  const menu = list.querySelector('select')!;
  menu.value = 'testing';
  menu.dispatchEvent(new menu.ownerDocument.defaultView!.Event('change'));

  assert.deepEqual(selected, ['a']);
});

test('the selected card is marked and the mark moves with the selection', (t) => {
  const list = installDocument(t);
  const panel = new AgentPanel(list, () => undefined, () => undefined);
  panel.render([{ id: 'a', name: 'A', activity: 'idle' }, { id: 'b', name: 'B', activity: 'idle' }]);
  const [cardA, cardB] = list.querySelectorAll('.agent-card');

  panel.setSelected('a');
  assert.equal(cardA.classList.contains('selected'), true);
  panel.setSelected('b');
  assert.equal(cardA.classList.contains('selected'), false);
  assert.equal(cardB.classList.contains('selected'), true);
  panel.setSelected(null);
  assert.equal(list.querySelectorAll('.selected').length, 0);
});

test('without a select handler the card name does nothing and is not marked clickable', (t) => {
  const list = installDocument(t);
  const panel = new AgentPanel(list, () => undefined);
  panel.render([{ id: 'a', name: 'A', activity: 'idle' }]);
  const name = list.querySelector<HTMLElement>('.agent-name')!;
  name.click();
  assert.equal(name.classList.contains('selectable'), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { ViewSwitch } from '../src/ui/ViewSwitch.js';

function mount(): { root: HTMLElement } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const root = dom.window.document.getElementById('root')!;
  return { root };
}

function calls() {
  const seen: string[] = [];
  return {
    seen,
    options: {
      isometric: () => seen.push('isometric'),
      desk: () => seen.push('desk'),
    },
  };
}

function button(root: HTMLElement, mode: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`.view-switch-button[data-mode="${mode}"]`)!;
}

test('mounts three buttons, one per camera mode, each with a title naming its key', () => {
  const { root } = mount();
  new ViewSwitch(root, 'first-person', calls().options);
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.view-switch-button'));
  assert.deepEqual(buttons.map((b) => b.dataset.mode), ['isometric', 'first-person', 'desk']);
  assert.match(button(root, 'isometric').title, /Isometric.*key I/);
  assert.match(button(root, 'desk').title, /Desk.*key H/);
});

test('the starting mode shows as active, the other two do not', () => {
  const { root } = mount();
  new ViewSwitch(root, 'isometric', calls().options);
  assert.equal(button(root, 'isometric').classList.contains('active'), true);
  assert.equal(button(root, 'first-person').classList.contains('active'), false);
  assert.equal(button(root, 'desk').classList.contains('active'), false);
  assert.equal(button(root, 'isometric').getAttribute('aria-pressed'), 'true');
  assert.equal(button(root, 'first-person').getAttribute('aria-pressed'), 'false');
});

test('clicking the isometric button calls isometric(), clicking desk calls desk()', () => {
  const { root } = mount();
  const { seen, options } = calls();
  new ViewSwitch(root, 'first-person', options);
  button(root, 'isometric').click();
  button(root, 'desk').click();
  assert.deepEqual(seen, ['isometric', 'desk'], 'each button calls the one method its matching key already calls');
});

test('clicking the already-active mode is a no-op: the view switch is a selector, not a toggle', () => {
  const { root } = mount();
  const { seen, options } = calls();
  new ViewSwitch(root, 'isometric', options);
  button(root, 'isometric').click();
  assert.deepEqual(seen, []);
});

test('the first-person button calls whichever of the other two toggles is the live one\'s way back', () => {
  const { root } = mount();
  const fromIso = calls();
  new ViewSwitch(root, 'isometric', fromIso.options);
  button(root, 'first-person').click();
  assert.deepEqual(fromIso.seen, ['isometric'], 'from isometric, toggleIsometric() is the way back');

  const { root: root2 } = mount();
  const fromDesk = calls();
  new ViewSwitch(root2, 'desk', fromDesk.options);
  button(root2, 'first-person').click();
  assert.deepEqual(fromDesk.seen, ['desk'], 'from desk, toggleDesk() is the way back');
});

test('the first-person button is a no-op when first person is already active', () => {
  const { root } = mount();
  const { seen, options } = calls();
  new ViewSwitch(root, 'first-person', options);
  button(root, 'first-person').click();
  assert.deepEqual(seen, []);
});

test('setActive moves the active mark to whichever mode the camera is actually in now, however it got there (a key, a double-click, the idle timeout)', () => {
  const { root } = mount();
  const view = new ViewSwitch(root, 'first-person', calls().options);
  view.setActive('desk');
  assert.equal(button(root, 'desk').classList.contains('active'), true);
  assert.equal(button(root, 'first-person').classList.contains('active'), false);

  view.setActive('isometric');
  assert.equal(button(root, 'isometric').classList.contains('active'), true);
  assert.equal(button(root, 'desk').classList.contains('active'), false);
});

test('after setActive, the same button no longer calls through on a click (it is now the active one)', () => {
  const { root } = mount();
  const { seen, options } = calls();
  const view = new ViewSwitch(root, 'first-person', options);
  view.setActive('isometric');
  button(root, 'isometric').click();
  assert.deepEqual(seen, []);
});

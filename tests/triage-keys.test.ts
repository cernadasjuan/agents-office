import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleTriageKey, type TriageKeyEvent } from '../src/ui/TriageKeys.js';

function keyEvent(code: string, overrides: Partial<TriageKeyEvent> = {}): TriageKeyEvent {
  return {
    code,
    target: null,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: () => undefined,
    ...overrides,
  };
}

function calls() {
  const seen: string[] = [];
  return {
    seen,
    handlers: {
      next: () => seen.push('next'),
      focus: () => seen.push('focus'),
      filter: () => seen.push('filter'),
    },
  };
}

test('key N calls next, key F calls focus, key / calls filter', () => {
  const { seen, handlers } = calls();
  handleTriageKey(keyEvent('KeyN'), handlers);
  handleTriageKey(keyEvent('KeyF'), handlers);
  handleTriageKey(keyEvent('Slash'), handlers);
  assert.deepEqual(seen, ['next', 'focus', 'filter']);
});

test('any other key calls nothing', () => {
  const { seen, handlers } = calls();
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyQ', 'ShiftLeft', 'KeyO', 'KeyI', 'KeyL', 'Escape']) {
    handleTriageKey(keyEvent(code), handlers);
  }
  assert.deepEqual(seen, []);
});

test('typing in an input, select or textarea is ignored, even for N, F and /', () => {
  const { seen, handlers } = calls();
  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) {
    const target = { tagName } as unknown as EventTarget;
    handleTriageKey(keyEvent('KeyN', { target }), handlers);
    handleTriageKey(keyEvent('KeyF', { target }), handlers);
    handleTriageKey(keyEvent('Slash', { target }), handlers);
  }
  assert.deepEqual(seen, []);
});

test('a held modifier (Ctrl, Alt or Meta) is ignored, so a browser or OS shortcut on these keys still works', () => {
  const { seen, handlers } = calls();
  handleTriageKey(keyEvent('KeyN', { ctrlKey: true }), handlers);
  handleTriageKey(keyEvent('KeyF', { altKey: true }), handlers);
  handleTriageKey(keyEvent('Slash', { metaKey: true }), handlers);
  assert.deepEqual(seen, []);
});

test('key / stops the browser default (for example Firefox quick find)', () => {
  let prevented = 0;
  handleTriageKey(keyEvent('Slash', { preventDefault: () => { prevented++; } }), calls().handlers);
  assert.equal(prevented, 1);
});

test('keys N and F do not call preventDefault: they never block a browser default', () => {
  let prevented = 0;
  const event = (code: string) => keyEvent(code, { preventDefault: () => { prevented++; } });
  handleTriageKey(event('KeyN'), calls().handlers);
  handleTriageKey(event('KeyF'), calls().handlers);
  assert.equal(prevented, 0);
});

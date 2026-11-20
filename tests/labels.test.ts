import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { createLabel, updateLabel } from '../src/characters/Label.js';

function installDocument(t: TestContext): void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: dom.window.document,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    dom.window.close();
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
}

function assertPlainLabel(element: HTMLElement, name: string, activity: string, id = ''): void {
  assert.equal(element.querySelector('.name')?.textContent, name);
  assert.equal(element.querySelector('.activity')?.textContent, activity);
  assert.equal(element.querySelector('.agent-id-tag')?.textContent, id);
  assert.equal(element.children.length, 3);
  assert.equal(element.querySelector('.name')?.childElementCount, 0);
  assert.equal(element.querySelector('.activity')?.childElementCount, 0);
  assert.equal(element.querySelector('.agent-id-tag')?.childElementCount, 0);
  assert.equal(element.querySelector('img, svg, script, iframe'), null);
  assert.equal(element.querySelector('[onerror], [onload], [onclick]'), null);
}

const payloads = [
  '<img src=x onerror="window.compromised=true">',
  '</div><svg onload="window.compromised=true"></svg><div>',
  '<script>window.compromised=true</script>',
];

for (const payload of payloads) {
  test(`createLabel treats markup as text: ${payload}`, (t) => {
    installDocument(t);
    const label = createLabel(payload, payload, undefined, payload);
    assertPlainLabel(label.element, payload, payload, `#${payload}`);
    assert.equal(label.element.className, 'agent-label');
    assert.deepEqual(label.position.toArray(), [0, 2.1, 0]);
  });

  test(`updateLabel treats markup as text: ${payload}`, (t) => {
    installDocument(t);
    const label = createLabel('normal agent', 'idle');
    updateLabel(label, payload, payload, undefined, payload);
    assertPlainLabel(label.element, payload, payload, `#${payload}`);
    assert.equal(label.element.className, 'agent-label');
  });
}

test('ordinary labels retain text and update without accumulating child elements', (t) => {
  installDocument(t);
  const label = createLabel('API & docs <team>', 'researching');
  assertPlainLabel(label.element, 'API & docs <team>', 'researching');
  updateLabel(label, '>> worker "one"', 'implementing');
  updateLabel(label, 'worker two', 'idle');
  assertPlainLabel(label.element, 'worker two', 'idle');
});

test('a provider tag is appended to the activity line as text', (t) => {
  installDocument(t);
  const label = createLabel('billing-service', 'Testing', 'codex');
  assertPlainLabel(label.element, 'billing-service', 'Testing · codex');
  updateLabel(label, 'billing-service', 'Idle', '<b>codex</b>');
  assertPlainLabel(label.element, 'billing-service', 'Idle · <b>codex</b>');
  updateLabel(label, 'claude-agent', 'Idle');
  assertPlainLabel(label.element, 'claude-agent', 'Idle');
});

test('issue #171: a short id is appended as its own line, hidden by CSS in compact mode, never as markup', (t) => {
  installDocument(t);
  const label = createLabel('billing-service', 'Testing', undefined, '12ab34cd');
  assertPlainLabel(label.element, 'billing-service', 'Testing', '#12ab34cd');
  updateLabel(label, 'billing-service', 'Idle', 'codex', '12ab34cd');
  assertPlainLabel(label.element, 'billing-service', 'Idle · codex', '#12ab34cd');
  updateLabel(label, 'billing-service', 'Idle', 'codex');
  assertPlainLabel(label.element, 'billing-service', 'Idle · codex', '');
});

// --- The wait chip (#132): readable in a compact queue label, without the activity line ---

test('without a wait, a label has no wait chip at all', (t) => {
  installDocument(t);
  const label = createLabel('agent', 'Waiting for you');
  assert.equal(label.element.querySelector('.wait'), null);
  assert.equal(label.element.children.length, 3);
});

test('a wait chip is its own text-only element, so it survives in a compact label (the activity line hides there)', (t) => {
  installDocument(t);
  const label = createLabel('agent', 'Waiting for you · 12 min', undefined, undefined, '12m');
  assert.equal(label.element.querySelector('.wait')?.textContent, '12m');
  assert.equal(label.element.children.length, 4);
  assert.equal(label.element.querySelector('img, svg, script, iframe'), null);
});

test('updateLabel drops the wait chip once the agent stops waiting', (t) => {
  installDocument(t);
  const label = createLabel('agent', 'Waiting for you · 12 min', undefined, undefined, '12m');
  updateLabel(label, 'agent', 'Implementing');
  assert.equal(label.element.querySelector('.wait'), null);
  assert.equal(label.element.children.length, 3);
});

test('the wait chip treats markup as text', (t) => {
  installDocument(t);
  const payload = '<img src=x onerror="window.compromised=true">';
  const label = createLabel('agent', 'Waiting for you', undefined, undefined, payload);
  assert.equal(label.element.querySelector('.wait')?.textContent, payload);
  assert.equal(label.element.querySelector('img, svg, script, iframe'), null);
});

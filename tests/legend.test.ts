import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { Legend, legendSections } from '../src/ui/Legend.js';

function setup(t: TestContext, options: { plugins?: string[]; layout?: string } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><button id="legend-button">?</button><input id="field"></body></html>');
  const document = dom.window.document;
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
  t.after(() => {
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'document');
  });
  const button = document.getElementById('legend-button')!;
  const legend = new Legend({
    parent: document.body,
    button,
    keys: dom.window,
    layout: options.layout ?? 'building',
    plugins: () => options.plugins ?? [],
  });
  const overlay = () => document.getElementById('legend')!;
  const press = (key: string, target: EventTarget = dom.window) =>
    target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  const signs = () => [...overlay().querySelectorAll('dt')].map((dt) => dt.textContent);
  return { document, button, legend, overlay, press, signs };
}

test('the legend is closed at start; "?" opens it and closes it again', (t) => {
  const { overlay, press, button } = setup(t);
  assert.equal(overlay().hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');

  press('?');
  assert.equal(overlay().hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');

  press('?');
  assert.equal(overlay().hidden, true);
});

test('the legend button toggles the overlay, and Esc or the close button close it', (t) => {
  const { overlay, press, button } = setup(t);
  button.click();
  assert.equal(overlay().hidden, false);
  press('Escape');
  assert.equal(overlay().hidden, true);

  button.click();
  overlay().querySelector<HTMLButtonElement>('.legend-close')!.click();
  assert.equal(overlay().hidden, true);
});

test('opening the legend while pointer lock is active releases the lock', (t) => {
  const { document, button, overlay } = setup(t);
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  let exited = 0;
  Object.defineProperty(document, 'pointerLockElement', { value: canvas, configurable: true });
  document.exitPointerLock = () => { exited++; };

  button.click();

  assert.equal(overlay().hidden, false);
  assert.equal(exited, 1);
});

test('"?" typed in a form field does not open the legend', (t) => {
  const { overlay, press, document } = setup(t);
  press('?', document.getElementById('field')!);
  assert.equal(overlay().hidden, true);
});

test('the legend explains the beacon, the raised hand, the attention bands, the rooms and the keys', (t) => {
  const { button, signs, overlay } = setup(t);
  button.click();
  const shown = signs();
  for (const sign of ['Beacon', 'Raised hand', 'Fresh wait', 'Aging wait', 'Cold wait', 'Done', 'Your office', 'Desks', 'Lounge', 'O', 'V', 'N', 'F', '/', '?']) {
    assert.ok(shown.includes(sign), `missing ${sign} in ${shown.join(', ')}`);
  }
  assert.match(overlay().textContent!, /15 min/, 'the band limits come from the attention bands');
  assert.match(overlay().textContent!, /24 h/);
});

test('tombstones, cards and hats appear only while their plugin is active', (t) => {
  const plain = legendSections('building', []).flatMap((section) => section.entries.map((entry) => entry.sign));
  assert.ok(!plain.includes('Tombstones'));
  assert.ok(!plain.includes('Cards'));
  assert.ok(!plain.includes('Hats'));

  const { button, signs } = setup(t, { plugins: ['missions', 'github', 'bmad'] });
  button.click();
  for (const sign of ['Tombstones', 'Cards', 'Hats']) assert.ok(signs().includes(sign), `missing ${sign}`);
});

test('the rooms appear only in the building layout', () => {
  const signs = legendSections('activity', []).flatMap((section) => section.entries.map((entry) => entry.sign));
  assert.ok(!signs.includes('Your office'));
  assert.ok(signs.includes('Beacon'));
});

test('the legend writes text only, never markup', (t) => {
  const { button, overlay } = setup(t, { plugins: ['missions', 'github', 'bmad'] });
  button.click();
  const allowed = new Set(['DIV', 'H3', 'H4', 'DL', 'DT', 'DD', 'BUTTON', 'SECTION']);
  for (const element of overlay().querySelectorAll('*')) assert.ok(allowed.has(element.tagName), element.tagName);
  assert.equal(overlay().querySelector('[style], [onclick], a, img, script'), null);
});

test('Esc that closes the legend does not reach the other key handlers (the selection stays)', (t) => {
  const dom = new JSDOM('<!doctype html><html><body><button id="b">?</button></body></html>');
  t.after(() => dom.window.close());
  const document = dom.window.document;
  let otherEscapes = 0;
  dom.window.addEventListener('keydown', (event) => { if (event.key === 'Escape') otherEscapes++; });
  const legend = new Legend({ parent: document.body, button: document.getElementById('b')!, keys: dom.window, layout: 'building', plugins: () => [] });
  legend.open();
  document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(legend.isOpen, false);
  assert.equal(otherEscapes, 0);

  document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(otherEscapes, 1, 'with the legend closed, Esc works as before');
});

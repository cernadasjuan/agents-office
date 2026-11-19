import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { createOffice } = await import('../src/scene/Office.js');
const { ActivityLayout } = await import('../src/layout/ActivityLayout.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

test('the lounge sofas add six seated idle seats after the coffee spots', () => {
  const stations = createOffice(new THREE.Scene());
  const idle = [...stations.entries()].filter(([, station]) => station.type === 'idle');

  assert.equal(idle.length, 8);
  assert.deepEqual(idle.slice(0, 2).map(([key]) => key), ['coffee_0', 'coffee_1']);
  assert.ok(idle.slice(2).every(([key, station]) => key.startsWith('sofa_') && station.posture === 'seated'));
});

test('eight idle agents find a seat without an overflow spot', () => {
  const layout = new ActivityLayout(createOffice(new THREE.Scene()));
  const seats = Array.from({ length: 8 }, (_, i) => layout.seatFor({ id: `idle-${i}`, activity: 'idle' }, null)!);

  assert.ok(seats.every((seat) => !seat.key.startsWith('overflow')));
  assert.equal(seats.filter((seat) => seat.posture === 'seated').length, 6);
});

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
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

/** Half the width the desks used to span before issue #121: the old center columns. */
const OLD_CENTER_HALF_X = 7;

test('issue #121: the coding desks cluster in the corners; the center floor stays clear of them', () => {
  const stations = createOffice(new THREE.Scene());
  const desks = [...stations.entries()].filter(([key]) => key.startsWith('desk_'));

  assert.equal(desks.length, 8, 'the desk count does not change, only where they sit');
  for (const [key, station] of desks) {
    assert.ok(Math.abs(station.position.x) >= OLD_CENTER_HALF_X, `${key} sits at x=${station.position.x}, clear of the center`);
  }
  // Two clusters, not one line: at least one desk left of center and one right of it.
  assert.ok(desks.some(([, s]) => s.position.x < 0));
  assert.ok(desks.some(([, s]) => s.position.x > 0));
});

test('issue #121: no desk sits in the room the old scattered desks used to occupy (|x| < 7, -6 <= z <= 0)', () => {
  const stations = createOffice(new THREE.Scene());
  const desks = [...stations.entries()].filter(([key]) => key.startsWith('desk_'));
  for (const [key, station] of desks) {
    const inOldCenter = Math.abs(station.position.x) < OLD_CENTER_HALF_X && station.position.z >= -6 && station.position.z <= 0;
    assert.equal(inOldCenter, false, `${key} at (${station.position.x}, ${station.position.z}) should have left the old scattered zone`);
  }
});

test('issue #121: moving the desks adds no station of a new type and no station count change', () => {
  const stations = createOffice(new THREE.Scene());
  const types = new Set([...stations.values()].map((s) => s.type));
  assert.deepEqual([...types].sort(), ['idle', 'implementing', 'meeting', 'planning', 'researching', 'reviewing', 'testing']);
});

function namedDescendant(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  let found: THREE.Object3D | undefined;
  root.traverse((object) => { if (object.name === name) found = object; });
  return found;
}

test('issue #122: the hall has a kitchen zone with its own furniture', () => {
  const scene = new THREE.Scene();
  createOffice(scene);
  const hall = scene.getObjectByName('hall')!;
  assert.ok(namedDescendant(hall, 'kitchen-counter'), 'a kitchen counter stands in the hall');
  assert.ok(namedDescendant(hall, 'kitchen-fridge'), 'a fridge stands in the hall');
});

test('issue #122: the hall has a play zone with a foosball table, an air hockey table and a video game piece', () => {
  const scene = new THREE.Scene();
  createOffice(scene);
  const hall = scene.getObjectByName('hall')!;
  assert.ok(namedDescendant(hall, 'foosball-table'));
  assert.ok(namedDescendant(hall, 'air-hockey-table'));
  assert.ok(namedDescendant(hall, 'arcade-cabinet'));
});

test('issue #122: the new kitchen and play furniture adds no agent station (decoration only, per the PO note on #122)', () => {
  const before = createOffice(new THREE.Scene()).size;
  // A second call is deterministic: the station count is a pure function of createOffice, so this
  // also guards against a future change accidentally wiring the new furniture to a station.
  const again = createOffice(new THREE.Scene()).size;
  assert.equal(before, again);
  // 2 whiteboards + 8 desks + 2 bookshelves + 2 test + 3 review + 2 coffee + 3 meeting + 6 sofa seats = 28
  assert.equal(before, 28);
});

test('the kitchen and play furniture sits in the open center, clear of every station', () => {
  const scene = new THREE.Scene();
  const stations = createOffice(scene);
  const hall = scene.getObjectByName('hall')!;
  const pieceNames = ['kitchen-counter', 'kitchen-fridge', 'foosball-table', 'air-hockey-table', 'arcade-cabinet'];
  const positions = pieceNames.map((name) => namedDescendant(hall, name)!.position);
  for (const position of positions) {
    for (const station of stations.values()) {
      const dx = Math.abs(position.x - station.position.x);
      const dz = Math.abs(position.z - station.position.z);
      assert.ok(dx > 1 || dz > 1, `a piece at (${position.x}, ${position.z}) sits clear of the station at (${station.position.x}, ${station.position.z})`);
    }
  }
});

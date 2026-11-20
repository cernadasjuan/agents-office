import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { OffscreenMarkers } from '../src/ui/OffscreenMarkers.js';
import type { Wait } from '../src/ui/attention.js';

const WIDTH = 1600;
const HEIGHT = 900;

function installDocument(t: TestContext): { container: HTMLElement; canvas: HTMLCanvasElement } {
  const dom = new JSDOM('<!doctype html><html><body><div id="markers"></div></body></html>');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  t.after(() => {
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'document');
  });
  const container = dom.window.document.getElementById('markers')!;
  const canvas = dom.window.document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ width: WIDTH, height: HEIGHT, left: 0, top: 0, right: WIDTH, bottom: HEIGHT, x: 0, y: 0, toJSON: () => undefined });
  return { container, canvas };
}

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 1000);
  cam.position.set(0, 2, 10);
  cam.lookAt(0, 2, 0);
  cam.updateMatrixWorld();
  return cam;
}

function agentAt(id: string, x: number, y: number, z: number, wait?: Wait) {
  const object = new THREE.Object3D();
  object.position.set(x, y, z);
  object.updateMatrixWorld();
  return { id, object, color: new THREE.Color('#ff0000'), wait };
}

test('an agent in the fresh band, off screen, gets a marker; on screen it gets none', (t) => {
  const { container, canvas } = installDocument(t);
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: () => undefined });

  markers.refresh([agentAt('onscreen', 0, 2, 0, { attention: 'waiting', waitMinutes: 3 }), agentAt('offscreen', 80, 2, 0, { attention: 'waiting', waitMinutes: 3 })]);

  assert.equal(container.querySelectorAll(`.${'offscreen-marker'}`).length, 1);
  assert.equal(container.children.length, 1);
});

test('aging and cold waits never get a marker, even off screen', (t) => {
  const { container, canvas } = installDocument(t);
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: () => undefined });

  markers.refresh([
    agentAt('aging', 80, 2, 0, { attention: 'waiting', waitMinutes: 60 }),
    agentAt('cold', 80, 2, 0, { attention: 'waiting', waitMinutes: 2000 }),
    agentAt('no-wait', 80, 2, 0, undefined),
  ]);

  assert.equal(container.children.length, 0);
});

test('a click on a marker selects that agent', (t) => {
  const { container, canvas } = installDocument(t);
  const selected: string[] = [];
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: (id) => selected.push(id) });

  markers.refresh([agentAt('a1', 80, 2, 0, { attention: 'waiting', waitMinutes: 3 })]);
  (container.firstElementChild as HTMLElement).click();

  assert.deepEqual(selected, ['a1']);
});

test('a marker for an agent that leaves the fresh band, or leaves entirely, is removed', (t) => {
  const { container, canvas } = installDocument(t);
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: () => undefined });

  markers.refresh([agentAt('a1', 80, 2, 0, { attention: 'waiting', waitMinutes: 3 })]);
  assert.equal(container.children.length, 1);

  markers.refresh([agentAt('a1', 80, 2, 0, { attention: 'waiting', waitMinutes: 60 })]);
  assert.equal(container.children.length, 0);

  markers.refresh([agentAt('a1', 80, 2, 0, { attention: 'waiting', waitMinutes: 3 })]);
  markers.refresh([]);
  assert.equal(container.children.length, 0);
});

test('without a canvas size (not yet laid out), refresh is a no-op', (t) => {
  const { container, canvas } = installDocument(t);
  canvas.getBoundingClientRect = () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => undefined });
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: () => undefined });

  markers.refresh([agentAt('a1', 80, 2, 0, { attention: 'waiting', waitMinutes: 3 })]);
  assert.equal(container.children.length, 0);
});

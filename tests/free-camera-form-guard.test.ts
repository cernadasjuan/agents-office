import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

/**
 * Issue #85 fix: the triage filter is the app's first text field, so key W/A/S/D,
 * Space and Q must not move the first-person camera while the user types in it.
 * `initFreeCamera` wires its own `window`/`document` listeners (not injected like
 * `ViewController`'s), so this test installs a real `window` global to exercise it.
 */
const dom = new JSDOM('<!doctype html><html><body><canvas id="c"></canvas><input id="filter"></body></html>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
});

const { initFreeCamera, updateFreeCamera } = await import('../src/scene/FreeCamera.js');

function setup() {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0.5, 0); // already above MIN_EYE_HEIGHT, so the floor clamp alone never moves it
  const canvas = dom.window.document.getElementById('c') as unknown as HTMLCanvasElement;
  initFreeCamera(camera, canvas, new THREE.Vector3(0, 0.5, -1));
  return { camera, input: dom.window.document.getElementById('filter')! };
}

function pressW(target: EventTarget) {
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
}

test('W typed into the filter field does not move the first-person camera', () => {
  const { camera, input } = setup();
  const before = camera.position.clone();
  pressW(input);
  updateFreeCamera(camera, 1);
  assert.deepEqual(camera.position.toArray(), before.toArray());
});

test('W outside any form field still moves the camera (old behavior)', () => {
  const { camera } = setup();
  const before = camera.position.clone();
  pressW(dom.window.document.body);
  updateFreeCamera(camera, 1);
  assert.notDeepEqual(camera.position.toArray(), before.toArray());
});

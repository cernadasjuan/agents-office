import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

/**
 * Issue #194: walls stop the first-person camera; doors (gaps in the wall rect list) stay
 * passable, and a wall hit while moving diagonally slides along it instead of sticking.
 * Same `window`/`document` wiring as `free-camera-ground-walk.test.ts`: `initFreeCamera`
 * attaches its own listeners to the real globals.
 */
const dom = new JSDOM('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
});

const { initFreeCamera, updateFreeCamera, setFreeCameraLook, setMovementEnabled, setWallColliders, EYE_HEIGHT } =
  await import('../src/scene/FreeCamera.js');

function setup(start: THREE.Vector3 = new THREE.Vector3(0, EYE_HEIGHT, 0)) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(start);
  const canvas = dom.window.document.getElementById('c') as unknown as HTMLCanvasElement;
  initFreeCamera(camera, canvas, new THREE.Vector3(start.x, start.y, start.z - 1));
  setMovementEnabled(true);
  updateFreeCamera(camera, 0); // settle grounded before the test presses anything
  return { camera };
}

function press(code: string) {
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code, bubbles: true }));
}

function release(code: string) {
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { code, bubbles: true }));
}

function tick(camera: THREE.PerspectiveCamera, seconds: number, step = 1 / 60) {
  for (let t = 0; t < seconds; t += step) updateFreeCamera(camera, step);
}

test('walking into a wall stops at a margin, never passing through it', () => {
  // A wall segment straight ahead (facing -z, the default look), from z = -4 to z = -3.9.
  setWallColliders([{ minX: -2, maxX: 2, minZ: -4, maxZ: -3.9 }]);
  const { camera } = setup();
  press('KeyW');
  tick(camera, 3); // far longer than needed to reach the wall at walk speed
  release('KeyW');
  assert.ok(camera.position.z > -4, `camera passed through the wall (z = ${camera.position.z})`);
  assert.ok(camera.position.z < -3.4, `camera stopped too far from the wall (z = ${camera.position.z})`);
  setWallColliders([]);
});

test('a single large-delta frame (a dropped frame, running) does not tunnel through a thin wall', () => {
  // A thin wall straight ahead, well within reach at run speed over a 2-second single step.
  setWallColliders([{ minX: -2, maxX: 2, minZ: -4, maxZ: -3.85 }]);
  const { camera } = setup();
  press('KeyW');
  updateFreeCamera(camera, 2); // one huge delta, not a sequence of small ticks
  release('KeyW');
  assert.ok(camera.position.z > -4, `camera tunneled through the wall in one frame (z = ${camera.position.z})`);
  setWallColliders([]);
});

test('round 7 (#214, raised walk/run speed): an actual double-tap run plus a long dropped frame still does not tunnel', () => {
  // Same thin wall, but this time drive the real double-tap-W run toggle (issue #174's
  // mechanism), so the move uses the new RUN_MULTIPLIER (2.6x walk), then a single 3-second
  // frame — far longer than the new top speed needs to cross the gap to the wall.
  setWallColliders([{ minX: -2, maxX: 2, minZ: -4, maxZ: -3.85 }]);
  const { camera } = setup();
  press('KeyW');
  release('KeyW');
  press('KeyW'); // second tap within the double-tap window engages running
  updateFreeCamera(camera, 3); // one huge delta at run speed
  release('KeyW');
  assert.ok(camera.position.z > -4, `camera tunneled through the wall while running (z = ${camera.position.z})`);
});

test('a door (a gap in the wall rect list) stays passable', () => {
  // Two wall segments with a 2-wide gap at x = -1..1, directly ahead.
  setWallColliders([
    { minX: -6, maxX: -1, minZ: -4, maxZ: -3.9 },
    { minX: 1, maxX: 6, minZ: -4, maxZ: -3.9 },
  ]);
  const { camera } = setup();
  press('KeyW');
  tick(camera, 3);
  release('KeyW');
  assert.ok(camera.position.z < -4, `camera should have walked through the door (z = ${camera.position.z})`);
  setWallColliders([]);
});

test('hitting a wall while moving diagonally slides along it instead of sticking', () => {
  // A wall ahead (blocks forward/-z) but nothing to the side (blocks no x movement). Wide
  // enough that the slide below never reaches past its x-extent.
  setWallColliders([{ minX: -50, maxX: 50, minZ: -4, maxZ: -3.9 }]);
  const { camera } = setup();
  press('KeyW');
  press('KeyD'); // forward + right
  // Review of #196 (PR comment): a camera that stops dead on first contact with the wall,
  // never sliding at all, could still pass a test that only checks a final x position past a
  // threshold reached before contact. Tick in two parts instead: first, just long enough to
  // reach the wall and stop (z settles); second, several more frames once contact is made,
  // and assert x keeps increasing frame to frame through that second part — the real
  // signature of sliding, not merely "ended up somewhere to the right".
  tick(camera, 1); // reaches the wall and stops; well past contact, since the wall sits 4 m ahead
  const zAtContact = camera.position.z;
  assert.ok(zAtContact > -4, `camera passed through the wall ahead (z = ${zAtContact})`);
  let x = camera.position.x;
  for (let i = 0; i < 30; i++) {
    updateFreeCamera(camera, 1 / 60);
    assert.ok(camera.position.x > x, `x should keep increasing while sliding along the wall (frame ${i}: ${camera.position.x} vs ${x})`);
    assert.equal(camera.position.z, zAtContact, `z must stay pinned at the wall, not drift (frame ${i})`);
    x = camera.position.x;
  }
  release('KeyW');
  release('KeyD');
  setWallColliders([]);
});

test('without any wall colliders set, ground walk is unobstructed (old behavior)', () => {
  setWallColliders([]);
  const { camera } = setup();
  press('KeyW');
  updateFreeCamera(camera, 1);
  release('KeyW');
  assert.ok(camera.position.z < -6, 'walks freely with no wall list');
});

test('movement disabled (desk mode) still applies no collision work and leaves position untouched', () => {
  setWallColliders([{ minX: -2, maxX: 2, minZ: -1, maxZ: 1 }]);
  const { camera } = setup();
  setMovementEnabled(false);
  press('KeyW');
  const before = camera.position.clone();
  updateFreeCamera(camera, 1);
  assert.deepEqual(camera.position.toArray(), before.toArray());
  release('KeyW');
  setMovementEnabled(true);
  setWallColliders([]);
});

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

/**
 * Issue #174: first person walks on the ground with gravity, instead of flying.
 * `initFreeCamera` wires its own `window`/`document` listeners, so this installs a real
 * `window` global, the same pattern as `free-camera-form-guard.test.ts`.
 */
const dom = new JSDOM('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
// StickFigureParts.ts (the agent's own eye height, issue #174) imports Materials.ts, which
// paints a toon gradient on a canvas at import time.
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
});

const { initFreeCamera, updateFreeCamera, setFreeCameraLook, setMovementEnabled, EYE_HEIGHT, CROUCH_EYE_HEIGHT } = await import('../src/scene/FreeCamera.js');

function setup() {
  const camera = new THREE.PerspectiveCamera();
  const canvas = dom.window.document.getElementById('c') as unknown as HTMLCanvasElement;
  initFreeCamera(camera, canvas, new THREE.Vector3(0, EYE_HEIGHT, -1));
  setMovementEnabled(true); // issue #174 (desk mode, #161): leave movement on for every other test
  updateFreeCamera(camera, 0); // settle standing (grounded's own y-snap) before the test presses anything
  return { camera };
}

function press(code: string, overrides: Partial<KeyboardEventInit> = {}) {
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code, bubbles: true, ...overrides }));
}

function release(code: string) {
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { code, bubbles: true }));
}

function tick(camera: THREE.PerspectiveCamera, seconds: number, step = 1 / 60) {
  for (let t = 0; t < seconds; t += step) updateFreeCamera(camera, step);
}

test('a jump rises then gravity pulls it back down to standing eye height', () => {
  const { camera } = setup();
  const before = camera.position.y;
  assert.equal(before, EYE_HEIGHT, 'starts standing');
  press('Space');
  updateFreeCamera(camera, 1 / 60);
  assert.ok(camera.position.y > before, 'the jump impulse lifts the camera at once');
  const apex = camera.position.y;
  tick(camera, 0.05);
  assert.ok(camera.position.y > apex, 'still rising a few frames in');
  tick(camera, 2); // long enough for any realistic jump arc to land
  assert.equal(camera.position.y, EYE_HEIGHT, 'gravity brings it back to exactly standing height, not past it');
});

test('Space mid-air does nothing: no double jump', () => {
  // Same jump, run twice: once with an extra Space press partway up, once without. A second
  // jump impulse would push the pressed run's trajectory above the plain one; without one,
  // the two trajectories (sampled a few frames later) land on the exact same height.
  const plain = (() => {
    const { camera } = setup();
    press('Space');
    tick(camera, 0.1);
    return camera.position.y;
  })();
  const pressedAgainMidair = (() => {
    const { camera } = setup();
    press('Space');
    updateFreeCamera(camera, 1 / 60); // airborne now
    press('Space'); // still airborne: must do nothing
    tick(camera, 0.1 - 1 / 60);
    return camera.position.y;
  })();
  assert.equal(pressedAgainMidair, plain, 'the extra mid-air Space left the jump arc exactly as it was');
});

test('Space jumps again once grounded', () => {
  const { camera } = setup();
  press('Space');
  tick(camera, 2); // land
  assert.equal(camera.position.y, EYE_HEIGHT);
  const grounded = camera.position.y;
  press('Space');
  updateFreeCamera(camera, 1 / 60);
  assert.ok(camera.position.y > grounded, 'a fresh jump works again after landing');
});

test('W moves forward at the default walk speed, a little faster than the old 6', () => {
  const { camera } = setup();
  press('KeyW');
  updateFreeCamera(camera, 1);
  // Forward from yaw 0 is -z; one second at the new base speed covers a bit more than 6 units.
  assert.ok(camera.position.z < -6, `expected more than the old 6 units/s, got ${-camera.position.z}`);
  assert.ok(camera.position.z > -10, `still a walk, not an unreasonable sprint (${-camera.position.z})`);
});

test('double-tapping W runs faster than a single, held W', () => {
  const walked = (() => {
    const { camera } = setup();
    press('KeyW');
    updateFreeCamera(camera, 1);
    return -camera.position.z;
  })();
  const ran = (() => {
    const { camera } = setup();
    press('KeyW');
    release('KeyW');
    press('KeyW'); // the second tap, within the double-tap window
    updateFreeCamera(camera, 1);
    return -camera.position.z;
  })();
  assert.ok(ran > walked, `running (${ran}) should cover more ground than walking (${walked}) in the same second`);
});

test('releasing W stops the run', () => {
  const { camera } = setup();
  press('KeyW');
  release('KeyW');
  press('KeyW'); // the second tap: now running
  updateFreeCamera(camera, 1 / 60);
  release('KeyW');
  const beforeRelease = -camera.position.z;
  updateFreeCamera(camera, 1); // W is up: no WASD held, no horizontal movement at all
  assert.equal(-camera.position.z, beforeRelease, 'nothing moves once every movement key is up');
});

test('holding Shift crouches: lower eye height and slower movement, not the old "Shift = fast"', () => {
  const { camera } = setup();
  press('ShiftLeft');
  updateFreeCamera(camera, 1 / 60);
  assert.equal(camera.position.y, CROUCH_EYE_HEIGHT, 'the eye height drops while crouching');
  assert.ok(CROUCH_EYE_HEIGHT < EYE_HEIGHT, 'crouching is lower than standing');

  const crouchWalk = (() => {
    press('KeyW');
    updateFreeCamera(camera, 1);
    return -camera.position.z;
  })();
  release('ShiftLeft');
  release('KeyW');

  const { camera: camera2 } = setup();
  press('KeyW');
  updateFreeCamera(camera2, 1);
  const standWalk = -camera2.position.z;
  assert.ok(crouchWalk < standWalk, `crouch-walking (${crouchWalk}) should be slower than standing walk (${standWalk})`);
});

test('releasing Shift stands back up', () => {
  const { camera } = setup();
  press('ShiftLeft');
  updateFreeCamera(camera, 1 / 60);
  assert.equal(camera.position.y, CROUCH_EYE_HEIGHT);
  release('ShiftLeft');
  updateFreeCamera(camera, 1 / 60);
  assert.equal(camera.position.y, EYE_HEIGHT);
});

test('looking up or down does not tilt the walk (movement stays on the ground plane)', () => {
  const { camera } = setup();
  setFreeCameraLook(camera, camera.position, new THREE.Vector3(0, EYE_HEIGHT + 5, -1)); // look steeply up
  press('KeyW');
  updateFreeCamera(camera, 1 / 60);
  assert.equal(camera.position.y, EYE_HEIGHT, 'walking while looking up never lifts the camera off the ground');
});

test('issue #174 (desk mode, #161): movement can be disabled without touching look', () => {
  const { camera } = setup();
  setMovementEnabled(false);
  press('KeyW');
  const before = camera.position.clone();
  updateFreeCamera(camera, 1);
  assert.deepEqual(camera.position.toArray(), before.toArray(), 'no movement, no gravity, while disabled');
  setMovementEnabled(true);
});

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

test('review #185: standing up mid-air (releasing crouch while still rising) never falsely cancels the jump', () => {
  // A single "y went up" check (the original version of this test) cannot tell the fix apart
  // from the bug it guards against: the old bug's false landing snaps the camera UP to
  // standing height, which is also greater than the pre-release value. The real signature of
  // a genuine, still-airborne jump is that y keeps changing frame to frame; a false landing
  // freezes it flat the instant it fires (re-review, round 2).
  const { camera } = setup();
  press('ShiftLeft'); // crouch first
  updateFreeCamera(camera, 1 / 60);
  assert.equal(camera.position.y, CROUCH_EYE_HEIGHT);
  press('Space'); // jump from the crouch height
  updateFreeCamera(camera, 1 / 60);
  const risingFromCrouch = camera.position.y;
  assert.ok(risingFromCrouch > CROUCH_EYE_HEIGHT, 'rising');
  release('ShiftLeft'); // stand up mid-air: the live target jumps from crouch height to the (higher) standing height
  updateFreeCamera(camera, 1 / 60);
  // The old bug: the camera (still low, from the crouch launch) was now below the new, higher
  // target, so the landing check fired immediately and zeroed the jump instead of continuing it.
  assert.ok(camera.position.y > risingFromCrouch, `still rising after standing up mid-air, not snapped to a landed height (${camera.position.y} vs ${risingFromCrouch})`);
  const y1 = camera.position.y;
  updateFreeCamera(camera, 1 / 60);
  const y2 = camera.position.y;
  assert.notEqual(y1, y2, `a genuine jump keeps moving frame to frame; y stuck at ${y1} means it was falsely landed by the posture change`);
  tick(camera, 2); // let it land for real
  assert.equal(camera.position.y, EYE_HEIGHT, 'eventually lands at the (now standing) target height');
});

test('review #185: the jump apex is the same at 30 fps and 60 fps (frame-rate independence)', () => {
  const apexAt = (fps: number) => {
    const { camera } = setup();
    press('Space');
    let apex = camera.position.y;
    const step = 1 / fps;
    for (let t = 0; t < 1; t += step) {
      updateFreeCamera(camera, step);
      if (camera.position.y > apex) apex = camera.position.y;
    }
    release('Space');
    return apex - EYE_HEIGHT; // the apex height above standing, so 0 fps-dependent offset cancels out
  };
  const apex30 = apexAt(30);
  const apex60 = apexAt(60);
  assert.ok(Math.abs(apex30 - apex60) / apex60 < 0.01, `apex at 30 fps (${apex30}) and 60 fps (${apex60}) should match within 1%`);
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

test('releasing W stops the run, confirmed with a different key afterward (review #185)', () => {
  // The old version of this test only checked that nothing moves with every key up, which
  // would still pass even with the keyup reset deleted entirely. A's own speed, taken right
  // after a run, is the real check: a stuck `running` flag would speed up every movement key,
  // not only W, so comparing against a plain strafe-only run catches that directly.
  const ranThenStrafed = (() => {
    const { camera } = setup();
    press('KeyW');
    release('KeyW');
    press('KeyW'); // the second tap: now running
    updateFreeCamera(camera, 1 / 60);
    release('KeyW'); // running must clear here
    press('KeyA');
    updateFreeCamera(camera, 1);
    release('KeyA');
    return camera.position.x;
  })();
  const strafedOnly = (() => {
    const { camera } = setup();
    press('KeyA');
    updateFreeCamera(camera, 1);
    release('KeyA');
    return camera.position.x;
  })();
  assert.ok(Math.abs(ranThenStrafed - strafedOnly) < 1e-6, `a stuck running flag would make the strafe after it faster too (${ranThenStrafed} vs a plain strafe's ${strafedOnly})`);
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
  // The old version of this test only checked that y stays at EYE_HEIGHT, which would still
  // pass even with pitch leaking into movement: the grounded branch forces y back to the
  // target height every frame regardless. The real check is the horizontal distance covered:
  // if pitch tilted the walk, looking steeply up would shorten the forward (x/z) component of
  // the same one-second walk, exactly the bug this guards against.
  const flat = (() => {
    const { camera } = setup();
    setFreeCameraLook(camera, camera.position, new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z - 1)); // level look
    press('KeyW');
    updateFreeCamera(camera, 1);
    release('KeyW');
    return { x: camera.position.x, z: camera.position.z };
  })();
  const lookingUp = (() => {
    const { camera } = setup();
    setFreeCameraLook(camera, camera.position, new THREE.Vector3(camera.position.x, camera.position.y + 5, camera.position.z - 1)); // same yaw, steep pitch up
    press('KeyW');
    updateFreeCamera(camera, 1);
    release('KeyW');
    return { x: camera.position.x, z: camera.position.z };
  })();
  assert.ok(Math.abs(flat.x - lookingUp.x) < 1e-9 && Math.abs(flat.z - lookingUp.z) < 1e-9, `same horizontal distance regardless of pitch (flat ${JSON.stringify(flat)} vs looking up ${JSON.stringify(lookingUp)})`);
});

test('issue #174 (desk mode, #161): movement can be disabled without touching look', () => {
  const { camera } = setup();
  setMovementEnabled(false);
  press('KeyW');
  const before = camera.position.clone();
  updateFreeCamera(camera, 1);
  assert.deepEqual(camera.position.toArray(), before.toArray(), 'no movement, no gravity, while disabled');
  release('KeyW');

  // Review #185: the old version of this test never exercised mouse-look, so a change that
  // broke look-while-disabled would not be caught. Simulate pointer lock (the same pattern as
  // tests/view-controller.test.ts), then move the mouse and confirm the camera still rotates.
  // (Re-review, round 2: JSDOM's MouseEvent constructor ignores movementX/movementY passed in
  // its init dict, so they come through undefined and the quaternion below went to NaN,
  // passing `notDeepEqual` for the wrong reason. `Object.defineProperty` on the dispatched
  // event itself is the one way JSDOM actually honors these two fields.)
  const canvas = dom.window.document.getElementById('c') as unknown as HTMLCanvasElement;
  Object.defineProperty(dom.window.document, 'pointerLockElement', { value: canvas, configurable: true });
  dom.window.document.dispatchEvent(new dom.window.Event('pointerlockchange'));
  const beforeQuaternion = camera.quaternion.clone();
  const mouseMove = new dom.window.MouseEvent('mousemove');
  Object.defineProperty(mouseMove, 'movementX', { value: 200, configurable: true });
  Object.defineProperty(mouseMove, 'movementY', { value: 0, configurable: true });
  dom.window.document.dispatchEvent(mouseMove);
  updateFreeCamera(camera, 1 / 60);
  const afterQuaternion = camera.quaternion.toArray();
  assert.ok(afterQuaternion.every((component) => Number.isFinite(component)), `the rotated quaternion must be finite, not NaN from an unapplied mouse move (${afterQuaternion})`);
  assert.notDeepEqual(afterQuaternion, beforeQuaternion.toArray(), 'look still rotates the camera while movement is disabled');

  Object.defineProperty(dom.window.document, 'pointerLockElement', { value: null, configurable: true });
  dom.window.document.dispatchEvent(new dom.window.Event('pointerlockchange'));
  setMovementEnabled(true);
});

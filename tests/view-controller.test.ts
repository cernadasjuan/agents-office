import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { Seat, LayoutStrategy } from '../src/layout/LayoutStrategy.js';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body><div id="pointer-hint"></div></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { ViewController } = await import('../src/scene/ViewController.js');
const { SelectionState } = await import('../src/scene/Selection.js');
const { STATIC_SOURCE_LAYER } = await import('../src/scene/StaticMerge.js');
const { EYE_HEIGHT, setSurfaceHeightProvider, setFreeCameraLook } = await import('../src/scene/FreeCamera.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const fixedLayout: LayoutStrategy = {
  id: 'fixed',
  seatFor: (agent): Seat => ({ key: agent.id, position: new THREE.Vector3(4, 0, -3), lookAt: new THREE.Vector3(4, 0, 0) }),
  release: () => undefined,
};

interface SetupExtras {
  deskView?: () => { position: THREE.Vector3; lookAt: THREE.Vector3; fov?: number } | null;
  roomAt?: (x: number, z: number) => { bounds: THREE.Box3; standing: { position: THREE.Vector3; lookAt: THREE.Vector3 } } | null;
  idleTimeoutSeconds?: number;
  crosshair?: HTMLElement | null;
  surfaceHeightAt?: (x: number, z: number) => number | null;
}

function setup(
  hash = '',
  figureShiftPx?: () => number,
  roomView?: (name: string) => { bounds: THREE.Box3; standing: { position: THREE.Vector3; lookAt: THREE.Vector3 } } | null,
  extras: SetupExtras = {},
) {
  const document = dom.window.document;
  const scene = new THREE.Scene();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  wall.userData.hiddenFromAbove = true;
  scene.add(wall);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(-12, EYE_HEIGHT, 11); // issue #174: first person settles here every frame it is grounded
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 1600 });
  Object.defineProperty(canvas, 'clientHeight', { value: 900 });
  document.body.appendChild(canvas);
  const manager = new AgentManager(scene, fixedLayout);
  const selection = new SelectionState();
  const hint = document.getElementById('pointer-hint');
  const view = new ViewController({
    camera, canvas, scene, selection, hint,
    agents: () => manager.getAgents(),
    keys: dom.window,
    hash,
    ...(figureShiftPx ? { figureShiftPx } : {}),
    ...(roomView ? { roomView } : {}),
    ...extras,
  });
  const press = (code: string) => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code, key: code }));
  return { view, camera, canvas, manager, selection, wall, hint, press };
}

/** A fixed desk pose away from the test's default first-person spot, so a flight there is visible. */
function fixtureDeskView(): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  return { position: new THREE.Vector3(20, 1.3, -2), lookAt: new THREE.Vector3(20, 1.2, -6) };
}

/** Issue #199: the same fixture, plus the widened lens `ViewController` applies only in desk mode. */
function fixtureDeskViewWithFov(fov = 82): { position: THREE.Vector3; lookAt: THREE.Vector3; fov: number } {
  return { ...fixtureDeskView(), fov };
}

test('first person stays the default and the camera does not move by itself', () => {
  const { view, camera, wall } = setup();
  view.update(1, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.deepEqual(camera.position.toArray(), [-12, EYE_HEIGHT, 11]);
  assert.equal(wall.visible, true);
});

test('key O does nothing: the overview mode is gone (#173)', () => {
  const { view, camera, wall, press } = setup();
  press('KeyO');
  assert.equal(view.mode, 'first-person');
  assert.equal(wall.visible, true);
  assert.deepEqual(camera.position.toArray(), [-12, EYE_HEIGHT, 11], 'the camera does not move');
});

test('key I switches to the isometric view and back, hiding near walls only there', () => {
  const { view, camera, wall, hint, press } = setup();
  press('KeyI');
  assert.equal(view.mode, 'isometric');
  assert.equal(wall.visible, false);
  assert.match(hint!.textContent ?? '', /wheel/i);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.notEqual(view.activeCamera, camera, 'isometric draws through its own orthographic camera');

  press('KeyI');
  for (let i = 0; i < 60; i++) view.update(1 + i / 60, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.equal(wall.visible, true);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(-12, EYE_HEIGHT, 11)) < 1e-6);
});

// --- Desk view (issue #161) ---

test('key H flies to the desk pose, in a short fly, not an instant cut', () => {
  const desk = fixtureDeskView();
  const { view, camera, press } = setup('', undefined, undefined, { deskView: () => desk });
  press('KeyH');
  assert.equal(view.mode, 'desk');
  // Mid-flight: not yet at the desk pose (it is a fly, issue #161 AC1).
  view.update(0, 1 / 120);
  assert.ok(camera.position.distanceTo(desk.position) > 0.01, 'still mid-flight, not an instant cut');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.ok(camera.position.distanceTo(desk.position) < 1e-6, 'lands exactly at the desk pose');
});

test('issue #249: toggling H while standing on an elevated surface (the hex walkway deck) returns to that surface\'s height, not y=0 plus eye height', () => {
  const desk = fixtureDeskView();
  const DECK_HEIGHT = 6.6; // WALKWAY_HEIGHT, the elevated surface this bug was found on
  const { view, camera } = setup('', undefined, undefined, {
    deskView: () => desk,
    surfaceHeightAt: () => DECK_HEIGHT, // every x/z on the deck reads the same height
  });
  // Stand on the deck before toggling desk view: the old code reset to `currentEyeHeight()`
  // alone on the way back, silently dropping the deck's own height from under the camera.
  camera.position.y = DECK_HEIGHT + EYE_HEIGHT;
  // `view.toggleDesk()` directly, not `press('KeyH')`: every test in this file shares one
  // JSDOM `window` as `keys`, and `ViewController` never removes its own keydown listener —
  // a real key dispatch here would also fire every still-attached listener from an earlier
  // H-toggle test, each driving its own (unrelated) view and, through it, the same
  // module-level `FreeCamera` floor-height singleton this test depends on reading cleanly.
  view.toggleDesk();
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60); // settle into desk mode
  assert.equal(view.mode, 'desk');

  view.toggleDesk(); // back to first person, at the saved deck position
  for (let i = 0; i < 60; i++) view.update(2 + i / 60, 1 / 60); // settle the fly back
  assert.equal(view.mode, 'first-person');
  assert.ok(
    Math.abs(camera.position.y - (DECK_HEIGHT + EYE_HEIGHT)) < 1e-6,
    `landed at y=${camera.position.y}, expected the deck height (${DECK_HEIGHT}) plus eye height (${EYE_HEIGHT}), not eye height alone`,
  );

  // `FreeCamera`'s floor height is a module-level singleton (one ground-walk at a time), not
  // per-`ViewController` — left at the deck height, it would silently leak into every test
  // that runs after this one in the same process (any of their own flight landings would
  // read this stale height as their fallback). `setFreeCameraLook` snaps it directly, no
  // easing to wait out.
  setSurfaceHeightProvider(() => 0);
  setFreeCameraLook(camera, camera.position, camera.position.clone().add(new THREE.Vector3(0, 0, -1)));
  setSurfaceHeightProvider(null);
});

test('key H without a desk to show is a no-op (graceful degradation, no deskView option at all)', () => {
  const { view, camera, press } = setup();
  press('KeyH');
  assert.equal(view.mode, 'first-person', 'stays in the current view; there is no desk to show');
  assert.deepEqual(camera.position.toArray(), [-12, EYE_HEIGHT, 11]);
});

test('review (defect 3): H from the isometric view flies to the desk, the same short fly as from first person', () => {
  const desk = fixtureDeskView();
  const { view, camera, press } = setup('', undefined, undefined, { deskView: () => desk });
  press('KeyI');
  assert.equal(view.mode, 'isometric');
  press('KeyH');
  assert.equal(view.mode, 'desk');
  // Mid-flight: not yet at the desk pose. Entering desk from isometric used to be a hard
  // cut (the generic isometric-exit rule), even though the perspective camera itself never
  // changed kind — only the orthographic camera stopped drawing.
  view.update(0, 1 / 120);
  assert.ok(camera.position.distanceTo(desk.position) > 0.01, 'still mid-flight, not an instant cut');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.ok(camera.position.distanceTo(desk.position) < 1e-6, 'lands exactly at the desk pose');
});

test('review (defect 1): typing in a form field still resets the idle clock, even though the key itself is ignored', () => {
  const desk = fixtureDeskView();
  const { view } = setup('', undefined, undefined, { deskView: () => desk, idleTimeoutSeconds: 5 });
  const input = dom.window.document.createElement('input');
  dom.window.document.body.appendChild(input);
  for (let i = 0; i < 4 * 60; i++) view.update(i / 60, 1 / 60);
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyA', bubbles: true })); // typing "a" in the filter
  for (let i = 4 * 60; i < 8 * 60; i++) view.update(i / 60, 1 / 60); // 4 more seconds: short of a fresh 5 s timeout
  assert.equal(view.mode, 'first-person', 'typing in the filter is still camera input for the idle clock');
  input.remove();
});

test('review (defect 2): the idle timeout never fires while a movement key is held, even with no further events', () => {
  const desk = fixtureDeskView();
  const { view, press } = setup('', undefined, undefined, { deskView: () => desk, idleTimeoutSeconds: 5 });
  press('KeyW'); // one keydown, then held: a real hold sends no further discrete event
  for (let i = 0; i < 20 * 60; i++) view.update(i / 60, 1 / 60); // far past the 5 s timeout
  assert.equal(view.mode, 'first-person', 'a held movement key keeps the idle clock from ever firing');

  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { code: 'KeyW' }));
  for (let i = 20 * 60; i < 26 * 60; i++) view.update(i / 60, 1 / 60); // past 5 s since release
  assert.equal(view.mode, 'desk', 'the clock resumes, and fires, once the key is released');
});

test('review (defect 2): the idle timeout never fires while the pointer is locked', () => {
  const desk = fixtureDeskView();
  const { view, canvas } = setup('', undefined, undefined, { deskView: () => desk, idleTimeoutSeconds: 5 });
  const document = dom.window.document;
  Object.defineProperty(document, 'pointerLockElement', { value: canvas, configurable: true });
  for (let i = 0; i < 20 * 60; i++) view.update(i / 60, 1 / 60); // far past the 5 s timeout, still locked
  assert.equal(view.mode, 'first-person', 'an engaged pointer lock keeps the idle clock from ever firing');

  Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
  for (let i = 20 * 60; i < 26 * 60; i++) view.update(i / 60, 1 / 60); // past 5 s since the lock exited
  assert.equal(view.mode, 'desk', 'the clock resumes, and fires, once the lock exits');
});

test('desk mode holds its pose every frame: WASD, mouse-look and gravity never move it', () => {
  const desk = fixtureDeskView();
  const { view, camera, press } = setup('', undefined, undefined, { deskView: () => desk });
  press('KeyH');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60); // let the fly land
  press('KeyW');
  press('Space');
  for (let i = 0; i < 60; i++) view.update(1 + i / 60, 1 / 60);
  assert.ok(camera.position.distanceTo(desk.position) < 1e-6, 'WASD and Space never move the desk camera');
});

test('desk mode never engages pointer lock: a click elsewhere clears the selection, exactly like a ground click in first person', () => {
  const desk = fixtureDeskView();
  const { view, manager, selection, canvas, press } = setup('', undefined, undefined, { deskView: () => desk });
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  press('KeyH');
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10 }));
  assert.equal(selection.selected, null, 'a ground click in desk mode clears the selection');
  assert.equal(view.mode, 'desk', 'a ground click never switches out of desk mode');
});

test('selecting an agent in desk mode shows the card but never flies the camera', () => {
  const desk = fixtureDeskView();
  const { view, manager, selection, camera, press } = setup('', undefined, undefined, { deskView: () => desk });
  press('KeyH');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  for (let i = 0; i < 60; i++) view.update(1 + i / 60, 1 / 60);
  assert.equal(selection.selected, 'a', 'the card still opens');
  assert.ok(camera.position.distanceTo(desk.position) < 1e-6, 'the camera stays locked at the desk pose');
});

test('H toggles back to the saved first-person pose', () => {
  const desk = fixtureDeskView();
  const { view, camera, press } = setup('', undefined, undefined, { deskView: () => desk });
  press('KeyH');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  press('KeyH');
  for (let i = 0; i < 60; i++) view.update(1 + i / 60, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.ok(camera.position.distanceTo(new THREE.Vector3(-12, EYE_HEIGHT, 11)) < 1e-6, 'back at the pose it left');
});

test('#view=desk starts in the desk view when a deskView is available', () => {
  const desk = fixtureDeskView();
  const { view, camera } = setup('#view=desk', undefined, undefined, { deskView: () => desk });
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.equal(view.mode, 'desk');
  assert.ok(camera.position.distanceTo(desk.position) < 1e-6);
});

test('issue #161: idling past the timeout settles the office into the desk view, from first person or isometric', () => {
  const desk = fixtureDeskView();
  const { view } = setup('', undefined, undefined, { deskView: () => desk, idleTimeoutSeconds: 5 });
  for (let i = 0; i < 4 * 60; i++) view.update(i / 60, 1 / 60); // under the timeout
  assert.equal(view.mode, 'first-person');
  for (let i = 4 * 60; i < 6 * 60; i++) view.update(i / 60, 1 / 60); // past it
  assert.equal(view.mode, 'desk');
});

test('issue #161: any camera input resets the idle timer', () => {
  const desk = fixtureDeskView();
  const { view, press } = setup('', undefined, undefined, { deskView: () => desk, idleTimeoutSeconds: 5 });
  for (let i = 0; i < 4 * 60; i++) view.update(i / 60, 1 / 60);
  press('KeyW'); // resets the idle clock; a camera input even though it does not move a locked camera
  for (let i = 4 * 60; i < 8 * 60; i++) view.update(i / 60, 1 / 60); // 4 more seconds: still short of a fresh 5 s timeout
  assert.equal(view.mode, 'first-person', 'the input reset the idle clock');
});

test('idling without a deskView option is a no-op forever (graceful degradation)', () => {
  const { view } = setup('', undefined, undefined, { idleTimeoutSeconds: 1 });
  for (let i = 0; i < 5 * 60; i++) view.update(i / 60, 1 / 60);
  assert.equal(view.mode, 'first-person');
});

// --- Desk camera FOV (issue #199) ---

test('a deskView with fov widens the shared camera only in desk mode, and restores it on exit', () => {
  const desk = fixtureDeskViewWithFov();
  const { view, camera, press } = setup('', undefined, undefined, { deskView: () => desk });
  const defaultFov = camera.fov;
  press('KeyH');
  assert.equal(camera.fov, desk.fov, 'desk mode widens the lens as soon as it is entered');
  press('KeyH');
  assert.equal(camera.fov, defaultFov, 'leaving desk mode restores the exact prior lens');
});

test('a deskView with fov restores the lens on the way out to the isometric view too', () => {
  const desk = fixtureDeskViewWithFov();
  const { view, camera, press } = setup('', undefined, undefined, { deskView: () => desk });
  const defaultFov = camera.fov;
  press('KeyH');
  assert.equal(camera.fov, desk.fov);
  press('KeyI');
  assert.equal(view.mode, 'isometric');
  assert.equal(camera.fov, defaultFov, 'isometric framing uses the restored lens, not the widened one');
});

test('entering and leaving desk mode twice never loses or corrupts the restored lens', () => {
  const desk = fixtureDeskViewWithFov();
  const { camera, press } = setup('', undefined, undefined, { deskView: () => desk });
  const defaultFov = camera.fov;
  press('KeyH');
  press('KeyH');
  assert.equal(camera.fov, defaultFov, 'first round trip restores the lens');
  press('KeyH');
  assert.equal(camera.fov, desk.fov, 'second entry widens it again from the same restored baseline');
  press('KeyH');
  assert.equal(camera.fov, defaultFov, 'second round trip restores it again, not some stale value');
});

test('a deskView without fov (an older layout, or a test fixture) never touches the lens — old behavior', () => {
  const desk = fixtureDeskView();
  const { camera, press } = setup('', undefined, undefined, { deskView: () => desk });
  const defaultFov = camera.fov;
  press('KeyH');
  assert.equal(camera.fov, defaultFov, 'no fov on the pose means no lens change at all');
  press('KeyH');
  assert.equal(camera.fov, defaultFov);
});

// --- Double-click a room in isometric (issue #175) ---

test('double-clicking a room in the isometric view enters it in first person, at its standing pose', () => {
  const room = { bounds: new THREE.Box3(new THREE.Vector3(20, 0, -6), new THREE.Vector3(32, 2.6, 6)), standing: { position: new THREE.Vector3(24, EYE_HEIGHT, 0), lookAt: new THREE.Vector3(30, EYE_HEIGHT, 0) } };
  // The fixture scene has no floor geometry for the isometric camera to frame around, so this
  // stub answers for whatever ground point the ray actually lands on (the real `roomAt`'s own
  // rect-containment check is covered directly in tests/building.test.ts).
  const { view, camera, canvas, press } = setup('', undefined, undefined, { roomAt: () => room });
  press('KeyI');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  canvas.dispatchEvent(new dom.window.MouseEvent('dblclick', { clientX: 800, clientY: 450 }));
  assert.equal(view.mode, 'first-person', 'double-click leaves the isometric view for first person');
  assert.ok(camera.position.distanceTo(room.standing.position) < 1e-6, 'lands exactly at the room\'s own standing pose, a cut (leaving isometric never flies)');
});

test('double-click does nothing outside the isometric view, or when no room is under the point', () => {
  const { view: firstPersonView, canvas: firstPersonCanvas } = setup('', undefined, undefined, { roomAt: () => ({ bounds: new THREE.Box3(), standing: { position: new THREE.Vector3(1, 1, 1), lookAt: new THREE.Vector3() } }) });
  firstPersonCanvas.dispatchEvent(new dom.window.MouseEvent('dblclick', { clientX: 800, clientY: 450 }));
  assert.equal(firstPersonView.mode, 'first-person', 'a double-click outside the isometric view does nothing');

  const { view, canvas, press } = setup('', undefined, undefined, { roomAt: () => null });
  press('KeyI');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  canvas.dispatchEvent(new dom.window.MouseEvent('dblclick', { clientX: 800, clientY: 450 }));
  assert.equal(view.mode, 'isometric', 'a double-click over no room (or without a roomAt option) stays in isometric');
});

test('#view=iso starts in the isometric view', () => {
  const { view } = setup('#view=iso');
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'isometric');
  assert.ok((view.activeCamera as THREE.OrthographicCamera).isOrthographicCamera);
});

test('issue #89: #zoom= starts the isometric view at the equivalent camera distance, not its own default framing', () => {
  const baseline = setup('#view=iso');
  const { view, camera } = setup('#view=iso&zoom=15');
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'isometric');
  assert.ok(Math.abs(view.zoomDistance - 15) < 1e-6, `zoomDistance is the requested 15 (got ${view.zoomDistance})`);
  assert.notEqual(view.zoomDistance, baseline.view.zoomDistance, 'different from the view’s own default framing');
  assert.ok(camera.position.y > 0, 'still a real isometric pose, not a degenerate one');
});

test('issue #89: #zoom= is clamped into the view’s own pan/zoom limits, like the wheel already is', () => {
  const baseline = setup('#view=iso');
  baseline.view.update(0, 1 / 60);
  const { view, camera } = setup('#view=iso&zoom=1000000');
  view.update(0, 1 / 60);
  const isometric = (view as unknown as { isometric: { maxHalfHeight: number } }).isometric;
  // The real upper bound (review, #184): equivalentDistance is halfHeight / tan(fov/2), the
  // inverse of applyStartZoom's own conversion, so this is the exact distance maxHalfHeight
  // maps to — not just "some finite number", which would still pass with the clamp removed.
  const maxZoomDistance = isometric.maxHalfHeight / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  assert.ok(Math.abs(view.zoomDistance - maxZoomDistance) < 1e-6, `clamped to the real zoom-out limit (${view.zoomDistance} vs maxHalfHeight-derived ${maxZoomDistance})`);
  assert.notEqual(view.zoomDistance, baseline.view.zoomDistance, 'different from the view’s own default framing');
});

test('issue #89 review, fix round 2: a bare #zoom= (no #select=) only sets the initial framing; a later, unrelated click gets its own normal framing', () => {
  const { view, manager, selection } = setup('#view=iso&zoom=20');
  view.update(0, 1 / 60);
  manager.addAgent({ id: 'other', name: 'Other', activity: 'idle' });
  selection.select('other');
  for (let i = 0; i < 120; i++) view.update(i / 60, 1 / 60);
  assert.notEqual(view.zoomDistance, 20, `an unrelated click should use its own normal framing, not the bare #zoom= (got ${view.zoomDistance})`);
});

test('issue #89 review, fix round 2: #zoom=&select=wanted — a decoy selected first gets normal framing, and "wanted" never steals it back', () => {
  const { view, manager, selection } = setup('#view=iso&zoom=20&select=wanted');
  manager.addAgent({ id: 'decoy', name: 'Decoy', activity: 'idle' });
  selection.select('decoy'); // selected before "wanted" ever appears
  for (let i = 0; i < 120; i++) view.update(i / 60, 1 / 60);
  assert.notEqual(view.zoomDistance, 20, `the decoy should get its own normal framing, not the zoom meant for "wanted" (got ${view.zoomDistance})`);

  manager.addAgent({ id: 'wanted', name: 'Wanted', activity: 'idle' });
  view.agentsChanged(manager.getAgents());
  for (let i = 0; i < 120; i++) view.update(120 / 60 + i / 60, 1 / 60);
  assert.notEqual(view.zoomDistance, 20, '"wanted" lost its claim once another agent was selected first: the URL zoom is dropped for good, not reclaimed');
});

/** A room away from the default scene origin, so framing it looks different from the view's own default. */
function fixtureRoomView(): { bounds: THREE.Box3; standing: { position: THREE.Vector3; lookAt: THREE.Vector3 } } {
  const bounds = new THREE.Box3(new THREE.Vector3(20, 0, -6), new THREE.Vector3(32, 2.6, 6));
  // issue #174: first person always settles at EYE_HEIGHT once grounded, so a standing
  // fixture at any other height would never survive a single `view.update()` call.
  return { bounds, standing: { position: new THREE.Vector3(24, EYE_HEIGHT, 0), lookAt: new THREE.Vector3(30, EYE_HEIGHT, 0) } };
}

test('issue #89: #room= frames a named room in the isometric view, via the active layout', () => {
  const room = fixtureRoomView();
  const { view } = setup('#view=iso&room=office', undefined, (name) => (name === 'office' ? room : null));
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'isometric');
  const target = (view as unknown as { isometric: { target: THREE.Vector3 } }).isometric.target;
  const center = room.bounds.getCenter(new THREE.Vector3());
  assert.ok(Math.abs(target.x - center.x) < 0.5 && Math.abs(target.z - center.z) < 0.5, `target is near the room's center (${target.toArray()} vs ${center.toArray()})`);
});

test('issue #89: #room= in first person stands inside the room, facing its main wall', () => {
  const room = fixtureRoomView();
  const { view, camera } = setup('#room=library', undefined, (name) => (name === 'library' ? room : null));
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.ok(camera.position.distanceTo(room.standing.position) < 1e-6, `camera stands at the room's standing point (${camera.position.toArray()})`);
});

test('issue #89: #room= with an unknown name, or no roomView at all, is a no-op (the view keeps its own default framing)', () => {
  const baseline = setup('#view=iso');
  baseline.view.update(0, 1 / 60);
  const { view } = setup('#view=iso&room=not-a-room', undefined, () => null);
  view.update(0, 1 / 60);
  assert.equal(view.zoomDistance, baseline.view.zoomDistance);

  const noCallback = setup('#view=iso&room=office');
  noCallback.view.update(0, 1 / 60);
  assert.equal(noCallback.view.zoomDistance, baseline.view.zoomDistance, 'no roomView option at all is the same as an unknown name');
});

test('issue #89: #room= wins over #zoom= when both are given and the room resolves', () => {
  const room = fixtureRoomView();
  const { view } = setup('#view=iso&zoom=5&room=office', undefined, (name) => (name === 'office' ? room : null));
  view.update(0, 1 / 60);
  assert.notEqual(view.zoomDistance, 5, 'the room framing wins, not the literal #zoom= value');
});

test('a click picks a tombstone, not just an agent figure (issue #127)', () => {
  const document = dom.window.document;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(0, 1, 5);
  const tombstone = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
  mesh.layers.set(STATIC_SOURCE_LAYER);
  tombstone.add(mesh);
  tombstone.position.set(0, 1, 0);
  scene.add(tombstone);
  camera.lookAt(tombstone.position);
  scene.updateMatrixWorld(true);
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const manager = new AgentManager(scene, fixedLayout);
  const view = new ViewController({
    camera, canvas, scene,
    agents: () => manager.getAgents(),
    tombstones: () => [{ id: 'tomb-1', object: tombstone }],
    keys: dom.window,
  });
  assert.equal(view.pickAt(800, 450), 'tomb-1');
});

test('an open tombstone card survives a routine agent poll (issue #127)', () => {
  const document = dom.window.document;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 1600 });
  Object.defineProperty(canvas, 'clientHeight', { value: 900 });
  document.body.appendChild(canvas);
  const manager = new AgentManager(scene, fixedLayout);
  const selection = new SelectionState();
  const tombstone = new THREE.Object3D();
  const view = new ViewController({
    camera, canvas, scene, selection,
    agents: () => manager.getAgents(),
    tombstones: () => [{ id: 'tomb-1', object: tombstone }],
    keys: dom.window,
  });

  selection.select('tomb-1');
  // The 3 s agent poll calls this with no agents at all in an otherwise empty office;
  // a tombstone never appears in `agents`, so it must not look like it "left".
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, 'tomb-1');

  // A tombstone that genuinely goes away (the room's world update removed it) still deselects.
  const otherView = new ViewController({
    camera, canvas, scene, selection,
    agents: () => manager.getAgents(),
    tombstones: () => [],
    keys: dom.window,
  });
  otherView.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, null);
});

test('#focus selects the agent once it appears, and flies the camera to it', () => {
  const { view, manager, selection, camera } = setup('#focus=agent-1');
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, null);

  manager.addAgent({ id: 'agent-1', name: 'One', activity: 'idle' });
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, 'agent-1');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  const lookAt = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const toAgent = new THREE.Vector3(4, 1.1, -3).sub(camera.position).normalize(); // chest height, where flyToAgent aims
  assert.ok(lookAt.dot(toAgent) > 0.99, 'the camera looks at the selected agent');

  selection.clear();
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, null, 'the focus applies only once');
});

test('issue #89: #select= selects the agent once it appears, the same as #focus=', () => {
  const { view, manager, selection } = setup('#view=iso&select=agent-1');
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, null);

  manager.addAgent({ id: 'agent-1', name: 'One', activity: 'idle' });
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, 'agent-1');
});

test('issue #89 review (fix 1): #zoom= and #select=/#focus= together both survive — the pending selection flight honors the requested zoom', () => {
  const { view, manager, selection } = setup('#view=iso&zoom=20&select=agent-1');
  view.agentsChanged(manager.getAgents());

  manager.addAgent({ id: 'agent-1', name: 'One', activity: 'idle' });
  view.agentsChanged(manager.getAgents()); // the pending #select= fires here, starting the flight
  assert.equal(selection.selected, 'agent-1');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60); // let the 0.6 s flight finish
  assert.ok(Math.abs(view.zoomDistance - 20) < 0.5, `settles at the requested zoom, 20 (got ${view.zoomDistance})`);
});

test('issue #89 review (fix 1): #zoom= is consumed only once — a later selection uses the normal fixed framing distance', () => {
  const { view, manager, selection } = setup('#view=iso&zoom=20&select=agent-1');
  view.agentsChanged(manager.getAgents());
  manager.addAgent({ id: 'agent-1', name: 'One', activity: 'idle' });
  manager.addAgent({ id: 'agent-2', name: 'Two', activity: 'idle' });
  view.agentsChanged(manager.getAgents());
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.ok(Math.abs(view.zoomDistance - 20) < 0.5, 'the first (pending #select=) flight honors #zoom=');

  selection.select('agent-2'); // a second, ordinary selection: #zoom= no longer applies
  for (let i = 0; i < 60; i++) view.update(1 + i / 60, 1 / 60);
  assert.ok(Math.abs(view.zoomDistance - 20) > 1, `a later selection is not pinned to the stale #zoom= value (got ${view.zoomDistance})`);
});

test('Esc clears the selection and an agent that leaves is deselected', () => {
  const { view, manager, selection, press } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  press('Escape');
  assert.equal(selection.selected, null);

  selection.select('a');
  manager.removeAgent('a');
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, null);
});

test('selecting in first person flies there and keeps first person', () => {
  const { view, manager, selection, camera } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.ok(camera.position.distanceTo(new THREE.Vector3(4, 0, -3)) < 7);
});

test('reselect flies the camera to the already-selected agent again (a marker or the top-count click)', () => {
  const { view, manager, selection, camera } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  const figurePosition = manager.getAgents().find((agent) => agent.info.id === 'a')!.figure.group.position;
  selection.select('a');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);

  // The player wandered off in first person; the camera no longer sits near the agent.
  camera.position.set(50, 0, 50);
  assert.ok(camera.position.distanceTo(figurePosition) > 40, 'the camera should start far from the agent');

  selection.reselect();
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.ok(camera.position.distanceTo(figurePosition) < 7, `expected the camera back near the agent, got ${camera.position.toArray()}`);
});

test('zoomDistance reports the isometric camera distance and follows the wheel', () => {
  const { view } = setup('#view=iso');
  const before = view.zoomDistance;
  assert.ok(Number.isFinite(before) && before > 0);
  const canvases = dom.window.document.querySelectorAll('canvas');
  const canvas = canvases[canvases.length - 1];
  canvas.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -400, cancelable: true }));
  assert.ok(view.zoomDistance < before, `zoomed in (${view.zoomDistance} < ${before})`);
});

function screenX(camera: THREE.Camera, point: THREE.Vector3): number {
  camera.updateMatrixWorld();
  return point.clone().project(camera).x;
}

for (const hash of ['#view=iso', '']) {
  const mode = hash ? 'isometric' : 'first person';
  test(`${mode}: with an open agent card the camera frames the figure left of the card`, () => {
    const { view, manager, selection } = setup(hash, () => 300);
    manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
    selection.select('a');
    for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
    const target = hash ? new THREE.Vector3(4, 0, -3) : new THREE.Vector3(4, 1.1, -3);
    // 300 px left of the center of a 1600 px canvas is -0.375 in normalized device coordinates.
    assert.ok(Math.abs(screenX(view.activeCamera, target) + 0.375) < 0.02, `figure at x=${screenX(view.activeCamera, target)}`);
  });

  test(`${mode}: without a card shift the camera centers the figure (old behavior)`, () => {
    const { view, manager, selection } = setup(hash);
    manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
    selection.select('a');
    for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
    const target = hash ? new THREE.Vector3(4, 0, -3) : new THREE.Vector3(4, 1.1, -3);
    assert.ok(Math.abs(screenX(view.activeCamera, target)) < 0.02, `figure at x=${screenX(view.activeCamera, target)}`);
  });
}

test('a click that misses every agent closes the open agent card (issue #133)', () => {
  const { view, manager, selection, canvas } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10 }));
  assert.equal(selection.selected, null);
});

test('a drag release is never misread as a closing click (issue #133)', () => {
  const { view, manager, selection, canvas } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 400, clientY: 10 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 400, clientY: 10 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 400, clientY: 10 }));
  assert.equal(selection.selected, 'a', 'the drag release does not clear the card');
});

test('an out-and-back pan in the isometric view is never misread as a closing click (issue #133)', () => {
  const { view, manager, selection, canvas, press } = setup();
  press('KeyI'); // isometric: the only mode that pans on drag
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  // Past the click tolerance, then back near the press point: `isClick` alone compares only
  // endpoints, so without tracking the drag itself this reads as a miss on release.
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 400, clientY: 10 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 10, clientY: 10 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 10, clientY: 10 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10 }));
  assert.equal(selection.selected, 'a', 'a pan that returns near the press point still does not clear the card');
});

test('a click while pointer-locked is for looking, not for closing the card (issue #133)', () => {
  const { view, manager, selection, canvas } = setup();
  const document = dom.window.document;
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  Object.defineProperty(document, 'pointerLockElement', { value: canvas, configurable: true });
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10 }));
  assert.equal(selection.selected, 'a', 'a locked click looks around, it does not close the card');
  Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
});

test('a click outside the canvas (the card, a panel, the legend) never reaches the click handler (issue #133)', () => {
  const { view, manager, selection } = setup();
  const document = dom.window.document;
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  const card = document.createElement('div');
  document.body.appendChild(card);
  card.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }));
  assert.equal(selection.selected, 'a', 'a click on a sibling element never clears the card');
  card.remove();
});

test('first person: the card shift turns only the aim; the camera stands where the unshifted flight puts it', () => {
  const fly = (shift?: () => number) => {
    const { view, manager, selection, camera } = setup('', shift);
    manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
    selection.select('a');
    for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
    return { position: camera.position.clone(), forward: new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion) };
  };
  const plain = fly();
  const shifted = fly(() => 300);
  assert.ok(shifted.position.distanceTo(plain.position) < 1e-6, `camera moved by ${shifted.position.distanceTo(plain.position)}`);
  assert.ok(shifted.forward.angleTo(plain.forward) > 0.05, 'the aim turns toward the screen right');
});

// --- Crosshair dot and a locked click selects under it (issue #205) ---

test('a locked click selects whatever is under the center dot, not the click position', () => {
  const document = dom.window.document;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(0, 1, 5);
  const tombstone = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
  mesh.layers.set(STATIC_SOURCE_LAYER);
  tombstone.add(mesh);
  tombstone.position.set(0, 1, 0);
  scene.add(tombstone);
  camera.lookAt(tombstone.position); // dead center of the frame, where the dot sits
  scene.updateMatrixWorld(true);
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(canvas);
  const manager = new AgentManager(scene, fixedLayout);
  const selection = new SelectionState();
  new ViewController({
    camera, canvas, scene, selection,
    agents: () => manager.getAgents(),
    tombstones: () => [{ id: 'tomb-1', object: tombstone }],
    keys: dom.window,
  });
  Object.defineProperty(document, 'pointerLockElement', { value: canvas, configurable: true });
  // Clicked at a screen corner, nowhere near the target: a locked click never reads this point.
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10 }));
  assert.equal(selection.selected, 'tomb-1', 'the center dot, not the click position, picks the target');
  Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
});

test('a locked click that misses never selects and never clears the existing selection (issue #133 behavior unchanged)', () => {
  const { manager, selection, canvas } = setup();
  const document = dom.window.document;
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  Object.defineProperty(document, 'pointerLockElement', { value: canvas, configurable: true });
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10 }));
  assert.equal(selection.selected, 'a', 'a locked miss leaves the selection exactly as it was');
  Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
});

test('a locked click never leaves pointer lock and never changes the view mode', () => {
  const { view, manager, selection, canvas } = setup();
  const document = dom.window.document;
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  Object.defineProperty(document, 'pointerLockElement', { value: canvas, configurable: true });
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10 }));
  assert.equal(view.mode, 'first-person');
  assert.equal(document.pointerLockElement, canvas, 'the click never exits pointer lock itself');
  Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
  assert.equal(selection.selected, null);
});

test('the crosshair dot shows only in first person while the pointer is locked', () => {
  const dot = dom.window.document.createElement('div');
  const { canvas, press } = setup('', undefined, undefined, { crosshair: dot });
  const document = dom.window.document;
  assert.equal(dot.style.display, 'none', 'hidden by default: first person, not locked');

  Object.defineProperty(document, 'pointerLockElement', { value: canvas, configurable: true });
  document.dispatchEvent(new dom.window.Event('pointerlockchange'));
  assert.equal(dot.style.display, 'block', 'shown: first person and locked');

  press('KeyI');
  assert.equal(dot.style.display, 'none', 'hidden in the isometric view, even with the lock flag still set');

  press('KeyI'); // back to first person; the mock lock flag never actually changed
  assert.equal(dot.style.display, 'block', 'shown again on return to first person');

  Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
  document.dispatchEvent(new dom.window.Event('pointerlockchange'));
  assert.equal(dot.style.display, 'none', 'hidden once the lock exits');
});

test('the crosshair dot is untouched without a crosshair option at all (graceful degradation)', () => {
  const { view, press } = setup();
  assert.doesNotThrow(() => press('KeyI'));
  assert.equal(view.mode, 'isometric');
});

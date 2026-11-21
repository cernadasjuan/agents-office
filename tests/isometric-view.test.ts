import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { RoomView, Seat, LayoutStrategy } from '../src/layout/LayoutStrategy.js';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body><div id="pointer-hint"></div></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { ViewController } = await import('../src/scene/ViewController.js');
const { SelectionState, parseViewHash } = await import('../src/scene/Selection.js');
const { IsometricController, isometricDirection, ISO_ELEVATION, floorPointUnderCursor, zoomTowardCursor, followIsometric, isometricAtRest, applyIsometricState, distanceForHalfHeight } = await import('../src/scene/IsometricCamera.js');
const { chooseViewMode, viewStatusText } = await import('../src/scene/ViewMemory.js');
const { labelDetail, signVisible, roomLabelVisible, ISOMETRIC_FULL_LABEL_ZOOM } = await import('../src/ui/LabelDetail.js');
const { renderQuality } = await import('../src/scene/RenderScheduler.js');
const { roomLabelPose } = await import('../src/addons/building/roomLabels.js');
const { findCeilings } = await import('../src/scene/Cutaway.js');
const { createWalls } = await import('../src/furniture/Walls.js');
const { FrameLoop } = await import('../src/scene/FrameLoop.js');
const { markStatic } = await import('../src/scene/StaticMerge.js');
const { EYE_HEIGHT } = await import('../src/scene/FreeCamera.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const BUILDING = new THREE.Box3(new THREE.Vector3(-30, 0, -20), new THREE.Vector3(30, 3, 20));

function corners(box: THREE.Box3): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) points.push(new THREE.Vector3(x, y, z));
  return points;
}

function framedCamera(aspect = 16 / 9) {
  const iso = new IsometricController();
  iso.frame(BUILDING, aspect);
  const camera = new THREE.OrthographicCamera();
  iso.applyTo(camera, aspect, 60);
  camera.updateMatrixWorld();
  return { iso, camera };
}

// --- The isometric camera ---

test('the isometric direction is the classic angle: 35.26 degrees above the floor, at 45 degrees to the walls', () => {
  const direction = isometricDirection();
  assert.ok(Math.abs(ISO_ELEVATION - Math.atan(1 / Math.SQRT2)) < 1e-9);
  assert.ok(Math.abs(Math.abs(direction.x) - Math.abs(direction.z)) < 1e-9, 'equal angle to both wall axes');
  assert.ok(Math.abs(direction.length() - 1) < 1e-9);
});

test('framed, the whole building is on screen with an orthographic projection', () => {
  for (const aspect of [16 / 9, 0.6]) {
    const { camera } = framedCamera(aspect);
    for (const corner of corners(BUILDING)) {
      const ndc = corner.clone().project(camera);
      assert.ok(Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && Math.abs(ndc.z) <= 1, `corner ${corner.toArray()} at ${ndc.toArray()} (aspect ${aspect})`);
    }
  }
});

test('no perspective distortion: the same floor length has the same screen length near and far', () => {
  const { camera } = framedCamera();
  const screenLength = (z: number) => new THREE.Vector3(1, 0, z).project(camera).distanceTo(new THREE.Vector3(-1, 0, z).project(camera));
  assert.ok(Math.abs(screenLength(-18) - screenLength(18)) < 1e-9);
});

test('the wheel zooms within limits and the zoom reads as an overview-like distance', () => {
  const { iso } = framedCamera();
  const framed = iso.halfHeight;
  const distance = iso.equivalentDistance(60);
  iso.zoom(-400);
  assert.ok(iso.halfHeight < framed);
  assert.ok(iso.equivalentDistance(60) < distance, 'zooming in lowers the distance the label rules read');
  for (let i = 0; i < 50; i++) iso.zoom(-1000);
  assert.ok(iso.halfHeight >= iso.minHalfHeight - 1e-9);
  for (let i = 0; i < 50; i++) iso.zoom(1000);
  assert.ok(iso.halfHeight <= iso.maxHalfHeight + 1e-9);
});

test('issue #87 AC1: the isometric wheel zooms toward the cursor — the same floor point stays under it after 5 zoom steps', () => {
  const aspect = 16 / 9;
  const { iso } = framedCamera(aspect);
  const ndcX = 0.4;
  const ndcY = 0.3;
  const underCursor = floorPointUnderCursor(iso.target, iso.halfHeight, aspect, ndcX, ndcY);
  const halfHeightBefore = iso.halfHeight;

  // -100 per step: one mouse wheel notch in most browsers.
  for (let step = 0; step < 5; step++) zoomTowardCursor(iso, ndcX, ndcY, -100, aspect);
  assert.ok(iso.halfHeight < halfHeightBefore, 'zoomed in');

  const camera = new THREE.OrthographicCamera();
  iso.applyTo(camera, aspect, 60);
  camera.updateMatrixWorld();
  const projected = underCursor.clone().project(camera);

  const viewportHeight = 900;
  const pxDx = ((projected.x - ndcX) / 2) * (viewportHeight * aspect);
  const pxDy = ((projected.y - ndcY) / 2) * viewportHeight;
  assert.ok(Math.hypot(pxDx, pxDy) < 50, `point stayed under the cursor within 50 px (off by ${Math.hypot(pxDx, pxDy)})`);
});

test('issue #87: the isometric zoom still respects the pan/zoom limits (min/max half-height, floor bounds)', () => {
  const aspect = 16 / 9;
  const { iso } = framedCamera(aspect);
  const framed = iso.halfHeight;

  for (let step = 0; step < 50; step++) zoomTowardCursor(iso, 0.9, 0.9, -100000, aspect);
  assert.ok(iso.halfHeight >= iso.minHalfHeight - 1e-9);
  assert.ok(iso.target.x >= BUILDING.min.x - 1e-6 && iso.target.x <= BUILDING.max.x + 1e-6, `target.x ${iso.target.x} stayed in bounds`);
  assert.ok(iso.target.z >= BUILDING.min.z - 1e-6 && iso.target.z <= BUILDING.max.z + 1e-6, `target.z ${iso.target.z} stayed in bounds`);

  const { iso: iso2 } = framedCamera(aspect);
  for (let step = 0; step < 50; step++) zoomTowardCursor(iso2, -0.9, -0.9, 100000, aspect);
  assert.ok(iso2.halfHeight <= iso2.maxHalfHeight + 1e-9);
  assert.ok(iso2.halfHeight <= framed * 1.5 + 1e-6);
  assert.ok(iso2.target.x >= BUILDING.min.x - 1e-6 && iso2.target.x <= BUILDING.max.x + 1e-6, `target.x ${iso2.target.x} stayed in bounds`);
  assert.ok(iso2.target.z >= BUILDING.min.z - 1e-6 && iso2.target.z <= BUILDING.max.z + 1e-6, `target.z ${iso2.target.z} stayed in bounds`);
});

test('the same zoom gives the same screen size as the overview at that distance', () => {
  const { iso, camera } = framedCamera();
  iso.zoom(-600);
  iso.applyTo(camera, 16 / 9, 60);
  camera.updateMatrixWorld();
  const perspective = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
  perspective.position.copy(iso.target).addScaledVector(isometricDirection(), iso.equivalentDistance(60));
  perspective.lookAt(iso.target);
  perspective.updateMatrixWorld();
  const size = (cam: THREE.Camera) => iso.target.clone().add(new THREE.Vector3(1, 0, 1)).project(cam).distanceTo(iso.target.clone().project(cam));
  assert.ok(Math.abs(size(camera) - size(perspective)) < 1e-6, `ortho ${size(camera)} vs perspective ${size(perspective)}`);
});

test('a drag moves the floor with the pointer, and the target stays over the building', () => {
  const { iso, camera } = framedCamera();
  const start = iso.target.clone();
  iso.drag(-100, 0, 900);
  assert.ok(iso.target.distanceTo(start) > 0.5, 'a drag pans');
  // The floor point under the pointer follows it: the target moved right on screen by 100 px of floor
  iso.applyTo(camera, 16 / 9, 60);
  camera.updateMatrixWorld();
  const moved = start.clone().project(camera);
  assert.ok(Math.abs(moved.x * 800 + 100) < 1, `start point now ${moved.x * 800} px from the center`);
  for (let i = 0; i < 100; i++) iso.pan(100, 100);
  assert.ok(iso.target.x <= BUILDING.max.x && iso.target.z >= BUILDING.min.z);
});

test('a vertical drag keeps the floor point under the pointer despite the tilt', () => {
  const { iso, camera } = framedCamera();
  const start = iso.target.clone();
  iso.drag(0, 90, 900);
  iso.applyTo(camera, 16 / 9, 60);
  camera.updateMatrixWorld();
  const moved = start.clone().project(camera);
  assert.ok(Math.abs(moved.y * 450 + 90) < 1, `start point now ${moved.y * 450} px from the center`);
});

// --- The goal/follower redesign (issue #113) ---

/** A small, seeded PRNG (mulberry32): deterministic across runs, no flaky property test. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: whatever the goal does — a wheel tick, a cursor zoom, a drag, a selection, a bounds grow or shrink, a resize — one follower step never moves the camera more than its own step limit', () => {
  const rng = mulberry32(1113);
  const aspect = 16 / 9;
  let bounds = new THREE.Box3(new THREE.Vector3(-30, 0, -20), new THREE.Vector3(30, 3, 20));
  const goal = new IsometricController();
  goal.frame(bounds, aspect);
  let live = goal.state();

  for (let i = 0; i < 2000; i++) {
    const action = Math.floor(rng() * 7);
    if (action === 0) goal.zoom((rng() - 0.5) * 2000); // the wheel
    else if (action === 1) zoomTowardCursor(goal, rng() * 2 - 1, rng() * 2 - 1, (rng() - 0.5) * 2000, aspect); // cursor zoom
    else if (action === 2) goal.drag((rng() - 0.5) * 400, (rng() - 0.5) * 400, 900); // a drag
    else if (action === 3) goal.focusOn(new THREE.Vector3((rng() - 0.5) * 120, 0, (rng() - 0.5) * 80)); // a selection
    else if (action === 4) { // bounds grow or shrink (a room added or removed)
      const half = 10 + rng() * 40;
      bounds = new THREE.Box3(new THREE.Vector3(-half, 0, -half * 0.7), new THREE.Vector3(half, 3, half * 0.7));
      goal.retrack(bounds, aspect);
    } else if (action === 5) { // a resize
      goal.retrack(bounds, 0.5 + rng() * 2);
    } // action 6: no input this tick, only the follower runs

    const delta = 1 / 144 + rng() * (1 / 20); // a ragged frame rate, 7 to 55 ms
    const reference = Math.max(live.halfHeight, goal.state().halfHeight, 5);
    const maxPan = 7 * reference * delta + 1e-9;
    const maxZoom = 4.5 * reference * delta + 1e-9;
    const before = live;
    live = followIsometric(live, goal.state(), delta);
    const panMoved = before.target.distanceTo(live.target);
    const zoomMoved = Math.abs(live.halfHeight - before.halfHeight);
    assert.ok(panMoved <= maxPan, `step ${i}: pan moved ${panMoved}, limit ${maxPan}`);
    assert.ok(zoomMoved <= maxZoom, `step ${i}: zoom moved ${zoomMoved}, limit ${maxZoom}`);
    assert.ok(Number.isFinite(live.target.x) && Number.isFinite(live.halfHeight), `step ${i}: live state stays finite`);
  }
});

test('the follower lands exactly on the goal (no asymptotic creep) once within its step for the frame', () => {
  const goal: { target: THREE.Vector3; halfHeight: number } = { target: new THREE.Vector3(10, 0, -4), halfHeight: 8 };
  let live = { target: new THREE.Vector3(10.001, 0, -4), halfHeight: 8.0001 };
  live = followIsometric(live, goal, 1 / 60);
  assert.ok(isometricAtRest(live, goal), 'a tiny remaining gap closes in one step, not forever');
  assert.deepEqual(live.target.toArray(), goal.target.toArray());
  assert.equal(live.halfHeight, goal.halfHeight);
});

test('applyIsometricState: the far plane covers whichever of the live and the goal distance is farther', () => {
  const live = { target: new THREE.Vector3(0, 0, 0), halfHeight: 10 };
  const camera = new THREE.OrthographicCamera();
  const liveDistance = distanceForHalfHeight(10, 60);
  const closerGoalDistance = distanceForHalfHeight(6, 60);
  applyIsometricState(live, 40, camera, 16 / 9, 60, closerGoalDistance);
  assert.ok(camera.far >= liveDistance + 40 - 1e-6, 'a goal that is now closer never drops the far plane below the live camera');

  const fartherGoalDistance = distanceForHalfHeight(30, 60);
  applyIsometricState(live, 40, camera, 16 / 9, 60, fartherGoalDistance);
  assert.ok(camera.far >= fartherGoalDistance + 40 - 1e-6, 'a goal that is now farther grows the far plane ahead of the live camera');
});

// --- View controller ---

const fixedLayout: LayoutStrategy = {
  id: 'fixed',
  seatFor: (agent): Seat => ({ key: agent.id, position: new THREE.Vector3(4, 0, -3), lookAt: new THREE.Vector3(4, 0, 0) }),
  release: () => undefined,
};

function setup(hash = '', options: { figureShiftPx?: () => number; view?: 'first-person' | 'isometric'; roomView?: (name: string) => RoomView | null } = {}) {
  const document = dom.window.document;
  const scene = new THREE.Scene();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  wall.userData.hiddenFromAbove = true;
  scene.add(wall);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(-12, EYE_HEIGHT, 11); // issue #174: first person settles here every frame it is grounded
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 1600, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: 900, configurable: true });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900, x: 0, y: 0, toJSON: () => ({}) });
  document.body.appendChild(canvas);
  const manager = new AgentManager(scene, fixedLayout);
  const selection = new SelectionState();
  const hint = document.getElementById('pointer-hint');
  const modes: string[] = [];
  const view = new ViewController({
    camera, canvas, scene, selection, hint,
    agents: () => manager.getAgents(),
    keys: dom.window,
    hash,
    modeChanged: (mode) => modes.push(mode),
    ...options,
  });
  const press = (code: string) => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code, key: code }));
  const settle = () => { for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60); };
  return { view, camera, canvas, scene, manager, selection, wall, hint, press, modes, settle };
}

test('#view=iso starts in the isometric view with an orthographic camera and no near walls', () => {
  assert.equal(parseViewHash('#view=iso').view, 'isometric');
  const { view, wall, modes, hint } = setup('#view=iso');
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'isometric');
  assert.ok((view.activeCamera as THREE.OrthographicCamera).isOrthographicCamera);
  assert.equal(wall.visible, false);
  assert.deepEqual(modes, ['isometric']);
  assert.match(hint!.textContent ?? '', /isometric/i);
});

test('without the isometric view the active camera stays the perspective camera (old behavior)', () => {
  const { view, camera, press } = setup();
  assert.equal(view.activeCamera, camera);
  press('KeyO');
  assert.equal(view.activeCamera, camera);
});

test('key O does nothing: the overview mode is gone (#173)', () => {
  const { view, modes, press } = setup();
  const before = [...modes]; // the constructor reports the start mode once, before any key press
  press('KeyO');
  assert.equal(view.mode, 'first-person');
  assert.deepEqual(modes, before, 'no further mode change from the key press');
});

test('key I enters the isometric view and goes back to first person', () => {
  const { view, camera, wall, press, modes } = setup();
  press('KeyI');
  assert.equal(view.mode, 'isometric');
  assert.equal(wall.visible, false);
  press('KeyI');
  assert.equal(view.mode, 'first-person');
  assert.equal(wall.visible, true);
  assert.equal(view.activeCamera, camera);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(-12, EYE_HEIGHT, 11)) < 1e-6, 'first person comes back where it was');
  assert.deepEqual(modes, ['first-person', 'isometric', 'first-person']);
});

test('the given start view can be the isometric view (the remembered view)', () => {
  const { view } = setup('', { view: 'isometric' });
  assert.equal(view.mode, 'isometric');
});

test('in the isometric view the wheel zooms and the zoom distance follows it', () => {
  const { view, canvas, settle } = setup('#view=iso');
  settle();
  const before = view.zoomDistance;
  const camera = view.activeCamera as THREE.OrthographicCamera;
  const heightBefore = camera.top - camera.bottom;
  canvas.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -400, cancelable: true }));
  view.update(2, 1 / 60);
  assert.ok(view.zoomDistance < before, `zoomed in (${view.zoomDistance} < ${before})`);
  assert.ok(camera.top - camera.bottom < heightBefore, 'the orthographic frustum shrinks');
});

test('in the isometric view a drag and WASD pan the camera', () => {
  const { view, canvas, press, settle } = setup('#view=iso');
  settle();
  const camera = view.activeCamera;
  const start = camera.position.clone();
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 800, clientY: 450, button: 0 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 700, clientY: 450 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 700, clientY: 450 }));
  view.update(2, 1 / 60);
  const dragged = camera.position.clone();
  assert.ok(dragged.distanceTo(start) > 0.1, 'a drag pans');
  press('KeyD');
  for (let i = 0; i < 30; i++) view.update(3 + i / 60, 1 / 60);
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { code: 'KeyD' }));
  assert.ok(camera.position.distanceTo(dragged) > 0.1, 'D pans');
});

test('in the isometric view a click on a figure selects it, through the orthographic camera', () => {
  const { view, canvas, scene, manager, selection, settle } = setup('#view=iso');
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  settle();
  scene.updateMatrixWorld(true);
  const camera = view.activeCamera;
  camera.updateMatrixWorld();
  const chest = new THREE.Vector3(4, 1.1, -3).project(camera);
  const x = (chest.x + 1) * 800;
  const y = (1 - chest.y) * 450;
  assert.equal(view.pickAt(x, y), 'a');
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: x, clientY: y }));
  assert.equal(selection.selected, 'a');
  assert.equal(view.pickAt(5, 5), null);
});

for (const shift of [0, 300]) {
  test(`isometric: a selection flies to the figure ${shift ? 'left of the open agent card' : 'at the center'}`, () => {
    const { view, manager, selection, settle } = setup('#view=iso', shift ? { figureShiftPx: () => shift } : {});
    manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
    settle();
    const framed = view.zoomDistance;
    selection.select('a');
    for (let i = 0; i < 60; i++) view.update(2 + i / 60, 1 / 60);
    const camera = view.activeCamera;
    camera.updateMatrixWorld();
    const at = new THREE.Vector3(4, 0, -3).project(camera);
    const expected = shift ? -shift / 800 : 0;
    assert.ok(Math.abs(at.x - expected) < 0.02, `figure at x=${at.x}, want ${expected}`);
    assert.ok(Math.abs(at.y) < 0.02, `figure at y=${at.y}`);
    assert.ok(view.zoomDistance < framed, 'the camera zooms in on the figure');
  });
}

/** How long `view.update()` takes to land exactly on the goal (the live and goal pose both read equal), at a fixed `fps`, or -1 past `maxSeconds` (a stuck follower, not a slow one). */
function settleSeconds(view: { update(elapsed: number, delta: number): void }, isAtRest: () => boolean, fps: number, maxSeconds = 5): number {
  const delta = 1 / fps;
  let elapsed = 0;
  for (let i = 0; i < maxSeconds * fps; i++) {
    elapsed += delta;
    view.update(elapsed, delta);
    if (isAtRest()) return elapsed;
  }
  return -1;
}

for (const fps of [30, 60]) {
  test(`PR #200 review round: a selection flight from a typical distance settles in 0.45-0.8 s at ${fps} fps (a flight, not a jump)`, () => {
    const { view, manager, selection, settle } = setup('#view=iso');
    manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
    settle();
    selection.select('a');
    const seconds = settleSeconds(
      view,
      () => {
        const isometric = (view as unknown as { isometric: { target: THREE.Vector3; halfHeight: number } }).isometric;
        const live = (view as unknown as { liveIsometric: { target: THREE.Vector3; halfHeight: number } }).liveIsometric;
        return live.target.equals(isometric.target) && live.halfHeight === isometric.halfHeight;
      },
      fps,
    );
    assert.ok(seconds >= 0.45 && seconds <= 0.8, `settled in ${seconds} s at ${fps} fps, want 0.45-0.8 s (PR #140 wanted visible easing; the direct rates alone settled this in about 0.12 s, which read like a jump)`);
  });
}

test('PR #200 review round: a wheel tick keeps its direct-manipulation responsiveness, even right after a selection flight is still easing in', () => {
  const { view, canvas, manager, selection, settle } = setup('#view=iso');
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  settle();
  selection.select('a'); // starts a slow flight
  view.update(2, 1 / 60); // one frame into the flight, well short of settling
  const camera = view.activeCamera as THREE.OrthographicCamera;
  const before = camera.top - camera.bottom;

  canvas.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -400, cancelable: true }));
  view.update(2 + 1 / 60, 1 / 60);
  const afterOneFrame = camera.top - camera.bottom;
  // A direct-rate step at the live camera's own zoom closes a sizeable fraction of a typical
  // wheel notch in a single frame; a still-flight-paced step here would barely move at all.
  assert.ok(before - afterOneFrame > (before * 0.01), `one wheel tick still zooms in noticeably in a single frame (${before} to ${afterOneFrame})`);
});

// --- PR #140 parked failure repros, fixed by the goal/follower redesign (issue #113) ---

/** A floor the building's own size, so adding or removing an annex grows or shrinks the bounds instead of replacing them outright (the only floor object would otherwise be the annex itself). */
function addBaseFloor(scene: THREE.Scene): void {
  const base = new THREE.Mesh(new THREE.PlaneGeometry(30, 26));
  base.rotation.x = -Math.PI / 2;
  base.userData.floor = true;
  scene.add(base);
}

function addAnnex(scene: THREE.Scene, x: number): THREE.Mesh {
  const annex = new THREE.Mesh(new THREE.PlaneGeometry(10, 10));
  annex.rotation.x = -Math.PI / 2;
  annex.position.set(x, 0, 0);
  annex.userData.floor = true;
  scene.add(annex);
  return annex;
}

test('PR #140 repro 1: letting a wheel-retargeted correction finish never snaps the camera on the next frame', () => {
  const { view, canvas, settle } = setup('#view=iso');
  settle();
  canvas.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -400, cancelable: true }));
  const camera = view.activeCamera as THREE.OrthographicCamera;
  for (let i = 0; i < 120; i++) view.update(1 + i / 60, 1 / 60); // run well past any settling time
  const settledPosition = camera.position.clone();
  view.update(3, 1 / 60); // one further frame, no input at all
  assert.ok(camera.position.distanceTo(settledPosition) < 1e-6, 'no stale state left to snap back from');
});

test('PR #140 repro 2: a second bounds shrink mid-correction retargets smoothly, it never jumps to the stale first endpoint', () => {
  const { view, scene, settle } = setup('#view=iso');
  addBaseFloor(scene);
  const near = addAnnex(scene, 40);
  const far = addAnnex(scene, 100);
  view.sceneChanged();
  settle();
  const camera = view.activeCamera as THREE.OrthographicCamera;

  scene.remove(far); // first shrink: starts a correction toward the near-annex bounds
  view.sceneChanged();
  view.update(1, 1 / 60);
  const before = camera.position.clone();
  view.update(1 + 1 / 60, 1 / 60);
  const firstStep = camera.position.distanceTo(before);

  scene.remove(near); // second shrink, mid-correction: the goal moves again before the first arrives
  view.sceneChanged();
  view.update(1 + 2 / 60, 1 / 60);
  const secondStep = camera.position.distanceTo(before) - firstStep;
  // A stale tween retargeted in place (the parked bug) jumped by a large multiple of an
  // ordinary step here; the follower recomputes fresh from the live position every frame, so
  // the second shrink's own first step is bounded exactly like the first shrink's was.
  assert.ok(secondStep < firstStep * 3 + 0.5, `the second shrink's own first step (${secondStep}) stays in the same order as the first (${firstStep})`);
});

test('PR #140 repro 3: a drag during a bounds correction eases, it never cancels the correction and jumps', () => {
  const { view, scene, canvas, settle } = setup('#view=iso');
  addBaseFloor(scene);
  const annex = addAnnex(scene, 100);
  view.sceneChanged();
  settle();
  const camera = view.activeCamera as THREE.OrthographicCamera;

  scene.remove(annex); // starts a correction back toward the base floor
  view.sceneChanged();
  view.update(1, 1 / 60);
  const before = camera.position.clone();

  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 800, clientY: 450, button: 0 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 750, clientY: 450 }));
  view.update(1 + 1 / 60, 1 / 60);
  const step = camera.position.distanceTo(before);
  const reference = Math.max((view as unknown as { liveIsometric: { halfHeight: number } }).liveIsometric.halfHeight, 5);
  assert.ok(step <= 7 * reference * (1 / 60) + 1e-6, `a drag mid-correction still obeys the step limit (moved ${step})`);
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 750, clientY: 450 }));
});

test('PR #140 repro 4: a bounds shrink while zoomed near the old limit never drops the far plane below the live camera', () => {
  const { view, scene } = setup('#view=iso');
  addBaseFloor(scene);
  const farAnnex = addAnnex(scene, 400);
  view.sceneChanged();
  settleIso(view);
  const iso = (view as unknown as { isometric: { maxHalfHeight: number; halfHeight: number } }).isometric;
  iso.halfHeight = iso.maxHalfHeight; // zoomed all the way out, at the old limit
  view.update(1, 1 / 60);
  const camera = view.activeCamera as THREE.OrthographicCamera;
  const liveDistance = (view as unknown as { liveIsometric: { halfHeight: number } }).liveIsometric.halfHeight;

  scene.remove(farAnnex); // the bounds shrink back: the goal's own distance drops at once
  view.sceneChanged();
  view.update(1 + 1 / 60, 1 / 60);
  assert.ok(camera.far >= liveDistance, `the far plane still covers where the camera actually sits (far=${camera.far}, live halfHeight=${liveDistance})`);
});

function settleIso(view: { update(elapsed: number, delta: number): void }): void {
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
}

test('issue #113: a resize recomputes the isometric zoom-out limit without moving the live camera (a cut, not a correction)', () => {
  const { view, canvas } = setup('#view=iso');
  settleIso(view);
  const iso = (view as unknown as { isometric: { maxHalfHeight: number } }).isometric;
  const before = iso.maxHalfHeight;

  Object.defineProperty(canvas, 'clientWidth', { value: 500, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  view.update(1, 1 / 60);
  assert.notEqual(iso.maxHalfHeight, before, 'a narrower window recomputes the zoom-out limit');
});

test('issue #113: a room added grows the pan/zoom bounds without moving the camera that is already on screen', () => {
  const { view, scene } = setup('#view=iso');
  addBaseFloor(scene);
  settleIso(view);
  const camera = view.activeCamera as THREE.OrthographicCamera;
  const before = camera.position.clone();

  addAnnex(scene, 100); // a room added far away: the bounds grow, the current view still fits
  view.sceneChanged();
  view.update(1, 1 / 60);
  assert.ok(camera.position.distanceTo(before) < 1e-6, 'growing the bounds alone never moves a camera that is still within them');
});

test('issue #242 review: #room= to a target outside the default bounds (the hex structure) survives the retrack a poll triggers', () => {
  const farRoom: RoomView = {
    bounds: new THREE.Box3(new THREE.Vector3(295, 0, -5), new THREE.Vector3(305, 6, 5)),
    standing: { position: new THREE.Vector3(300, EYE_HEIGHT, 0), lookAt: new THREE.Vector3(296, EYE_HEIGHT, 0) },
  };
  const { view, scene } = setup('#view=iso&room=hub', { roomView: (name) => (name === 'hub' ? farRoom : null) });
  addBaseFloor(scene); // the only tagged floor: default bounds stay the small rect building, far from x=300
  // The GOAL (not the eased live camera, whose follow speed scales with the on-screen frame
  // size — unrelated to this fix, and unrealistically slow to settle from a near-empty test
  // scene's tiny default framing): `applyStartRoom` already set this synchronously.
  const iso = (view as unknown as { isometric: { target: THREE.Vector3 } }).isometric;
  const goalAfterConstruction = iso.target.clone();
  assert.ok(goalAfterConstruction.x > 100, 'framed on the far room, not the default small bounds, right after construction');

  // `main.ts`'s `buildUI()` calls `view.sceneChanged()` on every agent poll, including the
  // very first one, moments after page load — exactly the sequence that silently undid this
  // flight before `IsometricController.pinBounds`/`retrack` existed.
  view.sceneChanged();
  view.update(1, 1 / 60);
  assert.ok(iso.target.distanceTo(goalAfterConstruction) < 1e-6, 'the pinned room target survives the retrack a poll triggers');
});

test('issue #242 review: retrack with a pinned target only widens the position clamp, never maxHalfHeight/reach — the default zoom-out limit is untouched', () => {
  const bounds = BUILDING;
  const iso = new IsometricController();
  iso.frame(bounds, 16 / 9);
  const maxBefore = iso.maxHalfHeight;
  const reachBefore = iso.reach;

  iso.pinBounds(new THREE.Box3(new THREE.Vector3(295, 0, -5), new THREE.Vector3(305, 6, 5)));
  iso.retrack(bounds, 16 / 9); // same bounds as frame(): only the pin should change anything
  assert.equal(iso.maxHalfHeight, maxBefore, 'maxHalfHeight derives only from bounds, never the pin');
  assert.equal(iso.reach, reachBefore, 'reach derives only from bounds, never the pin');

  // The target itself is allowed past the normal bounds while pinned...
  iso.target.set(300, 0, 0);
  iso.retrack(bounds, 16 / 9);
  assert.ok(Math.abs(iso.target.x - 300) < 1e-6, 'the pinned target is not clamped back');

  // ...but clearing the pin restores the ordinary bounds clamp on the very next retrack.
  iso.clearPin();
  iso.retrack(bounds, 16 / 9);
  assert.ok(iso.target.x <= bounds.max.x + 1e-6, 'without a pin, retrack clamps to the default bounds again');
});

test('issue #242 review: panning far enough to leave the pinned room clears the pin — a later retrack clamps normally again', () => {
  const farRoom: RoomView = {
    bounds: new THREE.Box3(new THREE.Vector3(295, 0, -5), new THREE.Vector3(305, 6, 5)),
    standing: { position: new THREE.Vector3(300, EYE_HEIGHT, 0), lookAt: new THREE.Vector3(296, EYE_HEIGHT, 0) },
  };
  const { view, scene, canvas } = setup('#view=iso&room=hub', { roomView: (name) => (name === 'hub' ? farRoom : null) });
  addBaseFloor(scene);
  const iso = (view as unknown as { isometric: { target: THREE.Vector3 } }).isometric;
  assert.ok(iso.target.x > 100, 'starts pinned on the far room');

  // A real drag, far enough to carry the target clean out of the pinned room's own 10-unit
  // width — a small drag that stays inside it must NOT clear the pin (the next test).
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 1200, clientY: 450, button: 0 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 0, clientY: 450 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 0, clientY: 450 }));
  view.update(2, 1 / 60);

  view.sceneChanged();
  view.update(10, 1 / 60);
  assert.ok(iso.target.x < 100, 'once the pin is cleared, the next retrack clamps the goal back to the default (small) bounds, not the old room target');
});

test('issue #249: a wheel tick or a small drag that stays inside the pinned room never snaps the camera back to the default bounds', () => {
  // The reported bug: `pan`/`shiftTarget` clamped straight to the plain default bounds,
  // ignoring any pin, so the very first wheel tick or drag after `#room=hub` undid the
  // flight — only `retrack` (fired by a poll, not by the user's own input) ever honored it.
  const bounds = BUILDING;
  const iso = new IsometricController();
  iso.frame(bounds, 16 / 9);
  const farRoomBounds = new THREE.Box3(new THREE.Vector3(295, 0, -5), new THREE.Vector3(305, 6, 5));
  iso.target.set(300, 0, 0);
  iso.pinBounds(farRoomBounds);

  iso.pan(0.5, 0); // a tiny pan, well within the room's own 10-unit width
  assert.ok(iso.target.x > 100, 'a small pan inside the pinned room must not clamp back to the default bounds');

  iso.shiftTarget(0.2, 0); // the wheel's own cursor-shift path (zoomTowardCursor)
  assert.ok(iso.target.x > 100, 'a small cursor-zoom shift inside the pinned room must not clamp back either');
});

test('issue #249: panning far enough to leave the pinned room (via pan(), not just retrack) clears the pin', () => {
  const bounds = BUILDING;
  const iso = new IsometricController();
  iso.frame(bounds, 16 / 9);
  iso.target.set(300, 0, 0);
  iso.pinBounds(new THREE.Box3(new THREE.Vector3(295, 0, -5), new THREE.Vector3(305, 6, 5)));

  iso.pan(-1000, 0); // well past the pinned room's own width, and past the default bounds too
  assert.ok(iso.target.x <= bounds.max.x + 1e-6, 'pan() itself clamps to the default bounds once the pin is left behind');
});

test('issue #249 review round 3: a shift that lands just past the pinned room, but still short of the default bounds, clamps into the default bounds in the same call — not on some later input or scene poll', () => {
  // Reproduces the review finding: the old clampTargetAndUnpinIfLeft() clamped against the
  // widened (pin-union) box, found the result no longer inside the pin, and cleared the pin
  // — but never re-clamped against the now-narrower default-only box. A target between the
  // pinned room's edge (x=295) and the default bounds' own edge (x=30) was left stranded
  // there, outside the active bounds, until a later pan/retrack silently snapped it back.
  const bounds = BUILDING; // default bounds: x in [-30, 30]
  const iso = new IsometricController();
  iso.frame(bounds, 16 / 9);
  iso.target.set(300, 0, 0);
  iso.pinBounds(new THREE.Box3(new THREE.Vector3(295, 0, -5), new THREE.Vector3(305, 6, 5)));

  iso.shiftTarget(-6, 0); // target.x -> 294: past the pinned room's min.x, nowhere near default bounds
  assert.ok(iso.target.x <= bounds.max.x + 1e-6, 'the pin-clearing shift must itself land the target back inside the default bounds, not just outside the pin');
});

test('a settled isometric view stops moving the camera: the follower is at rest once the goal and the live pose match', () => {
  const { view } = setup('#view=iso');
  settleIso(view);
  const camera = view.activeCamera as THREE.OrthographicCamera;
  camera.updateMatrixWorld();
  const matrixBefore = camera.matrixWorld.clone();
  view.update(2, 1 / 60); // no input, nothing pending
  camera.updateMatrixWorld();
  assert.ok(camera.matrixWorld.equals(matrixBefore), 'no camera movement once the live pose already equals the goal (render-on-demand stays idle)');
});

// --- View memory and labels ---

test('the remembered view and the hash include the isometric view; the header names it', () => {
  const storage = { getItem: () => 'isometric' };
  assert.equal(chooseViewMode('', storage, 'isometric'), 'isometric');
  assert.equal(chooseViewMode('#view=iso', undefined, 'isometric'), 'isometric');
  assert.equal(chooseViewMode('#view=isometric', undefined, 'isometric'), 'isometric');
  assert.equal(viewStatusText('Building', 'isometric'), 'Building layout · Isometric');
});

test('label rules in the isometric view follow its own zoom (#173: the only view from above)', () => {
  const facts = { attention: undefined, selected: false, hovered: false, distance: 999 };
  const near = { mode: 'smart' as const, viewMode: 'isometric' as const, zoomDistance: ISOMETRIC_FULL_LABEL_ZOOM - 1 };
  const far = { ...near, zoomDistance: 40 };
  assert.equal(labelDetail(facts, near), 'full');
  assert.equal(labelDetail(facts, far), 'compact');
  assert.equal(signVisible({ hovered: false, distance: 999, hoverOnly: false }, near), true);
  assert.equal(signVisible({ hovered: false, distance: 999, hoverOnly: false }, far), false);
  assert.equal(roomLabelVisible({ viewMode: 'isometric', cameraInside: true }), true);
  const pose = roomLabelPose({ viewMode: 'isometric', zoomDistance: 30, detail: false }, 3);
  assert.ok(pose.onTop, 'drawn on top, like any view from above');
  assert.ok(pose.height > 0 && pose.width > 0);
});

test('the isometric view renders at a lowered pixel ratio with hard shadows', () => {
  assert.deepEqual(renderQuality('isometric', 2), { pixelRatio: 1.5, shadowType: THREE.BasicShadowMap });
});

// --- Frame loop ---

test('the frame loop draws through the active camera, cuts walls and ceilings in the isometric view, and idles', () => {
  const scene = new THREE.Scene();
  scene.add(createWalls());
  const roomWalls = new THREE.Group();
  roomWalls.add(new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.2), new THREE.MeshLambertMaterial()));
  markStatic(roomWalls, { zone: 'room-walls', overviewLower: 3 });
  scene.add(roomWalls);
  const perspective = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  perspective.position.set(0, 1.7, 5);
  const { camera: ortho } = framedCamera();
  const drawn: THREE.Camera[] = [];
  const renderer = {
    render: (_scene: THREE.Scene, camera: THREE.Camera) => { drawn.push(camera); }, info: { render: { calls: 0, triangles: 0 }, reset: () => undefined },
    shadowMap: { needsUpdate: false, type: THREE.PCFSoftShadowMap }, getPixelRatio: () => 1, setPixelRatio: () => undefined,
  };
  const loop = new FrameLoop({
    scene, camera: perspective, activeCamera: () => ortho, renderer: renderer as never, labelRenderer: { render: () => undefined },
    update: () => undefined, figures: () => [], mode: () => 'isometric',
  });
  loop.frame(0);
  assert.equal(drawn[drawn.length - 1], ortho);
  assert.equal(findCeilings(scene)[0].visible, false, 'no ceiling in the isometric view');
  const lowered = scene.children.some((zone) => typeof zone.userData.overviewLower === 'number' && zone.scale.y < 1);
  assert.ok(lowered, 'the cutaway walls drop as in the overview');
  const frames = drawn.length;
  for (let t = 100; t < 900; t += 34) loop.frame(t);
  assert.equal(drawn.length, frames, 'a still isometric view renders nothing more');
});

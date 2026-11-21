import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { Seat, LayoutStrategy } from '../src/layout/LayoutStrategy.js';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body><div id="pointer-hint"></div></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
// initFreeCamera (re-review, round 2: the crouch-mid-flight test below) wires its own
// window-level key listeners, so this file needs a real `window` global too, not only
// `document`, the same pattern tests/free-camera-ground-walk.test.ts already uses.
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { ViewController, VIEW_HINTS } = await import('../src/scene/ViewController.js');
const { SelectionState } = await import('../src/scene/Selection.js');
const { updateFreeCamera, setFreeCameraLook, focusPosition, initFreeCamera, EYE_HEIGHT, CROUCH_EYE_HEIGHT } = await import('../src/scene/FreeCamera.js');
const { floorUnder } = await import('../src/scene/OverviewCamera.js');
const { chooseViewMode, rememberViewMode, viewStatusText, VIEW_STORAGE_KEY } = await import('../src/scene/ViewMemory.js');
const { applyCeilingCut, findCeilings, CEILING_HEIGHT } = await import('../src/scene/Cutaway.js');
const { createWalls } = await import('../src/furniture/Walls.js');
const { FrameLoop } = await import('../src/scene/FrameLoop.js');
const registry = await import('../src/layout/registry.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'window');
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    data,
  };
}

// --- Key hints list the keyboard triage keys (issue #85) ---

test('every view hint lists N, F and the filter key', () => {
  for (const hint of Object.values(VIEW_HINTS)) {
    assert.match(hint, /N = next/);
    assert.match(hint, /F = focus/);
    assert.match(hint, /\/ = filter/);
  }
});

// --- Free camera: ground-walk, no flying (issue #174) ---

test('first person keeps x/z free outside the old office box (no horizontal bounding box)', () => {
  const camera = new THREE.PerspectiveCamera();
  setFreeCameraLook(camera, new THREE.Vector3(40, 20, -35), new THREE.Vector3(0, 0, 0));
  updateFreeCamera(camera, 1 / 30);
  assert.equal(camera.position.x, 40);
  assert.equal(camera.position.z, -35);
});

test('first person settles at standing eye height, never flies (issue #174, replaces the old floor-only clamp)', () => {
  const camera = new THREE.PerspectiveCamera();
  setFreeCameraLook(camera, new THREE.Vector3(30, 20, 0), new THREE.Vector3(0, 0, 0));
  updateFreeCamera(camera, 1 / 30);
  assert.equal(camera.position.y, EYE_HEIGHT, 'a placement above the ground comes straight back down to standing height');
  assert.equal(camera.position.x, 30);

  setFreeCameraLook(camera, new THREE.Vector3(30, -4, 0), new THREE.Vector3(0, 0, 0));
  updateFreeCamera(camera, 1 / 30);
  assert.equal(camera.position.y, EYE_HEIGHT, 'a placement below the ground also settles at standing height, not at the floor');
});

// --- Fly-to: the camera ends on the agent's side of the walls ---

const room = new THREE.Box3(new THREE.Vector3(15, 0, -6), new THREE.Vector3(27, 0, 6));

test('a focus position that would cross a room wall stays inside the room', () => {
  const lookAt = new THREE.Vector3(16, 1.1, 0);
  const away = new THREE.Vector3(-1, 0, 0); // toward the hall, through the wall at x = 15
  const position = focusPosition(lookAt, away, room, 4, 1.2);
  assert.ok(position.x > room.min.x && position.x < room.max.x, `x=${position.x}`);
  assert.ok(position.z > room.min.z && position.z < room.max.z, `z=${position.z}`);
  const flat = new THREE.Vector2(position.x - lookAt.x, position.z - lookAt.z).length();
  assert.ok(flat >= 2, `the camera keeps some distance from the figure (${flat})`);
});

test('a focus position without a room is the plain point at the focus distance (old behavior)', () => {
  const position = focusPosition(new THREE.Vector3(0, 1.1, 0), new THREE.Vector3(0, 0, 1), null, 4, 1.2);
  assert.deepEqual(position.toArray(), [0, 2.3, 4]);
});

function floorPlane(box: THREE.Box3): THREE.Group {
  const group = new THREE.Group();
  group.userData.floor = true;
  const size = box.getSize(new THREE.Vector3());
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.z));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.copy(box.getCenter(new THREE.Vector3()));
  group.add(mesh);
  return group;
}

const hall = new THREE.Box3(new THREE.Vector3(-15, 0, -13), new THREE.Vector3(15, 0, 13));

test('floorUnder finds the floor that holds a point, or null outside every floor', () => {
  const scene = new THREE.Scene();
  scene.add(floorPlane(hall), floorPlane(room));
  const inRoom = floorUnder(scene, new THREE.Vector3(20, 0, 1));
  assert.ok(inRoom && Math.abs(inRoom.min.x - 15) < 1e-6 && Math.abs(inRoom.max.x - 27) < 1e-6);
  const inHall = floorUnder(scene, new THREE.Vector3(0, 0, 0));
  assert.ok(inHall && Math.abs(inHall.min.x + 15) < 1e-6);
  assert.equal(floorUnder(scene, new THREE.Vector3(100, 0, 100)), null);
});

function viewSetup(options: { hash?: string; seat?: THREE.Vector3; floors?: THREE.Box3[]; view?: 'overview' | 'first-person'; modes?: string[] } = {}) {
  const document = dom.window.document;
  const scene = new THREE.Scene();
  for (const box of options.floors ?? []) scene.add(floorPlane(box));
  const seat = options.seat ?? new THREE.Vector3(4, 0, -3);
  const layout: LayoutStrategy = {
    id: 'fixed',
    seatFor: (agent): Seat => ({ key: agent.id, position: seat.clone(), lookAt: seat.clone().add(new THREE.Vector3(1, 0, 0)) }),
    release: () => undefined,
  };
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(-12, 5.5, 11);
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const manager = new AgentManager(scene, layout);
  const selection = new SelectionState();
  const view = new ViewController({
    camera, canvas, scene, selection,
    agents: () => manager.getAgents(),
    keys: dom.window,
    hash: options.hash ?? '',
    view: options.view,
    modeChanged: options.modes ? (mode) => options.modes!.push(mode) : undefined,
  });
  const press = (code: string) => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code, key: code }));
  return { view, camera, manager, selection, press };
}

test('fly-to an agent next to a room wall ends inside its room, with the figure in frame', () => {
  const seat = new THREE.Vector3(15.6, 0, 1);
  const { view, manager, selection, camera } = viewSetup({ seat, floors: [hall, room] });
  camera.position.set(0, 1.7, 1); // in the hall, so the plain flight would end in the hall, behind the wall
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.ok(camera.position.x > room.min.x && camera.position.x < room.max.x, `camera x=${camera.position.x}`);
  assert.ok(camera.position.z > room.min.z && camera.position.z < room.max.z, `camera z=${camera.position.z}`);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const toFigure = new THREE.Vector3(seat.x, 1.1, seat.z).sub(camera.position).normalize();
  assert.ok(forward.dot(toFigure) > 0.95, 'the figure is in frame');
});

test('key F fix: refocus flies to an already-selected agent, even though a reselect alone is a no-op', () => {
  const seat = new THREE.Vector3(15.6, 0, 1);
  const { view, manager, selection, camera } = viewSetup({ seat, floors: [hall, room] });
  camera.position.set(0, 1.7, 1);
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  const afterFirstFly = camera.position.clone();

  camera.position.set(-5, 1.7, -5); // pan away, as if the user moved the camera by hand
  selection.select('a'); // a plain reselect: SelectionState ignores it, nothing flies
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.notDeepEqual(camera.position.toArray(), afterFirstFly.toArray(), 'confirms the reselect alone did not fly back');

  view.refocus('a');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.ok(Math.abs(camera.position.x - afterFirstFly.x) < 0.05 && Math.abs(camera.position.z - afterFirstFly.z) < 0.05,
    'refocus flew back to the same framing');
});

test('review #185: selecting an agent in first person lands at ground-walk\'s own eye height, with no pop a frame later', () => {
  // Running a full second before sampling (the original version of this test) misses the bug
  // entirely: the old pop happened and self-corrected to EYE_HEIGHT well within that window,
  // so `justLanded` was already past it either way. The only frame that can tell the fix apart
  // from the bug is the landing frame itself, against the very next one (re-review, round 2).
  const { view, manager, selection, camera } = viewSetup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  const flightField = (view as unknown as { flight: unknown }) as { flight: unknown };
  let justLanded = NaN;
  let afterOneMoreFrame = NaN;
  for (let i = 0; i < 120; i++) {
    const wasFlying = flightField.flight !== null;
    view.update(i / 60, 1 / 60);
    if (wasFlying && flightField.flight === null) {
      justLanded = camera.position.y;
      view.update((i + 1) / 60, 1 / 60);
      afterOneMoreFrame = camera.position.y;
      break;
    }
  }
  assert.ok(Math.abs(justLanded - EYE_HEIGHT) < 1e-6, `the flight itself should land at EYE_HEIGHT (${EYE_HEIGHT}), got ${justLanded}`);
  // The bug this guards against: the old fixed focus height (2.3) landed there, then the very
  // next frame's ground-walk rule snapped it down to EYE_HEIGHT (1.75), a visible 0.55 m pop.
  assert.equal(afterOneMoreFrame, justLanded, 'no height change on the frame right after the flight lands');
});

test('review #185 (re-review, round 2): crouching mid-flight never pops on arrival', () => {
  // The fix round closed this for the simple case (land, then nothing changes next frame),
  // but a posture change WHILE the 0.6 s flight is still animating was never covered: the
  // flight's destination height was baked in once, at launch, from whatever currentEyeHeight()
  // returned at that instant. Pressing Shift partway through the flight must not leave that
  // destination stale.
  const { view, manager, selection, camera } = viewSetup();
  const canvas = dom.window.document.createElement('canvas');
  initFreeCamera(camera, canvas, camera.position.clone().add(new THREE.Vector3(0, 0, -1)));
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  const flightField = (view as unknown as { flight: unknown }) as { flight: unknown };
  // Press Shift partway through the flight (it takes 0.6 s; this is well inside that window).
  for (let i = 0; i < 20; i++) view.update(i / 60, 1 / 60);
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'ShiftLeft' }));
  let justLanded = NaN;
  let afterOneMoreFrame = NaN;
  for (let i = 20; i < 120; i++) {
    const wasFlying = flightField.flight !== null;
    view.update(i / 60, 1 / 60);
    if (wasFlying && flightField.flight === null) {
      justLanded = camera.position.y;
      view.update((i + 1) / 60, 1 / 60);
      afterOneMoreFrame = camera.position.y;
      break;
    }
  }
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { code: 'ShiftLeft' }));
  assert.ok(Math.abs(justLanded - CROUCH_EYE_HEIGHT) < 1e-6, `crouched by the time it lands, so it should land at CROUCH_EYE_HEIGHT (${CROUCH_EYE_HEIGHT}), got ${justLanded}`);
  assert.equal(afterOneMoreFrame, justLanded, 'no height change on the frame right after the flight lands, even though Shift was pressed mid-flight');
});

test('key F fix: refocus on an agent no longer in the scene does nothing', () => {
  const { view, camera } = viewSetup();
  const before = camera.position.clone();
  view.refocus('gone');
  assert.deepEqual(camera.position.toArray(), before.toArray());
});

// --- Start view and remembered view ---

test('the start view: a #view hash, then the saved view, then the layout default', () => {
  assert.equal(chooseViewMode('', undefined, 'overview'), 'overview');
  assert.equal(chooseViewMode('', undefined, 'first-person'), 'first-person');
  assert.equal(chooseViewMode('', memoryStorage({ [VIEW_STORAGE_KEY]: 'first-person' }), 'overview'), 'first-person');
  assert.equal(chooseViewMode('#view=overview', memoryStorage({ [VIEW_STORAGE_KEY]: 'first-person' }), 'first-person'), 'overview');
  assert.equal(chooseViewMode('#view=first-person', memoryStorage({ [VIEW_STORAGE_KEY]: 'overview' }), 'overview'), 'first-person');
  assert.equal(chooseViewMode('#view=sideways', memoryStorage({ [VIEW_STORAGE_KEY]: 'junk' }), 'overview'), 'overview');
  const throwing = { getItem: () => { throw new Error('blocked'); } };
  assert.equal(chooseViewMode('', throwing, 'overview'), 'overview');
});

test('the view mode is saved in the browser and a blocked storage does not break it', () => {
  const storage = memoryStorage();
  rememberViewMode('first-person', storage);
  assert.equal(storage.data.get(VIEW_STORAGE_KEY), 'first-person');
  assert.doesNotThrow(() => rememberViewMode('overview', { setItem: () => { throw new Error('full'); } }));
});

test('the view controller starts in the given view and reports each mode change', () => {
  const modes: string[] = [];
  const { view, press, camera } = viewSetup({ view: 'overview', modes });
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'overview');
  assert.ok(camera.position.y > 15);
  press('KeyO');
  assert.equal(view.mode, 'first-person');
  assert.deepEqual(modes, ['overview', 'first-person']);
});

test('without a given view the hash still decides and first person stays the default', () => {
  assert.equal(viewSetup().view.mode, 'first-person');
  assert.equal(viewSetup({ hash: '#view=overview' }).view.mode, 'overview');
});

test('the header text names the layout and the view', () => {
  assert.equal(viewStatusText(registry.layoutName('building'), 'overview'), 'Building layout · Overview');
  assert.equal(viewStatusText(registry.layoutName('activity'), 'first-person'), 'Activity layout · First person');
});

// --- Layout switch: Shift+L and a confirmation ---

const key = (code: string, shiftKey: boolean, target: EventTarget | null = null) => ({ code, shiftKey, ctrlKey: false, metaKey: false, altKey: false, target });

test('one L does nothing; Shift+L is the layout switch key', () => {
  assert.equal(registry.isLayoutSwitchKey(key('KeyL', false)), false);
  assert.equal(registry.isLayoutSwitchKey(key('KeyL', true)), true);
  assert.equal(registry.isLayoutSwitchKey(key('KeyK', true)), false);
  assert.equal(registry.isLayoutSwitchKey(key('KeyL', true, dom.window.document.createElement('select'))), false);
  assert.equal(registry.isLayoutSwitchKey({ ...key('KeyL', true), metaKey: true }), false);
});

test('the layout changes only when the user confirms', () => {
  registry.registerLayout('nav-test', () => ({ id: 'nav-test', seatFor: () => null, release: () => undefined }));
  const ids = registry.layoutIds();
  const next = ids[(ids.indexOf('activity') + 1) % ids.length];
  const questions: string[] = [];
  assert.equal(registry.confirmLayoutSwitch('activity', (question) => { questions.push(question); return false; }), null);
  assert.equal(registry.confirmLayoutSwitch('activity', () => true), next);
  assert.match(questions[0], new RegExp(registry.layoutName(next)));
});

test('a layout can ask for the overview as its start view; others keep first person', () => {
  registry.registerLayout('nav-overview', () => ({ id: 'nav-overview', seatFor: () => null, release: () => undefined }), { defaultView: 'overview' });
  assert.equal(registry.defaultViewFor('nav-overview'), 'overview');
  assert.equal(registry.defaultViewFor('activity'), 'first-person');
  assert.equal(registry.defaultViewFor('unknown'), 'first-person');
});

// --- Ceiling: hidden above the ceiling height and in the overview ---

test('the ceiling is its own marked mesh so it can hide without a static merge rebuild', () => {
  const ceilings = findCeilings(createWalls());
  assert.equal(ceilings.length, 1);
  assert.equal(ceilings[0].userData.dynamic, true);
});

test('the ceiling hides above the ceiling height and in the overview, and comes back below', () => {
  const ceilings = findCeilings(createWalls());
  assert.equal(applyCeilingCut(ceilings, 1.7, false), false, 'nothing changes below the ceiling');
  assert.equal(ceilings[0].visible, true);
  assert.equal(applyCeilingCut(ceilings, CEILING_HEIGHT + 0.5, false), true);
  assert.equal(ceilings[0].visible, false);
  assert.equal(applyCeilingCut(ceilings, 1.7, false), true);
  assert.equal(ceilings[0].visible, true);
  assert.equal(applyCeilingCut(ceilings, 1.7, true), true);
  assert.equal(ceilings[0].visible, false);
});

test('the frame loop renders and hides the ceiling when the camera rises above it', () => {
  const scene = new THREE.Scene();
  scene.add(createWalls());
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(0, 1.7, 5);
  let renders = 0;
  const renderer = {
    render: () => { renders++; }, info: { render: { calls: 0, triangles: 0 }, reset: () => undefined },
    shadowMap: { needsUpdate: false, type: THREE.PCFSoftShadowMap }, getPixelRatio: () => 1, setPixelRatio: () => undefined,
  };
  const loop = new FrameLoop({
    scene, camera, renderer: renderer as never, labelRenderer: { render: () => undefined },
    update: () => undefined, figures: () => [], mode: () => 'first-person',
  });
  loop.frame(0);
  const ceiling = findCeilings(scene)[0];
  assert.equal(ceiling.visible, true);
  camera.position.y = 9;
  loop.frame(100);
  assert.equal(ceiling.visible, false);
  const before = renders;
  camera.position.y = 1.7;
  loop.frame(200);
  assert.equal(ceiling.visible, true);
  assert.equal(renders, before + 1);
});

test('a ceiling change alone, with a still camera, makes the frame loop render', () => {
  const scene = new THREE.Scene();
  scene.add(createWalls());
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(0, 1.7, 5);
  let renders = 0;
  const renderer = {
    render: () => { renders++; }, info: { render: { calls: 0, triangles: 0 }, reset: () => undefined },
    shadowMap: { needsUpdate: false, type: THREE.PCFSoftShadowMap }, getPixelRatio: () => 1, setPixelRatio: () => undefined,
  };
  const loop = new FrameLoop({
    scene, camera, renderer: renderer as never, labelRenderer: { render: () => undefined },
    update: () => undefined, figures: () => [], mode: () => 'first-person',
  });
  for (let t = 0; t <= 2000; t += 100) loop.frame(t);
  const ceiling = findCeilings(scene)[0];
  ceiling.visible = false;
  const before = renders;
  loop.frame(2050);
  assert.equal(ceiling.visible, true, 'the ceiling rule restores the ceiling below its height');
  assert.equal(renders, before + 1, 'and that change alone renders a frame');
});

// --- Layout switch reload ---

test('the layout switch reloads when only the hash would change, and navigates when ?layout= is dropped', async () => {
  const { reloadForLayoutSwitch } = await import('../src/layout/registry.js');
  const calls: string[] = [];
  const at = (href: string) => ({ href, search: new URL(href).search, assign: (u: string) => calls.push(`assign ${u}`), reload: () => calls.push('reload') });

  reloadForLayoutSwitch(at('http://127.0.0.1:5173/?debug=1#view=overview'));
  reloadForLayoutSwitch(at('http://127.0.0.1:5173/#view=overview'));
  reloadForLayoutSwitch(at('http://127.0.0.1:5173/?layout=building#view=overview'));

  assert.deepEqual(calls, ['reload', 'reload', 'assign http://127.0.0.1:5173/#view=overview']);
});

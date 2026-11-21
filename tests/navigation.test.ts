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
const { ViewController, VIEW_HINTS } = await import('../src/scene/ViewController.js');
const { SelectionState } = await import('../src/scene/Selection.js');
const { updateFreeCamera, setFreeCameraLook, focusPosition, MIN_EYE_HEIGHT } = await import('../src/scene/FreeCamera.js');
const { floorUnder } = await import('../src/scene/OverviewCamera.js');
const { chooseViewMode, rememberViewMode, viewStatusText, VIEW_STORAGE_KEY } = await import('../src/scene/ViewMemory.js');
const { applyCeilingCut, findCeilings } = await import('../src/scene/Cutaway.js');
const { createWalls } = await import('../src/furniture/Walls.js');
const { FrameLoop } = await import('../src/scene/FrameLoop.js');
const { buildRoom, CEILING_ZONE_NAME } = await import('../src/addons/building/rooms.js');
const { slotFor } = await import('../src/addons/building/RoomPlanner.js');
const registry = await import('../src/layout/registry.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
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

// --- Free camera: no bounding box ---

test('first person keeps a position far outside the old office box and above the building', () => {
  const camera = new THREE.PerspectiveCamera();
  setFreeCameraLook(camera, new THREE.Vector3(40, 20, -35), new THREE.Vector3(0, 0, 0));
  updateFreeCamera(camera, 1 / 30);
  assert.deepEqual(camera.position.toArray(), [40, 20, -35]);
});

test('first person still cannot sink below the floor', () => {
  const camera = new THREE.PerspectiveCamera();
  setFreeCameraLook(camera, new THREE.Vector3(30, -4, 0), new THREE.Vector3(0, 0, 0));
  updateFreeCamera(camera, 1 / 30);
  assert.equal(camera.position.y, MIN_EYE_HEIGHT);
  assert.equal(camera.position.x, 30);
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

function viewSetup(options: { hash?: string; seat?: THREE.Vector3; floors?: THREE.Box3[]; view?: 'isometric' | 'first-person'; modes?: string[] } = {}) {
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

test('key F fix: refocus on an agent no longer in the scene does nothing', () => {
  const { view, camera } = viewSetup();
  const before = camera.position.clone();
  view.refocus('gone');
  assert.deepEqual(camera.position.toArray(), before.toArray());
});

// --- Start view and remembered view ---

test('the start view: a #view hash, then the saved view, then the layout default', () => {
  assert.equal(chooseViewMode('', undefined, 'isometric'), 'isometric');
  assert.equal(chooseViewMode('', undefined, 'first-person'), 'first-person');
  assert.equal(chooseViewMode('', memoryStorage({ [VIEW_STORAGE_KEY]: 'first-person' }), 'isometric'), 'first-person');
  assert.equal(chooseViewMode('#view=iso', memoryStorage({ [VIEW_STORAGE_KEY]: 'first-person' }), 'first-person'), 'isometric');
  assert.equal(chooseViewMode('#view=first-person', memoryStorage({ [VIEW_STORAGE_KEY]: 'isometric' }), 'isometric'), 'first-person');
  assert.equal(chooseViewMode('#view=sideways', memoryStorage({ [VIEW_STORAGE_KEY]: 'junk' }), 'isometric'), 'isometric');
  const throwing = { getItem: () => { throw new Error('blocked'); } };
  assert.equal(chooseViewMode('', throwing, 'isometric'), 'isometric');
});

test('#173 review: #view=overview, the retired mode\'s own name, lands on the layout default, not hardcoded to first person', () => {
  // `chooseViewMode` never special-cases "overview": an unrecognized hash value is exactly as
  // unrecognized as any other, so it falls through to storage, then the layout's own default.
  // The building layout's default is isometric (#173: the closest view from above), so that is
  // where `#view=overview` lands when nothing else is saved — not first person, a wrong claim an
  // earlier revision of this PR made (review, #184).
  assert.equal(chooseViewMode('#view=overview', memoryStorage(), 'isometric'), 'isometric');
  assert.equal(chooseViewMode('#view=overview', memoryStorage(), 'first-person'), 'first-person');
  // A saved view still wins over the layout default, the same as any other unrecognized hash.
  assert.equal(chooseViewMode('#view=overview', memoryStorage({ [VIEW_STORAGE_KEY]: 'first-person' }), 'isometric'), 'first-person');
});

test('the view mode is saved in the browser and a blocked storage does not break it', () => {
  const storage = memoryStorage();
  rememberViewMode('first-person', storage);
  assert.equal(storage.data.get(VIEW_STORAGE_KEY), 'first-person');
  assert.doesNotThrow(() => rememberViewMode('isometric', { setItem: () => { throw new Error('full'); } }));
});

test('the view controller starts in the given view and reports each mode change (#173: key I, not O)', () => {
  const modes: string[] = [];
  const { view, press, camera } = viewSetup({ view: 'isometric', modes });
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'isometric');
  assert.notEqual(view.activeCamera, camera, 'isometric draws through its own orthographic camera');
  press('KeyI');
  assert.equal(view.mode, 'first-person');
  assert.deepEqual(modes, ['isometric', 'first-person']);
});

test('without a given view the hash still decides and first person stays the default', () => {
  assert.equal(viewSetup().view.mode, 'first-person');
  assert.equal(viewSetup({ hash: '#view=iso' }).view.mode, 'isometric');
});

test('the header text names the layout and the view', () => {
  assert.equal(viewStatusText(registry.layoutName('building'), 'isometric'), 'Building layout · Isometric');
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

test('a layout can ask for the isometric view as its start view; others keep first person', () => {
  registry.registerLayout('nav-isometric', () => ({ id: 'nav-isometric', seatFor: () => null, release: () => undefined }), { defaultView: 'isometric' });
  assert.equal(registry.defaultViewFor('nav-isometric'), 'isometric');
  assert.equal(registry.defaultViewFor('activity'), 'first-person');
  assert.equal(registry.defaultViewFor('unknown'), 'first-person');
});

// --- Ceiling: shown in first person, hidden in the isometric view (issue #176) ---

test('the ceiling is its own marked mesh so it can hide without a static merge rebuild', () => {
  const ceilings = findCeilings(createWalls());
  assert.equal(ceilings.length, 1);
  assert.equal(ceilings[0].userData.dynamic, true);
});

test('the ceiling always shows in first person; it hides only in the isometric view', () => {
  const scene = new THREE.Scene();
  const ceilings = findCeilings(createWalls());
  assert.equal(applyCeilingCut(scene, ceilings, false), false, 'nothing changes: already shown');
  assert.equal(ceilings[0].visible, true);
  assert.equal(applyCeilingCut(scene, ceilings, true), true);
  assert.equal(ceilings[0].visible, false);
  assert.equal(applyCeilingCut(scene, ceilings, false), true);
  assert.equal(ceilings[0].visible, true);
});

test('the frame loop shows the ceiling in first person and hides it in the isometric view, however high the camera sits', () => {
  const scene = new THREE.Scene();
  scene.add(createWalls());
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(0, 1.7, 5);
  let renders = 0;
  const renderer = {
    render: () => { renders++; }, info: { render: { calls: 0, triangles: 0 }, reset: () => undefined },
    shadowMap: { needsUpdate: false, type: THREE.PCFSoftShadowMap }, getPixelRatio: () => 1, setPixelRatio: () => undefined,
  };
  let mode: 'first-person' | 'isometric' = 'first-person';
  const loop = new FrameLoop({
    scene, camera, renderer: renderer as never, labelRenderer: { render: () => undefined },
    update: () => undefined, figures: () => [], mode: () => mode,
  });
  loop.frame(0);
  const ceiling = findCeilings(scene)[0];
  assert.equal(ceiling.visible, true);
  // A tall camera, still in first person (ground-walk's eventual height cap is a different
  // rule): the ceiling stays up, unlike the old height-based rule the overview mode needed.
  camera.position.y = 9;
  loop.frame(100);
  assert.equal(ceiling.visible, true);
  mode = 'isometric';
  loop.frame(200);
  assert.equal(ceiling.visible, false);
  const before = renders;
  mode = 'first-person';
  camera.position.y = 1.7;
  loop.frame(300);
  assert.equal(ceiling.visible, true);
  assert.equal(renders, before + 1);
});

test('a room\'s own (merged) ceiling also shows in first person and hides in isometric, through a real frame loop (review, #184 round 2)', () => {
  const scene = new THREE.Scene();
  scene.add(createWalls());
  scene.add(buildRoom('library', slotFor(1), 1, []).group);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(0, 1.7, 5);
  const renderer = {
    render: () => undefined, info: { render: { calls: 0, triangles: 0 }, reset: () => undefined },
    shadowMap: { needsUpdate: false, type: THREE.PCFSoftShadowMap }, getPixelRatio: () => 1, setPixelRatio: () => undefined,
  };
  let mode: 'first-person' | 'isometric' = 'first-person';
  const loop = new FrameLoop({
    scene, camera, renderer: renderer as never, labelRenderer: { render: () => undefined },
    update: () => undefined, figures: () => [], mode: () => mode,
  });
  loop.frame(0);
  const merged = scene.getObjectByName(CEILING_ZONE_NAME);
  assert.ok(merged, 'the room ceiling merged into its shared zone on the first frame');
  assert.equal(merged!.visible, true, 'first person: the merged room ceiling shows');
  mode = 'isometric';
  loop.frame(100);
  assert.equal(merged!.visible, false, 'isometric: the merged room ceiling hides');
  mode = 'first-person';
  loop.frame(200);
  assert.equal(merged!.visible, true, 'back in first person: it shows again');
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

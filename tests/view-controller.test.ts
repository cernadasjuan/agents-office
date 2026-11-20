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
const { EYE_HEIGHT } = await import('../src/scene/FreeCamera.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const fixedLayout: LayoutStrategy = {
  id: 'fixed',
  seatFor: (agent): Seat => ({ key: agent.id, position: new THREE.Vector3(4, 0, -3), lookAt: new THREE.Vector3(4, 0, 0) }),
  release: () => undefined,
};

function setup(hash = '', figureShiftPx?: () => number, roomView?: (name: string) => { bounds: THREE.Box3; standing: { position: THREE.Vector3; lookAt: THREE.Vector3 } } | null) {
  const document = dom.window.document;
  const scene = new THREE.Scene();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  wall.userData.overviewHidden = true;
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
  });
  const press = (code: string) => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code, key: code }));
  return { view, camera, canvas, manager, selection, wall, hint, press };
}

test('first person stays the default and the camera does not move by itself', () => {
  const { view, camera, wall } = setup();
  view.update(1, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.deepEqual(camera.position.toArray(), [-12, EYE_HEIGHT, 11]);
  assert.equal(wall.visible, true);
});

test('key O switches to the overview and back, hiding near walls only in the overview', () => {
  const { view, camera, wall, hint, press } = setup();
  press('KeyO');
  assert.equal(view.mode, 'overview');
  assert.equal(wall.visible, false);
  assert.match(hint!.textContent ?? '', /wheel/i);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.ok(camera.position.y > 15, `overview camera is high above the floor (${camera.position.y})`);

  press('KeyO');
  for (let i = 0; i < 60; i++) view.update(1 + i / 60, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.equal(wall.visible, true);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(-12, EYE_HEIGHT, 11)) < 1e-6);
});

test('#view=overview starts in the overview', () => {
  const { view, camera } = setup('#view=overview');
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'overview');
  assert.ok(camera.position.y > 15);
});

test('issue #89: #zoom= starts the overview at that camera distance, not its own default framing', () => {
  const baseline = setup('#view=overview');
  const { view, camera } = setup('#view=overview&zoom=15');
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'overview');
  assert.ok(Math.abs(view.zoomDistance - 15) < 1e-6, `zoomDistance is the requested 15 (got ${view.zoomDistance})`);
  assert.notEqual(view.zoomDistance, baseline.view.zoomDistance, 'different from the view’s own default framing');
  assert.ok(camera.position.y > 0, 'still a real overview pose, not a degenerate one');
});

test('issue #89: #zoom= starts the isometric view at the equivalent camera distance', () => {
  const { view } = setup('#view=iso&zoom=15');
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'isometric');
  assert.ok(Math.abs(view.zoomDistance - 15) < 1e-6, `zoomDistance reads the overview-equivalent 15 (got ${view.zoomDistance})`);
});

test('issue #89: #zoom= is clamped into the view’s own pan/zoom limits, like the wheel already is', () => {
  const { view } = setup('#view=overview&zoom=1000000');
  view.update(0, 1 / 60);
  const overview = (view as unknown as { overview: { maxDistance: number } }).overview;
  assert.ok(view.zoomDistance <= overview.maxDistance + 1e-6, `clamped to the zoom-out limit (${view.zoomDistance} vs ${overview.maxDistance})`);
});

test('issue #89 review, fix round 2: a bare #zoom= (no #select=) only sets the initial framing; a later, unrelated click gets its own normal framing', () => {
  const { view, manager, selection } = setup('#view=overview&zoom=20');
  view.update(0, 1 / 60);
  manager.addAgent({ id: 'other', name: 'Other', activity: 'idle' });
  selection.select('other');
  for (let i = 0; i < 120; i++) view.update(i / 60, 1 / 60);
  assert.notEqual(view.zoomDistance, 20, `an unrelated click should use its own normal framing, not the bare #zoom= (got ${view.zoomDistance})`);
});

test('issue #89 review, fix round 2: #zoom=&select=wanted — a decoy selected first gets normal framing, and "wanted" never steals it back', () => {
  const { view, manager, selection } = setup('#view=overview&zoom=20&select=wanted');
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

test('issue #89: #room= frames a named room in the overview, via the active layout', () => {
  const room = fixtureRoomView();
  const { view } = setup('#view=overview&room=office', undefined, (name) => (name === 'office' ? room : null));
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'overview');
  const target = (view as unknown as { overview: { target: THREE.Vector3 } }).overview.target;
  const center = room.bounds.getCenter(new THREE.Vector3());
  assert.ok(Math.abs(target.x - center.x) < 0.5 && Math.abs(target.z - center.z) < 0.5, `target is near the room's center (${target.toArray()} vs ${center.toArray()})`);
});

test('issue #89: #room= frames a named room in the isometric view too', () => {
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
  const baseline = setup('#view=overview');
  baseline.view.update(0, 1 / 60);
  const { view } = setup('#view=overview&room=not-a-room', undefined, () => null);
  view.update(0, 1 / 60);
  assert.equal(view.zoomDistance, baseline.view.zoomDistance);

  const noCallback = setup('#view=overview&room=office');
  noCallback.view.update(0, 1 / 60);
  assert.equal(noCallback.view.zoomDistance, baseline.view.zoomDistance, 'no roomView option at all is the same as an unknown name');
});

test('issue #89: #room= wins over #zoom= when both are given and the room resolves', () => {
  const room = fixtureRoomView();
  const { view } = setup('#view=overview&zoom=5&room=office', undefined, (name) => (name === 'office' ? room : null));
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
  const { view, manager, selection, camera } = setup('#view=overview&focus=agent-1');
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, null);

  manager.addAgent({ id: 'agent-1', name: 'One', activity: 'idle' });
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, 'agent-1');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  const lookAt = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const toAgent = new THREE.Vector3(4, 0, -3).sub(camera.position).normalize();
  assert.ok(lookAt.dot(toAgent) > 0.99, 'the camera looks at the selected agent');

  selection.clear();
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, null, 'the focus applies only once');
});

test('issue #89: #select= selects the agent once it appears, the same as #focus=', () => {
  const { view, manager, selection } = setup('#view=overview&select=agent-1');
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, null);

  manager.addAgent({ id: 'agent-1', name: 'One', activity: 'idle' });
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, 'agent-1');
});

test('issue #89 review (fix 1): #zoom= and #select=/#focus= together both survive — the pending selection flight honors the requested zoom', () => {
  const { view, manager, selection } = setup('#view=overview&zoom=20&select=agent-1');
  view.agentsChanged(manager.getAgents());

  manager.addAgent({ id: 'agent-1', name: 'One', activity: 'idle' });
  view.agentsChanged(manager.getAgents()); // the pending #select= fires here, starting the flight
  assert.equal(selection.selected, 'agent-1');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60); // let the 0.6 s flight finish
  assert.ok(Math.abs(view.zoomDistance - 20) < 0.5, `settles at the requested zoom, 20 (got ${view.zoomDistance})`);
});

test('issue #89 review (fix 1): the same, in the isometric view', () => {
  const { view, manager, selection } = setup('#view=iso&zoom=20&select=agent-1');
  view.agentsChanged(manager.getAgents());

  manager.addAgent({ id: 'agent-1', name: 'One', activity: 'idle' });
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, 'agent-1');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.ok(Math.abs(view.zoomDistance - 20) < 0.5, `settles at the requested zoom, 20 (got ${view.zoomDistance})`);
});

test('issue #89 review (fix 1): #zoom= is consumed only once — a later selection uses the normal fixed framing distance', () => {
  const { view, manager, selection } = setup('#view=overview&zoom=20&select=agent-1');
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

test('zoomDistance reports the overview camera distance and follows the wheel', () => {
  const { view } = setup('#view=overview');
  const before = view.zoomDistance;
  assert.ok(Number.isFinite(before) && before > 0);
  const canvases = dom.window.document.querySelectorAll('canvas');
  const canvas = canvases[canvases.length - 1];
  canvas.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -400, cancelable: true }));
  assert.ok(view.zoomDistance < before, `zoomed in (${view.zoomDistance} < ${before})`);
});

function screenX(camera: THREE.PerspectiveCamera, point: THREE.Vector3): number {
  camera.updateMatrixWorld();
  return point.clone().project(camera).x;
}

for (const hash of ['#view=overview', '']) {
  const mode = hash ? 'overview' : 'first person';
  test(`${mode}: with an open agent card the camera frames the figure left of the card`, () => {
    const { view, manager, selection, camera } = setup(hash, () => 300);
    manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
    selection.select('a');
    for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
    const target = hash ? new THREE.Vector3(4, 0, -3) : new THREE.Vector3(4, 1.1, -3);
    // 300 px left of the center of a 1600 px canvas is -0.375 in normalized device coordinates.
    assert.ok(Math.abs(screenX(camera, target) + 0.375) < 0.02, `figure at x=${screenX(camera, target)}`);
  });

  test(`${mode}: without a card shift the camera centers the figure (old behavior)`, () => {
    const { view, manager, selection, camera } = setup(hash);
    manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
    selection.select('a');
    for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
    const target = hash ? new THREE.Vector3(4, 0, -3) : new THREE.Vector3(4, 1.1, -3);
    assert.ok(Math.abs(screenX(camera, target)) < 0.02, `figure at x=${screenX(camera, target)}`);
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

test('an out-and-back pan in the overview is never misread as a closing click (issue #133)', () => {
  const { view, manager, selection, canvas, press } = setup();
  press('KeyO'); // overview: the only mode that pans on drag
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

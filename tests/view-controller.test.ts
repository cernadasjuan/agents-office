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
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const fixedLayout: LayoutStrategy = {
  id: 'fixed',
  seatFor: (agent): Seat => ({ key: agent.id, position: new THREE.Vector3(4, 0, -3), lookAt: new THREE.Vector3(4, 0, 0) }),
  release: () => undefined,
};

function setup(hash = '', figureShiftPx?: () => number) {
  const document = dom.window.document;
  const scene = new THREE.Scene();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  wall.userData.overviewHidden = true;
  scene.add(wall);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(-12, 5.5, 11);
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
  });
  const press = (code: string) => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code, key: code }));
  return { view, camera, canvas, manager, selection, wall, hint, press };
}

test('first person stays the default and the camera does not move by itself', () => {
  const { view, camera, wall } = setup();
  view.update(1, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.deepEqual(camera.position.toArray(), [-12, 5.5, 11]);
  assert.equal(wall.visible, true);
});

test('key O does nothing: the overview mode is gone (#173)', () => {
  const { view, camera, wall, press } = setup();
  press('KeyO');
  assert.equal(view.mode, 'first-person');
  assert.equal(wall.visible, true);
  assert.deepEqual(camera.position.toArray(), [-12, 5.5, 11], 'the camera does not move');
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
  assert.ok(camera.position.distanceTo(new THREE.Vector3(-12, 5.5, 11)) < 1e-6);
});

test('#view=iso starts in the isometric view', () => {
  const { view } = setup('#view=iso');
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'isometric');
  assert.ok((view.activeCamera as THREE.OrthographicCamera).isOrthographicCamera);
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

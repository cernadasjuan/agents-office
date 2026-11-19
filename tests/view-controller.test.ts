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
  return { view, camera, manager, selection, wall, hint, press };
}

test('first person stays the default and the camera does not move by itself', () => {
  const { view, camera, wall } = setup();
  view.update(1, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.deepEqual(camera.position.toArray(), [-12, 5.5, 11]);
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
  assert.ok(camera.position.distanceTo(new THREE.Vector3(-12, 5.5, 11)) < 1e-6);
});

test('#view=overview starts in the overview', () => {
  const { view, camera } = setup('#view=overview');
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'overview');
  assert.ok(camera.position.y > 15);
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

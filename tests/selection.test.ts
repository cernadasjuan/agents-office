import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { SelectionState, isClick, onSelectionChange, parseViewHash, selectOrFly, selectedAgentId } from '../src/scene/Selection.js';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { StickFigure } = await import('../src/characters/StickFigure.js');
const { pickAgent } = await import('../src/scene/Selection.js');
const { STATIC_SOURCE_LAYER } = await import('../src/scene/StaticMerge.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

test('selection changes notify listeners once per change', () => {
  const selection = new SelectionState();
  const seen: Array<string | null> = [];
  const stop = selection.onChange((id) => seen.push(id));

  selection.select('a');
  selection.select('a');
  selection.select('b');
  selection.clear();
  selection.clear();
  stop();
  selection.select('c');

  assert.deepEqual(seen, ['a', 'b', null]);
  assert.equal(selection.selected, 'c');
});

test('reselect notifies listeners for the current selection again, with no change', () => {
  const selection = new SelectionState();
  const seen: Array<string | null> = [];
  selection.onChange((id) => seen.push(id));
  selection.select('a');
  selection.reselect();
  selection.reselect();
  assert.deepEqual(seen, ['a', 'a', 'a']);
  assert.equal(selection.selected, 'a');
});

test('reselect on no selection notifies listeners with null, without picking one', () => {
  const selection = new SelectionState();
  const seen: Array<string | null> = [];
  selection.onChange((id) => seen.push(id));
  selection.reselect();
  assert.deepEqual(seen, [null]);
  assert.equal(selection.selected, null);
});

test('selectOrFly selects a new agent normally, but re-notifies for an agent already selected (so a marker click still flies there)', () => {
  const seen: Array<string | null> = [];
  const stop = onSelectionChange((id) => seen.push(id));
  try {
    selectOrFly('x');
    selectOrFly('x');
    selectOrFly('y');
    assert.deepEqual(seen, ['x', 'x', 'y']);
    assert.equal(selectedAgentId(), 'y');
  } finally {
    stop();
  }
});

test('a failing listener does not stop the others', (t) => {
  t.mock.method(console, 'debug', () => undefined);
  const selection = new SelectionState();
  const seen: string[] = [];
  selection.onChange(() => { throw new Error('boom'); });
  selection.onChange((id) => seen.push(String(id)));
  selection.select('a');
  assert.deepEqual(seen, ['a']);
});

test('the selection drops an agent that left and keeps one that stays', () => {
  const selection = new SelectionState();
  selection.select('a');
  selection.keepOnly(['a', 'b']);
  assert.equal(selection.selected, 'a');
  selection.keepOnly(['b']);
  assert.equal(selection.selected, null);
});

test('a ray through a figure picks its agent, a ray past it picks nothing', () => {
  const near = new StickFigure('Near', new THREE.Color(0xff0000));
  const far = new StickFigure('Far', new THREE.Color(0x00ff00));
  near.teleportTo(new THREE.Vector3(3, 0, 0), new THREE.Vector3(3, 0, 1));
  far.teleportTo(new THREE.Vector3(3, 0, -6), new THREE.Vector3(3, 0, 1));
  const scene = new THREE.Scene();
  scene.add(near.group, far.group);
  scene.updateMatrixWorld(true);
  const targets = [{ id: 'far', object: far.group }, { id: 'near', object: near.group }];

  const hit = new THREE.Raycaster(new THREE.Vector3(3, 1.2, 10), new THREE.Vector3(0, 0, -1));
  assert.equal(pickAgent(hit, targets), 'near');

  const miss = new THREE.Raycaster(new THREE.Vector3(-8, 1.2, 10), new THREE.Vector3(0, 0, -1));
  assert.equal(pickAgent(miss, targets), null);
  assert.equal(pickAgent(hit, []), null);
});

test('issue #223: a target with `resolve` turns the ray hit into its own id, not the target id', () => {
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  plane.position.set(0, 0, 0);
  const scene = new THREE.Scene();
  scene.add(plane);
  scene.updateMatrixWorld(true);
  const resolved: Array<THREE.Vector2 | undefined> = [];
  const targets = [{
    id: 'board',
    object: plane,
    resolve: (hit: THREE.Intersection) => { resolved.push(hit.uv); return hit.uv && hit.uv.y > 0.5 ? 'row-a' : null; },
  }];

  const top = new THREE.Raycaster(new THREE.Vector3(0.2, 0.6, 5), new THREE.Vector3(0, 0, -1));
  assert.equal(pickAgent(top, targets), 'row-a');

  const bottom = new THREE.Raycaster(new THREE.Vector3(0.2, -0.6, 5), new THREE.Vector3(0, 0, -1));
  assert.equal(pickAgent(bottom, targets), null, 'resolve returning null is "no selection", not the target id');

  assert.ok(resolved.every((uv) => uv !== undefined), 'the hit carried a uv for resolve to read');
});

test('a press and release close together is a click, a drag is not', () => {
  assert.equal(isClick({ x: 10, y: 10 }, { x: 12, y: 13 }), true);
  assert.equal(isClick({ x: 10, y: 10 }, { x: 40, y: 10 }), false);
  assert.equal(isClick(null, { x: 10, y: 10 }), true);
});

test('the URL hash picks the start view and the agent to focus', () => {
  assert.deepEqual(parseViewHash(''), { view: 'first-person', focus: null, zoom: null, room: null });
  assert.deepEqual(parseViewHash('#view=iso'), { view: 'isometric', focus: null, zoom: null, room: null });
  assert.deepEqual(parseViewHash('#focus=ab12cd&view=iso'), { view: 'isometric', focus: 'ab12cd', zoom: null, room: null });
  assert.deepEqual(parseViewHash('#view=sideways&focus=a'), { view: 'first-person', focus: 'a', zoom: null, room: null });
  // parseViewHash's own fallback only; chooseViewMode (ViewMemory.ts) layers the saved view and
  // the layout default on top, so the live app does not always land in first person for this
  // (see tests/navigation.test.ts's #173 review test: the building layout lands in isometric).
  assert.deepEqual(parseViewHash('#view=overview&focus=a'), { view: 'first-person', focus: 'a', zoom: null, room: null }, 'the overview mode is gone (#173): an unknown view falls back to first person here');
  assert.deepEqual(parseViewHash('#focus=<script>'), { view: 'first-person', focus: null, zoom: null, room: null });
  assert.deepEqual(parseViewHash(`#focus=${'a'.repeat(200)}`), { view: 'first-person', focus: null, zoom: null, room: null });
});

test('issue #89: #select= is the current name for the agent to focus; #focus= still works', () => {
  assert.deepEqual(parseViewHash('#select=ab12cd&view=iso'), { view: 'isometric', focus: 'ab12cd', zoom: null, room: null });
  // Both given: #select wins, it is the name the issue's own acceptance criteria use.
  assert.deepEqual(parseViewHash('#select=a&focus=b'), { view: 'first-person', focus: 'a', zoom: null, room: null });
  assert.deepEqual(parseViewHash('#select=<script>'), { view: 'first-person', focus: null, zoom: null, room: null });
});

test('issue #89: #zoom= starts the view at that camera distance', () => {
  assert.deepEqual(parseViewHash('#view=iso&zoom=12.5'), { view: 'isometric', focus: null, zoom: 12.5, room: null });
  assert.deepEqual(parseViewHash('#zoom=0'), { view: 'first-person', focus: null, zoom: null, room: null }, 'zero is not a usable distance');
  assert.deepEqual(parseViewHash('#zoom=-5'), { view: 'first-person', focus: null, zoom: null, room: null }, 'negative is not a usable distance');
  assert.deepEqual(parseViewHash('#zoom=not-a-number'), { view: 'first-person', focus: null, zoom: null, room: null });
  assert.deepEqual(parseViewHash(''), { view: 'first-person', focus: null, zoom: null, room: null }, 'missing stays null, not 0');
});

test('issue #89: #room= frames a named room or mission, lowercased; unknown shapes stay null', () => {
  assert.deepEqual(parseViewHash('#room=office'), { view: 'first-person', focus: null, zoom: null, room: 'office' });
  assert.deepEqual(parseViewHash('#room=Library'), { view: 'first-person', focus: null, zoom: null, room: 'library' }, 'lowercased');
  assert.deepEqual(parseViewHash('#room=media-plan-persistence'), { view: 'first-person', focus: null, zoom: null, room: 'media-plan-persistence' });
  assert.deepEqual(parseViewHash('#room=<script>'), { view: 'first-person', focus: null, zoom: null, room: null });
  assert.deepEqual(parseViewHash(''), { view: 'first-person', focus: null, zoom: null, room: null }, 'missing stays null');
});

test('a tombstone (static-merged furniture, source moved to its own layer) is still pickable', () => {
  // After StaticMerge.rebuild(), a tombstone's source mesh is still the same object at the same
  // position, just set to STATIC_SOURCE_LAYER so the main camera skips it (the merged mesh draws instead).
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
  mesh.layers.set(STATIC_SOURCE_LAYER);
  group.add(mesh);
  group.position.set(3, 0, 0);
  const scene = new THREE.Scene();
  scene.add(group);
  scene.updateMatrixWorld(true);
  const targets = [{ id: 'tomb-1', object: group }];

  const hit = new THREE.Raycaster(new THREE.Vector3(3, 0, 5), new THREE.Vector3(0, 0, -1));
  assert.equal(pickAgent(hit, targets), 'tomb-1');
});

test('a pick leaves the raycaster layers as it found them', () => {
  const figure = new StickFigure('agent', new THREE.Color(0xe05050));
  const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 1.2, 5), new THREE.Vector3(0, 0, -1));
  const mask = raycaster.layers.mask;
  pickAgent(raycaster, [{ id: 'a', object: figure.group }]);
  assert.equal(raycaster.layers.mask, mask);
});

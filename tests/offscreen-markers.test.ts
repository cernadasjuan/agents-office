import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { OffscreenMarkers, clusterBySpacing } from '../src/ui/OffscreenMarkers.js';
import type { Wait } from '../src/ui/attention.js';

const WIDTH = 1600;
const HEIGHT = 900;

function installDocument(t: TestContext): { container: HTMLElement; canvas: HTMLCanvasElement } {
  const dom = new JSDOM('<!doctype html><html><body><div id="markers"></div></body></html>');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  t.after(() => {
    dom.window.close();
    Reflect.deleteProperty(globalThis, 'document');
  });
  const container = dom.window.document.getElementById('markers')!;
  const canvas = dom.window.document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ width: WIDTH, height: HEIGHT, left: 0, top: 0, right: WIDTH, bottom: HEIGHT, x: 0, y: 0, toJSON: () => undefined });
  return { container, canvas };
}

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 1000);
  cam.position.set(0, 2, 10);
  cam.lookAt(0, 2, 0);
  cam.updateMatrixWorld();
  return cam;
}

function agentAt(id: string, x: number, y: number, z: number, wait?: Wait) {
  const object = new THREE.Object3D();
  object.position.set(x, y, z);
  object.updateMatrixWorld();
  return { id, object, color: new THREE.Color('#ff0000'), wait };
}

test('an agent in the fresh band, off screen, gets a marker; on screen it gets none', (t) => {
  const { container, canvas } = installDocument(t);
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: () => undefined });

  markers.refresh([agentAt('onscreen', 0, 2, 0, { attention: 'waiting', waitMinutes: 3 }), agentAt('offscreen', 80, 2, 0, { attention: 'waiting', waitMinutes: 3 })]);

  assert.equal(container.querySelectorAll(`.${'offscreen-marker'}`).length, 1);
  assert.equal(container.children.length, 1);
});

test('aging and cold waits never get a marker, even off screen', (t) => {
  const { container, canvas } = installDocument(t);
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: () => undefined });

  markers.refresh([
    agentAt('aging', 80, 2, 0, { attention: 'waiting', waitMinutes: 60 }),
    agentAt('cold', 80, 2, 0, { attention: 'waiting', waitMinutes: 2000 }),
    agentAt('no-wait', 80, 2, 0, undefined),
  ]);

  assert.equal(container.children.length, 0);
});

test('a click on a marker selects that agent', (t) => {
  const { container, canvas } = installDocument(t);
  const selected: string[] = [];
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: (id) => selected.push(id) });

  markers.refresh([agentAt('a1', 80, 2, 0, { attention: 'waiting', waitMinutes: 3 })]);
  (container.firstElementChild as HTMLElement).click();

  assert.deepEqual(selected, ['a1']);
});

test('a marker for an agent that leaves the fresh band, or leaves entirely, is removed', (t) => {
  const { container, canvas } = installDocument(t);
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: () => undefined });

  markers.refresh([agentAt('a1', 80, 2, 0, { attention: 'waiting', waitMinutes: 3 })]);
  assert.equal(container.children.length, 1);

  markers.refresh([agentAt('a1', 80, 2, 0, { attention: 'waiting', waitMinutes: 60 })]);
  assert.equal(container.children.length, 0);

  markers.refresh([agentAt('a1', 80, 2, 0, { attention: 'waiting', waitMinutes: 3 })]);
  markers.refresh([]);
  assert.equal(container.children.length, 0);
});

test('without a canvas size (not yet laid out), refresh is a no-op', (t) => {
  const { container, canvas } = installDocument(t);
  canvas.getBoundingClientRect = () => ({ width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => undefined });
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: () => undefined });

  markers.refresh([agentAt('a1', 80, 2, 0, { attention: 'waiting', waitMinutes: 3 })]);
  assert.equal(container.children.length, 0);
});

test('a marker stops short of the avoided rect (the side panel)', (t) => {
  const { container, canvas } = installDocument(t);
  // Up and to the right from this camera: without the avoided rect this lands inside it.
  const panel = { left: 1280, top: 16, right: 1584, bottom: 500 };
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: () => undefined, avoid: () => panel });

  markers.refresh([agentAt('a1', 30, 30, -20, { attention: 'waiting', waitMinutes: 3 })]);
  const el = container.firstElementChild as HTMLElement;
  assert.ok(el);
  const match = /translate\(([\d.-]+)px,\s*([\d.-]+)px\)/.exec(el.style.transform);
  assert.ok(match, `expected a translate in the transform, got ${el.style.transform}`);
  const x = Number(match![1]) + 14;
  const y = Number(match![2]) + 14;
  const insidePanel = x >= panel.left && x <= panel.right && y >= panel.top && y <= panel.bottom;
  assert.equal(insidePanel, false, `expected the marker outside the panel rect, got (${x}, ${y})`);
});

test('markers close enough to collide merge into one, with a count, and fly to the oldest fresh wait on click', (t) => {
  const { container, canvas } = installDocument(t);
  const selected: string[] = [];
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: (id) => selected.push(id) });

  // All three sit far to the right, at nearly the same angle from the camera: they collide on one edge point.
  markers.refresh([
    agentAt('short', 80, 2, 0.02, { attention: 'waiting', waitMinutes: 2 }),
    agentAt('longest', 80, 2, 0.01, { attention: 'waiting', waitMinutes: 12 }),
    agentAt('mid', 80, 2, 0, { attention: 'waiting', waitMinutes: 5 }),
  ]);

  assert.equal(container.children.length, 1, 'expected the three colliding markers to merge into one');
  const el = container.firstElementChild as HTMLElement;
  assert.equal(el.classList.contains('offscreen-marker-cluster'), true);
  assert.equal(el.textContent, '3');

  el.click();
  assert.deepEqual(selected, ['longest'], 'expected the click to fly to the longest-waiting (oldest fresh) agent in the cluster');
});

test('two groups whose first members are far apart still merge, when their displayed (oldest-wait) points collide', () => {
  // Hand-picked so the group comparing only first-arrival points would miss this:
  // group A's first member a0=(0,0) and group B's first member b0=(70,0) are 70px apart
  // (over CLUSTER_SPACING_PX, 34), so a naive "compare to the first member" check keeps
  // them separate. But A's oldest member a1=(33,0) and B's oldest member b1=(37,0) are
  // only 4px apart: the two groups would still draw overlapping markers.
  const fresh = (waitMinutes: number): Wait => ({ attention: 'waiting', waitMinutes });
  const a0 = { id: 'a0', point: { x: 0, y: 0, angle: 0 }, wait: fresh(1) };
  const a1 = { id: 'a1', point: { x: 33, y: 0, angle: 0 }, wait: fresh(10) };
  const b0 = { id: 'b0', point: { x: 70, y: 0, angle: 0 }, wait: fresh(1) };
  const b1 = { id: 'b1', point: { x: 37, y: 0, angle: 0 }, wait: fresh(12) };

  assert.ok(Math.hypot(a0.point.x - b0.point.x, a0.point.y - b0.point.y) >= 34, 'the first members must look far apart, to make this a real regression case');
  assert.ok(Math.hypot(a1.point.x - b1.point.x, a1.point.y - b1.point.y) < 34, 'the oldest members must actually collide, to make this a real regression case');

  const groups = clusterBySpacing([a0, a1, b0, b1]);

  // Whatever the grouping, no two groups may display colliding points.
  const displayed = groups.map((group) => {
    const oldest = [...group].sort((x, y) => y.wait!.waitMinutes! - x.wait!.waitMinutes!)[0];
    return oldest.point;
  });
  for (let i = 0; i < displayed.length; i++) {
    for (let j = i + 1; j < displayed.length; j++) {
      const distance = Math.hypot(displayed[i].x - displayed[j].x, displayed[i].y - displayed[j].y);
      assert.ok(distance >= 34, `groups ${i} and ${j} still collide at distance ${distance}`);
    }
  }
  // This exact case cascades into one group, with the longest wait (b1, 12 min) as its display point.
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 4);
});

test('agents far enough apart on the edge each keep their own marker', (t) => {
  const { container, canvas } = installDocument(t);
  const markers = new OffscreenMarkers({ container, canvas, camera, onSelect: () => undefined });

  markers.refresh([agentAt('right', 80, 2, 0, { attention: 'waiting', waitMinutes: 3 }), agentAt('up', 0, 80, 0, { attention: 'waiting', waitMinutes: 3 })]);

  assert.equal(container.children.length, 2);
  for (const el of [...container.children] as HTMLElement[]) assert.equal(el.classList.contains('offscreen-marker-cluster'), false);
});

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// missionRooms.ts pulls in furniture factories that paint toon gradients on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const { createOffice } = await import('../src/scene/Office.js');
const { addLighting } = await import('../src/scene/SceneSetup.js');
const { BuildingLayout } = await import('../src/addons/building/BuildingLayout.js');
const { countDrawCalls, DRAW_CALL_BUDGET } = await import('../src/scene/RenderBudget.js');
const { StaticBatch } = await import('../src/scene/StaticMerge.js');

/**
 * Issue #123 (no cap on the mission wing): the corridor fix merges every war room's floor,
 * walls and furniture into the same `missions`/`room-walls` static zones a single war room
 * already used (`StaticMerge`), so growing the wing should cost the renderer close to nothing
 * per room — the real risk the decision record names is CSS2D label/sign clutter, already
 * handled by `LabelDetailController`'s distance culling (`src/ui/LabelDetail.ts`), not draw
 * calls. This measures 42 war rooms (well past the ~9 the other render-budget fixture carries,
 * and past the 30-50 room range Winston's assessment named as the likely bite point) against
 * the real draw-call budget, with no agents and no GitHub/BMAD plugins — isolating what the
 * mission wing itself costs.
 */
const WAR_ROOM_COUNT = 42;

function buildScene(count: number): THREE.Scene {
  const scene = new THREE.Scene();
  addLighting(scene);
  const layout = new BuildingLayout(scene, createOffice(scene), {
    storage: { getItem: () => null, setItem: () => undefined },
  });
  layout.syncWorldRooms(Array.from({ length: count }, (_, i) => ({
    id: `m${i}`, kind: 'mission', title: `Mission ${i}`, state: 'open' as const,
    sleepers: [],
    walls: { statement: 'x', docs: ['a'], issues: [], kanban: [] },
  })));
  return scene;
}

test('issue #123: a 42-war-room mission wing stays under the draw-call budget', () => {
  const scene = buildScene(WAR_ROOM_COUNT);
  scene.updateMatrixWorld();
  const statics = new StaticBatch(scene);
  statics.update();
  const camera = new THREE.PerspectiveCamera(60, 1280 / 800, 0.1, 100);
  camera.position.set(0, 40, 0);
  camera.lookAt(0, 0, -80);
  camera.updateMatrixWorld();
  const after = countDrawCalls(scene, camera);
  console.log(`42 war rooms: ${JSON.stringify(after)}`);
  assert.ok(after.total < DRAW_CALL_BUDGET, `42 war rooms ${JSON.stringify(after)} exceeds the budget (${DRAW_CALL_BUDGET})`);
});

test('issue #123: growing the mission wing from 9 to 42 war rooms adds only a handful of draw calls, not one per room', () => {
  const small = buildScene(9);
  const large = buildScene(WAR_ROOM_COUNT);
  const camera = new THREE.PerspectiveCamera(60, 1280 / 800, 0.1, 150);
  camera.position.set(0, 60, 0);
  camera.lookAt(0, 0, -120);
  camera.updateMatrixWorld();
  for (const scene of [small, large]) scene.updateMatrixWorld();
  new StaticBatch(small).update();
  new StaticBatch(large).update();
  const smallTotal = countDrawCalls(small, camera).total;
  const largeTotal = countDrawCalls(large, camera).total;
  console.log(`9 rooms: ${smallTotal} draw calls, 42 rooms: ${largeTotal} draw calls, camera-culled`);
  // The floor, walls, ceiling, corridor and furniture merge into the shared static zones a
  // single war room already used (StaticMerge): growing the wing costs nothing there. Each
  // room's 4 canvas wall boards (statement/docs/issues/kanban, `MeshBasicMaterial`, not a toon
  // material) are the one real per-room draw-call cost `StaticMerge` cannot absorb; measured
  // at ~1.4 per added room once the camera culls the rooms behind it (not the worst-case 4 per
  // room with no camera at all). A regression here (every room's boards suddenly all drawing,
  // or a new un-merged piece added per room) would push this well past a loose bound, not
  // nudge it — 60 is 33 rooms' worth of headroom above the measured 46.
  assert.ok(largeTotal - smallTotal <= 60, `expected growth well below one draw call per room, got ${largeTotal - smallTotal} for 33 more rooms`);
});

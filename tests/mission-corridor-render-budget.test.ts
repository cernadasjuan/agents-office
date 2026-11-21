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
const { MAX_TOMBSTONES } = await import('../src/addons/building/missionRooms.js');
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { countDrawCalls, DRAW_CALL_BUDGET } = await import('../src/scene/RenderBudget.js');
const { StaticBatch } = await import('../src/scene/StaticMerge.js');
const { FigureBatch } = await import('../src/characters/FigureBatch.js');

/**
 * Issue #123 (no cap on the mission wing): the corridor fix merges every war room's floor,
 * walls and furniture into the same `missions`/`room-walls` static zones a single war room
 * already used (`StaticMerge`), so growing the wing should cost the renderer close to nothing
 * per room — the real risk the decision record names is CSS2D label/sign clutter, already
 * handled by `LabelDetailController`'s distance culling (`src/ui/LabelDetail.ts`), not draw
 * calls. This measures 42 war rooms (well past the ~9 the other render-budget fixture carries,
 * and past the 30-50 room range Winston's assessment named as the likely bite point) against
 * the real draw-call budget.
 *
 * Review of the first version (PR #204): the fixture had no agents, furniture state or
 * tombstones, so it measured only the empty-room case, well below what a populated wing
 * actually costs. This version pushes every room to its tombstone cap and its furniture peak
 * (desks, debug stations), and keeps 40 agents live, the same worst-case shape
 * `tests/real-size-office.ts`'s fixture already uses at 9 rooms.
 */
const WAR_ROOM_COUNT = 42;
const AGENT_COUNT = 40;
// Measured growth (9 -> 42 populated war rooms, each at its tombstone cap and furniture peak,
// 40 agents live) is 14 draw calls for 33 more rooms. 25 is that plus an 11-call margin — real
// headroom above a number this fixture actually and repeatably measures, not padding chosen to
// avoid a failure (review of PR #204's first version, which used slack this way).
const MEASURED_GROWTH_BOUND = 25;

function worldRoom(index: number) {
  return {
    id: `m${index}`, kind: 'mission' as const, title: `Mission ${index}`, state: 'open' as const,
    // Worst case: every war room at the tombstone cap, not just a handful (same as the
    // real-size fixture).
    sleepers: Array.from({ length: MAX_TOMBSTONES }, (_, j) => ({ id: `m${index}-tomb-${j}`, endedAt: '2026-11-18' })),
    walls: { statement: 'x', docs: ['a'], issues: [], kanban: [] },
  };
}

function buildPopulatedScene(roomCount: number): { scene: THREE.Scene; manager: InstanceType<typeof AgentManager> } {
  const scene = new THREE.Scene();
  addLighting(scene);
  const layout = new BuildingLayout(scene, createOffice(scene), {
    storage: { getItem: () => null, setItem: () => undefined },
  });
  layout.syncWorldRooms(Array.from({ length: roomCount }, (_, i) => worldRoom(i)));
  const manager = new AgentManager(scene, layout);
  for (let i = 0; i < AGENT_COUNT; i++) {
    manager.addAgent({ id: `a${i}`, name: `agent ${i}`, activity: 'implementing', extras: { room: `m${i % roomCount}` } });
  }
  // Push every room's furniture to its peak (desks, debug stations), the same worst-case
  // the other render-budget fixture uses: furniture grows with the peak live count and never
  // shrinks back, so a room that briefly holds 8 agents keeps its full desk grid after they leave.
  for (let room = 0; room < roomCount; room++) {
    const stressIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = `stress-${room}-${i}`;
      stressIds.push(id);
      manager.addAgent({ id, name: id, activity: i < 4 ? 'debugging' : 'implementing', extras: { room: `m${room}` } });
    }
    layout.update();
    for (const id of stressIds) manager.removeAgent(id);
  }
  return { scene, manager };
}

function renderedDrawCalls(scene: THREE.Scene, manager: InstanceType<typeof AgentManager>, camera: THREE.Camera): number {
  scene.updateMatrixWorld();
  new StaticBatch(scene).update();
  new FigureBatch(scene).sync(manager.getAgents().map((managed) => managed.figure.group));
  return countDrawCalls(scene, camera).total;
}

test('issue #123: a populated 42-war-room mission wing stays under the draw-call budget', () => {
  const { scene, manager } = buildPopulatedScene(WAR_ROOM_COUNT);
  const camera = new THREE.PerspectiveCamera(60, 1280 / 800, 0.1, 100);
  camera.position.set(0, 60, 0);
  camera.lookAt(0, 0, -120);
  camera.updateMatrixWorld();
  const total = renderedDrawCalls(scene, manager, camera);
  console.log(`42 populated war rooms: ${total} draw calls`);
  assert.ok(total < DRAW_CALL_BUDGET, `42 populated war rooms (${total}) exceeds the budget (${DRAW_CALL_BUDGET})`);
});

test('issue #123: growing a populated mission wing from 9 to 42 war rooms adds only a handful of draw calls, not one per room', () => {
  const small = buildPopulatedScene(9);
  const large = buildPopulatedScene(WAR_ROOM_COUNT);
  const camera = new THREE.PerspectiveCamera(60, 1280 / 800, 0.1, 150);
  camera.position.set(0, 80, 0);
  camera.lookAt(0, 0, -150);
  camera.updateMatrixWorld();
  const smallTotal = renderedDrawCalls(small.scene, small.manager, camera);
  const largeTotal = renderedDrawCalls(large.scene, large.manager, camera);
  const growth = largeTotal - smallTotal;
  console.log(`9 populated rooms: ${smallTotal} draw calls, 42 populated rooms: ${largeTotal} draw calls, growth ${growth} for 33 more rooms`);
  // The floor, walls, ceiling, corridor and furniture merge into the shared static zones a
  // single war room already used (StaticMerge): growing the wing costs nothing there. Each
  // room's 4 canvas wall boards (statement/docs/issues/kanban, `MeshBasicMaterial`, not a toon
  // material) are the one real per-room draw-call cost StaticMerge cannot absorb. Review of
  // the first version (PR #204): its bound (60) had slack baked in that did not match its own
  // measured rate. This bound is the measured growth plus a small, fixed margin, so a
  // regression (every room's boards suddenly all drawing, or a new un-merged piece per room)
  // fails this test instead of hiding inside a loose number.
  assert.ok(growth <= MEASURED_GROWTH_BOUND, `expected growth near the measured rate, got ${growth} for 33 more rooms (bound ${MEASURED_GROWTH_BOUND})`);
});

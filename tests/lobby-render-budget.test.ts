import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time; rooms add signs. The document
// must exist before any of these modules are first imported, so every one of them is a
// dynamic import below, the same order `tests/render-budget.test.ts` already relies on.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { createOffice } = await import('../src/scene/Office.js');
const { addLighting } = await import('../src/scene/SceneSetup.js');
const { BuildingLayout } = await import('../src/addons/building/BuildingLayout.js');
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { countDrawCalls, DRAW_CALL_BUDGET } = await import('../src/scene/RenderBudget.js');
const { StaticBatch } = await import('../src/scene/StaticMerge.js');
const { FigureBatch } = await import('../src/characters/FigureBatch.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

/**
 * Issue #192: with a floor focused, the scene is this floor's own building (its office,
 * desks, library, lounge) plus the lobby's own cross-floor queue — never the other floors'
 * own rooms (`AgentPoller`'s floor filter drops everything on another floor except an agent
 * that queues for Gabriel, `src/agents/AgentPoller.ts`). This mirrors what one page actually
 * renders once the poller has filtered: a realistic single floor's own population (it never
 * approaches the pinned 40-agent/25-room worst case `tests/real-size-office.ts` measures
 * with no floors at all), plus a handful of cross-floor queue entries from two other floors
 * (three floors' worth of data feeding one render), never their own desks or rooms.
 */
function buildFocusedFloorOffice() {
  const scene = new THREE.Scene();
  addLighting(scene);
  const rooms = ['office', 'library', 'lounge', 'desks', 'desks'];
  const store = new Map([['agents-office.building.rooms:agents-office', JSON.stringify(rooms)]]);
  const layout = new BuildingLayout(scene, createOffice(scene), {
    storage: { getItem: (key: string) => store.get(key) ?? null, setItem: () => undefined },
    floor: 'agents-office',
  });
  const manager = new AgentManager(scene, layout);
  // This floor's own population: a realistic desk crowd, never the 40-agent worst case.
  for (let i = 0; i < 15; i++) {
    manager.addAgent({ id: `local-${i}`, name: `local ${i}`, activity: 'implementing', extras: { floor: 'agents-office' } });
  }
  // Two other floors, each with a couple of agents waiting on Gabriel: the poller kept
  // them (issue #192) even though neither floor's own building renders here.
  for (const [floor, count] of [['widget-service', 3], ['billing-service', 2]] as const) {
    for (let i = 0; i < count; i++) {
      manager.addAgent({
        id: `${floor}-wait-${i}`, name: `${floor} ${i}`, activity: 'meeting',
        extras: { attention: 'waiting', waitMinutes: 5 + i, floor },
      });
    }
  }
  layout.update();
  return { scene, manager };
}

test('issue #192: one floor focused, plus the lobby\'s cross-floor queue (3 floors of data), stays under the draw-call budget', () => {
  const { scene, manager } = buildFocusedFloorOffice();
  scene.updateMatrixWorld();
  new StaticBatch(scene).update();
  new FigureBatch(scene).sync(manager.getAgents().map((managed) => managed.figure.group));

  const after = countDrawCalls(scene);
  console.log(`one floor + lobby queue draw calls: ${JSON.stringify(after)}`);
  assert.ok(after.total < DRAW_CALL_BUDGET, `${JSON.stringify(after)} over the ${DRAW_CALL_BUDGET} budget`);
});

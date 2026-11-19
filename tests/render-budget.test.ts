import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time; rooms add signs and boards.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { buildRealSizeOffice } = await import('./real-size-office.js');
const { countDrawCalls, DRAW_CALL_BUDGET } = await import('../src/scene/RenderBudget.js');
const { StaticBatch, STATIC_SOURCE_LAYER } = await import('../src/scene/StaticMerge.js');
const { FigureBatch } = await import('../src/characters/FigureBatch.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

function vertexCount(meshes: THREE.Mesh[]): number {
  return meshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
}

test('at the real size (25 rooms, 40 agents) one frame stays under the draw-call budget, shadow pass included', () => {
  const { scene, manager } = buildRealSizeOffice();
  scene.updateMatrixWorld();
  const before = countDrawCalls(scene);
  // Without the batches the same scene is far above the budget: the test can fail
  assert.ok(before.total > DRAW_CALL_BUDGET * 10, `unbatched ${JSON.stringify(before)}`);

  const statics = new StaticBatch(scene);
  statics.update();
  new FigureBatch(scene).sync(manager.getAgents().map((managed) => managed.figure.group));
  const after = countDrawCalls(scene);

  console.log(`draw calls before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  assert.equal(after.shadowLights, 3);
  assert.ok(after.total < DRAW_CALL_BUDGET, `batched ${JSON.stringify(after)}`);
});

test('the merge keeps every visible furniture triangle: merged vertices equal the source vertices', () => {
  const { scene } = buildRealSizeOffice();
  scene.updateMatrixWorld();
  const statics = new StaticBatch(scene);
  statics.update();
  const sources: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && object.layers.isEnabled(STATIC_SOURCE_LAYER)) sources.push(object as THREE.Mesh);
  });
  assert.ok(sources.length > 2000, `${sources.length} merged sources`);
  assert.equal(vertexCount(statics.mergedMeshes), vertexCount(sources));
  const sourceMaterials = new Set(sources.map((mesh) => mesh.material));
  for (const mesh of statics.mergedMeshes) assert.ok(sourceMaterials.has(mesh.material), 'a merged mesh uses a source material');
});

test('a second update with no change rebuilds nothing', () => {
  const { scene } = buildRealSizeOffice();
  scene.updateMatrixWorld();
  const statics = new StaticBatch(scene);
  assert.equal(statics.update(), true);
  assert.equal(statics.update(), false);
});

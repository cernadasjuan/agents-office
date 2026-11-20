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
const { buildRealSizeOffice, realSizeCameras, REAL_SIZE } = await import('./real-size-office.js');
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

function countNamed(scene: THREE.Object3D, name: string): number {
  let count = 0;
  scene.traverse((object) => { if (object.name === name) count++; });
  return count;
}

test('the real-size fixture wears BMAD hats and GitHub cards, as with the fork plugins on', () => {
  const { scene, github } = buildRealSizeOffice();
  assert.equal(countNamed(scene, 'bmad-hats'), REAL_SIZE.hatWearers);
  assert.equal(countNamed(scene, 'github-cards'), 1, 'all cards are one mesh');
  assert.equal(new Set(github.cards.placements.map((placement) => placement.agentId)).size, REAL_SIZE.cardHolders);
});

test('at the real size (25 rooms, 40 agents, hats and cards) a frame from each start view stays under the draw-call budget, shadow pass included', () => {
  const { scene, manager } = buildRealSizeOffice();
  scene.updateMatrixWorld();
  const cameras = realSizeCameras(scene);
  const before = countDrawCalls(scene, cameras.firstPerson);
  // Without the batches the same scene is far above the budget: the test can fail
  assert.ok(before.total > DRAW_CALL_BUDGET * 2, `unbatched ${JSON.stringify(before)}`);

  const statics = new StaticBatch(scene);
  statics.update();
  new FigureBatch(scene).sync(manager.getAgents().map((managed) => managed.figure.group));
  for (const [view, camera] of Object.entries(cameras)) {
    const after = countDrawCalls(scene, camera);
    console.log(`${view}: draw calls before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    assert.equal(after.shadowLights, 3);
    assert.ok(after.total < DRAW_CALL_BUDGET, `${view} batched ${JSON.stringify(after)}`);
  }
});

test('the count culls like the renderer: a mesh behind the camera or outside every lamp cone costs nothing', () => {
  const scene = new THREE.Scene();
  const light = new THREE.SpotLight(0xffffff, 1, 20, Math.PI / 3);
  light.castShadow = true;
  light.position.set(0, 5, 0);
  light.target.position.set(0, 0, 0);
  scene.add(light, light.target);
  const box = () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  };
  box().position.set(0, 0.5, 0); // seen by the camera and the lamp
  box().position.set(0, 0.5, 30); // behind the camera, outside the cone
  const always = box();
  always.position.set(50, 0.5, 50);
  always.frustumCulled = false; // an instanced batch: drawn in every pass
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 2, 10);
  camera.lookAt(0, 0, 0);
  scene.updateMatrixWorld();
  camera.updateMatrixWorld();

  const culled = countDrawCalls(scene, camera);
  assert.deepEqual({ main: culled.main, shadowCalls: culled.shadowCalls, total: culled.total }, { main: 2, shadowCalls: 2, total: 4 });
  // Without a camera the count stays the worst case: every mesh, every caster for every light
  const worst = countDrawCalls(scene);
  assert.deepEqual({ main: worst.main, shadowCalls: worst.shadowCalls, total: worst.total }, { main: 3, shadowCalls: 3, total: 6 });
});

test('with 5 issue cards on each of the 40 agents the frame stays under the draw-call budget', () => {
  const { scene, manager, github } = buildRealSizeOffice();
  const agents = manager.getAgents();
  agents.forEach((managed, a) => {
    managed.info.extras = { ...managed.info.extras, issues: Array.from({ length: 5 }, (_, i) => ({ number: a * 10 + i + 1, title: '', repo: 'agents-office', color: '0e8a16' })) };
  });
  github.agentsChanged(agents);
  const cards = github.cards;
  scene.updateMatrixWorld();
  new StaticBatch(scene).update();
  new FigureBatch(scene).sync(agents.map((managed) => managed.figure.group));
  const after = countDrawCalls(scene);

  console.log(`draw calls with 200 cards ${JSON.stringify(after)}`);
  assert.equal(cards.placements.length, 200);
  assert.ok(after.total < DRAW_CALL_BUDGET, `with cards ${JSON.stringify(after)}`);
  // This is the worst case this suite measures. It was 466 before issue #121/#122 (main-room
  // desks and furniture), then dropped to 367 once the perf-shadow-budget PR recovered
  // headroom and moved DRAW_CALL_BUDGET to 430. It is 368 after the library wing move, the
  // persona-badge routing fix and the Librarian hat (issues #120/#128/#149): +1 against that
  // baseline. Each PR gets up to 5 more before it must recover headroom elsewhere, not just
  // add to the margin left by the last one.
  assert.ok(after.total <= 372, `worst case ${after.total} exceeds the current baseline (367) + 5`);
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

test('a sprite (a room label) counts as one camera draw call and casts no shadow', () => {
  const scene = new THREE.Scene();
  const before = countDrawCalls(scene).main;
  scene.add(new THREE.Sprite(new THREE.SpriteMaterial()));
  const after = countDrawCalls(scene);
  assert.equal(after.main, before + 1);
  assert.equal(after.shadowCasters, 0);
});

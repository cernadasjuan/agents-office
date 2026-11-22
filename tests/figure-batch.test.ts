import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time; labels need a document.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { StickFigure } = await import('../src/characters/StickFigure.js');
const { FigureBatch, FIGURE_PART_LAYER } = await import('../src/characters/FigureBatch.js');
const { pickAgent } = await import('../src/scene/Selection.js');
const { countDrawCalls } = await import('../src/scene/RenderBudget.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const RED = new THREE.Color(0xe05050);
const BLUE = new THREE.Color(0x5070e0);

function figures(scene: THREE.Scene, colors: THREE.Color[]): InstanceType<typeof StickFigure>[] {
  return colors.map((color, i) => {
    const figure = new StickFigure(`f${i}`, color);
    figure.group.position.set(i * 2, 0, 0);
    scene.add(figure.group);
    return figure;
  });
}

function partsOf(figure: InstanceType<typeof StickFigure>): THREE.Mesh[] {
  const parts: THREE.Mesh[] = [];
  figure.group.traverse((object) => {
    if (object.userData.figurePart) parts.push(object as THREE.Mesh);
  });
  return parts;
}

test('all figures draw in one call per part shape and color, each part where its joint puts it', () => {
  const scene = new THREE.Scene();
  const all = figures(scene, [RED, RED, BLUE]);
  scene.updateMatrixWorld();
  // 17 body + face parts (head, torso, 2 hands, 2 feet, 8 limbs, 2 eyes, 1 mouth) per
  // figure, plus hair (issue #165 round 2; round 7 replaced 'cap' with 'tufts', 2 cones
  // reusing the 'spiky' shape, not 1 — a round 7 follow-up dropped the middle tuft and
  // scaled the remaining 2 up, so it no longer reads as floating dots): f0 seeds 'tufts'
  // (2 pieces), f1 and f2 both seed 'spiky' (5 cones each) — 3 * 17 + 2 + 5 + 5 = 63.
  assert.equal(countDrawCalls(scene).main, 63);

  const batch = new FigureBatch(scene);
  batch.sync(all.map((figure) => figure.group));

  // head, hand, foot, leg, arm and torso shapes (two torso colors) = 7, plus the Hero
  // face/hair additions: eyes (1, shared by every figure), the mouth's one shape (all
  // three start idle, so all three share the 'neutral' bucket), and 1 hair bucket (round
  // 7: 'tufts' reuses the 'spiky' cone shape, so both styles share the one 'hair:spike'
  // bucket instead of costing one each) = 10.
  assert.equal(countDrawCalls(scene).main, 10);
  for (const figure of all) for (const part of partsOf(figure)) assert.equal(part.layers.isEnabled(0), false);
  const heads = batch.meshes.find((mesh) => mesh.geometry === all[0].joints.head.geometry)!;
  assert.equal(heads.count, 3);
  const matrix = new THREE.Matrix4();
  heads.getMatrixAt(2, matrix);
  // The instance buffer stores float32 (FigureBatch.ts); a per-agent body-width scale
  // (issue #165 round 2, HeroVariety.ts) is rarely exactly float32-representable, so the
  // comparison rounds the same way the buffer itself does, rather than asserting bit-exact
  // equality against the figure's own double-precision matrixWorld.
  const expected = all[2].joints.head.matrixWorld.clone();
  for (let i = 0; i < 16; i++) expected.elements[i] = Math.fround(expected.elements[i]);
  assert.ok(matrix.equals(expected));
  // Body parts still cast a shadow; the Hero face and hair additions never do (same "a
  // tiny topper casts nothing worth the cost" rationale as a persona hat).
  const bodyBucket = batch.meshes.find((mesh) => mesh.geometry === all[0].joints.head.geometry)!;
  assert.equal(bodyBucket.castShadow, true);
  const mouthBucket = batch.meshes.find((mesh) => mesh.geometry === all[0].joints.mouth.geometry)!;
  assert.equal(mouthBucket.castShadow, false);
});

test('a figure that moves is reported; a still figure is not', () => {
  const scene = new THREE.Scene();
  const all = figures(scene, [RED, BLUE]);
  const batch = new FigureBatch(scene);
  const roots = all.map((figure) => figure.group);
  scene.updateMatrixWorld();
  const first = batch.sync(roots);
  assert.equal(first.changed, true);

  scene.updateMatrixWorld();
  assert.deepEqual(batch.sync(roots), { moved: [], changed: false });

  all[1].joints.rightUpperArm.rotation.x = -1;
  scene.updateMatrixWorld();
  const next = batch.sync(roots);
  assert.deepEqual(next.moved, [all[1].group]);
  assert.equal(next.changed, false);
});

test('a figure that leaves the scene leaves the batch', () => {
  const scene = new THREE.Scene();
  const all = figures(scene, [RED, RED]);
  const batch = new FigureBatch(scene);
  scene.updateMatrixWorld();
  batch.sync(all.map((figure) => figure.group));
  scene.remove(all[0].group);
  const result = batch.sync([all[1].group]);
  assert.equal(result.changed, true);
  assert.equal(batch.meshes.find((mesh) => mesh.geometry === all[1].joints.head.geometry)!.count, 1);
});

test('things attached to a part still draw themselves, and a click still picks a batched figure', () => {
  const scene = new THREE.Scene();
  const [figure] = figures(scene, [RED]);
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.2), new THREE.MeshBasicMaterial());
  figure.joints.head.add(hat);
  scene.updateMatrixWorld();
  new FigureBatch(scene).sync([figure.group]);

  assert.equal(hat.layers.isEnabled(0), true);
  assert.equal(figure.joints.head.layers.isEnabled(FIGURE_PART_LAYER), true);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 1.2, 5), new THREE.Vector3(0, 0, -1));
  assert.equal(pickAgent(raycaster, [{ id: 'f0', object: figure.group }]), 'f0');
});

test('a part attached after the first sync (a hat marked as a figure part) joins the batch on the next sync', () => {
  const scene = new THREE.Scene();
  const all = figures(scene, [RED, RED]);
  const batch = new FigureBatch(scene);
  const roots = all.map((figure) => figure.group);
  scene.updateMatrixWorld();
  batch.sync(roots);
  const before = countDrawCalls(scene).main;

  const cone = new THREE.ConeGeometry(0.1, 0.2);
  const material = new THREE.MeshBasicMaterial();
  for (const figure of all) {
    const hat = new THREE.Mesh(cone, material);
    hat.userData.figurePart = true;
    figure.joints.head.add(hat);
  }
  scene.updateMatrixWorld();
  assert.equal(batch.sync(roots).changed, true);
  assert.equal(countDrawCalls(scene).main, before + 1);
  assert.equal(batch.meshes.find((mesh) => mesh.geometry === cone)!.count, 2);
});

test('a still figure far from the origin is not reported as moved (float32 instance matrices)', () => {
  const scene = new THREE.Scene();
  const [figure] = figures(scene, [RED]);
  figure.group.position.set(37.3, 0, -45.1);
  figure.group.rotation.y = 0.7;
  const batch = new FigureBatch(scene);
  scene.updateMatrixWorld();
  batch.sync([figure.group]);
  scene.updateMatrixWorld();
  assert.deepEqual(batch.sync([figure.group]).moved, []);
});

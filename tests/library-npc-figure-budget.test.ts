import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time; labels need a document.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
const { StickFigure } = await import('../src/characters/StickFigure.js');
const { FigureBatch } = await import('../src/characters/FigureBatch.js');
const { countDrawCalls } = await import('../src/scene/RenderBudget.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

/**
 * The librarian NPC (issue #248) draws through the exact same shared figure batch real agents
 * do (`main.ts`'s own `figures()` callback now includes every extension's `npcFigures()`), so
 * his own marginal cost is bounded by however many NEW part shapes/colors he adds to the
 * batch's own buckets — head, hand, foot, arm, leg, eyes and mouth are shared across every
 * figure regardless of its own accent color (`tests/figure-batch.test.ts`'s own finding); only
 * the torso's own tint and (if his own hair style is not already in use) one hair bucket are
 * ever genuinely new. Measured here against a handful of differently-colored stand-in agents
 * (a realistic office, not an empty one): 2 new draw calls, comfortably inside the 430 budget's
 * current 6-call headroom (`npm run measure`, 424/430) — a change to `StickFigure`'s own shared
 * part geometries, not this NPC's own fault, would be the only way this number moves.
 */
test('the librarian NPC, synced through the shared figure batch alongside real agents, adds only a couple of new draw calls (his own torso tint and hair bucket), never one per body part', () => {
  const scene = new THREE.Scene();
  const colors = [0xe05050, 0x5070e0, 0x50c080, 0xd0a030, 0xa050d0];
  const agents = colors.map((color, i) => {
    const figure = new StickFigure(`agent${i}`, new THREE.Color(color));
    figure.group.position.set(i * 2, 0, 0);
    scene.add(figure.group);
    return figure;
  });
  scene.updateMatrixWorld();
  const batch = new FigureBatch(scene);
  batch.sync(agents.map((figure) => figure.group));
  scene.updateMatrixWorld();
  const before = countDrawCalls(scene).main;

  const npc = new StickFigure('Prospero', new THREE.Color(0x5a4a3a));
  npc.group.position.set(20, 0, 0);
  scene.add(npc.group);
  scene.updateMatrixWorld();
  batch.sync([...agents.map((figure) => figure.group), npc.group]);
  scene.updateMatrixWorld();
  const after = countDrawCalls(scene).main;

  assert.equal(after - before, 2, 'the NPC only ever adds his own torso-color and hair buckets, never a per-body-part cost');
});

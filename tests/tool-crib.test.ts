import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { createOffice } = await import('../src/scene/Office.js');
const { createToolCrib } = await import('../src/furniture/ToolCrib.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

/** Issue #167 addendum: "a new object... very small thing... just do it", no trip mechanic this round. */
test('the hall has one tool crib, with no shadow on any of its meshes (a small static prop, same rationale as a hat)', () => {
  const scene = new THREE.Scene();
  createOffice(scene);
  const hall = scene.getObjectByName('hall')!;
  const crib = hall.getObjectByName('tool-crib')!;
  assert.ok(crib, 'expected one tool crib in the hall');
  let meshCount = 0;
  crib.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      meshCount++;
      assert.equal(object.castShadow, false, 'a crib piece casts no shadow, same as a hat');
      assert.equal(object.userData.figurePart, undefined, 'the crib is static furniture, not a per-agent figure part');
    }
  });
  assert.ok(meshCount > 0, 'expected at least one mesh');
});

test('createToolCrib returns a fresh group each call, never a shared instance', () => {
  assert.notEqual(createToolCrib(), createToolCrib());
});

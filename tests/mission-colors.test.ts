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
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { FigureBatch } = await import('../src/characters/FigureBatch.js');
const { Colors } = await import('../src/utils/Colors.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

/**
 * Issue #125 part 3: every agent and subagent of a mission wears that mission's own
 * pair of colors (from `Colors.accents`, never orange), seeded by the mission's own
 * room id, so a reload picks the same pair. The second color (hands) must cost no
 * extra draw call: it is a per-instance tint on the figure batch, not a new material.
 */

function managerWithLayout(scene: THREE.Scene): InstanceType<typeof AgentManager> {
  return new AgentManager(scene, new Map());
}

test('the same mission id always picks the same color pair', () => {
  const scene = new THREE.Scene();
  const manager = managerWithLayout(scene);
  const a1 = manager.addAgent({ id: 'a1', name: 'a1', activity: 'implementing', extras: { room: 'mission-x' } });
  const a2 = manager.addAgent({ id: 'a2', name: 'a2', activity: 'researching', extras: { room: 'mission-x' } });
  assert.ok(a1.accentColor.equals(a2.accentColor), 'same mission, same body color');
  assert.ok((a1.joints.leftHand.userData.tint as THREE.Color).equals(a2.joints.leftHand.userData.tint as THREE.Color), 'same mission, same hand tint');
});

test('two different missions are not forced into the same pair', () => {
  const scene = new THREE.Scene();
  const manager = managerWithLayout(scene);
  const a1 = manager.addAgent({ id: 'a1', name: 'a1', activity: 'implementing', extras: { room: 'mission-one' } });
  const a2 = manager.addAgent({ id: 'a2', name: 'a2', activity: 'implementing', extras: { room: 'mission-two' } });
  assert.ok(!a1.accentColor.equals(a2.accentColor) || !(a1.joints.leftHand.userData.tint as THREE.Color).equals(a2.joints.leftHand.userData.tint as THREE.Color));
});

test('no mission ever wears orange: that color already means "waits for you"', () => {
  const scene = new THREE.Scene();
  const manager = managerWithLayout(scene);
  const orange = Colors.accents[6];
  for (let i = 0; i < 30; i++) {
    const figure = manager.addAgent({ id: `a${i}`, name: `a${i}`, activity: 'implementing', extras: { room: `mission-${i}` } });
    assert.ok(!figure.accentColor.equals(orange), `mission-${i} body is orange`);
    // The tint is a ratio to skin, not the raw accent color; recover it by multiplying back
    const tint = figure.joints.leftHand.userData.tint as THREE.Color;
    const hand = new THREE.Color(tint.r * Colors.skin.r, tint.g * Colors.skin.g, tint.b * Colors.skin.b);
    assert.ok(!hand.equals(orange), `mission-${i} hand is orange`);
  }
});

test('a subagent of a mission agent wears the same mission pair, not its own id\'s color', () => {
  const scene = new THREE.Scene();
  const manager = managerWithLayout(scene);
  const parent = manager.addAgent({ id: 'p', name: 'p', activity: 'implementing', extras: { room: 'mission-sub' } });
  const sub = manager.addAgent({ id: 's', name: 's', activity: 'researching', extras: { room: 'mission-sub', parentId: 'p' } });
  assert.ok(parent.accentColor.equals(sub.accentColor));
  assert.ok((parent.joints.leftHand.userData.tint as THREE.Color).equals(sub.joints.leftHand.userData.tint as THREE.Color));
});

test('an agent with no mission room keeps the old per-agent-id color, with plain skin hands', () => {
  const scene = new THREE.Scene();
  const manager = managerWithLayout(scene);
  const figure = manager.addAgent({ id: 'lone', name: 'lone', activity: 'implementing' });
  assert.equal(figure.joints.leftHand.userData.tint, undefined, 'no tint: plain skin');
});

// --- Issue #125 part 3 review round 2: a mission's own enricher can attach `roomKey` to an
// agent's extras after it already exists, not only at its first appearance ---

test('a figure joining a mission after it already exists still takes that mission\'s colors', () => {
  const scene = new THREE.Scene();
  const manager = managerWithLayout(scene);
  const figure = manager.addAgent({ id: 'a', name: 'a', activity: 'implementing' });
  const beforeAccent = figure.accentColor.clone();
  assert.equal(figure.joints.leftHand.userData.tint, undefined, 'no mission yet: plain skin hands');

  manager.setExtras('a', { room: 'mission-late' });
  assert.ok(!figure.accentColor.equals(beforeAccent), 'picks up the mission\'s body color, not its old per-id one');
  assert.notEqual(figure.joints.leftHand.userData.tint, undefined, 'picks up a hand tint too, not plain skin anymore');
});

test('a figure moving from one mission to another with the same body color still gets the new hand color (review round 3)', () => {
  // `mission-tint-5` and `mission-tint-7` hash to palette pairs that share the first
  // (body) color and differ only on the second (hand): a guard that compares only the
  // body color would wrongly treat the second as a no-op.
  const scene = new THREE.Scene();
  const manager = managerWithLayout(scene);
  const figure = manager.addAgent({ id: 'a', name: 'a', activity: 'implementing', extras: { room: 'mission-tint-5' } });
  const bodyBefore = figure.accentColor.clone();
  const tintBefore = figure.joints.leftHand.userData.tint?.clone();
  assert.ok(tintBefore, 'has a hand tint from the first mission');

  manager.setExtras('a', { room: 'mission-tint-7' });
  assert.ok(figure.accentColor.equals(bodyBefore), 'the two missions share the same body color');
  assert.ok(!figure.joints.leftHand.userData.tint.equals(tintBefore), 'the hand color still changed, even though the body one did not');
});

test('a mission hand color costs no extra draw call: one hand bucket for every mission in the room', () => {
  const scene = new THREE.Scene();
  const manager = managerWithLayout(scene);
  // Five different missions, each with a different color pair (by id hash), all in view at once
  for (let i = 0; i < 5; i++) {
    manager.addAgent({ id: `a${i}`, name: `a${i}`, activity: 'implementing', extras: { room: `mission-${i}` } });
  }
  scene.updateMatrixWorld();
  const batch = new FigureBatch(scene);
  const figures = manager.getAgents().map((managed) => managed.figure);
  batch.sync(figures.map((figure) => figure.group));
  const handBuckets = batch.meshes.filter((mesh) => mesh.geometry === figures[0].joints.leftHand.geometry);
  assert.equal(handBuckets.length, 1, 'every hand, whatever its mission tint, shares one bucket');
});

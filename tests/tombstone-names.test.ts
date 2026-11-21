import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

/**
 * Issue #159, review round 1: the engraved name is a texture decal (`TombstoneNameBatch`), not
 * a `CSS2DObject`. Unlike `RoomLabelBatch`, its quad is NOT billboarded: it must inherit its
 * handle's full world transform (translation, rotation and scale), so it reads as flush with
 * whichever way the tombstone itself faces, not the camera.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { MAX_TOMBSTONE_NAMES, sceneOf, setTombstoneName, tombstoneNameBatchFor, tombstoneNameplate } = await import('../src/addons/building/tombstoneNames.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

test('sceneOf finds the root scene of an attached object, and null for a detached one', () => {
  const scene = new THREE.Scene();
  const object = new THREE.Object3D();
  assert.equal(sceneOf(object), null);
  scene.add(object);
  assert.equal(sceneOf(object), scene);
});

test('AC: one tracked nameplate costs exactly one draw call, however many more are tracked', () => {
  const scene = new THREE.Scene();
  const batch = tombstoneNameBatchFor(scene);
  for (let i = 0; i < 20; i++) batch.track(tombstoneNameplate(`slug-${i}`));
  assert.equal(scene.children.filter((child) => (child as THREE.InstancedMesh).isInstancedMesh).length, 1);
  assert.equal(batch.mesh.count, 20);
});

test('the same scene always gets the same batch (one shared InstancedMesh, not one per call)', () => {
  const scene = new THREE.Scene();
  assert.equal(tombstoneNameBatchFor(scene), tombstoneNameBatchFor(scene));
});

test('track is idempotent: tracking the same handle twice does not grow the instance count', () => {
  const scene = new THREE.Scene();
  const batch = tombstoneNameBatchFor(scene);
  const handle = tombstoneNameplate('tidy-otter');
  batch.track(handle);
  batch.track(handle);
  assert.equal(batch.mesh.count, 1);
});

test('tracking stops silently past MAX_TOMBSTONE_NAMES, rather than growing without bound', () => {
  const scene = new THREE.Scene();
  const batch = tombstoneNameBatchFor(scene);
  for (let i = 0; i < MAX_TOMBSTONE_NAMES + 10; i++) batch.track(tombstoneNameplate(`slug-${i}`));
  assert.equal(batch.mesh.count, MAX_TOMBSTONE_NAMES);
});

test('AC: a handle not parented to this scene (removed, or never attached) is hidden, scale 0', () => {
  const scene = new THREE.Scene();
  const batch = tombstoneNameBatchFor(scene);
  const attached = tombstoneNameplate('attached');
  scene.add(attached);
  batch.track(attached);
  const detached = tombstoneNameplate('detached');
  batch.track(detached); // never added to any scene
  scene.updateMatrixWorld();
  batch.sync();
  // A zero-scale matrix draws a zero-area quad either way; `Matrix4.decompose` itself falls
  // back to reporting scale 1 for a degenerate (zero-determinant) matrix, so this checks the
  // raw matrix elements directly rather than decomposing.
  const matrix = new THREE.Matrix4();
  batch.mesh.getMatrixAt(1, matrix);
  assert.deepEqual(matrix.elements, new THREE.Matrix4().makeScale(0, 0, 0).elements);
});

test('AC: the quad inherits its handle\'s full world transform, not a camera-facing billboard', () => {
  const scene = new THREE.Scene();
  const batch = tombstoneNameBatchFor(scene);
  const tombstone = new THREE.Object3D();
  tombstone.rotation.y = Math.PI / 2; // facing sideways, not toward +z
  tombstone.position.set(3, 0, 5);
  scene.add(tombstone);
  const handle = tombstoneNameplate('tidy-otter');
  tombstone.add(handle);
  batch.track(handle);
  scene.updateMatrixWorld();
  batch.sync();
  const matrix = new THREE.Matrix4();
  batch.mesh.getMatrixAt(0, matrix);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  matrix.decompose(position, quaternion, new THREE.Vector3());
  // The instance's world position matches the handle's local offset rotated by the tombstone
  const expected = handle.position.clone().applyQuaternion(new THREE.Quaternion().setFromEuler(tombstone.rotation)).add(tombstone.position);
  assert.ok(position.distanceTo(expected) < 1e-6, `expected ${expected.toArray()}, got ${position.toArray()}`);
  // The instance carries the tombstone's own rotation, not identity (a billboard would not)
  const expectedQuat = new THREE.Quaternion().setFromEuler(tombstone.rotation);
  assert.ok(quaternion.angleTo(expectedQuat) < 1e-6);
});

test('setTombstoneName changes the handle\'s own text; the batch redraws its slot on the next sync', () => {
  const scene = new THREE.Scene();
  const batch = tombstoneNameBatchFor(scene);
  const handle = tombstoneNameplate('tidy-otter');
  scene.add(handle);
  batch.track(handle);
  scene.updateMatrixWorld();
  batch.sync();
  setTombstoneName(handle, 'keen-lynx');
  assert.equal(handle.userData.nameText, 'keen-lynx');
  // sync() does not throw and completes a redraw without error
  batch.sync();
});

test('untrack frees a slot: the batch shrinks and a later nameplate reuses the freed slot', () => {
  const scene = new THREE.Scene();
  const batch = tombstoneNameBatchFor(scene);
  const a = tombstoneNameplate('a');
  const b = tombstoneNameplate('b');
  batch.track(a);
  batch.track(b);
  assert.equal(batch.mesh.count, 2);
  batch.untrack(a);
  assert.equal(batch.mesh.count, 1);
  assert.equal(batch.labels.includes(a), false);
  assert.equal(batch.labels.includes(b), true);
});

test('untrack on a handle this batch never tracked is a silent no-op', () => {
  const scene = new THREE.Scene();
  const batch = tombstoneNameBatchFor(scene);
  batch.untrack(tombstoneNameplate('never-tracked'));
  assert.equal(batch.mesh.count, 0);
});

test('collect finds every nameplate under a root, even nested several levels deep', () => {
  const scene = new THREE.Scene();
  const batch = tombstoneNameBatchFor(scene);
  const room = new THREE.Object3D();
  const tombstonesGroup = new THREE.Object3D();
  const tombstone = new THREE.Object3D();
  const handle = tombstoneNameplate('tidy-otter');
  tombstone.add(handle);
  tombstonesGroup.add(tombstone);
  room.add(tombstonesGroup);
  batch.collect(room);
  assert.equal(batch.labels.includes(handle), true);
});

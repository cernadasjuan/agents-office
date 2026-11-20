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
const { StaticBatch, STATIC_SOURCE_LAYER, markStatic } = await import('../src/scene/StaticMerge.js');
const { getToonMaterial } = await import('../src/utils/Materials.js');
const { countDrawCalls } = await import('../src/scene/RenderBudget.js');
const { createOffice } = await import('../src/scene/Office.js');
const { BuildingLayout } = await import('../src/addons/building/BuildingLayout.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const wood = () => getToonMaterial(0x8b6b4a);
const metal = () => getToonMaterial(0x555555);

function box(material: THREE.Material, x: number, castShadow = true): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.position.set(x, 0.5, 0);
  mesh.castShadow = castShadow;
  return mesh;
}

function worldBox(object: THREE.Object3D): THREE.Box3 {
  object.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(object);
}

test('a static root draws one mesh per material, in the same place, and its sources leave the camera layer', () => {
  const scene = new THREE.Scene();
  const room = new THREE.Group();
  room.position.set(10, 0, 5);
  room.rotation.y = Math.PI / 2;
  const sources = [box(wood(), 0), box(wood(), 2), box(metal(), 4)];
  room.add(...sources);
  markStatic(room, { zone: 'rooms' });
  scene.add(room);
  const expected = worldBox(room);
  assert.equal(countDrawCalls(scene).main, 3);

  new StaticBatch(scene).update();

  assert.equal(countDrawCalls(scene).main, 2);
  for (const source of sources) assert.equal(source.layers.isEnabled(STATIC_SOURCE_LAYER) && !source.layers.isEnabled(0), true);
  const merged = scene.getObjectByName('static-batch-rooms')!;
  const drawn = new THREE.Box3();
  merged.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) drawn.union(worldBox(object));
  });
  assert.ok(drawn.min.distanceTo(expected.min) < 1e-5 && drawn.max.distanceTo(expected.max) < 1e-5, 'merged geometry sits where the furniture was');
});

test('boards, transparent, hidden, overview-hidden and dynamic meshes keep their own draw call', () => {
  const scene = new THREE.Scene();
  const room = new THREE.Group();
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.Texture() }));
  const glass = box(new THREE.MeshToonMaterial({ transparent: true, opacity: 0.5 }), 1);
  const hidden = box(wood(), 2);
  hidden.visible = false;
  const wall = box(wood(), 3);
  wall.userData.overviewHidden = true;
  const door = new THREE.Group();
  door.userData.dynamic = true;
  const doorPanel = box(wood(), 4);
  door.add(doorPanel);
  const chair = box(wood(), 5);
  room.add(board, glass, hidden, wall, door, chair);
  markStatic(room, { zone: 'rooms' });
  scene.add(room);

  new StaticBatch(scene).update();

  for (const mesh of [board, glass, hidden, wall, doorPanel]) assert.equal(mesh.layers.isEnabled(0), true, `${mesh.uuid} still draws itself`);
  assert.equal(chair.layers.isEnabled(0), false);
});

test('a batch rebuilds when a mesh is added, removed or hidden, and not otherwise', () => {
  const scene = new THREE.Scene();
  const room = new THREE.Group();
  markStatic(room, { zone: 'rooms' });
  const first = box(wood(), 0);
  room.add(first);
  scene.add(room);
  const batch = new StaticBatch(scene);
  assert.equal(batch.update(), true);
  assert.equal(batch.update(), false);

  const second = box(wood(), 2);
  room.add(second);
  assert.equal(batch.update(), true);
  assert.equal(batch.mergedMeshes[0].geometry.attributes.position.count, 48);

  second.visible = false;
  assert.equal(batch.update(), true);
  assert.equal(second.layers.isEnabled(0), true, 'a hidden mesh leaves the merge and keeps its own visibility');
  assert.equal(batch.mergedMeshes[0].geometry.attributes.position.count, 24);

  room.remove(first);
  assert.equal(batch.update(), true);
  assert.equal(batch.mergedMeshes.length, 0);
});

test('a root without a zone merges in place and follows its own visibility (lamps in the overview)', () => {
  const scene = new THREE.Scene();
  const lamp = new THREE.Group();
  lamp.userData.overviewHidden = true;
  lamp.add(box(metal(), 0), box(metal(), 1));
  markStatic(lamp);
  scene.add(lamp);

  new StaticBatch(scene).update();
  assert.equal(countDrawCalls(scene).main, 1);
  assert.equal(lamp.children.filter((child) => child.name === 'static-merged').length, 1);

  lamp.visible = false;
  assert.equal(countDrawCalls(scene).main, 0);
});

test('a zone that casts no shadow merges into meshes that cast none; receive flags stay', () => {
  const scene = new THREE.Scene();
  const room = new THREE.Group();
  const floor = box(wood(), 0, false);
  floor.receiveShadow = true;
  room.add(floor, box(wood(), 1, true));
  markStatic(room, { zone: 'rooms', castShadow: false });
  scene.add(room);

  const batch = new StaticBatch(scene);
  batch.update();

  assert.equal(batch.mergedMeshes.some((mesh) => mesh.castShadow), false);
  assert.equal(batch.mergedMeshes.filter((mesh) => mesh.receiveShadow).length, 1);
});

test('the building still opens room walls by name after the merge, and the new room draws', () => {
  const scene = new THREE.Scene();
  const rooms = Array.from({ length: 7 }, () => 'lounge');
  const store = new Map([['agents-office.building.rooms', JSON.stringify(rooms)]]);
  const layout = new BuildingLayout(scene, createOffice(scene), {
    storage: { getItem: (key: string) => store.get(key) ?? null, setItem: () => undefined },
  });
  const batch = new StaticBatch(scene);
  batch.update();
  const roomCount = layout.roomKinds.length;

  // Fill every hall desk first: the shared pool (#138) means a workspace session only rents a room once those are gone
  for (let i = 0; i < 8; i++) layout.seatFor({ id: `s${i}`, activity: 'implementing' }, null);
  const before = batch.mergedMeshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);

  // One more session rents a desk room: the ninth room opens a door in the room inside it
  layout.seatFor({ id: 'a', activity: 'implementing', extras: { group: { id: 'g', label: 'ws' } } }, null);
  assert.equal(layout.roomKinds.length, roomCount + 1, 'a ring-1 room was added');
  assert.equal(batch.update(), true);
  const afterCount = batch.mergedMeshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
  assert.ok(afterCount > before, 'the new room draws');
  assert.equal(batch.update(), false);
});

test('the overview hiding walls and lamps does not rebuild a batch', () => {
  const scene = new THREE.Scene();
  const hall = new THREE.Group();
  const nearWall = box(wood(), 0);
  nearWall.userData.overviewHidden = true;
  hall.add(nearWall, box(wood(), 1));
  markStatic(hall, { zone: 'hall' });
  const lamp = new THREE.Group();
  lamp.userData.overviewHidden = true;
  lamp.add(box(metal(), 3));
  markStatic(lamp);
  scene.add(hall, lamp);
  const batch = new StaticBatch(scene);
  batch.update();

  nearWall.visible = false;
  lamp.visible = false;
  assert.equal(batch.update(), false);
  assert.equal(countDrawCalls(scene).main, 1);
});

test('a source that changes its material rebuilds its batch with the new material', () => {
  const scene = new THREE.Scene();
  const room = new THREE.Group();
  markStatic(room);
  const floor = box(wood(), 0);
  room.add(floor, box(wood(), 2));
  scene.add(room);
  scene.updateMatrixWorld();
  const statics = new StaticBatch(scene);
  statics.update();
  floor.material = metal();
  assert.equal(statics.update(), true);
  assert.deepEqual(new Set(statics.mergedMeshes.map((mesh) => mesh.material)), new Set([wood(), metal()]));
});

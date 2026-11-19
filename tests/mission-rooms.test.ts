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
const { buildMissionRoom } = await import('../src/addons/building/missionRooms.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const room = (id: string, state: 'open' | 'locked') => ({
  id, kind: 'mission' as const, title: id, state, walls: { statement: 'x', docs: [], issues: [], kanban: [] },
});

function floorColor(group: THREE.Object3D): number {
  const floor = group.children.find((child) => child.userData.floor) as THREE.Mesh;
  return (floor.material as THREE.MeshToonMaterial).color.getHex();
}

test('one locked mission room darkens only its own floor', () => {
  const open = buildMissionRoom(room('a', 'open'), 0);
  const locked = buildMissionRoom(room('b', 'open'), 1);
  open.update(room('a', 'open'));
  const openColor = floorColor(open.group);
  locked.update(room('b', 'locked'));
  assert.notEqual(floorColor(locked.group), openColor);
  assert.equal(floorColor(open.group), openColor);
  locked.update(room('b', 'open'));
  assert.equal(floorColor(locked.group), openColor);
});

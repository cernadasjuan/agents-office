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
const { buildMissionRoom, MAX_TOMBSTONES } = await import('../src/addons/building/missionRooms.js');
const { MAX_DESK_SLOTS } = await import('../src/addons/building/warRoomFurnishing.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const room = (id: string, state: 'open' | 'locked', sleepers: Array<{ id: string; endedAt?: string }> = []) => ({
  id, kind: 'mission' as const, title: id, state, sleepers, walls: { statement: 'x', docs: [], issues: [], kanban: [] },
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

// --- Issue #127: beds become small tombstones, identifiable and resurrectable ---

test('AC1: an ended session appears as a tombstone, pickable by id', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1', endedAt: '2026-11-18' }]));
  const targets = missionRoom.tombstonePickTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, 'tomb-1');
  assert.ok(targets[0].object instanceof THREE.Object3D);
});

test('AC2: a session that returns removes its own tombstone by id, leaving the others in place', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1' }, { id: 'tomb-2' }, { id: 'tomb-3' }]));
  const before = new Map(missionRoom.tombstonePickTargets().map((t) => [t.id, t.object]));
  assert.equal(before.size, 3);
  // tomb-2's session returns: its entry leaves the list, the other two stay (not "trim the oldest")
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1' }, { id: 'tomb-3' }]));
  const after = new Map(missionRoom.tombstonePickTargets().map((t) => [t.id, t.object]));
  assert.deepEqual([...after.keys()].sort(), ['tomb-1', 'tomb-3']);
  // The surviving tombstones are the very same objects, not rebuilt
  assert.equal(after.get('tomb-1'), before.get('tomb-1'));
  assert.equal(after.get('tomb-3'), before.get('tomb-3'));
});

test('AC3: a tombstone carries which session it was and when it ended', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1', endedAt: '2026-11-18' }]));
  let hoverSign: THREE.Object3D | undefined;
  missionRoom.group.traverse((o) => { if (o.userData.detailSign?.hoverOnly && /Ended/.test((o as { element?: HTMLElement }).element?.textContent ?? '')) hoverSign = o; });
  assert.ok(hoverSign, 'a hover-only sign names the end date, not an always-on label');
  assert.match((hoverSign as unknown as { element: HTMLElement }).element.textContent ?? '', /2026-11-18/);
});

test('AC4: beyond the cap, the existing "N not shown" sign logic carries over', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  const sleepers = Array.from({ length: MAX_TOMBSTONES + 5 }, (_, i) => ({ id: `tomb-${i}` }));
  missionRoom.update(room('a', 'open', sleepers));
  assert.equal(missionRoom.tombstonePickTargets().length, MAX_TOMBSTONES, 'only the cap renders');
  let countSign: THREE.Object3D | undefined;
  missionRoom.group.traverse((o) => { if (/past session/.test((o as { element?: HTMLElement }).element?.textContent ?? '')) countSign = o; });
  assert.match((countSign as unknown as { element: HTMLElement })?.element.textContent ?? '', /\(\+5 not shown\)/);
});

test('every tombstone keeps the same merged toon material: a room full of them still draws cheap', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  const sleepers = Array.from({ length: MAX_TOMBSTONES }, (_, i) => ({ id: `tomb-${i}` }));
  missionRoom.update(room('a', 'open', sleepers));
  const materials = new Set<THREE.Material>();
  for (const { object } of missionRoom.tombstonePickTargets()) {
    object.traverse((child) => { if ((child as THREE.Mesh).isMesh) materials.add((child as THREE.Mesh).material as THREE.Material); });
  }
  // 2 materials (slab, stone) shared by every tombstone, not one fresh material per instance
  assert.equal(materials.size, 2);
});

// --- Issue #125: war-room furnishing package ---

test('AC1: a new war room has its must-have furniture from the start, built from the library', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  const names: string[] = [];
  missionRoom.group.traverse((o) => { if (typeof o.userData.piece === 'string') names.push(o.userData.piece); });
  for (const must of ['clock', 'whiteboard', 'bookshelf', 'sofa', 'lowTable']) assert.ok(names.includes(must), `missing ${must}`);
});

test('desk-like furniture grows with the peak live count and never shrinks back', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  const countOf = (name: string) => {
    let n = 0;
    missionRoom.group.traverse((o) => { if (o.userData.piece === name) n++; });
    return n;
  };
  assert.equal(countOf('desk') + countOf('debugStation'), 0, 'no agents yet, no desks');

  missionRoom.updateCounts({ deskLike: 3, debugging: 1 });
  assert.equal(countOf('desk'), 3);
  assert.equal(countOf('debugStation'), 1);

  // The room empties out: furniture stays at its peak, it does not shrink back
  missionRoom.updateCounts({ deskLike: 0, debugging: 0 });
  assert.equal(countOf('desk'), 3);
  assert.equal(countOf('debugStation'), 1);

  // A later, bigger peak grows it further
  missionRoom.updateCounts({ deskLike: 6, debugging: 2 });
  assert.equal(countOf('desk'), 6);
  assert.equal(countOf('debugStation'), 2);
});

test('the desk grid never exceeds the room\'s physical fit', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.updateCounts({ deskLike: 20, debugging: 5 });
  let total = 0;
  missionRoom.group.traverse((o) => { if (o.userData.piece === 'desk' || o.userData.piece === 'debugStation') total++; });
  assert.equal(total, MAX_DESK_SLOTS);
});

test('a peak that does not grow rebuilds nothing: the same furniture objects stay in the scene', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.updateCounts({ deskLike: 3, debugging: 0 });
  const before: THREE.Object3D[] = [];
  missionRoom.group.traverse((o) => { if (o.userData.piece === 'desk') before.push(o); });
  missionRoom.updateCounts({ deskLike: 2, debugging: 0 }); // smaller: no growth, no rebuild
  const after: THREE.Object3D[] = [];
  missionRoom.group.traverse((o) => { if (o.userData.piece === 'desk') after.push(o); });
  assert.deepEqual(after, before);
});

test('AC5: every war-room rule-set piece is named after a factory in the furniture library, not inline geometry', async () => {
  const { PIECES } = await import('../src/furniture/index.js');
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.updateCounts({ deskLike: 6, debugging: 2 });
  const names: string[] = [];
  missionRoom.group.traverse((o) => { if (typeof o.userData.piece === 'string') names.push(o.userData.piece); });
  assert.ok(names.length > 0, 'the plan actually placed pieces');
  for (const name of names) assert.ok(name in PIECES, `${name} is not a furniture library piece`);
});

// --- Issue #124: mission signs move off the door frame ---

test('AC124: the title and lock signs sit on the far wall, not near the door', async () => {
  const { missionSlot } = await import('../src/addons/building/missionRooms.js');
  const { RoomFrame } = await import('../src/addons/building/rooms.js');
  const { ROOM_SIZE: SIZE } = await import('../src/addons/building/RoomPlanner.js');
  const missionRoom = buildMissionRoom(room('a', 'locked'), 0);
  const slot = missionSlot(0);
  const frame = new RoomFrame(slot.rect, slot.door);
  const doorPoint = frame.point(0, 0);
  const farWallPoint = frame.point(0, SIZE);

  const signs: THREE.Object3D[] = [];
  missionRoom.group.traverse((o) => { if ((o as { element?: HTMLElement }).element) signs.push(o); });
  const title = signs.find((o) => /^a$/.test((o as { element?: HTMLElement }).element?.textContent ?? ''));
  const lock = signs.find((o) => /Locked/.test((o as { element?: HTMLElement }).element?.textContent ?? ''));
  assert.ok(title && lock, 'both signs exist');
  for (const sign of [title!, lock!]) {
    const toDoor = sign.position.distanceTo(doorPoint);
    const toFarWall = sign.position.distanceTo(farWallPoint);
    assert.ok(toFarWall < toDoor, `sign at ${sign.position.toArray()} is nearer the far wall than the door`);
  }
});

// --- Issue #146: a click on the issue board opens the real-link list ---

test('the issue board is pickable, and its pick id points at this room', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  const target = missionRoom.issuesBoardPickTarget();
  assert.equal(target.id, 'issues:a');
  assert.ok(target.object instanceof THREE.Object3D);
});

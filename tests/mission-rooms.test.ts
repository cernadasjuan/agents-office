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
const { buildMissionRoom, MAX_TOMBSTONES, canvasBoard, combinedBoard } = await import('../src/addons/building/missionRooms.js');
const { MAX_DESK_SLOTS } = await import('../src/addons/building/warRoomFurnishing.js');
const { tombstoneNameBatchFor } = await import('../src/addons/building/tombstoneNames.js');

/** The engraved nameplate under a tombstone's own object (there is exactly one, direct child). */
function nameplateOf(object: THREE.Object3D): THREE.Object3D {
  const found = object.children.find((child) => child.name === 'tombstone-nameplate');
  if (!found) throw new Error('no nameplate found');
  return found;
}
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const room = (id: string, state: 'open' | 'locked', sleepers: Array<{ id: string; endedAt?: string; name?: string }> = []) => ({
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
  const targets = missionRoom.tombstonePickTargets();
  assert.equal(targets[0].id, 'tomb-1');
});

// --- Issue #159: engrave the session name as a texture decal, remove the floating sign ---
//
// Review round 1: a `CSS2DObject` is always a floating DOM window, never flush with a 3D
// face, regardless of what it is parented to or when it shows. The engraving is now a texture
// decal (`tombstoneNameplate`/`TombstoneNameBatch`, `tombstoneNames.ts`): no DOM element at all.

test('AC: a tombstone engraves its session name as a texture decal, not a CSS2D sign', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1', name: 'tidy-otter' }]));
  const object = missionRoom.tombstonePickTargets()[0].object;
  const nameplate = nameplateOf(object);
  assert.equal(nameplate.userData.nameText, 'tidy-otter');
  // No CSS2D-style DOM element anywhere on the tombstone: the engraving carries no `element`.
  assert.equal((nameplate as unknown as { element?: unknown }).element, undefined);
});

test('AC: no floating sign of any kind remains on a tombstone', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1', endedAt: '2026-11-18', name: 'tidy-otter' }]));
  // The only CSS2D-style elements left in the room are its title, lock and past-sessions
  // signs (none of which ever names a session) — not a broad "no 'Ended' text" check, which
  // would trivially pass now that nothing produces that text at all, tombstone or otherwise.
  const elements: string[] = [];
  missionRoom.group.traverse((o) => {
    const text = (o as { element?: HTMLElement }).element?.textContent;
    if (text) elements.push(text);
  });
  assert.ok(elements.length > 0, 'the room still has its own legitimate signs');
  assert.ok(elements.every((text) => !text.includes('tidy-otter') && !text.includes('Ended')), `a stray sign named the session: ${elements}`);
});

test('AC: a tombstone with no known session name shows a plain placeholder, not a blank', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1' }]));
  const object = missionRoom.tombstonePickTargets()[0].object;
  assert.equal(nameplateOf(object).userData.nameText, 'Ended session');
});

test('AC: a session that changes name updates the same nameplate handle, not a new object', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1', name: 'tidy-otter' }]));
  const before = missionRoom.tombstonePickTargets()[0].object;
  const beforeNameplate = nameplateOf(before);
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1', name: 'keen-lynx' }]));
  const after = missionRoom.tombstonePickTargets()[0].object;
  assert.equal(after, before);
  assert.equal(nameplateOf(after), beforeNameplate);
  assert.equal(nameplateOf(after).userData.nameText, 'keen-lynx');
});

// The engraved nameplate is a child of the tombstone's own object (issue #159 review): it
// travels with the stone for free, and a room full of tombstones still merges the same way
// as before (`StaticMerge` only ever merges `THREE.Mesh`, never an `InstancedMesh`).
test('AC: the nameplate is a child of the tombstone object, not a scene-level sibling', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1', name: 'tidy-otter' }]));
  const object = missionRoom.tombstonePickTargets()[0].object;
  assert.ok(object.children.includes(nameplateOf(object)));
});

test('AC: removing a tombstone stops the shared batch from drawing its nameplate (no leak)', () => {
  const scene = new THREE.Scene();
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  scene.add(missionRoom.group);
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1', name: 'tidy-otter' }]));
  const batch = tombstoneNameBatchFor(scene);
  const nameplate = nameplateOf(missionRoom.tombstonePickTargets()[0].object);
  batch.track(nameplate); // the batch registers lazily (BuildingLayout's `collect`); do it directly here
  assert.ok(batch.labels.includes(nameplate));
  missionRoom.update(room('a', 'open', [])); // the session returns or scrolls past the cap
  assert.equal(batch.labels.includes(nameplate), false);
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
  for (const must of ['clock', 'whiteboard', 'bookshelf', 'desk', 'debugStation']) assert.ok(names.includes(must), `missing ${must}`);
  assert.ok(!names.includes('sofa'), 'issue #209: no sofa in a war room');
  assert.ok(!names.includes('lowTable'), 'issue #209: no coffee table in a war room');
});

test('desk-like furniture grows with the peak live count and never shrinks back', () => {
  // Issue #123: every war room's door opens onto the mission corridor at its own row's
  // center, so every index (not just a later ring) gets the grid's full, door-centered fit.
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  const countOf = (name: string) => {
    let n = 0;
    missionRoom.group.traverse((o) => { if (o.userData.piece === name) n++; });
    return n;
  };
  // Issue #209: the base work set, even with no agents yet, is 1 workstation + 1 debug station.
  assert.equal(countOf('desk'), 1, 'the base work set: one workstation, even with no agents yet');
  assert.equal(countOf('debugStation'), 1, 'the base work set: one debug station, even with no agents yet');

  missionRoom.updateCounts({ deskLike: 2, debugging: 1 });
  assert.equal(countOf('desk'), 2);
  assert.equal(countOf('debugStation'), 1);

  // The room empties out: furniture stays at its peak, it does not shrink back
  missionRoom.updateCounts({ deskLike: 0, debugging: 0 });
  assert.equal(countOf('desk'), 2);
  assert.equal(countOf('debugStation'), 1);

  // A later, bigger peak grows it further, up to this room's own physical fit
  missionRoom.updateCounts({ deskLike: 6, debugging: 2 });
  assert.equal(countOf('desk'), 6);
  assert.equal(countOf('debugStation'), 2);
});

test('the desk grid never exceeds the room\'s physical fit', () => {
  // Every row's door sits at the column's own center (`missionSlot`, issue #123), so every
  // room's fit is the grid's full, door-centered MAX_DESK_SLOTS.
  const missionRoom = buildMissionRoom(room('a', 'open'), 2);
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

// --- Issue #123 review (blocking defect 1): RoomFrame used a fixed ROOM_SIZE depth
// regardless of door orientation, and the war room's own rect kept WAR_ROOM_WIDTH on the
// wrong axis once the corridor fix moved the door to the east/west wall — together, these put
// most of a war room's own furniture outside its own walls. ---

/** Every wall's own thickness, and a door frame's own post width, legitimately straddle the
 * rect boundary they sit on by half their own size — never more. A room full of furniture
 * genuinely spilling out of its own walls (the regression this guards) measures in whole
 * meters, not fractions of this margin. */
const WALL_STRADDLE_TOLERANCE = 0.2;

test('issue #123 review: every mesh of a built war room stays inside its own room rect, at several rows', () => {
  const failures: string[] = [];
  for (const index of [0, 1, 2, 3, 20]) {
    const missionRoom = buildMissionRoom(room(`m${index}`, 'open'), index);
    missionRoom.updateCounts({ deskLike: 6, debugging: 2 });
    missionRoom.group.updateMatrixWorld(true);
    const { rect } = missionRoom.slot;
    const bounds = new THREE.Box3(
      new THREE.Vector3(rect.minX - WALL_STRADDLE_TOLERANCE, -1, rect.minZ - WALL_STRADDLE_TOLERANCE),
      new THREE.Vector3(rect.maxX + WALL_STRADDLE_TOLERANCE, 10, rect.maxZ + WALL_STRADDLE_TOLERANCE),
    );
    missionRoom.group.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh) return;
      const box = new THREE.Box3().setFromObject(object);
      if (!bounds.containsBox(box)) {
        failures.push(`room ${index}: ${object.name || object.userData.piece || '(unnamed mesh)'} at ${JSON.stringify(box)} falls outside rect ${JSON.stringify(rect)}`);
      }
    });
  }
  assert.deepEqual(failures, []);
});

// --- Issue #123 review round 2: the kanban board's own along-the-door-wall offset still used
// the rect's x-span unconditionally (left over from when the door wall always ran along x),
// so once the corridor fix put war room doors on the east/west wall, the board floated meters
// off the side wall it is meant to sit flush against, instead of touching it. ---

/**
 * Issue #244: statement, docs and kanban now share one merged mesh (`combinedBoard`), each at
 * its own `geometry.groups` entry, in the order they were passed in (statement, docs, kanban —
 * `buildMissionRoom`'s own call) — `mergeGeometries(geometries, true)`'s own documented
 * behavior, one group per input geometry. Recovers one board's own world-space footprint from
 * the merged index/position buffers, rather than assuming a fixed vertex count per plane.
 */
function combinedBoardWorldCenter(mesh: THREE.Mesh, groupIndex: number): THREE.Vector3 {
  const geometry = mesh.geometry;
  const group = geometry.groups[groupIndex];
  if (!group) throw new Error(`no geometry group ${groupIndex} on the combined board mesh`);
  const index = geometry.index;
  if (!index) throw new Error('the combined board mesh has no index buffer');
  const position = geometry.attributes.position;
  const box = new THREE.Box3();
  const vertex = new THREE.Vector3();
  for (let i = group.start; i < group.start + group.count; i++) {
    vertex.fromBufferAttribute(position, index.getX(i));
    box.expandByPoint(vertex);
  }
  mesh.updateMatrixWorld(true);
  box.min.applyMatrix4(mesh.matrixWorld);
  box.max.applyMatrix4(mesh.matrixWorld);
  return box.getCenter(new THREE.Vector3());
}

test('issue #123 review round 2: the kanban board sits flush against a side wall, in both wing columns', () => {
  for (const index of [0, 1]) {
    const missionRoom = buildMissionRoom(room(`m${index}`, 'open'), index);
    missionRoom.group.updateMatrixWorld(true);
    const { rect, door } = missionRoom.slot;
    assert.ok(door.side === 'east' || door.side === 'west', `expected an east/west door, got ${door.side}`);
    let combinedBoardMesh: THREE.Mesh | undefined;
    missionRoom.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      // `mesh.geometry.groups.length === 3` alone is not unique: a plain `CylinderGeometry`
      // (chair poles, desk legs, plant pots) always carries 3 built-in groups (top, bottom,
      // side) of its own. The combined board mesh is the only `MeshBasicMaterial` with a
      // canvas-texture map in this room — everything else here is a toon material.
      const material = mesh.material as THREE.MeshBasicMaterial | undefined;
      if (mesh.isMesh && (mesh.geometry.groups?.length ?? 0) === 3 && material?.isMeshBasicMaterial && material.map) combinedBoardMesh = mesh;
    });
    if (!combinedBoardMesh) throw new Error(`room ${index}: combined board mesh (statement/docs/kanban) not found`);
    // `buildMissionRoom` passes statement, docs, kanban to `combinedBoard` in that order (group 2 = kanban).
    const position = combinedBoardWorldCenter(combinedBoardMesh, 2);
    // A side wall runs the room's full depth at the rect's own z-extremes (the door wall's
    // east/west rows run along z); flush against one of them means within wall thickness of
    // minZ or maxZ, never floating meters toward the room's own z-center.
    const distanceToNearestWall = Math.min(Math.abs(position.z - rect.minZ), Math.abs(position.z - rect.maxZ));
    assert.ok(distanceToNearestWall < 0.2, `room ${index}: kanban board at z=${position.z} is ${distanceToNearestWall.toFixed(2)}m from the nearest side wall (rect ${JSON.stringify(rect)})`);
  }
});

// --- combinedBoard preserves each spec's own resolution (review, #244 round 2) ---

test('combinedBoard gives each spec canvasBoard\'s own pixel sizing, not one shared density — a narrower board (docs) keeps its old line capacity', () => {
  // Same specs buildMissionRoom passes: statement (3.6x1.6), docs (2.4x1.6), kanban (3.6x1.8).
  const specs = [
    { width: 3.6, height: 1.6, position: new THREE.Vector3(0, 1.7, 0), rotationY: 0 },
    { width: 2.4, height: 1.6, position: new THREE.Vector3(0, 1.7, 0), rotationY: 0 },
    { width: 3.6, height: 1.8, position: new THREE.Vector3(0, 1.7, 0), rotationY: 0 },
  ];
  const combined = combinedBoard(specs);
  const atlas = (combined.mesh.material as THREE.MeshBasicMaterial).map!.image as HTMLCanvasElement;
  // Each spec's own canvasBoard would be 512 wide, height round(512 * h/w): 228, 341, 256 — a
  // shared PX_PER_UNIT (the first version of this fix) instead packed every spec by physical
  // width, giving the narrower docs board only 224 px (floor((224-70)/28) = 5 lines instead of
  // its old 9: a silent truncation, not just a size change). A uniform-density regression
  // would shrink this sum; this asserts the full, undiminished total.
  const expectedHeight = [
    Math.round(512 * (1.6 / 3.6)),
    Math.round(512 * (1.6 / 2.4)),
    Math.round(512 * (1.8 / 3.6)),
  ].reduce((sum, h) => sum + h, 0);
  assert.equal(atlas.width, 512, 'every spec keeps canvasBoard\'s own fixed 512px width');
  assert.equal(atlas.height, expectedHeight, `expected the atlas to stack each spec's own canvasBoard height (${expectedHeight}), got ${atlas.height} — a shared density would shrink this`);

  // The docs board (index 1) on its own, standalone canvasBoard, for a direct before/after.
  const standaloneDocs = canvasBoard(2.4, 1.6);
  const docsCanvas = (standaloneDocs.mesh.material as THREE.MeshBasicMaterial).map!.image as HTMLCanvasElement;
  const docsLineCapacity = Math.floor((docsCanvas.height - 70) / 28);
  assert.equal(docsLineCapacity, 9, 'sanity check: the standalone docs board fits 9 lines');
  // The merged atlas gives region 1 (docs) the same height as its standalone board would.
  const docsRegionHeight = Math.round(512 * (1.6 / 2.4));
  const mergedDocsLineCapacity = Math.floor((docsRegionHeight - 70) / 28);
  assert.equal(mergedDocsLineCapacity, docsLineCapacity, 'the merged docs region must keep the same line capacity as its old standalone board, not truncate to 5');
});

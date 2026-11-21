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

// uv values ground-truthed against `canvasBoardSections`'s own `draw()` pixel layout for this
// board (`canvasBoardSections(3.6, 1.8)`: canvas 512x256, 2 equal 128 px sections, flipY
// texture; title at `top + 30`, rows at `top + 60 + j * 19`, review fix: tightened from 24 px
// so all 4 `MAX_SESSION_ROWS` fit). Review fix (issue #223): the original uv values here (0.45,
// 0.35, 0.25, 0.05) were picked to match `resolveSessionRow`'s own (wrong) even-split
// assumption, not the actual rendered position of the title and each row, so this test could
// not have caught the bug it introduced — every drawn row resolved to the session listed one
// slot below it, and a click on the "Sessions" title resolved to the first row instead of
// nothing.
const SECTION_TOP_PX = 128; // canvasBoardSections(3.6, 1.8), 2 sections: 256 / 2
const uvForCanvasY = (y: number) => 1 - y / 256;

test('issue #223: the sessions board shares the kanban mesh (no extra draw call) and its `resolve` reaches the clicked session', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  const kanbanLikeTarget = missionRoom.issuesBoardPickTarget(); // a different mesh, for the identity check below
  const target = missionRoom.sessionsBoardPickTarget();
  assert.equal(target.id, 'sessions-board:a');
  assert.notEqual(target.object, kanbanLikeTarget.object, 'the sessions pick target is not the issues board');
  assert.ok(target.resolve, 'resolves a row, rather than selecting the board mesh itself');

  missionRoom.updateSessions([
    { id: 'agent-1', name: 'Amelia', extras: { stuck: true } },
    { id: 'agent-2', name: 'Quinn', extras: {} },
  ]);
  const hitAt = (v: number) => ({ uv: new THREE.Vector2(0.5, v) }) as THREE.Intersection;
  // The top half of the board is the kanban section: never a session, whatever v is.
  assert.equal(target.resolve!(hitAt(0.9)), null);
  // The "Sessions" title text itself, drawn at `top + 30` (`canvasBoardSections`' draw()).
  assert.equal(target.resolve!(hitAt(uvForCanvasY(SECTION_TOP_PX + 30))), null);
  // Row 0 (blocked ranks first, drawn at `top + 60`) and row 1 (`top + 79`).
  assert.equal(target.resolve!(hitAt(uvForCanvasY(SECTION_TOP_PX + 60))), 'agent-1');
  assert.equal(target.resolve!(hitAt(uvForCanvasY(SECTION_TOP_PX + 79))), 'agent-2');
  // Past the last drawn row (`top + 98`, a 3rd row that was never provided): no stale selection.
  assert.equal(target.resolve!(hitAt(uvForCanvasY(SECTION_TOP_PX + 98))), null);
});

test('issue #223: no live sessions resolves to no selection anywhere on the board', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  missionRoom.updateSessions([]);
  const target = missionRoom.sessionsBoardPickTarget();
  const vs = [0.9, uvForCanvasY(SECTION_TOP_PX + 30), uvForCanvasY(SECTION_TOP_PX + 60), uvForCanvasY(SECTION_TOP_PX + 79), uvForCanvasY(SECTION_TOP_PX + 98)];
  for (const v of vs) {
    assert.equal(target.resolve!({ uv: new THREE.Vector2(0.5, v) } as THREE.Intersection), null, `v=${v}`);
  }
});

// Review fix: `BuildingLayout.update()` calls `updateSessions()` every animation frame, not
// only on the slower agent poll — redrawing (and re-uploading the texture) on every one of
// those calls regardless of whether the sessions actually changed broke the render-on-change
// rule every other board redraw in this file follows. `THREE.Texture.version` only increments
// when `needsUpdate` is set to `true`, so it stands in for "did a redraw actually happen".
test('issue #223: the sessions board redraws only when the sessions actually change, not on every tick', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0);
  const texture = (missionRoom.sessionsBoardPickTarget().object as THREE.Mesh & { material: THREE.MeshBasicMaterial }).material.map!;

  missionRoom.updateSessions([{ id: 'agent-1', name: 'Amelia', extras: {} }]);
  const versionAfterFirstDraw = texture.version;

  // Same session, same state, called again (as a per-frame poll would): no new redraw.
  missionRoom.updateSessions([{ id: 'agent-1', name: 'Amelia', extras: {} }]);
  assert.equal(texture.version, versionAfterFirstDraw, 'an unchanged sessions list must not redraw');

  // The same session's state actually changes: this must redraw.
  missionRoom.updateSessions([{ id: 'agent-1', name: 'Amelia', extras: { stuck: true } }]);
  assert.equal(texture.version, versionAfterFirstDraw + 1, 'a changed sessions list must redraw');
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

test('issue #123 review round 2: the kanban board sits flush against a side wall, in both wing columns', () => {
  for (const index of [0, 1]) {
    const missionRoom = buildMissionRoom(room(`m${index}`, 'open'), index);
    missionRoom.group.updateMatrixWorld(true);
    const { rect, door } = missionRoom.slot;
    assert.ok(door.side === 'east' || door.side === 'west', `expected an east/west door, got ${door.side}`);
    let kanban: THREE.Mesh | undefined;
    missionRoom.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const geometry = mesh.geometry as THREE.PlaneGeometry | undefined;
      if (mesh.isMesh && geometry?.parameters?.width === 3.6 && geometry?.parameters?.height === 1.8) kanban = mesh;
    });
    if (!kanban) throw new Error(`room ${index}: kanban board mesh not found`);
    const position = kanban.getWorldPosition(new THREE.Vector3());
    // A side wall runs the room's full depth at the rect's own z-extremes (the door wall's
    // east/west rows run along z); flush against one of them means within wall thickness of
    // minZ or maxZ, never floating meters toward the room's own z-center.
    const distanceToNearestWall = Math.min(Math.abs(position.z - rect.minZ), Math.abs(position.z - rect.maxZ));
    assert.ok(distanceToNearestWall < 0.2, `room ${index}: kanban board at z=${position.z} is ${distanceToNearestWall.toFixed(2)}m from the nearest side wall (rect ${JSON.stringify(rect)})`);
  }
});

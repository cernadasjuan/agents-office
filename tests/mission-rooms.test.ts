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
const { buildMissionRoom, testHexWarRoom, MAX_TOMBSTONES, canvasBoard, combinedBoard } = await import('../src/addons/building/missionRooms.js');
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

/** Issue #259: a hex war room's floor is part of `HexRooms.ts`'s one shared `hex-floors` zone
 * across every room in the structure, not an independently-recolorable mesh of its own the way
 * the old rect room's floor was — the lock sign below is the one signal a locked mission's own
 * war room still gives (`missionRooms.ts`'s own doc comment explains why the floor tint was not
 * ported). This replaces the old "darkens only its own floor" test with the equivalent check on
 * that sign instead. */
test('one locked mission room shows its own lock sign; an open one never does', () => {
  const open = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
  const locked = buildMissionRoom(room('b', 'open'), 1, testHexWarRoom(1));
  const lockSignOf = (group: THREE.Object3D) => {
    let sign: { visible: boolean } | undefined;
    group.traverse((o) => { if (/Locked: mission closed/.test((o as { element?: HTMLElement }).element?.textContent ?? '')) sign = o as unknown as { visible: boolean }; });
    return sign;
  };
  open.update(room('a', 'open'));
  assert.equal(lockSignOf(open.group)?.visible, false);
  locked.update(room('b', 'locked'));
  assert.equal(lockSignOf(locked.group)?.visible, true);
  assert.equal(lockSignOf(open.group)?.visible, false);
  locked.update(room('b', 'open'));
  assert.equal(lockSignOf(locked.group)?.visible, false);
});

// --- Issue #127: beds become small tombstones, identifiable and resurrectable ---

test('AC1: an ended session appears as a tombstone, pickable by id', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1', endedAt: '2026-11-18' }]));
  const targets = missionRoom.tombstonePickTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, 'tomb-1');
  assert.ok(targets[0].object instanceof THREE.Object3D);
});

test('AC2: a session that returns removes its own tombstone by id, leaving the others in place', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
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
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
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
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1', name: 'tidy-otter' }]));
  const object = missionRoom.tombstonePickTargets()[0].object;
  const nameplate = nameplateOf(object);
  assert.equal(nameplate.userData.nameText, 'tidy-otter');
  // No CSS2D-style DOM element anywhere on the tombstone: the engraving carries no `element`.
  assert.equal((nameplate as unknown as { element?: unknown }).element, undefined);
});

test('AC: no floating sign of any kind remains on a tombstone', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
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
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1' }]));
  const object = missionRoom.tombstonePickTargets()[0].object;
  assert.equal(nameplateOf(object).userData.nameText, 'Ended session');
});

test('AC: a session that changes name updates the same nameplate handle, not a new object', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
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
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
  missionRoom.update(room('a', 'open', [{ id: 'tomb-1', name: 'tidy-otter' }]));
  const object = missionRoom.tombstonePickTargets()[0].object;
  assert.ok(object.children.includes(nameplateOf(object)));
});

test('AC: removing a tombstone stops the shared batch from drawing its nameplate (no leak)', () => {
  const scene = new THREE.Scene();
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
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
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
  const sleepers = Array.from({ length: MAX_TOMBSTONES + 5 }, (_, i) => ({ id: `tomb-${i}` }));
  missionRoom.update(room('a', 'open', sleepers));
  assert.equal(missionRoom.tombstonePickTargets().length, MAX_TOMBSTONES, 'only the cap renders');
  let countSign: THREE.Object3D | undefined;
  missionRoom.group.traverse((o) => { if (/past session/.test((o as { element?: HTMLElement }).element?.textContent ?? '')) countSign = o; });
  assert.match((countSign as unknown as { element: HTMLElement })?.element.textContent ?? '', /\(\+5 not shown\)/);
});

test('every tombstone keeps the same merged toon material: a room full of them still draws cheap', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
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
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
  const names: string[] = [];
  missionRoom.group.traverse((o) => { if (typeof o.userData.piece === 'string') names.push(o.userData.piece); });
  // Issue #259 review round 2: no clock any more — Gabriel's own base set names only the work
  // furniture (desk, debug station, whiteboard, bookshelf), no ornamental pieces.
  for (const must of ['whiteboard', 'bookshelf', 'desk', 'debugStation']) assert.ok(names.includes(must), `missing ${must}`);
  assert.ok(!names.includes('sofa'), 'issue #209: no sofa in a war room');
  assert.ok(!names.includes('lowTable'), 'issue #209: no coffee table in a war room');
  assert.ok(!names.includes('clock'), 'issue #259: no clock in a war room');
});

test('desk-like furniture grows with the peak live count and never shrinks back', () => {
  // Issue #123: every war room's door opens onto the mission corridor at its own row's
  // center, so every index (not just a later ring) gets the grid's full, door-centered fit.
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
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

  // A later, bigger peak grows it further, up to this room's own physical fit (issue #259
  // review round 2: MAX_DESK_SLOTS shrank from 8 to 6, shared between desk and debug — debug
  // stations fill first, so 2 debugging + 6 desk-like requested caps out at 2 debug + 4 desk).
  missionRoom.updateCounts({ deskLike: 6, debugging: 2 });
  assert.equal(countOf('desk'), 4);
  assert.equal(countOf('debugStation'), 2);
});

test('the desk grid never exceeds the room\'s physical fit', () => {
  // Every row's door sits at the column's own center (`missionSlot`, issue #123), so every
  // room's fit is the grid's full, door-centered MAX_DESK_SLOTS.
  const missionRoom = buildMissionRoom(room('a', 'open'), 2, testHexWarRoom(2));
  missionRoom.updateCounts({ deskLike: 20, debugging: 5 });
  let total = 0;
  missionRoom.group.traverse((o) => { if (o.userData.piece === 'desk' || o.userData.piece === 'debugStation') total++; });
  assert.equal(total, MAX_DESK_SLOTS);
});

test('a peak that does not grow rebuilds nothing: the same furniture objects stay in the scene', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
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
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
  missionRoom.updateCounts({ deskLike: 6, debugging: 2 });
  const names: string[] = [];
  missionRoom.group.traverse((o) => { if (typeof o.userData.piece === 'string') names.push(o.userData.piece); });
  assert.ok(names.length > 0, 'the plan actually placed pieces');
  for (const name of names) assert.ok(name in PIECES, `${name} is not a furniture library piece`);
});

// --- Issue #124: mission signs move off the door frame ---

test('AC124: the title and lock signs sit on the far wall, not near the door', async () => {
  const { HexFrame } = await import('../src/addons/building/HexFrame.js');
  const { ROOM_SIZE: SIZE } = await import('../src/addons/building/RoomPlanner.js');
  const hexRoom = testHexWarRoom(0);
  const missionRoom = buildMissionRoom(room('a', 'locked'), 0, hexRoom);
  const frame = new HexFrame(hexRoom, hexRoom.openEdges[0]);
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
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
  const target = missionRoom.issuesBoardPickTarget();
  assert.equal(target.id, 'issues:a');
  assert.ok(target.object instanceof THREE.Object3D);
});

// uv values ground-truthed against `drawSectionedBoardContent`'s own pixel layout for the
// kanban region (2 equal 128 px sections, flipY texture; title at `top + 30`, rows at
// `top + 60 + j * 19`, review fix: tightened from 24 px so all 4 `MAX_SESSION_ROWS` fit).
// Review fix (issue #223): the original uv values here (0.45, 0.35, 0.25, 0.05) were picked to
// match `resolveSessionRow`'s own (wrong) even-split assumption, not the actual rendered
// position of the title and each row, so this test could not have caught the bug it
// introduced — every drawn row resolved to the session listed one slot below it, and a click
// on the "Sessions" title resolved to the first row instead of nothing.
//
// Issue #223 vs #244: the kanban board lives inside `combinedBoard`'s shared canvas (its own
// region, index 2 — statement, docs, kanban, `buildMissionRoom`'s own call), not a dedicated
// 512x256 canvas of its own, so a hit's `uv.y` is in the shared canvas's full UV space, not a
// region-local [0, 1]. `kanbanRegion` below (the same 3 specs `buildMissionRoom` passes to
// `combinedBoard`, only `width`/`height` affect a region's own bounds) gives this test the real
// region bounds to convert a region-local canvas-Y pixel position into that full UV space,
// instead of assuming the region is the whole canvas.
// Issue #259 review round 2: the display wall's own board grid shrank along with the room
// (BOARD_W/BOARD_H, `buildMissionRoom`'s own constants) — same 3 specs, smaller dimensions.
const kanbanRegion = combinedBoard([
  { width: 1.4, height: 0.8, position: new THREE.Vector3(), rotationY: 0 },
  { width: 1.4, height: 0.8, position: new THREE.Vector3(), rotationY: 0 },
  { width: 1.4, height: 0.8, position: new THREE.Vector3(), rotationY: 0 },
]).regionOf(2);
const SECTION_TOP_PX = kanbanRegion.h / 2; // this region, 2 equal sections
const uvForCanvasY = (y: number) => kanbanRegion.vBottom + (1 - y / kanbanRegion.h) * (kanbanRegion.vTop - kanbanRegion.vBottom);

test('issue #223: the sessions board shares the kanban mesh (no extra draw call) and its `resolve` reaches the clicked session', () => {
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
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
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
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
  const missionRoom = buildMissionRoom(room('a', 'open'), 0, testHexWarRoom(0));
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

test('issue #259: every mesh of a built hex war room stays inside its own hex interior, at several wings and ordinals', async () => {
  const { pointInPolygon, hexRoomCorners } = await import('../src/addons/building/HexRoomPlanner.js');
  const failures: string[] = [];
  for (const index of [0, 1, 2, 3, 20]) {
    const hexRoom = testHexWarRoom(index);
    const missionRoom = buildMissionRoom(room(`m${index}`, 'open'), index, hexRoom);
    missionRoom.updateCounts({ deskLike: 6, debugging: 2 });
    missionRoom.group.updateMatrixWorld(true);
    // A grown copy of the room's own hex, the same "a touch larger at the corners" margin
    // every other coarse hex-interior check in this fork already uses.
    const grown = hexRoomCorners(hexRoom.center, hexRoom.radius + WALL_STRADDLE_TOLERANCE);
    missionRoom.group.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh) return;
      const box = new THREE.Box3().setFromObject(object);
      const corners2D = [
        { x: box.min.x, z: box.min.z }, { x: box.min.x, z: box.max.z },
        { x: box.max.x, z: box.min.z }, { x: box.max.x, z: box.max.z },
      ];
      for (const corner of corners2D) {
        if (!pointInPolygon(corner, grown)) {
          failures.push(`room ${index}: ${object.name || object.userData.piece || '(unnamed mesh)'} at ${JSON.stringify(box)} falls outside its hex (center ${JSON.stringify(hexRoom.center)}, radius ${hexRoom.radius})`);
          break;
        }
      }
    });
  }
  assert.deepEqual(failures, []);
});

// Issue #259 review round 2: the furniture plan now spans 4 of the room's own 6 walls (each
// its own `HexFrame`, `warRoomFurnishing.ts`'s own doc comment) instead of one rect room's
// single frame — a real risk the old single-frame layout never had is two pieces on
// *different* walls landing in the same world spot near the room's own center. This checks
// every named furniture piece (`userData.piece`, desks/debug stations/whiteboard/bookshelf —
// not boards, signs or tombstones, which are not floor-standing pieces competing for the same
// footprint) pairwise, at the full desk/debug count where the grid is busiest.
test('issue #259 review round 2: no two furniture pieces of a built hex war room overlap, at the full desk/debug count', () => {
  const failures: string[] = [];
  for (const index of [0, 1, 2, 3, 20]) {
    const hexRoom = testHexWarRoom(index);
    const missionRoom = buildMissionRoom(room(`m${index}`, 'open'), index, hexRoom);
    missionRoom.updateCounts({ deskLike: 6, debugging: 2 });
    missionRoom.group.updateMatrixWorld(true);
    const boxes: Array<{ name: string; box: THREE.Box3 }> = [];
    missionRoom.group.traverse((object) => {
      if (typeof object.userData.piece !== 'string') return;
      boxes.push({ name: object.userData.piece, box: new THREE.Box3().setFromObject(object) });
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (boxes[i].box.intersectsBox(boxes[j].box)) {
          failures.push(`room ${index}: ${boxes[i].name} overlaps ${boxes[j].name}`);
        }
      }
    }
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

// Issue #259 review: `warRoomFurnishing.ts`'s plan keeps the old rect room's exact `a`/`d`
// coordinates (the build plan's own instruction — reuse the furniture plan as-is, not
// rescaled), and `WAR_ROOM_HEX_RADIUS` is sized to contain that plan's deepest corners
// (the far-wall boards at `d` close to `ROOM_SIZE`). That makes the hex interior visibly
// bigger than the old rect's own footprint, so a board authored to sit flush against the old
// rect's side wall (a = ±9) no longer touches the bigger hex's own, further-out wall — a known,
// documented trade-off of this port, not a missed regression. This test checks the board still
// sits on the room's own outer third along its side axis (same intent: "on a side wall," not
// floating near the center), not literal wall contact.
// Issue #259 review round 2: statement, docs and kanban all mount on the display wall now (the
// edge opposite the door, round 7's own "a clear display wall"), 2x2 with the issues board —
// not split across the far wall and a side wall the way the old rect room did. This checks the
// combined mesh's own 3 regions all sit near the display wall's own depth (not floating near
// the room's center) and are laterally distinct from each other (statement and docs share a
// row, kanban sits below one of them — never on top of either).
test('issue #259: the combined board (statement/docs/kanban) mounts on the display wall, each region laterally distinct', async () => {
  for (const index of [0, 1]) {
    const hexRoom = testHexWarRoom(index);
    const missionRoom = buildMissionRoom(room(`m${index}`, 'open'), index, hexRoom);
    missionRoom.group.updateMatrixWorld(true);
    let combinedBoardMesh: THREE.Mesh | undefined;
    missionRoom.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.MeshBasicMaterial | undefined;
      if (mesh.isMesh && (mesh.geometry.groups?.length ?? 0) === 3 && material?.isMeshBasicMaterial && material.map) combinedBoardMesh = mesh;
    });
    if (!combinedBoardMesh) throw new Error(`room ${index}: combined board mesh (statement/docs/kanban) not found`);
    const { HexFrame } = await import('../src/addons/building/HexFrame.js');
    const frame = new HexFrame(hexRoom, hexRoom.openEdges[0]);
    const doorPoint = frame.point(0, 0);
    const positions = [0, 1, 2].map((i) => combinedBoardWorldCenter(combinedBoardMesh!, i));
    for (const position of positions) {
      const toDoor = position.distanceTo(doorPoint);
      assert.ok(toDoor > hexRoom.radius, `room ${index}: a display-wall board sits only ${toDoor.toFixed(2)}m from the door, nearer the room's center than its own far wall`);
    }
    // No two of the 3 regions land at the same world spot (statement/docs share a row, kanban
    // sits in its own spot below one of them).
    assert.ok(positions[0].distanceTo(positions[1]) > 0.5, 'statement and docs overlap');
    assert.ok(positions[0].distanceTo(positions[2]) > 0.5 || positions[1].distanceTo(positions[2]) > 0.5, 'kanban overlaps both statement and docs');
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

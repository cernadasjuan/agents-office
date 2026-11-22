import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time (the same pattern
// view-controller.test.ts and floor-library-client.test.ts already use).
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;

const { relevantLibrary, roomStanding, buildEntranceHall, LibraryCameraRig } = await import('../src/library/bootLibrary.js');
const { RoomFrame, wallRects } = await import('../src/addons/building/rooms.js');
const { slotFor, HALL, ROOM_SIZE } = await import('../src/addons/building/RoomPlanner.js');
const { shelfPlacement, sectionRoomLayouts } = await import('../src/library/libraryLayout.js');
const { moveWithCollision } = await import('../src/library/cameraMath.js');

after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
  Reflect.deleteProperty(globalThis, 'window');
});

function library(id: string, repo: string | undefined) {
  return { id, repo, sections: [] };
}

// --- Issue #245 round 3 review: an unmatched floor used to fall back to the first library ---

test('relevantLibrary returns the matching library for its own floor', () => {
  const libraries = [library('a', 'org/repo-a'), library('b', 'org/repo-b')];
  assert.equal(relevantLibrary(libraries, 'org/repo-b')?.id, 'b');
});

test('relevantLibrary with no floor at all still defaults to the first configured library', () => {
  const libraries = [library('a', 'org/repo-a'), library('b', 'org/repo-b')];
  assert.equal(relevantLibrary(libraries, undefined)?.id, 'a');
});

test('issue #245 round 3 review: a floor that matches none of the configured libraries gets an empty catalog, never the first library', () => {
  const libraries = [library('a', 'org/repo-a'), library('b', 'org/repo-b')];
  assert.equal(relevantLibrary(libraries, 'org/unrelated-repo'), undefined);
});

// --- Issue #245 round 3 review: a one-entry section's teleport pose could land in a wall margin ---

const WALL_MARGIN = 0.3; // cameraMath.ts's own padding, duplicated here only for the assertion

function blockedBy(walls: ReturnType<typeof wallRects>, x: number, z: number): boolean {
  return walls.some((wall) => x > wall.minX - WALL_MARGIN && x < wall.maxX + WALL_MARGIN && z > wall.minZ - WALL_MARGIN && z < wall.maxZ + WALL_MARGIN);
}

test("issue #245 round 3 review: a one-entry section's teleport pose clears the door wall's own collision margin", () => {
  const slot = slotFor(0);
  const frame = new RoomFrame(slot.rect, slot.door);
  const placements = [shelfPlacement(0)]; // the lone shelf of a one-entry section
  const standing = roomStanding(frame, placements);
  const walls = wallRects(slot.rect, [slot.door]);
  assert.equal(blockedBy(walls, standing.position.x, standing.position.z), false,
    `standing pose (${standing.position.x}, ${standing.position.z}) sits inside a wall's own collision margin`);
});

test("roomStanding still faces the sparse section's own lone shelf, not a generic room center (the depth fix never touched the column)", () => {
  const slot = slotFor(0);
  const frame = new RoomFrame(slot.rect, slot.door);
  const placements = [shelfPlacement(0)];
  const standing = roomStanding(frame, placements);
  const roomCenter = frame.point(0, ROOM_SIZE / 2, 0.6);
  // review round 4: `slotFor(0)`'s own door is on the room's west wall, so `frame.point`'s
  // "along" (column) axis runs over world Z here, not X — comparing `.x` only ever captures
  // the depth difference (`roomStanding`'s own `d`), which this fix never touched, so the
  // assertion passed whether or not the column centering logic was actually broken. Project
  // onto the frame's own `along` vector instead of assuming which world axis it happens to be,
  // so this stays correct for a room whose door sits on any of its four walls.
  const lookAtAlong = new THREE.Vector3().subVectors(standing.lookAt, frame.point(0, 0, 0)).dot(frame.along);
  const roomCenterAlong = new THREE.Vector3().subVectors(roomCenter, frame.point(0, 0, 0)).dot(frame.along);
  assert.notEqual(lookAtAlong, roomCenterAlong, 'still looks down the lone shelf\'s own column, not the room\'s generic middle');
});

test('issue #245 round 3 review: the standing position and look-at never land on the same depth (a degenerate, straight-down look direction)', () => {
  const slot = slotFor(0);
  const frame = new RoomFrame(slot.rect, slot.door);
  const standing = roomStanding(frame, [shelfPlacement(0)]); // the worst case: a lone shelf right at the door's own grid start
  const horizontalRun = Math.hypot(standing.lookAt.x - standing.position.x, standing.lookAt.z - standing.position.z);
  assert.ok(horizontalRun > 0.5, `position and lookAt are nearly the same point in the XZ plane (run=${horizontalRun}); yawPitchFromLookAt would pick an arbitrary yaw, freezing WASD's own forward step`);
});

// --- Issue #245 round 3 review: the entrance hall had no floor, walls or colliders at all ---

test('issue #245 round 3 review: the entrance hall is bounded on a side with no section rented there yet', () => {
  const scene = new THREE.Scene();
  const colliders = buildEntranceHall(scene, []); // nothing rented yet at all
  const { z } = moveWithCollision(0, 0, 0, -1000, colliders); // walking north forever
  assert.ok(z > HALL.minZ, `walked straight through the hall's own wall into the void, stopped at z=${z}`);
});

test("issue #245 round 3 review: a rented section's own door is still a walk-through gap in the hall's boundary", () => {
  const scene = new THREE.Scene();
  const sections = sectionRoomLayouts([{ name: 'vendors', entries: [] }]); // section 0: ring 0, door on HALL's east side
  const colliders = buildEntranceHall(scene, sections.map((section) => section.slot));
  const { x } = moveWithCollision(0, 0, 1000, 0, colliders); // walking east, straight at the rented section's own door
  // review round 4: a fully sealed hall (no door at all) still stops just short of the wall
  // itself, at x=14.4 (`WALL_MARGIN` short of `HALL.maxX`'s own 15) — `x > 14` alone passes
  // whether or not the door gap actually exists. Only a position past `HALL.maxX` proves the
  // camera actually walked through an opening, not just up to the wall's own collision margin.
  assert.ok(x > HALL.maxX, `blocked at the door's own gap instead of walking through it, stopped at x=${x}`);
});

test('issue #245 round 3 review: the same side stays solid everywhere except at the actual door gap', () => {
  const scene = new THREE.Scene();
  const sections = sectionRoomLayouts([{ name: 'vendors', entries: [] }]);
  const colliders = buildEntranceHall(scene, sections.map((section) => section.slot));
  // Section 0's door sits at z=0 on HALL's east wall (DOOR_WIDTH 2.4 wide); well off that gap,
  // along the same east wall, the hall must still be solid.
  const { x } = moveWithCollision(0, 10, 1000, 0, colliders); // walking east at z=10, away from the door
  assert.ok(x < HALL.maxX, `walked straight through the hall's own solid wall away from the door, stopped at x=${x}`);
});

// --- Issue #245 round 3 review: a resize while idle left a stale frame on screen ---

test('issue #245 round 3 review: resizing the window marks the camera rig dirty, forcing one more render', () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  const canvasElement = dom.window.document.createElement('canvas');
  const rig = new LibraryCameraRig(camera, canvasElement);
  rig.dirty = false;
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  assert.equal(rig.dirty, true, 'idle rendering skips a frame with nothing changed; a resize must still force one');
});

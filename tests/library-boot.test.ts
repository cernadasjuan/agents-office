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

const { relevantLibrary, roomStanding, buildEntranceHall, LibraryCameraRig, LibrarianDesk } = await import('../src/library/bootLibrary.js');
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
  assert.notEqual(standing.lookAt.x, roomCenter.x, 'still looks down the lone shelf\'s own column, not the room\'s generic middle');
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
  assert.ok(x > 14, `blocked at the door's own gap instead of walking through it, stopped at x=${x}`);
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

// --- Issue #248 review: the librarian desk's own figure row ---

function mockAgents(agents: Array<{ id: string; name: string; role?: string }>): void {
  Object.defineProperty(globalThis, 'fetch', {
    value: (async () => ({ ok: true, json: async () => agents })) as unknown as typeof fetch,
    configurable: true, writable: true,
  });
}

test('issue #248 review: a departing agent frees its own row slot instead of leaving a new arrival to double up on it', async () => {
  const scene = new THREE.Scene();
  let dirtyCalls = 0;
  const desk = new LibrarianDesk(scene, () => { dirtyCalls += 1; });

  mockAgents([{ id: 'a', name: 'Alice', role: 'librarian' }, { id: 'b', name: 'Bob', role: 'librarian' }]);
  await desk.poll();
  assert.equal(desk.count, 2);
  assert.ok(dirtyCalls > 0, 'seating the first two agents is a real scene change and must ask for a render');

  // A departs, C arrives: B must keep its own original spot, never share it with C.
  mockAgents([{ id: 'b', name: 'Bob', role: 'librarian' }, { id: 'c', name: 'Carol', role: 'librarian' }]);
  await desk.poll();
  assert.equal(desk.count, 2);
  const positions = scene.children.map((child) => child.position.x); // LibrarianDesk only ever adds StickFigure groups to this scene
  const unique = new Set(positions.map((x) => Math.round(x * 100)));
  assert.equal(unique.size, positions.length, `two figures must never share the same row slot; positions were ${positions.join(', ')}`);
});

test('issue #248 review: an unchanged poll (same agents) never asks for another render', async () => {
  const scene = new THREE.Scene();
  let dirtyCalls = 0;
  const desk = new LibrarianDesk(scene, () => { dirtyCalls += 1; });
  mockAgents([{ id: 'a', name: 'Alice', role: 'librarian' }]);
  await desk.poll();
  dirtyCalls = 0;
  await desk.poll(); // same agent, same poll result
  assert.equal(dirtyCalls, 0, 'nothing actually changed; a render request here would be wasted work every 5 seconds forever');
});

test('issue #248 review: a malformed /api/agents body degrades to no figures, never an unhandled rejection', async () => {
  const scene = new THREE.Scene();
  const desk = new LibrarianDesk(scene, () => {});
  Object.defineProperty(globalThis, 'fetch', {
    value: (async () => ({ ok: true, json: async () => ({ not: 'an array' }) })) as unknown as typeof fetch,
    configurable: true, writable: true,
  });
  await assert.doesNotReject(desk.poll());
  assert.equal(desk.count, 0);
});

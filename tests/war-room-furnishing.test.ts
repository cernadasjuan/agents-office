import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Furniture paints toon gradients on a canvas; some pieces need a document.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { furnishWarRoom, tierFor, MAX_DESK_SLOTS, DOOR_PATH_CLEARANCE, WAR_ROOM_WIDTH } = await import('../src/addons/building/warRoomFurnishing.js');
const { DOOR_WIDTH, ROOM_SIZE } = await import('../src/addons/building/RoomPlanner.js');
const { QUEUE_SPOT_RADIUS } = await import('../src/addons/building/furnishing.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

type Plan = ReturnType<typeof furnishWarRoom>;
type Placement = Plan['pieces'][number];

/** The floor footprint of a placed piece in room coordinates (a along the door wall, d inward). */
function footprint(placement: Placement) {
  const object = placement.piece.create();
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const quarter = Math.round((placement.turn ?? 0) / (Math.PI / 2));
  const swap = Math.abs(quarter) % 2 === 1;
  const [halfA, halfD] = swap
    ? [Math.max(-box.min.z, box.max.z), Math.max(-box.min.x, box.max.x)]
    : [Math.max(-box.min.x, box.max.x), Math.max(-box.min.z, box.max.z)];
  return { minA: placement.a - halfA, maxA: placement.a + halfA, minD: placement.d - halfD, maxD: placement.d + halfD, height: box.max.y - box.min.y };
}

const standsOnFloor = (placement: Placement) => footprint(placement).height > 0.05 && (placement.y ?? 0) < 0.5;

function hitsRect(box: ReturnType<typeof footprint>, minA: number, maxA: number, minD: number, maxD: number): boolean {
  return box.minA < maxA && minA < box.maxA && box.minD < maxD && minD < box.maxD;
}

const ZERO = { deskLike: 0, debugging: 0 };

test('tierFor matches the rulebook thresholds', () => {
  assert.equal(tierFor(0), 'small');
  assert.equal(tierFor(3), 'small');
  assert.equal(tierFor(4), 'medium');
  assert.equal(tierFor(5), 'medium');
  assert.equal(tierFor(6), 'large');
  assert.equal(tierFor(20), 'large');
});

// --- AC1: every war room has every must-have piece ---

test('AC1: a new war room has every must-have piece, even with no agents yet', () => {
  const plan = furnishWarRoom('mission-a', ZERO);
  const names: string[] = plan.pieces.map((p) => p.piece.name);
  for (const must of ['clock', 'whiteboard', 'bookshelf', 'desk', 'debugStation']) {
    assert.ok(names.includes(must), `missing ${must}`);
  }
  assert.ok(names.filter((n) => n === 'plant' || n === 'tallPlant').length >= 3, 'plants present');
});

// --- Issue #209: a war room is a work space only, no sofa and no coffee table ---

test('issue #209: no sofa and no low table in a war room, at any count', () => {
  for (const counts of [ZERO, { deskLike: 6, debugging: 2 }]) {
    const plan = furnishWarRoom('mission-no-lounge', counts);
    const names = plan.pieces.map((p) => p.piece.name);
    assert.ok(!names.includes('sofa'), 'issue #209: no sofa in a war room');
    assert.ok(!names.includes('lowTable'), 'issue #209: no coffee table in a war room');
    assert.ok(!plan.stations.some((s) => s.type === 'idle'), 'issue #209: no idle station in a war room');
  }
});

// --- Issue #209: the base work set is present even with zero agents, and never shrinks below it ---

test('issue #209: an empty war room still shows the base work set (1 workstation + 1 debug station)', () => {
  const plan = furnishWarRoom('mission-empty-209', ZERO);
  const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
  assert.equal(deskPieces.length, 2, 'base work set: one workstation + one debug station');
  assert.equal(deskPieces.filter((p) => p.piece.name === 'debugStation').length, 1);
  assert.equal(deskPieces.filter((p) => p.piece.name === 'desk').length, 1);
});

test('issue #209: the base work set still fits clear of the door, at every off-center door position', () => {
  for (const doorAlong of [-1, -3, 1, 3]) {
    const plan = furnishWarRoom(`mission-empty-door-${doorAlong}`, ZERO, doorAlong);
    const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
    assert.equal(deskPieces.length, 2, `base work set at doorAlong=${doorAlong}`);
  }
});

// Review: at the room's own full slot cap (MAX_DESK_SLOTS, or fewer near an off-center door),
// debugging headcount alone used to fill every slot and starve the base desk guaranteed above
// (debug stations fill first). A desk must still survive once the cap, not the floor, is what
// actually limits the grid.
test('review: the base desk survives even when debugging headcount alone fills the room\'s full slot cap', () => {
  for (const doorAlong of [0, -3, 3]) {
    const plan = furnishWarRoom(`mission-debug-saturated-${doorAlong}`, { deskLike: 0, debugging: 8 }, doorAlong);
    const names = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation').map((p) => p.piece.name);
    assert.ok(names.includes('desk'), `missing the base desk at doorAlong=${doorAlong}, got ${names.join(',')}`);
  }
});

// --- AC2: the same mission id gives the same layout, on every reload ---

test('AC2: the same mission id and counts furnish the same room every time', () => {
  const a = furnishWarRoom('mission-repeat', { deskLike: 3, debugging: 1 });
  const b = furnishWarRoom('mission-repeat', { deskLike: 3, debugging: 1 });
  assert.deepEqual(a.pieces.map((p) => [p.piece.name, p.a, p.d, p.turn]), b.pieces.map((p) => [p.piece.name, p.a, p.d, p.turn]));
  assert.deepEqual(a.stations, b.stations);
});

test('AC2: two different mission ids are not forced into the same layout', () => {
  const a = furnishWarRoom('mission-x', { deskLike: 3, debugging: 0 });
  const b = furnishWarRoom('mission-y', { deskLike: 3, debugging: 0 });
  assert.notDeepEqual(a.pieces.map((p) => [p.a, p.d]), b.pieces.map((p) => [p.a, p.d]), 'jitter differs by seed');
});

// --- Issue #193: the desk grid fits 6 to 8 desks, not 4, in the now-wider war room ---

test('issue #193: the room fits 6 to 8 desks, up from the original 4', () => {
  assert.ok(MAX_DESK_SLOTS >= 6 && MAX_DESK_SLOTS <= 8, `MAX_DESK_SLOTS is ${MAX_DESK_SLOTS}, expected 6-8`);
  assert.ok(WAR_ROOM_WIDTH > ROOM_SIZE, `a war room's width (${WAR_ROOM_WIDTH}) should be wider than a generic room's (${ROOM_SIZE})`);
});

test('issue #193: every agent gets a desk at the room\'s own new physical fit, not the old 4-desk cap', () => {
  const plan = furnishWarRoom('mission-full-193', { deskLike: MAX_DESK_SLOTS - 2, debugging: 2 });
  const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
  assert.equal(deskPieces.length, MAX_DESK_SLOTS, `expected every requested agent (${MAX_DESK_SLOTS}) to get a desk`);
});

// --- Desk grid: debug stations fill first, capped at the room's physical fit ---

test('desk-like and debugging agents each get their own station, debug stations first', () => {
  const plan = furnishWarRoom('mission-desks', { deskLike: 2, debugging: 2 });
  const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
  assert.equal(deskPieces.length, 4);
  assert.equal(deskPieces.filter((p) => p.piece.name === 'debugStation').length, 2);
  assert.equal(plan.stations.filter((s) => s.type === 'debugging').length, 2);
  assert.equal(plan.stations.filter((s) => s.type === 'implementing').length, 2);
});

test('the desk grid caps at the physical fit; extra agents do not get an extra desk', () => {
  const plan = furnishWarRoom('mission-crowded', { deskLike: 10, debugging: 4 });
  const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
  assert.equal(deskPieces.length, MAX_DESK_SLOTS);
  assert.equal(deskPieces.filter((p) => p.piece.name === 'debugStation').length, 4);
});

// --- Round 7 (#214): no desk beside the door, every desk faces the room center ---

test('#214: no desk slot sits inside the old door-flanking lane (a = ±2.4)', () => {
  const plan = furnishWarRoom('mission-no-door-desk', { deskLike: MAX_DESK_SLOTS, debugging: 0 });
  const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
  for (const p of deskPieces) assert.ok(Math.abs(p.a) > 4, `desk at a=${p.a} is still beside the door, not a corner or side wall`);
});

test('#214: every desk and debug station turns to face the room center, not the door', () => {
  const plan = furnishWarRoom('mission-face-center', { deskLike: MAX_DESK_SLOTS, debugging: 0 });
  const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
  for (const p of deskPieces) {
    const turn = p.turn ?? 0;
    if (p.a < 0) assert.ok(turn > 0, `left-wall desk at a=${p.a} should turn toward +a (center), got turn=${turn}`);
    else assert.ok(turn < 0, `right-wall desk at a=${p.a} should turn toward -a (center), got turn=${turn}`);
  }
});

// --- Round 7 (#214) review fix: the seated station must land in the piece's own built-in chair ---

test('#214 review: a desk or debug station seats its agent in the chair the piece actually renders, not across the room from it', async () => {
  const { RoomFrame } = await import('../src/addons/building/rooms.js');
  const { missionSlot } = await import('../src/addons/building/missionRooms.js');
  const slot = missionSlot(0);
  const frame = new RoomFrame(slot.rect, slot.door);
  const plan = furnishWarRoom('mission-seat-alignment', { deskLike: MAX_DESK_SLOTS, debugging: 2 });
  const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
  for (const [i, p] of deskPieces.entries()) {
    const station = plan.stations[i];
    const deskCenter = frame.point(p.a, p.d);
    const chairLocal = new THREE.Vector3(0, 0, 0.7).applyAxisAngle(new THREE.Vector3(0, 1, 0), frame.faceDoor + (p.turn ?? 0));
    const chairWorld = deskCenter.clone().add(chairLocal);
    const stationWorld = frame.point(station.a, station.d);
    const gap = chairWorld.distanceTo(stationWorld);
    assert.ok(gap < 0.5, `station ${i} sits ${gap.toFixed(2)} m from its chair, should be seated in it`);
  }
});

// --- Could-haves unlock by tier ---

test('could-haves unlock only at medium and large tiers', () => {
  const small = furnishWarRoom('mission-small', { deskLike: 2, debugging: 0 });
  assert.ok(!small.pieces.some((p) => p.piece.name === 'waterCooler'));
  const medium = furnishWarRoom('mission-medium', { deskLike: 4, debugging: 0 });
  assert.ok(medium.pieces.some((p) => p.piece.name === 'waterCooler'));
});

// --- Rulebook §4: the same clearance rules as every other room ---

test('no floor-standing piece blocks the door path or the far-wall gap, at the full desk cap', () => {
  const plan = furnishWarRoom('mission-full', { deskLike: 6, debugging: 2 });
  for (const placement of plan.pieces.filter(standsOnFloor)) {
    const box = footprint(placement);
    const name = `${placement.piece.name} at (${placement.a.toFixed(2)}, ${placement.d.toFixed(2)})`;
    // Issue #193: a war room's width (`a`) is `WAR_ROOM_WIDTH`, wider than its depth (`d`,
    // still `ROOM_SIZE`) — the two axes are no longer the same constant.
    assert.ok(box.minA >= -WAR_ROOM_WIDTH / 2 && box.maxA <= WAR_ROOM_WIDTH / 2 && box.minD >= 0 && box.maxD <= ROOM_SIZE, `${name} stands inside the room`);
    assert.ok(!hitsRect(box, -DOOR_WIDTH / 2, DOOR_WIDTH / 2, 0, 2.5), `${name} blocks the door`);
    assert.ok(!hitsRect(box, -DOOR_WIDTH / 2, DOOR_WIDTH / 2, ROOM_SIZE - 1, ROOM_SIZE), `${name} blocks the far-wall gap`);
  }
});

// --- The real door is off-center for every room in the first ring (both wing columns in
// missionRooms.ts); the grid must clear the real door lane, not an assumed centered one ---

test('no floor-standing piece blocks an off-center door path, at the full desk cap', () => {
  for (const doorAlong of [-1, -3, 1, 3]) {
    const plan = furnishWarRoom(`mission-door-${doorAlong}`, { deskLike: 6, debugging: 2 }, doorAlong);
    for (const placement of plan.pieces.filter(standsOnFloor)) {
      const box = footprint(placement);
      const name = `${placement.piece.name} at (${placement.a.toFixed(2)}, ${placement.d.toFixed(2)}), doorAlong=${doorAlong}`;
      assert.ok(!hitsRect(box, doorAlong - DOOR_WIDTH / 2, doorAlong + DOOR_WIDTH / 2, 0, 2.5), `${name} blocks the door`);
    }
  }
});

// --- Pin the clearance formula's own threshold: a door offset that puts a slot's distance
// just inside DOOR_PATH_CLEARANCE drops it, just outside keeps it. The doorAlong values
// above (-1, -3, 1, 3) are all far enough from the threshold that a wrong constant (2.2
// instead of 2.3, say) would still pass them. ---

// Issue #193: requesting the full MAX_DESK_SLOTS (8) so the drop is visible in the count —
// with fewer requested than the 7 slots left after one drops, the request itself (not the
// clearance rule) would cap the count, hiding whether the drop happened at all.
function deskPieceCount(doorAlong: number): number {
  const plan = furnishWarRoom(`mission-threshold-${doorAlong}`, { deskLike: MAX_DESK_SLOTS, debugging: 0 }, doorAlong);
  return plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation').length;
}

test('the door clearance drops the nearest lane exactly at DOOR_PATH_CLEARANCE, keeps it just past it', () => {
  assert.equal(DOOR_PATH_CLEARANCE, 2.3);
  // Round 7 (#214) dropped the two door-flanking slots (a = ±2.4); the nearest lane left is
  // a = 4.6, which `clearsDoor` filters by `a` alone, so all three of its depth rows drop
  // together. At doorAlong = 2.31 the lane is 2.29 away (just inside clearance, all 3 dropped);
  // at doorAlong = 2.29 it is 2.31 away (just outside, all 3 kept). No other lane is affected.
  assert.equal(deskPieceCount(2.31), MAX_DESK_SLOTS - 3, 'the a = 4.6 lane (3 rows) is dropped just inside the threshold');
  assert.equal(deskPieceCount(2.29), MAX_DESK_SLOTS, 'the a = 4.6 lane is kept just outside the threshold');
});

// --- No two floor-standing pieces overlap, at the full desk cap, over many seeds (issue
// #125 PR 153 review, two rounds): row spacing vs chair backs, a divider inside a desk,
// the bookshelf on the tombstone strip, the divider on a meeting seat, a desk on a
// standing spot. The tombstone strip (#127) and the base meeting-room furniture (the
// table seats and standing ring already built by `missionRooms.ts` itself, not by
// `furnishWarRoom`) are not rebuilt here; their footprints are the fixed positions the
// real room uses. ---

const TOMBSTONE_STRIP = { minA: -ROOM_SIZE / 2 + 0.2, maxA: -ROOM_SIZE / 2 + 1.75, minD: 1.4, maxD: 11.0 };

interface Rect { minA: number; maxA: number; minD: number; maxD: number }

function overlaps(x: Rect, y: Rect): boolean {
  return x.minA < y.maxA && y.minA < x.maxA && x.minD < y.maxD && y.minD < x.maxD;
}

/**
 * `missionRooms.ts`'s own meeting table seats (8, radius 1.9) and standing ring (12,
 * radius 3.0), centered on the room at `d = 6.2`, the same formula that file uses: a
 * world-space offset of `(cos(angle) * radius, 0, sin(angle) * radius)` from the center,
 * which for every mission room (its door is always on the south side) lands on
 * `a = radius * cos(angle)`, `d = 6.2 - radius * sin(angle)`. Each spot is a small circle
 * for an agent's body, not a point; `QUEUE_SPOT_RADIUS` is the same clearance every other
 * room already keeps around a spot like this (`furnishing.ts`).
 */
function meetingRoomSpots(): Rect[] {
  const spots: Rect[] = [];
  const ring = (count: number, radius: number) => {
    for (let i = 0; i < count; i++) {
      const angle = ((i + (count === 12 ? 0.5 : 0)) / count) * Math.PI * 2;
      const a = radius * Math.cos(angle);
      const d = 6.2 - radius * Math.sin(angle);
      spots.push({ minA: a - QUEUE_SPOT_RADIUS, maxA: a + QUEUE_SPOT_RADIUS, minD: d - QUEUE_SPOT_RADIUS, maxD: d + QUEUE_SPOT_RADIUS });
    }
  };
  ring(8, 1.9); // table seats
  ring(12, 3.0); // standing spots
  return spots;
}

// Issue #209: the base work set (1 desk + 1 debug station, no agents counted yet) is included
// alongside the full desk cap, so the fuzz covers both ends of the growth range, not just the top.
test('no two floor-standing pieces overlap, at the base work set and the full desk cap, over many seeds and door positions', () => {
  const failures: string[] = [];
  const meetingSpots = meetingRoomSpots();
  for (const doorAlong of [0, -1, -3, 1, 3]) {
    for (let seed = 0; seed < 40; seed++) {
      for (const counts of [ZERO, { deskLike: 6, debugging: 2 }]) {
        const plan = furnishWarRoom(`mission-overlap-${doorAlong}-${seed}-${counts.deskLike}`, counts, doorAlong);
        const boxes = plan.pieces.filter(standsOnFloor).map((p) => ({ name: p.piece.name, box: footprint(p) }));
        for (let i = 0; i < boxes.length; i++) {
          if (overlaps(boxes[i].box, TOMBSTONE_STRIP)) {
            failures.push(`${boxes[i].name} on the tombstone strip (door=${doorAlong}, seed=${seed}, counts=${counts.deskLike})`);
          }
          meetingSpots.forEach((spot, n) => {
            if (overlaps(boxes[i].box, spot)) {
              failures.push(`${boxes[i].name} on meeting-room spot ${n} (door=${doorAlong}, seed=${seed}, counts=${counts.deskLike})`);
            }
          });
          for (let j = i + 1; j < boxes.length; j++) {
            if (overlaps(boxes[i].box, boxes[j].box)) {
              failures.push(`${boxes[i].name} overlaps ${boxes[j].name} (door=${doorAlong}, seed=${seed}, counts=${counts.deskLike})`);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('every piece in a war room plan is a factory from the furniture library', () => {
  const plan = furnishWarRoom('mission-check', { deskLike: 6, debugging: 2 });
  for (const placement of plan.pieces) {
    assert.equal(typeof placement.piece.create, 'function', `${placement.piece.name} is a PieceSpec`);
  }
});

// Issue #209 retired the war room's sofa and its idle stations (the #126 review round 2
// sofa-footprint test above this used to cover); an idle mission agent now goes to the main
// room's lounge instead, covered in `tests/building.test.ts`.

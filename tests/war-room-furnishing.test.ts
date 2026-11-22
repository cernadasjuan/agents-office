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
const { furnishWarRoom, MAX_DESK_SLOTS } = await import('../src/addons/building/warRoomFurnishing.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const ZERO = { deskLike: 0, debugging: 0 };

// --- AC1: every war room has every must-have piece ---

test('AC1: a new war room has every must-have piece, even with no agents yet', () => {
  const plan = furnishWarRoom('mission-a', ZERO);
  const names: string[] = plan.pieces.map((p) => p.piece.name);
  for (const must of ['whiteboard', 'bookshelf', 'desk', 'debugStation']) {
    assert.ok(names.includes(must), `missing ${must}`);
  }
});

// --- Issue #209/round 6: a war room is a work space only — no sofa, no table, and (review
// round 2) no ornamental filler either: no clock, no plants, no water cooler, no TV, no rug. ---

test('issue #259 review round 2: a war room carries only its base work set, no ornamental filler, at any count', () => {
  for (const counts of [ZERO, { deskLike: 6, debugging: 2 }]) {
    const plan = furnishWarRoom('mission-no-lounge', counts);
    const names = plan.pieces.map((p) => p.piece.name);
    for (const banned of ['sofa', 'lowTable', 'clock', 'plant', 'tallPlant', 'waterCooler', 'tv', 'lowDivider', 'rug', 'meetingTable'] as const) {
      assert.ok(!names.includes(banned), `issue #259: no ${banned} in a war room`);
    }
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

// Review: at the room's own full slot cap, debugging headcount alone used to fill every slot
// and starve the base desk guaranteed above (debug stations fill first). A desk must still
// survive once the cap, not the floor, is what actually limits the grid.
test('review: the base desk survives even when debugging headcount alone fills the room\'s full slot cap', () => {
  const plan = furnishWarRoom('mission-debug-saturated', { deskLike: 0, debugging: 8 });
  const names = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation').map((p) => p.piece.name);
  assert.ok(names.includes('desk'), `missing the base desk, got ${names.join(',')}`);
});

// --- AC2: the same mission id gives the same layout, on every reload ---

test('AC2: the same mission id and counts furnish the same room every time', () => {
  const a = furnishWarRoom('mission-repeat', { deskLike: 3, debugging: 1 });
  const b = furnishWarRoom('mission-repeat', { deskLike: 3, debugging: 1 });
  assert.deepEqual(a.pieces.map((p) => [p.piece.name, p.edge, p.a, p.d, p.turn]), b.pieces.map((p) => [p.piece.name, p.edge, p.a, p.d, p.turn]));
  assert.deepEqual(a.stations, b.stations);
});

test('AC2: two different mission ids are not forced into the same layout', () => {
  const a = furnishWarRoom('mission-x', { deskLike: 3, debugging: 0 });
  const b = furnishWarRoom('mission-y', { deskLike: 3, debugging: 0 });
  assert.notDeepEqual(a.pieces.map((p) => [p.a, p.d]), b.pieces.map((p) => [p.a, p.d]), 'jitter differs by seed');
});

// --- Issue #259 review round 2: a smaller room, a smaller cap (down from 8) ---

test('issue #259 review round 2: the desk cap shrank along with the room, 4 to 6 slots', () => {
  assert.ok(MAX_DESK_SLOTS >= 4 && MAX_DESK_SLOTS <= 6, `MAX_DESK_SLOTS is ${MAX_DESK_SLOTS}, expected 4-6`);
});

test('every agent gets a desk at the room\'s own physical fit, not more', () => {
  const plan = furnishWarRoom('mission-full', { deskLike: MAX_DESK_SLOTS - 2, debugging: 2 });
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

// --- Issue #259 review round 2: every desk-like piece lives on one of the 4 walls set aside
// for them, never the door's own edge (0) or the display wall (3, opposite it) ---

test('every desk and debug station sits on a side wall (edge 1, 2, 4 or 5), never the door or the display wall', () => {
  const plan = furnishWarRoom('mission-walls', { deskLike: MAX_DESK_SLOTS, debugging: 0 });
  const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
  for (const p of deskPieces) assert.ok(p.edge !== undefined && [1, 2, 4, 5].includes(p.edge), `desk at edge ${p.edge} is not a side wall`);
});

// --- Round 7 (#214): the seated station lands in the piece's own built-in chair ---

test('#214: a desk or debug station seats its agent in the chair the piece actually renders, not across the room from it', async () => {
  const { HexFrame } = await import('../src/addons/building/HexFrame.js');
  const { testHexWarRoom } = await import('../src/addons/building/missionRooms.js');
  const hexRoom = testHexWarRoom(0);
  const plan = furnishWarRoom('mission-seat-alignment', { deskLike: MAX_DESK_SLOTS, debugging: 2 });
  const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
  for (const [i, p] of deskPieces.entries()) {
    const station = plan.stations[i];
    const pieceFrame = new HexFrame(hexRoom, (hexRoom.openEdges[0] + p.edge!) % 6);
    const stationFrame = new HexFrame(hexRoom, (hexRoom.openEdges[0] + station.edge!) % 6);
    const deskCenter = pieceFrame.point(p.a, p.d);
    const chairLocal = new THREE.Vector3(0, 0, 0.7).applyAxisAngle(new THREE.Vector3(0, 1, 0), pieceFrame.faceDoor + (p.turn ?? 0));
    const chairWorld = deskCenter.clone().add(chairLocal);
    const stationWorld = stationFrame.point(station.a, station.d);
    const gap = chairWorld.distanceTo(stationWorld);
    assert.ok(gap < 0.5, `station ${i} sits ${gap.toFixed(2)} m from its chair, should be seated in it`);
  }
});

test('every piece in a war room plan is a factory from the furniture library', () => {
  const plan = furnishWarRoom('mission-check', { deskLike: 6, debugging: 2 });
  for (const placement of plan.pieces) {
    assert.equal(typeof placement.piece.create, 'function', `${placement.piece.name} is a PieceSpec`);
  }
});

// Issue #209 retired the war room's sofa and its idle stations; an idle mission agent now goes
// to the main room's lounge instead, covered in `tests/building.test.ts`. The exhaustive
// per-mesh "stays inside its own hex interior" and "no mesh of a built room overlaps another"
// checks (every piece this plan places, at full desk/debug counts, several wings and ordinals)
// live in `tests/mission-rooms.test.ts` — they exercise the real hex room, not a hand-rolled
// rect-footprint model of one, which is the actual geometry that matters now.

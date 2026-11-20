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
const { furnishWarRoom, tierFor, MAX_DESK_SLOTS } = await import('../src/addons/building/warRoomFurnishing.js');
const { DOOR_WIDTH, ROOM_SIZE } = await import('../src/addons/building/RoomPlanner.js');
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
  const names = plan.pieces.map((p) => p.piece.name);
  for (const must of ['clock', 'whiteboard', 'bookshelf', 'sofa', 'lowTable']) {
    assert.ok(names.includes(must), `missing ${must}`);
  }
  assert.ok(names.filter((n) => n === 'plant' || n === 'tallPlant').length >= 3, 'plants present');
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

// --- Desk grid: debug stations fill first, capped at the room's physical fit ---

test('desk-like and debugging agents each get their own station, debug stations first', () => {
  const plan = furnishWarRoom('mission-desks', { deskLike: 3, debugging: 2 });
  const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
  assert.equal(deskPieces.length, 5);
  assert.equal(deskPieces.filter((p) => p.piece.name === 'debugStation').length, 2);
  assert.equal(plan.stations.filter((s) => s.type === 'debugging').length, 2);
  assert.equal(plan.stations.filter((s) => s.type === 'implementing').length, 3);
});

test('the desk grid caps at the physical fit; extra agents do not get an extra desk', () => {
  const plan = furnishWarRoom('mission-crowded', { deskLike: 10, debugging: 4 });
  const deskPieces = plan.pieces.filter((p) => p.piece.name === 'desk' || p.piece.name === 'debugStation');
  assert.equal(deskPieces.length, MAX_DESK_SLOTS);
  assert.equal(deskPieces.filter((p) => p.piece.name === 'debugStation').length, 4);
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
    assert.ok(box.minA >= -ROOM_SIZE / 2 && box.maxA <= ROOM_SIZE / 2 && box.minD >= 0 && box.maxD <= ROOM_SIZE, `${name} stands inside the room`);
    assert.ok(!hitsRect(box, -DOOR_WIDTH / 2, DOOR_WIDTH / 2, 0, 2.5), `${name} blocks the door`);
    assert.ok(!hitsRect(box, -DOOR_WIDTH / 2, DOOR_WIDTH / 2, ROOM_SIZE - 1, ROOM_SIZE), `${name} blocks the far-wall gap`);
  }
});

test('every piece in a war room plan is a factory from the furniture library', () => {
  const plan = furnishWarRoom('mission-check', { deskLike: 6, debugging: 2 });
  for (const placement of plan.pieces) {
    assert.equal(typeof placement.piece.create, 'function', `${placement.piece.name} is a PieceSpec`);
  }
});

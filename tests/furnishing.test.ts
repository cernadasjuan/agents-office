import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { Activity } from '../src/agents/ActivityAnimations.js';
import type { AgentExtras } from '../src/agents/AgentData.js';
import type { RoomKind } from '../src/addons/building/rooms.js';

// Furniture paints toon gradients on a canvas; signs need a document.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { PIECES } = await import('../src/furniture/index.js');
const { roomFurnishing, QUEUE_SPOT_RADIUS } = await import('../src/addons/building/furnishing.js');
const { buildRoom, DOOR_FRAME_TOP } = await import('../src/addons/building/rooms.js');
const { slotFor, DOOR_WIDTH, ROOM_SIZE } = await import('../src/addons/building/RoomPlanner.js');
const { createOffice } = await import('../src/scene/Office.js');
const { BuildingLayout } = await import('../src/addons/building/BuildingLayout.js');
const { applyPortraitImage, PORTRAIT_NAME } = await import('../src/furniture/Portrait.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

type Plan = ReturnType<typeof roomFurnishing>;
type Placement = Plan['pieces'][number];

/** The floor footprint of a placed piece in room coordinates (a along the door wall, d inward). */
function footprint(placement: Placement) {
  const object = placement.piece.create();
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const quarter = Math.round((placement.turn ?? 0) / (Math.PI / 2));
  assert.ok(Math.abs((placement.turn ?? 0) - quarter * Math.PI / 2) < 1e-9, `${placement.piece.name}: turns are quarter turns`);
  const swap = Math.abs(quarter) % 2 === 1;
  const [halfA, halfD] = swap
    ? [Math.max(-box.min.z, box.max.z), Math.max(-box.min.x, box.max.x)]
    : [Math.max(-box.min.x, box.max.x), Math.max(-box.min.z, box.max.z)];
  return { minA: placement.a - halfA, maxA: placement.a + halfA, minD: placement.d - halfD, maxD: placement.d + halfD, height: box.max.y - box.min.y };
}

const standsOnFloor = (placement: Placement) => footprint(placement).height > 0.05 && (placement.y ?? 0) < 0.5;

function hitsCircle(box: ReturnType<typeof footprint>, a: number, d: number, radius: number): boolean {
  const nearA = Math.max(box.minA, Math.min(a, box.maxA));
  const nearD = Math.max(box.minD, Math.min(d, box.maxD));
  return Math.hypot(nearA - a, nearD - d) < radius;
}

function hitsRect(box: ReturnType<typeof footprint>, minA: number, maxA: number, minD: number, maxD: number): boolean {
  return box.minA < maxA && minA < box.maxA && box.minD < maxD && minD < box.maxD;
}

// --- The furniture library ---

test('every piece in the furniture library is a factory that builds mergeable toon geometry', () => {
  assert.ok(Object.keys(PIECES).length >= 15, 'one place lists every piece');
  for (const [name, make] of Object.entries(PIECES)) {
    const spec = make();
    assert.equal(spec.name, name);
    const object = spec.create();
    let meshes = 0;
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      meshes++;
      assert.ok(child.material instanceof THREE.MeshToonMaterial, `${name}: toon material, so the static merge takes it`);
    });
    if (name === 'portrait') assert.ok(object.getObjectByName(PORTRAIT_NAME), 'the portrait is one sprite');
    else assert.ok(meshes > 0, `${name} builds geometry`);
  }
});

test('rooms.ts builds no furniture geometry inline: pieces come from the furniture library through one plan per room', () => {
  const rooms = readFileSync(new URL('../src/addons/building/rooms.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(rooms, /from '\.\.\/\.\.\/furniture\//, 'rooms.ts imports no factory directly');
  const furnishing = readFileSync(new URL('../src/addons/building/furnishing.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(furnishing, /new THREE\.|Geometry/, 'the plans hold positions only');
  for (const kind of ['office', 'desks', 'library', 'lab', 'lounge'] as const) {
    const plan = roomFurnishing(kind, { doorAlong: 0 });
    assert.ok(plan.pieces.length > 0, `${kind} has a plan`);
  }
});

test('a built room holds each planned piece, named after it, inside the static room zone', () => {
  const slot = slotFor(0);
  const room = buildRoom('office', slot, 0, []);
  const plan = roomFurnishing('office', { doorAlong: 0 });
  const placed: string[] = [];
  room.group.traverse((child) => { if (typeof child.userData.piece === 'string') placed.push(child.userData.piece); });
  assert.deepEqual(placed.sort(), plan.pieces.map((p) => p.piece.name).sort());
  assert.ok(room.group.userData.staticBatch, 'the room is marked static, so its furniture merges');
});

// --- Your office ---

test('your office reads as furnished: 6 or more pieces besides the desk, and 5 or more plants', () => {
  const plan = roomFurnishing('office', { doorAlong: 0 });
  const names: string[] = plan.pieces.map((p) => p.piece.name);
  const plants = plan.pieces.filter((p) => p.piece.category === 'plant');
  const furniture = plan.pieces.filter((p) => p.piece.category === 'furniture' && p.piece.name !== 'desk');
  assert.ok(plants.length >= 5, `${plants.length} plants`);
  assert.ok(furniture.length >= 6, `${furniture.length} pieces`);
  for (const wanted of ['rug', 'armchair', 'lowTable', 'displayShelf', 'wallArt', 'floorLamp', 'credenza', 'portrait']) {
    assert.ok(names.includes(wanted), `the office has a ${wanted}`);
  }
  assert.ok(names.includes('sofa') || names.filter((n) => n === 'armchair').length >= 2, 'a lounge corner: a sofa or two armchairs');
});

function assertPathsClear(kind: 'office' | 'lounge', doorAlong: number) {
  const plan = roomFurnishing(kind, { doorAlong });
  for (const placement of plan.pieces.filter(standsOnFloor)) {
    const box = footprint(placement);
    const name = `${kind} ${placement.piece.name} at (${placement.a}, ${placement.d})`;
    assert.ok(box.minA >= -ROOM_SIZE / 2 && box.maxA <= ROOM_SIZE / 2 && box.minD >= 0 && box.maxD <= ROOM_SIZE, `${name} stands inside the room`);
    // The way in from the hall, and the far wall door an outer room may open
    assert.ok(!hitsRect(box, doorAlong - DOOR_WIDTH / 2, doorAlong + DOOR_WIDTH / 2, 0, 2.5), `${name} blocks the door`);
    assert.ok(!hitsRect(box, -DOOR_WIDTH / 2, DOOR_WIDTH / 2, ROOM_SIZE - 1, ROOM_SIZE), `${name} blocks the far wall door`);
    for (const spot of plan.spots) {
      // A sofa carries its own seats
      if (spot.posture === 'seated' && placement.piece.name === 'sofa') continue;
      assert.ok(!hitsCircle(box, spot.a, spot.d, QUEUE_SPOT_RADIUS), `${name} stands on the ${spot.type} spot (${spot.a}, ${spot.d})`);
    }
  }
}

/** Every door position a real room slot has (`RoomFrame.doorAlong` of slots 0 to 13). */
const REAL_DOOR_POSITIONS = [0, 1, 2.5, -2.5];

test('the real slots have only these door positions', async () => {
  const { RoomFrame } = await import('../src/addons/building/rooms.js');
  const seen = new Set<number>();
  for (let index = 0; index < 14; index++) {
    const slot = slotFor(index);
    seen.add(Math.round(new RoomFrame(slot.rect, slot.door).doorAlong * 10) / 10 + 0);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [...REAL_DOOR_POSITIONS].sort((a, b) => a - b));
});

test('no office piece stands on a queue spot, in the door path or in the far wall door, at every real door position', () => {
  for (const doorAlong of REAL_DOOR_POSITIONS) assertPathsClear('office', doorAlong);
});

/** Every room kind keeps the far-wall gap clear: an outer room's door may open there. */
function assertFarWallDoorClear(kind: RoomKind, doorAlong: number) {
  const plan = roomFurnishing(kind, { doorAlong });
  for (const placement of plan.pieces.filter(standsOnFloor)) {
    const box = footprint(placement);
    const name = `${kind} ${placement.piece.name} at (${placement.a}, ${placement.d})`;
    assert.ok(!hitsRect(box, -DOOR_WIDTH / 2, DOOR_WIDTH / 2, ROOM_SIZE - 1, ROOM_SIZE), `${name} blocks the far wall door`);
  }
}

test('no piece in any room kind blocks the far-wall door gap an outer room may need', () => {
  for (const kind of ['office', 'desks', 'library', 'lab', 'lounge'] as const) {
    for (const doorAlong of REAL_DOOR_POSITIONS) assertFarWallDoorClear(kind, doorAlong);
  }
});

test('the lounge corner of an office goes to the side away from the door', () => {
  const corner = (doorAlong: number) => roomFurnishing('office', { doorAlong }).pieces.find((p) => p.piece.name === 'sofa')!.a;
  assert.ok(corner(0) < 0 && corner(2.5) < 0, 'door center or right: corner on the left');
  assert.ok(corner(-2.5) > 0, 'door on the left: corner on the right');
});

test('queue spots are spaced and staggered so queued agents stand apart', () => {
  const spots = roomFurnishing('office', { doorAlong: 0 }).spots.filter((s) => s.type === 'queue');
  assert.ok(spots.length >= 20, `${spots.length} spots before a second office opens`);
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      const gap = Math.hypot(spots[i].a - spots[j].a, spots[i].d - spots[j].d);
      assert.ok(gap >= 1.6, `spots ${i} and ${j} are ${gap.toFixed(2)} m apart`);
    }
  }
  // The front center fills first
  assert.equal(spots[0].a, 0);
  assert.equal(Math.max(...spots.map((s) => s.d)), spots[0].d);
});

// --- The lounges ---

test('each lounge has 8 or more plants, tall and small, and none blocks a seat or a door', () => {
  for (const doorAlong of REAL_DOOR_POSITIONS) {
    const plan = roomFurnishing('lounge', { doorAlong });
    const plants = plan.pieces.filter((p) => p.piece.category === 'plant');
    assert.ok(plants.length >= 8, `${plants.length} plants`);
    assert.ok(plants.some((p) => p.piece.name === 'tallPlant') && plants.some((p) => p.piece.name === 'plant'), 'tall and small');
    assert.equal(plan.spots.filter((s) => s.type === 'idle').length, 9, 'the nine sofa seats stay');
    assertPathsClear('lounge', doorAlong);
  }
});

// --- The portrait over your door ---

test('a framed portrait hangs over your office door on the hall side, a placeholder until a picture loads', () => {
  const slot = slotFor(0);
  const room = buildRoom('office', slot, 0, []);
  room.group.updateMatrixWorld(true);
  const portrait = room.group.getObjectByName(PORTRAIT_NAME)!;
  assert.ok(portrait instanceof THREE.Sprite, 'one sprite: it faces the hall and the overview');
  const at = portrait.getWorldPosition(new THREE.Vector3());
  assert.ok(at.x < slot.rect.minX, 'on the hall side of the door wall');
  assert.ok(Math.abs(at.z - slot.door.at) < 0.01, 'centered over the door');
  assert.ok(at.y - portrait.scale.y / 2 > DOOR_FRAME_TOP, 'above the lintel');
  assert.equal(portrait.userData.portraitState, 'placeholder');
  const image = { width: 400, height: 300 } as unknown as CanvasImageSource;
  applyPortraitImage(room.group, image);
  assert.equal(portrait.userData.portraitState, 'image');
});

test('a second waiting room has no portrait and no count sign: only your office does', () => {
  const second = buildRoom('office', slotFor(2), 2, []);
  assert.equal(second.group.getObjectByName(PORTRAIT_NAME), undefined);
  let signs = 0;
  second.group.traverse((o) => { if (o.userData.queueCount !== undefined) signs++; });
  assert.equal(signs, 0);
  assert.ok([...second.stations.values()].filter((s) => s.type === 'queue').length >= 20, 'it still has queue spots');
  assert.ok(roomFurnishing('office', { doorAlong: 0, usersOffice: false }).pieces.length >= 10, 'and the furniture');
});

test('only the office has a portrait', () => {
  for (const kind of ['desks', 'library', 'lab', 'lounge'] as const) {
    assert.equal(buildRoom(kind, slotFor(1), 1, []).group.getObjectByName(PORTRAIT_NAME), undefined, kind);
  }
});

test('under the portrait, a sign counts the fresh and aging waits, hidden when nobody waits', () => {
  const scene = new THREE.Scene();
  let clock = 0;
  const layout = new BuildingLayout(scene, createOffice(scene), { now: () => clock });
  const agent = (id: string, activity: Activity, extras?: AgentExtras) => ({ id, activity, ...(extras ? { extras } : {}) });
  const countSign = () => {
    let found: THREE.Object3D | undefined;
    scene.traverse((o) => { if (o.userData.queueCount !== undefined) found = o; });
    return found!;
  };
  layout.update();
  assert.equal(countSign().visible, false, 'nobody waits: no sign');
  layout.seatFor(agent('a', 'meeting', { attention: 'waiting', waitMinutes: 2 }), null);
  layout.seatFor(agent('b', 'meeting', { attention: 'waiting', waitMinutes: 60 }), null);
  layout.seatFor(agent('c', 'meeting', { attention: 'waiting', waitMinutes: 3000 }), null);
  clock += 60_000;
  layout.update();
  const sign = countSign() as THREE.Object3D & { element: HTMLElement };
  assert.equal(sign.visible, true);
  assert.equal(sign.element.textContent, '2 waiting', 'a fresh and an aging wait; a cold one does not count');
  // A meeting without a wait also queues, but it is not a wait for you
  layout.seatFor(agent('d', 'meeting'), null);
  clock += 60_000;
  layout.update();
  assert.equal(sign.element.textContent, '2 waiting', 'only fresh and aging waits count');
});

test('the browser asks this server once for the picture: a 204 keeps the placeholder, an image fills the frame', async () => {
  const { loadPortrait, resetLoadedPortrait, showLoadedPortrait, PORTRAIT_URL } = await import('../src/addons/building/portrait.js');
  resetLoadedPortrait();
  const asked: string[] = [];
  const respond = (status: number, type?: string) => async (url: string) => {
    asked.push(url);
    return new Response(status === 204 ? null : new Blob([new Uint8Array([1, 2, 3])]), { status, headers: type ? { 'content-type': type } : {} });
  };
  const decode = async () => ({ width: 10, height: 10 }) as unknown as CanvasImageSource;
  const room = buildRoom('office', slotFor(0), 0, []);
  const portrait = room.group.getObjectByName(PORTRAIT_NAME)!;
  assert.equal(await loadPortrait(room.group, { fetch: respond(204), decode }), false);
  assert.equal(portrait.userData.portraitState, 'placeholder');
  assert.equal(await loadPortrait(room.group, { fetch: respond(200, 'text/html'), decode }), false, 'only an image');
  assert.equal(await loadPortrait(room.group, { fetch: async () => { throw new Error('offline'); }, decode }), false, 'never throws');
  assert.equal(portrait.userData.portraitState, 'placeholder');
  assert.equal(await loadPortrait(room.group, { fetch: respond(200, 'image/png'), decode }), true);
  assert.equal(portrait.userData.portraitState, 'image');
  assert.deepEqual([...new Set(asked)], [PORTRAIT_URL], 'the local route only, no other address');
  // Your office built after the picture loaded (a layout switch rebuilds it) gets the picture too
  const later = buildRoom('office', slotFor(0), 0, []);
  showLoadedPortrait(later.group);
  assert.equal(later.group.getObjectByName(PORTRAIT_NAME)!.userData.portraitState, 'image');
  resetLoadedPortrait();
});

test('wall art, the shelf and the credenza face into the room, and the armchairs face the low table', () => {
  for (const index of [0, 2, 5]) {
    const slot = slotFor(index);
    const room = buildRoom('office', slot, index, []);
    room.group.updateMatrixWorld(true);
    const center = new THREE.Vector3((slot.rect.minX + slot.rect.maxX) / 2, 0, (slot.rect.minZ + slot.rect.maxZ) / 2);
    const table = room.group.children.find((object) => object.userData.piece === 'lowTable')!.getWorldPosition(new THREE.Vector3());
    let armchairs = 0;
    room.group.traverse((object) => {
      const piece = object.userData.piece;
      if (!['wallArt', 'armchair', 'displayShelf', 'credenza'].includes(piece)) return;
      const front = object.getWorldDirection(new THREE.Vector3()).setY(0);
      const target = piece === 'armchair' ? table : center;
      if (piece === 'armchair') armchairs++;
      const toward = target.clone().sub(object.getWorldPosition(new THREE.Vector3())).setY(0).normalize();
      assert.ok(front.dot(toward) > 0.5, `room ${index}: ${piece} faces ${piece === 'armchair' ? 'the table' : 'the room'} (dot ${front.dot(toward).toFixed(2)})`);
    });
    assert.equal(armchairs, 2);
  }
});

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { HALL, rectsOverlap, slotFor, wallPieces } from '../src/addons/building/RoomPlanner.js';
import type { Activity } from '../src/agents/ActivityAnimations.js';
import type { AgentExtras } from '../src/agents/AgentData.js';

// Furniture paints toon gradients on a canvas; room signs need a document.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { createOffice } = await import('../src/scene/Office.js');
const { BuildingLayout, BUILDING_STORAGE_KEY } = await import('../src/addons/building/BuildingLayout.js');
const { missionSlot } = await import('../src/addons/building/missionRooms.js');
const { projectWorld } = await import('../server/seam.js');

/** The same hashing `server/vitePlugin.ts` uses for `publicId`, with its own random key held
 * for the whole call (one key, so the same raw string always hashes the same, the way one
 * server run does): a room's real client-facing `id` never carries the raw `mission:<slug>`
 * key it came from (issue #89 review, fix 2 — `roomView` must match through this, not an
 * injected raw id). */
function createFakePublicId(): (raw: string) => string {
  const key = randomBytes(32).toString('hex');
  return (raw: string) => createHmac('sha256', key).update(raw).digest('hex');
}
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

// --- Planner ---

test('the first ring of rooms surrounds the hall without overlap, the office first on the east side', () => {
  const slots = Array.from({ length: 7 }, (_, i) => slotFor(i));
  assert.deepEqual(slots[0].rect, { minX: 15, maxX: 27, minZ: -6, maxZ: 6 });
  for (let i = 0; i < slots.length; i++) {
    assert.equal(rectsOverlap(slots[i].rect, HALL), false, `slot ${i} overlaps the hall`);
    for (let j = i + 1; j < slots.length; j++) assert.equal(rectsOverlap(slots[i].rect, slots[j].rect), false, `${i} overlaps ${j}`);
  }
});

test('an outer room sits one room further out and opens toward the room inside it', () => {
  const outer = slotFor(7);
  assert.deepEqual(outer.rect, { minX: 27, maxX: 39, minZ: -6, maxZ: 6 });
  assert.deepEqual(outer.door, { side: 'west', at: 0 });
  assert.equal(outer.ring, 1);
});

test('walls leave a door-wide gap at each door', () => {
  const pieces = wallPieces({ minX: 0, maxX: 12, minZ: 0, maxZ: 12 }, [{ side: 'west', at: 6 }]).filter((p) => p.side === 'west');
  assert.deepEqual(pieces, [{ side: 'west', from: 0, to: 4.8 }, { side: 'west', from: 7.2, to: 12 }]);
});

// --- Layout ---

/** The real built floor rect of `room-${index}-${kind}` (`src/addons/building/rooms.ts`'s own name), not `slotFor` in isolation. */
function builtRoomRect(scene: THREE.Scene, index: number, kind: string): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const group = scene.getObjectByName(`room-${index}-${kind}`);
  if (!group) throw new Error(`no built room named room-${index}-${kind}`);
  let floor: THREE.Object3D | undefined;
  group.traverse((object) => { if (object.userData.floor) floor = object; });
  if (!floor) throw new Error(`room-${index}-${kind} has no floor`);
  const box = new THREE.Box3().setFromObject(floor);
  return { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z };
}

function setup(storage = new Map<string, string>()) {
  let clock = 0;
  let wallClock = Date.parse('2026-11-20T00:00:00Z');
  const scene = new THREE.Scene();
  const layout = new BuildingLayout(scene, createOffice(scene), {
    now: () => clock,
    wallClock: () => wallClock,
    dwellMs: 4000,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
  });
  const agent = (id: string, activity: Activity, extras?: AgentExtras) => ({ id, activity, ...(extras ? { extras } : {}) });
  return {
    scene, layout, storage, agent,
    tick: (ms: number) => { clock += ms; wallClock += ms; return layout.update(); },
  };
}

test('the building opens with the user office and the Library, and remembers its rooms', () => {
  const { layout, storage, scene } = setup();
  assert.deepEqual(layout.roomKinds, ['office', 'library']);
  assert.equal(storage.get(BUILDING_STORAGE_KEY), '["office","library"]');
  assert.ok(scene.getObjectByName('building-hall-walls'));
});

test('an agent keeps its home desk, makes a trip after the dwell time, and comes back to the same desk', () => {
  const { layout, agent, tick } = setup();
  const home = layout.seatFor(agent('a', 'implementing'), null)!;

  assert.equal(layout.seatFor(agent('a', 'testing'), 'implementing'), null, 'no move before the dwell time');
  assert.deepEqual(tick(3000).filter((m) => m.agentId === 'a'), []);
  const trip = tick(1500).find((m) => m.agentId === 'a')!;
  assert.match(trip.seat.key, /^test_/);

  layout.seatFor(agent('a', 'debugging'), 'testing');
  const back = tick(4500).find((m) => m.agentId === 'a')!;
  assert.equal(back.seat.key, home.key);
});

test('a non-librarian keeps its home desk through a research activity: no trip, no move at all (issue #128 AC2)', () => {
  const { layout, agent, tick } = setup();
  const home = layout.seatFor(agent('a', 'implementing'), null)!;

  assert.equal(layout.seatFor(agent('a', 'researching'), 'implementing'), null, 'the target does not change, so there is nothing to move to after the dwell time');
  assert.deepEqual(tick(4500).filter((m) => m.agentId === 'a'), []);

  layout.seatFor(agent('a', 'debugging'), 'researching');
  assert.deepEqual(tick(4500).filter((m) => m.agentId === 'a'), [], 'still at the same desk the whole time');
  assert.equal(layout.seatFor(agent('a', 'implementing'), 'debugging'), null);
});

test('a planning agent with no war room stays at its desk, not the lounge (#131)', () => {
  const { layout, agent, tick } = setup();
  const home = layout.seatFor(agent('a', 'implementing'), null)!;
  assert.equal(layout.seatFor(agent('a', 'planning'), 'implementing'), null, 'planning is desk work: no move pending');
  assert.deepEqual(tick(5000).filter((m) => m.agentId === 'a'), [], 'no trip ever starts for planning');
  assert.equal(layout.seatFor(agent('a', 'debugging'), 'planning'), null, 'still the same desk');
});

test('the planning RoomKind no longer exists: the building never opens one', () => {
  const { layout } = setup();
  assert.ok(!layout.roomKinds.includes('planning' as never), 'no planning room kind is ever recorded');
});

test('a saved building with an old planning room in storage drops it silently (#131)', () => {
  const storage = new Map<string, string>([[BUILDING_STORAGE_KEY, '["office","planning","library"]']]);
  const { layout } = setup(storage);
  assert.deepEqual(layout.roomKinds, ['office', 'library'], 'the stale planning entry is filtered out, no error');
});

test('an agent with no war room that writes docs stays at its desk, not the lounge (#141)', () => {
  const { layout, agent, tick } = setup();
  const home = layout.seatFor(agent('a', 'implementing'), null)!;
  assert.equal(layout.seatFor(agent('a', 'writing_docs'), 'implementing'), null, 'writing docs is desk work: no move pending');
  assert.deepEqual(tick(5000).filter((m) => m.agentId === 'a'), [], 'no trip ever starts for writing docs');
  assert.equal(layout.seatFor(agent('a', 'reviewing'), 'writing_docs'), null, 'still the same desk');
});

test('the review RoomKind no longer exists: the building never opens a writing room', () => {
  const { layout } = setup();
  assert.ok(!layout.roomKinds.includes('review' as never), 'no review room kind is ever recorded');
});

test('a saved building with an old writing room in storage drops it silently (#141)', () => {
  const storage = new Map<string, string>([[BUILDING_STORAGE_KEY, '["office","review","library"]']]);
  const { layout } = setup(storage);
  assert.deepEqual(layout.roomKinds, ['office', 'library'], 'the stale review entry is filtered out, no error');
});

test('a short tool call does not make the agent walk', () => {
  // Uses 'testing' (not 'researching', issue #128 review): a non-librarian's research no
  // longer creates a pending trip at all, so it could no longer prove cancellation works.
  const { layout, agent, tick } = setup();
  layout.seatFor(agent('a', 'implementing'), null);
  layout.seatFor(agent('a', 'testing'), 'implementing');
  tick(1000);
  layout.seatFor(agent('a', 'implementing'), 'testing');
  assert.deepEqual(tick(5000).filter((m) => m.agentId === 'a'), []);
});

test('agents blocked on the user go straight to the office and line up by how long they waited', () => {
  const { layout, agent, tick } = setup();
  for (const [id, wait] of [['short', 1], ['long', 10], ['mid', 5]] as const) {
    layout.seatFor(agent(id, 'implementing'), null);
    const seat = layout.seatFor(agent(id, 'meeting', { attention: 'waiting', waitMinutes: wait }), 'implementing');
    assert.match(seat!.key, /^room0_queue_/, `${id} goes to the office at once`);
  }
  tick(600);
  const spotOf = (id: string) => (layout as unknown as { agents: Map<string, { seat: string }> }).agents.get(id)!.seat;
  assert.deepEqual(['long', 'mid', 'short'].map(spotOf), ['room0_queue_0', 'room0_queue_1', 'room0_queue_2']);

  layout.release('long');
  const moves = tick(600);
  assert.deepEqual(moves.map((m) => [m.agentId, m.seat.key]).sort(), [['mid', 'room0_queue_0'], ['short', 'room0_queue_1']]);
});

test('the queue puts fresh waits before aging ones, the oldest first inside each band, your turn included', () => {
  const { layout, agent, tick } = setup();
  const waits = [['aging-young', 'waiting', 20], ['fresh-young', 'your-turn', 1], ['aging-old', 'your-turn', 600], ['fresh-old', 'waiting', 14]] as const;
  for (const [id, attention, wait] of waits) {
    layout.seatFor(agent(id, 'implementing'), null);
    const activity = attention === 'waiting' ? 'meeting' : 'idle';
    const seat = layout.seatFor(agent(id, activity, { attention, waitMinutes: wait }), 'implementing');
    assert.match(seat!.key, /^room0_queue_/, `${id} goes to the office at once`);
  }
  tick(600);
  const spotOf = (id: string) => (layout as unknown as { agents: Map<string, { seat: string }> }).agents.get(id)!.seat;
  assert.deepEqual(['fresh-old', 'fresh-young', 'aging-old', 'aging-young'].map(spotOf),
    ['room0_queue_0', 'room0_queue_1', 'room0_queue_2', 'room0_queue_3']);
});

test('14 waiting agents fill three rows, longest wait at the front, a new one joins at the back and a leaver closes up the line (#132)', () => {
  const { layout, agent, tick } = setup();
  // Longest wait first: a14 waited 14 minutes, a1 waited 1.
  for (let i = 14; i >= 1; i--) {
    const id = `a${i}`;
    layout.seatFor(agent(id, 'implementing'), null);
    const seat = layout.seatFor(agent(id, 'meeting', { attention: 'waiting', waitMinutes: i }), 'implementing');
    assert.match(seat!.key, /^room0_queue_/, `${id} goes to the office at once`);
  }
  tick(600);
  const spotOf = (id: string) => (layout as unknown as { agents: Map<string, { seat: string }> }).agents.get(id)!.seat;
  const seats = Array.from({ length: 14 }, (_, i) => spotOf(`a${14 - i}`));
  assert.deepEqual(seats, Array.from({ length: 14 }, (_, i) => `room0_queue_${i}`), 'the longest wait (a14) holds queue_0, the front of the line');
  assert.equal(layout.roomKinds.filter((k) => k === 'office').length, 1, '14 waits still fit in the first office: no second waiting room');

  // A new wait joins at the back.
  layout.seatFor(agent('new', 'implementing'), null);
  layout.seatFor(agent('new', 'meeting', { attention: 'waiting', waitMinutes: 0 }), 'implementing');
  tick(600);
  assert.equal(spotOf('new'), 'room0_queue_14', 'the newest, shortest wait joins at the back');

  // The front of the line leaves; everyone behind it closes up by one spot.
  layout.release('a14');
  tick(600);
  assert.equal(spotOf('a13'), 'room0_queue_0', 'the next-longest wait now leads the line');
  assert.equal(spotOf('new'), 'room0_queue_13', 'the line closed up behind the agent that left');
});

test('a cold wait leaves the queue for the lounge and never joins it', () => {
  const { layout, agent, tick } = setup();
  layout.seatFor(agent('b', 'implementing'), null);
  assert.match(layout.seatFor(agent('b', 'meeting', { attention: 'waiting', waitMinutes: 600 }), 'implementing')!.key, /^room0_queue_/);
  assert.equal(layout.seatFor(agent('b', 'meeting', { attention: 'waiting', waitMinutes: 24 * 60 }), 'meeting'), null, 'leaves after the dwell time');
  const leave = tick(4500).find((m) => m.agentId === 'b')!;
  assert.doesNotMatch(leave.seat.key, /queue/);

  const cold = layout.seatFor(agent('c', 'idle', { attention: 'your-turn', waitMinutes: 3 * 24 * 60 }), null)!;
  assert.doesNotMatch(cold.key, /queue/);
});

test('your turn without a wait time stays out of the queue, as before', () => {
  const { layout, agent } = setup();
  const seat = layout.seatFor(agent('y', 'idle', { attention: 'your-turn' }), null)!;
  assert.doesNotMatch(seat.key, /queue/);
});

test('the building rents a desk room when the hall desks are taken, and rebuilds it after a reload', () => {
  const { layout, agent, storage } = setup();
  const seats = Array.from({ length: 10 }, (_, i) => layout.seatFor(agent(`s${i}`, 'implementing'), null)!);
  assert.equal(new Set(seats.map((s) => s.key)).size, 10);
  assert.deepEqual(layout.roomKinds, ['office', 'library', 'desks']);

  const reloaded = setup(storage).layout;
  assert.deepEqual(reloaded.roomKinds, ['office', 'library', 'desks']);
});

test('a saved 3-room layout rents each kind at the slot its index gives it, the same way on every reload (issue #128 review round 2)', () => {
  // Rooms are remembered by kind, in rental order, and rented back in that same order on
  // reload (`roomKinds` above): slotFor(index) decides where each one physically sits, by
  // index alone, not by kind. For office/library/desks that is slot 0 (east-center, unmoved),
  // slot 1 (south-east since issue #120's swap) and slot 2 (north-east, where the Library
  // itself used to sit before that swap). This is the one-time move the swap causes for
  // anyone with an existing saved building of 3 or more rooms: whatever room was third stays
  // third, but the ground under it moved. Noted in README.md and CHANGELOG.md.
  //
  // This asserts the layout's own built rooms (by their `room-${index}-${kind}` name in the
  // scene, `src/addons/building/rooms.ts`), not `slotFor` in isolation: a bug in `addRoom`
  // that called `slotFor` with the wrong index would still leave `slotFor` itself correct,
  // and a test that only re-checked `slotFor` would never see it (issue #128 review round 2).
  const storage = new Map([[BUILDING_STORAGE_KEY, JSON.stringify(['office', 'library', 'desks'])]]);
  const { layout, scene } = setup(storage);
  assert.deepEqual(layout.roomKinds, ['office', 'library', 'desks']);
  const office = builtRoomRect(scene, 0, 'office');
  const library = builtRoomRect(scene, 1, 'library');
  const desks = builtRoomRect(scene, 2, 'desks');
  assert.deepEqual(office, { minX: 15, maxX: 27, minZ: -6, maxZ: 6 }, 'office: east-center, unmoved');
  assert.ok(library.minZ > 0, `library: south-east (issue #120), got ${JSON.stringify(library)}`);
  assert.ok(desks.minZ < 0, `desks: north-east, where the library used to be, got ${JSON.stringify(desks)}`);

  // Reloading the same saved kind order again lands every room at the same physical rect.
  const again = setup(new Map(storage));
  assert.deepEqual(again.layout.roomKinds, layout.roomKinds);
  assert.deepEqual(builtRoomRect(again.scene, 0, 'office'), office, 'office: same rect after reload');
  assert.deepEqual(builtRoomRect(again.scene, 1, 'library'), library, 'library: same rect after reload');
  assert.deepEqual(builtRoomRect(again.scene, 2, 'desks'), desks, 'desks: same rect after reload');
});

test('idle agents beyond the hall seats get a lounge room', () => {
  const { layout, agent } = setup();
  for (let i = 0; i < 10; i++) layout.seatFor(agent(`i${i}`, 'idle'), null);
  assert.ok(layout.roomKinds.includes('lounge'));
});

test('subagents gather around their parent desk', () => {
  const { layout, agent } = setup();
  const desk = layout.seatFor(agent('parent', 'implementing'), null)!;
  const helper = layout.seatFor(agent('child', 'researching', { parentId: 'parent' }), null)!;
  assert.match(helper.key, /_pod\d$/);
  assert.ok(helper.position.distanceTo(desk.position) < 2);
});

test('the hall side walls are replaced by walls with doors', () => {
  const { scene } = setup();
  const original = scene.getObjectByName('office-walls')!;
  const tallWalls = original.children.filter((c) => c instanceof THREE.Mesh && (c.geometry as THREE.BoxGeometry).parameters?.height === 6);
  assert.ok(tallWalls.length === 4 && tallWalls.every((wall) => !wall.visible));
});

// --- Mission war rooms ---

const missionRoom = (state: 'open' | 'locked' = 'open') => ({
  id: 'room-1', kind: 'mission' as const, title: 'Office roadmap', state,
  sleepers: [{ id: 'tomb-1' }, { id: 'tomb-2' }, { id: 'tomb-3' }],
  walls: { statement: 'Ship it', docs: ['Explainer'], issues: [{ number: 46, title: 'Parent', state: 'open' as const }], kanban: [] },
});

test('a mission becomes a war room north of the hall, with a door in the hall back wall', () => {
  const { layout, scene } = setup();
  layout.syncWorldRooms([missionRoom()]);
  assert.equal(layout.missionRoomCount, 1);
  const room = scene.getObjectByName('mission-room-0')!;
  const floor = room.children.find((c) => c.userData.floor)!;
  assert.ok(floor.position.z < -13, 'north of the hall');
  const hallWalls = scene.getObjectByName('building-hall-walls')!;
  const northPieces = hallWalls.children.filter((w) => Math.abs(w.position.z + 13) < 0.01);
  assert.ok(northPieces.length >= 2, 'the back wall has a door gap');
});

test('agents of a mission work in its war room, their helpers stand near them, and a locked room keeps them out', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const seat = layout.seatFor(agent('s', 'implementing', { room: 'room-1' }), null)!;
  assert.match(seat.key, /^mission0_/);
  const helper = layout.seatFor(agent('h', 'researching', { parentId: 's' }), null)!;
  assert.match(helper.key, /^mission0_.+_pod\d$/);

  layout.syncWorldRooms([missionRoom('locked')]);
  const late = layout.seatFor(agent('late', 'implementing', { room: 'room-1' }), null)!;
  assert.doesNotMatch(late.key, /^mission/);
});

// --- Issue #126: war-room furniture routes agent activity, in-room first ---

test('AC1/AC2/AC3: researching, planning and idle agents go to their own room\'s bookshelf, whiteboard and sofa', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const researching = layout.seatFor(agent('r', 'researching', { room: 'room-1' }), null)!;
  assert.match(researching.key, /^mission0_furniture_\d+$/);
  const planning = layout.seatFor(agent('p', 'planning', { room: 'room-1' }), null)!;
  assert.match(planning.key, /^mission0_furniture_\d+$/);
  const idle = layout.seatFor(agent('i', 'idle', { room: 'room-1' }), null)!;
  assert.match(idle.key, /^mission0_furniture_\d+$/);
  // Three different pieces, not the same one shared by coincidence
  assert.equal(new Set([researching.key, planning.key, idle.key]).size, 3);
});

test('AC5: a researching mission agent never goes to the library-knowledge shelves', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const seat = layout.seatFor(agent('r', 'researching', { room: 'room-1' }), null)!;
  assert.doesNotMatch(seat.key, /^room1_researching_/, 'room1 is the building Library, not the war room');
});

test('AC4: once the room\'s one researching spot is taken, the next researcher still stays in the room, not a dedicated room', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  layout.seatFor(agent('r1', 'researching', { room: 'room-1' }), null);
  const seat = layout.seatFor(agent('r2', 'researching', { room: 'room-1' }), null)!;
  assert.match(seat.key, /^mission0_/, 'still in the war room: the generic ring, not the library or a dedicated room');
});

// --- Issue #129: a 9th desk-like agent overflows to the room's standing ring, not a 9th desk ---

test('AC4 (#129): once a war room\'s 8 desk slots are full, the next desk-like agent uses the room\'s standing ring', () => {
  const { layout, agent, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);
  for (let i = 0; i < 8; i++) layout.seatFor(agent(`d${i}`, 'implementing', { room: 'room-1' }), null);
  tick(0); // grows the desk grid to its 8-slot cap
  for (let i = 0; i < 8; i++) layout.seatFor(agent(`d${i}`, 'implementing', { room: 'room-1' }), null);
  const overflow = layout.seatFor(agent('d8', 'implementing', { room: 'room-1' }), null)!;
  assert.doesNotMatch(overflow.key, /_furniture_/, 'no 9th desk piece');
  assert.match(overflow.key, /^mission0_seat_/, 'the room\'s own standing ring instead');
});

test('a waiting agent still goes to the user office before its war room', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const seat = layout.seatFor(agent('w', 'meeting', { room: 'room-1', attention: 'waiting' }), null)!;
  assert.match(seat.key, /^room0_queue_/);
});

test('a war room\'s furniture grows with the agents actually seated in it (issue #125)', () => {
  const { layout, agent, scene, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const warRoom = scene.getObjectByName('mission-room-0')!;
  const pieceCount = (name: string) => {
    let n = 0;
    warRoom.traverse((o) => { if (o.userData.piece === name) n++; });
    return n;
  };
  assert.equal(pieceCount('desk') + pieceCount('debugStation'), 0, 'no one works there yet');

  layout.seatFor(agent('a', 'implementing', { room: 'room-1' }), null);
  layout.seatFor(agent('b', 'implementing', { room: 'room-1' }), null);
  layout.seatFor(agent('c', 'debugging', { room: 'room-1' }), null);
  tick(0);
  assert.equal(pieceCount('desk'), 2);
  assert.equal(pieceCount('debugStation'), 1);

  // The debugger leaves; the furniture stays at its peak
  layout.seatFor(agent('c', 'idle', { room: 'room-1' }), 'debugging');
  tick(0);
  assert.equal(pieceCount('desk'), 2);
  assert.equal(pieceCount('debugStation'), 1);
});

// --- roomView (issue #89, #room=) ---

test('roomView("office") frames the user\'s office, the room at slot 0, never a later waiting room', () => {
  const { layout } = setup();
  const view = layout.roomView('office')!;
  assert.ok(view, 'office exists from the start');
  const officeRect = slotFor(0).rect;
  assert.deepEqual([view.bounds.min.x, view.bounds.max.x, view.bounds.min.z, view.bounds.max.z], [officeRect.minX, officeRect.maxX, officeRect.minZ, officeRect.maxZ]);
  assert.ok(view.bounds.max.y > view.bounds.min.y, 'has floor-to-wall height, not a flat box');
});

test('roomView is case-insensitive and trims whitespace', () => {
  const { layout } = setup();
  assert.deepEqual(layout.roomView('OFFICE'), layout.roomView('office'));
  assert.deepEqual(layout.roomView('  library  '), layout.roomView('library'));
});

test('roomView returns null for a kind that is not yet open and for any unknown name', () => {
  const { layout } = setup();
  assert.equal(layout.roomView('lab'), null, 'no test lab has been rented yet');
  assert.equal(layout.roomView('not-a-room'), null);
  assert.equal(layout.roomView(''), null);
});

test('roomView matches a mission room by its slugified title or its public id — through the real projectWorld projection (review fix 2)', () => {
  const { layout } = setup();
  assert.equal(layout.roomView('media-plan-q1'), null, 'not open yet');

  // The real server projection: the client only ever sees the hashed id and the display
  // title, never the raw `mission:<slug>` key this started from.
  const publicId = createFakePublicId();
  const projected = projectWorld(
    [{ rooms: [{ key: 'mission:media-plan-q1', kind: 'mission', title: 'Media Plan Q1', state: 'open', walls: {} }] }],
    ['missions'],
    publicId,
  ).rooms[0]!;
  assert.notEqual(projected.id, 'mission:media-plan-q1', 'the id a client sees is hashed, not the raw key');
  assert.equal(projected.title, 'Media Plan Q1');

  layout.syncWorldRooms([{ id: projected.id, kind: 'mission', title: projected.title, state: 'open', sleepers: [], walls: {} }]);

  assert.equal(layout.roomView('mission:media-plan-q1'), null, 'the raw server-side key never works on the client');
  const byTitle = layout.roomView('media-plan-q1')!;
  assert.ok(byTitle, 'matches by the slugified title instead');
  const byUppercaseTitle = layout.roomView('Media-Plan-Q1')!;
  assert.deepEqual(byUppercaseTitle, byTitle, 'case-insensitive, like every other roomView name');
  const byId = layout.roomView(projected.id)!;
  assert.deepEqual(byId, byTitle, 'the exact public id also works, for a reviewer who copies it from /api/world');

  const missionRect = missionSlot(0).rect;
  assert.deepEqual([byTitle.bounds.min.x, byTitle.bounds.max.x, byTitle.bounds.min.z, byTitle.bounds.max.z],
    [missionRect.minX, missionRect.maxX, missionRect.minZ, missionRect.maxZ]);
});

test('roomView picks none when two mission rooms slugify to the same title; the exact public id still works (review fix round 2)', () => {
  const { layout } = setup();
  const publicId = createFakePublicId();
  const projected = projectWorld(
    [{ rooms: [
      { key: 'mission:media-plan', kind: 'mission', title: 'Media Plan', state: 'open', walls: {} },
      { key: 'mission:media/plan', kind: 'mission', title: 'Media/Plan', state: 'open', walls: {} },
    ] }],
    ['missions'],
    publicId,
  ).rooms;
  assert.notEqual(projected[0]!.id, projected[1]!.id, 'two distinct rooms, two distinct ids');

  layout.syncWorldRooms(projected.map((room) => ({ id: room.id, kind: 'mission' as const, title: room.title, state: 'open' as const, sleepers: [], walls: {} })));

  assert.equal(layout.roomView('media-plan'), null, 'ambiguous by title: picks none, not whichever came first');
  assert.ok(layout.roomView(projected[0]!.id), 'the exact public id still resolves its own room');
  assert.ok(layout.roomView(projected[1]!.id), 'and the other room by its own id');
  assert.notDeepEqual(layout.roomView(projected[0]!.id), layout.roomView(projected[1]!.id));
});

test('roomView\'s first-person standing point sits inside the room, facing further into it', () => {
  const { layout } = setup();
  const view = layout.roomView('office')!;
  const rect = slotFor(0).rect;
  assert.ok(view.standing.position.x > rect.minX && view.standing.position.x < rect.maxX, 'inside the room on x');
  assert.ok(view.standing.position.z > rect.minZ && view.standing.position.z < rect.maxZ, 'inside the room on z');
  assert.ok(view.standing.position.y > 0, 'a standing eye height, not on the floor');
  const facing = view.standing.lookAt.clone().sub(view.standing.position);
  assert.ok(facing.lengthSq() > 0, 'looks somewhere other than straight down at its own feet');
});

// --- Library and librarians ---

test('the Librarian persona badge reaches the Library room before the hall shelves (issue #128)', () => {
  const { layout, agent } = setup();
  const seat = layout.seatFor(agent('r', 'researching', { badges: ['librarian'] }), null)!;
  assert.match(seat.key, /^room1_researching_/);
});

test('a librarian walks to the Library to research and back to its agent with what it found', () => {
  const { layout, agent, tick } = setup();
  const desk = layout.seatFor(agent('parent', 'implementing'), null)!;
  const fetching = layout.seatFor(agent('lib', 'researching', { parentId: 'parent', badges: ['librarian'] }), null)!;
  assert.match(fetching.key, /^room1_researching_/);

  layout.seatFor(agent('lib', 'writing_docs', { parentId: 'parent', badges: ['librarian'] }), 'researching');
  const back = tick(4500).find((m) => m.agentId === 'lib')!;
  assert.match(back.seat.key, /_pod\d$/);
  assert.ok(back.seat.position.distanceTo(desk.position) < 2);
});

test('an old-style role tag, with no Librarian persona badge, no longer reaches the Library (issue #128, Prospero\'s review)', () => {
  const { layout, agent } = setup();
  const seat = layout.seatFor(agent('r', 'researching', { role: 'librarian' }), null)!;
  assert.doesNotMatch(seat.key, /^room1_researching_/, 'a name or role tag alone is not the persona signal');
});

test('a main session with no Librarian badge and no war room keeps its own desk for a research trip, not the Library (issue #128 AC2)', () => {
  const { layout, agent } = setup();
  const seat = layout.seatFor(agent('r', 'researching'), null)!;
  assert.doesNotMatch(seat.key, /^room1_researching_/);
  assert.doesNotMatch(seat.key, /researching/, 'it never visits any researching station, hall shelves included');
  assert.match(seat.key, /^desk_/);
});

test('a main session with a war room keeps a non-librarian research trip inside that room, not the Library (issue #128 AC3)', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const seat = layout.seatFor(agent('r', 'researching', { room: 'room-1' }), null)!;
  // Issue #126, after this AC was written: a researching agent in a war room prefers that
  // room's own bookshelf (`mission0_furniture_*`) over its generic ring (`mission0_seat_*`).
  // Either one satisfies this AC's real point, inside the war room and never the Library.
  assert.match(seat.key, /^mission0_(seat|furniture)_/, 'inside its own war room');
  assert.doesNotMatch(seat.key, /^room1_researching_/, 'never the Library');
});

test('an ordinary subagent that researches stays at its parent desk', () => {
  const { layout, agent } = setup();
  layout.seatFor(agent('parent', 'implementing'), null);
  assert.match(layout.seatFor(agent('helper', 'researching', { parentId: 'parent' }), null)!.key, /_pod\d$/);
});

test('a non-librarian subagent whose parent has no seat yet never reaches the Library, even on this exact timing (issue #128 review)', () => {
  // A real race: a subagent is polled in the same cycle as its freshly spawned, not-yet-seated
  // parent. The persona check and the pod check both fall through; the generic research
  // routing must still never land on the Library's own shelves.
  const { layout, agent } = setup();
  const seat = layout.seatFor(agent('helper', 'researching', { parentId: 'parent' }), null)!;
  assert.doesNotMatch(seat.key, /^room1_researching_/, 'never the Library, even with an unseated parent');
  assert.doesNotMatch(seat.key, /_pod\d$/, 'there is no parent seat yet to anchor a pod spot to');
});

test('a librarian subagent still reaches the Library even though its parent already has a desk (the badge wins over the pod rule)', () => {
  const { layout, agent } = setup();
  layout.seatFor(agent('parent', 'implementing'), null);
  const seat = layout.seatFor(agent('lib', 'researching', { parentId: 'parent', badges: ['librarian'] }), null)!;
  assert.match(seat.key, /^room1_researching_/);
});

// --- Issue #120: the library wing moves to the south-east ---

test('the library (the second room the building ever rents) sits at the south-east slot, not the north-east', () => {
  // slotFor(1) is where the second rented room goes; the building rents the Library second,
  // right after the office. South of the hall is positive z (the front, where the meeting
  // table and coffee area sit); north is negative z (the back wall, the whiteboards).
  const slot = slotFor(1);
  assert.ok(slot.rect.minZ > 0, `slot 1 is south (minZ=${slot.rect.minZ}), not north`);
  // AC2: the corridor branch toward slot 1 (the hall's own door) leads straight to the
  // Library's entrance, the same way every ring-0 room's door already matches its slot
  // (rebuildHallWalls derives every door from slotFor(room.index)); this geometric
  // identity is what guarantees it, not a separate corridor structure (none exists yet).
  assert.deepEqual(slot.door, { side: 'west', at: 9.5 });
});

// --- Workspace grouping in the shared desk pool (#138: per-workspace desk rooms retired) ---

const inWorkspace = (label: string) => ({ group: { id: `g-${label}`, label } });

test('tagged sessions sit at the hall desks with everyone else; no desk room is rented for them', () => {
  const { layout, agent, scene } = setup();
  const a1 = layout.seatFor(agent('a1', 'implementing', inWorkspace('Alpha')), null)!;
  const b1 = layout.seatFor(agent('b1', 'implementing', inWorkspace('Beta')), null)!;
  const loner = layout.seatFor(agent('n', 'implementing'), null)!;

  assert.deepEqual(layout.roomKinds, ['office', 'library'], 'no new room for two workspaces of one session each');
  assert.match(a1.key, /^desk_/);
  assert.match(b1.key, /^desk_/);
  assert.match(loner.key, /^desk_/);
  const labels = scene.children.flatMap((c) => c.children).filter((c) => c.userData.roomLabel !== undefined).map((c) => c.userData.roomLabel);
  assert.ok(!labels.some((label) => label.startsWith('Desks ·')), 'no per-workspace room label');
});

test('sessions of one workspace get neighboring desks', () => {
  const { layout, agent } = setup();
  const a1 = layout.seatFor(agent('a1', 'implementing', inWorkspace('Alpha')), null)!;
  const a2 = layout.seatFor(agent('a2', 'implementing', inWorkspace('Alpha')), null)!;
  const b1 = layout.seatFor(agent('b1', 'implementing', inWorkspace('Beta')), null)!;

  assert.notEqual(a1.key, a2.key);
  assert.notEqual(b1.key, a1.key);
  assert.notEqual(b1.key, a2.key);
  assert.ok(a2.position.distanceTo(a1.position) < b1.position.distanceTo(a1.position), "Alpha's own next session sits closer to it than Beta's desk does");
});

test('"next to" is physical distance, not a key suffix: a desk one row over beats one across the aisle (#138 fix)', () => {
  // The hall desks sit in two rows of four, in the back corners since issue #121. desk_3
  // (end of row 1) and desk_4 (start of row 2) are adjacent keys but about 24 m apart (the
  // two far corners); desk_3 and desk_7 are far apart in key order but stand in the same
  // column, 3 m apart. The real nearest desk must win, not the key.
  const { layout, agent } = setup();
  layout.seatFor(agent('n0', 'implementing'), null); // desk_0
  layout.seatFor(agent('n1', 'implementing'), null); // desk_1
  layout.seatFor(agent('n2', 'implementing'), null); // desk_2
  const a1 = layout.seatFor(agent('a1', 'implementing', inWorkspace('Alpha')), null)!; // desk_3, the only one free so far
  assert.equal(a1.key, 'desk_3');

  const a2 = layout.seatFor(agent('a2', 'implementing', inWorkspace('Alpha')), null)!;
  assert.equal(a2.key, 'desk_7', 'the true nearest free desk, not desk_4 (index-adjacent, 24 m away)');
});

test('a stored desks@<workspace> room does not come back after a reload', () => {
  const storage = new Map([[BUILDING_STORAGE_KEY, JSON.stringify(['office', 'library', 'desks@proxy'])]]);
  const { layout } = setup(storage);

  assert.deepEqual(layout.roomKinds, ['office', 'library']);
  assert.deepEqual(JSON.parse(storage.get(BUILDING_STORAGE_KEY)!), ['office', 'library']);
});

test('a session whose workspace becomes known later keeps its desk; home is for life', () => {
  const { layout, agent } = setup();
  const first = layout.seatFor(agent('late', 'implementing'), null)!;
  assert.match(first.key, /^desk_/);
  assert.equal(layout.seatFor(agent('late', 'implementing', inWorkspace('Gamma')), 'implementing'), null, 'no move');
});

// --- Issue #144: a small missions board near the mission corridor ---

test('the missions board exists from the start, empty, and updates as missions arrive and close', () => {
  const { layout, scene, tick } = setup();
  const board = scene.getObjectByName('missions-board');
  assert.ok(board, 'the board is mounted even with no missions yet');

  layout.syncWorldRooms([{
    id: 'm-1', kind: 'mission', title: 'Office roadmap', state: 'open',
    createdAt: '2026-11-20T00:00:00Z',
    walls: { statement: 'x', docs: [], issues: [], kanban: [] },
  }]);
  // The board's own timer tick (not tied to the next world poll) must not throw
  tick(1500);
  tick(1500);

  layout.syncWorldRooms([{
    id: 'm-1', kind: 'mission', title: 'Office roadmap', state: 'locked',
    createdAt: '2026-11-20T00:00:00Z', closedAt: '2026-11-20T00:00:03Z',
    walls: { statement: 'x', docs: [], issues: [], kanban: [] },
  }]);
  tick(1500);
  // Still mounted: a closed mission does not remove the board or itself from it
  assert.ok(scene.getObjectByName('missions-board'));
});

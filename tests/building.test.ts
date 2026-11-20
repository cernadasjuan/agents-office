import assert from 'node:assert/strict';
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

function setup(storage = new Map<string, string>()) {
  let clock = 0;
  const scene = new THREE.Scene();
  const layout = new BuildingLayout(scene, createOffice(scene), {
    now: () => clock,
    dwellMs: 4000,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
  });
  const agent = (id: string, activity: Activity, extras?: AgentExtras) => ({ id, activity, ...(extras ? { extras } : {}) });
  return { scene, layout, storage, agent, tick: (ms: number) => { clock += ms; return layout.update(); } };
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
  const { layout, agent, tick } = setup();
  layout.seatFor(agent('a', 'implementing'), null);
  layout.seatFor(agent('a', 'researching'), 'implementing');
  tick(1000);
  layout.seatFor(agent('a', 'implementing'), 'researching');
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
  const seat = layout.seatFor(agent('s', 'planning', { room: 'room-1' }), null)!;
  assert.match(seat.key, /^mission0_seat_/);
  const helper = layout.seatFor(agent('h', 'researching', { parentId: 's' }), null)!;
  assert.match(helper.key, /^mission0_seat_\d+_pod\d$/);

  layout.syncWorldRooms([missionRoom('locked')]);
  const late = layout.seatFor(agent('late', 'implementing', { room: 'room-1' }), null)!;
  assert.doesNotMatch(late.key, /^mission/);
});

test('a waiting agent still goes to the user office before its war room', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const seat = layout.seatFor(agent('w', 'meeting', { room: 'room-1', attention: 'waiting' }), null)!;
  assert.match(seat.key, /^room0_queue_/);
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
  assert.match(seat.key, /^mission0_seat_/, 'inside its own war room');
  assert.doesNotMatch(seat.key, /^room1_researching_/, 'never the Library');
});

test('an ordinary subagent that researches stays at its parent desk', () => {
  const { layout, agent } = setup();
  layout.seatFor(agent('parent', 'implementing'), null);
  assert.match(layout.seatFor(agent('helper', 'researching', { parentId: 'parent' }), null)!.key, /_pod\d$/);
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

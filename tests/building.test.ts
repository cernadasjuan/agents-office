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

test('the building opens with the user office and remembers its rooms', () => {
  const { layout, storage, scene } = setup();
  assert.deepEqual(layout.roomKinds, ['office']);
  assert.equal(storage.get(BUILDING_STORAGE_KEY), '["office"]');
  assert.ok(scene.getObjectByName('building-hall-walls'));
});

test('an agent keeps its home desk, makes a trip after the dwell time, and comes back to the same desk', () => {
  const { layout, agent, tick } = setup();
  const home = layout.seatFor(agent('a', 'implementing'), null)!;

  assert.equal(layout.seatFor(agent('a', 'planning'), 'implementing'), null, 'no move before the dwell time');
  assert.deepEqual(tick(3000).filter((m) => m.agentId === 'a'), []);
  const trip = tick(1500).find((m) => m.agentId === 'a')!;
  assert.match(trip.seat.key, /whiteboard|planning/);

  layout.seatFor(agent('a', 'debugging'), 'planning');
  const back = tick(4500).find((m) => m.agentId === 'a')!;
  assert.equal(back.seat.key, home.key);
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

test('the building rents a desk room when the hall desks are taken, and rebuilds it after a reload', () => {
  const { layout, agent, storage } = setup();
  const seats = Array.from({ length: 10 }, (_, i) => layout.seatFor(agent(`s${i}`, 'implementing'), null)!);
  assert.equal(new Set(seats.map((s) => s.key)).size, 10);
  assert.deepEqual(layout.roomKinds, ['office', 'desks']);

  const reloaded = setup(storage).layout;
  assert.deepEqual(reloaded.roomKinds, ['office', 'desks']);
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

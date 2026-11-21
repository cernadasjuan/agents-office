import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';

// missionRooms.ts pulls in furniture factories that paint toon gradients on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

/**
 * Review of #196 (PR comment https://github.com/gabriel-amyot/agents-office/pull/196):
 * widening the war room's door-wall extent (`WAR_ROOM_WIDTH`, issue #193) pushed the
 * second war room column into the third rented room, and moved that same war room's door
 * into the hall's own second whiteboard. Both are regressions a property test over the
 * real room geometry should have caught before they shipped. This file is that test:
 * every rented room, every war room and the hall itself, for a realistic building (25
 * rented rooms, 12 war rooms), pairwise, must never overlap — and a war room's own door
 * gap must stay clear of the hall's whiteboards, the one hall fixture close enough to a
 * war room door to matter (the hall's other decorations are flush wall-mounted art, not
 * floor obstructions a door path could actually walk into).
 */
const { slotFor, HALL, rectsOverlap } = await import('../src/addons/building/RoomPlanner.js');
const { missionSlot } = await import('../src/addons/building/missionRooms.js');

const RENTED_ROOM_COUNT = 25;
const WAR_ROOM_COUNT = 12;

function allRects() {
  const rented = Array.from({ length: RENTED_ROOM_COUNT }, (_, i) => ({ label: `rented-${i}`, rect: slotFor(i).rect }));
  const war = Array.from({ length: WAR_ROOM_COUNT }, (_, i) => ({ label: `war-${i}`, rect: missionSlot(i).rect }));
  return [{ label: 'hall', rect: HALL }, ...rented, ...war];
}

test('issue #193 review: no rented room, war room or the hall overlaps any other, at a realistic building size', () => {
  const rects = allRects();
  const failures: string[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i].rect, rects[j].rect)) {
        failures.push(`${rects[i].label} ${JSON.stringify(rects[i].rect)} overlaps ${rects[j].label} ${JSON.stringify(rects[j].rect)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

// --- A door gap must clear the hall's own whiteboards (Office.ts: wb1 at x=-5, wb2 at x=5,
// both z=-12, each ~2.1 wide, so a footprint of roughly x in [-6.05,-3.95] and [3.95,6.05]) ---

const HALL_WHITEBOARDS = [
  { minX: -6.05, maxX: -3.95 },
  { minX: 3.95, maxX: 6.05 },
];
const DOOR_HALF_WIDTH = 1.2; // DOOR_WIDTH / 2, from RoomPlanner.ts

test('issue #193 review: every first-ring war room door gap clears the hall whiteboards', () => {
  const failures: string[] = [];
  for (let i = 0; i < 4; i++) { // first ring: war rooms 0-3, the only ones whose door sits on the hall wall
    const slot = missionSlot(i);
    if (slot.ring !== 0) continue;
    const gapMin = slot.door.at - DOOR_HALF_WIDTH;
    const gapMax = slot.door.at + DOOR_HALF_WIDTH;
    for (const board of HALL_WHITEBOARDS) {
      const overlaps = gapMin < board.maxX && board.minX < gapMax;
      if (overlaps) failures.push(`war room ${i} door gap [${gapMin}, ${gapMax}] crosses whiteboard [${board.minX}, ${board.maxX}]`);
    }
    // The door gap must also land on the hall's own wall, not past its edge
    assert.ok(gapMin >= HALL.minX && gapMax <= HALL.maxX, `war room ${i} door gap [${gapMin}, ${gapMax}] exceeds the hall's own wall (${HALL.minX}..${HALL.maxX})`);
  }
  assert.deepEqual(failures, []);
});

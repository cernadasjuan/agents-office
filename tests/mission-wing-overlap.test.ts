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
 * Issue #259: the mission wing is a hex structure now, not rect rooms strung along a mission
 * corridor — the rect-geometry overlap/door checks this file used to run (`missionSlot`,
 * `missionCorridorRect`, `MISSION_CORRIDOR_DOOR`, all deleted) have their own hex equivalents
 * already: contiguity and non-overlap of every claimed hex room (`tests/hex-world.test.ts`,
 * `tests/hex-room-planner.test.ts`), and every room reachable only by its own stair
 * (`tests/hex-world.test.ts`'s own walkway-chain test). This file keeps the one check neither
 * of those covers: the hex structure (offset by `HEX_OFFSET`, built "side by side" with the
 * rect building, issue #218 step 2) must never actually overlap the rect building's own rented
 * rooms or hall, at a realistic room count on both sides.
 */
const { slotFor, HALL, rectsOverlap } = await import('../src/addons/building/RoomPlanner.js');
const { buildHexWorld } = await import('../src/addons/building/HexRoomPlanner.js');

const RENTED_ROOM_COUNT = 25;

test('issue #259: the hex mission wing never overlaps the rect building, at a realistic room count on both sides', () => {
  const rented = Array.from({ length: RENTED_ROOM_COUNT }, (_, i) => ({ label: `rented-${i}`, rect: slotFor(i).rect }));
  const rectRects = [{ label: 'hall', rect: HALL }, ...rented];

  const layout = buildHexWorld({ library: 3, portal: 10, agents: 10, tooling: 10, infra: 10 });
  const hexRects = layout.rooms.map((room) => {
    const xs = room.corners.map((c) => c.x);
    const zs = room.corners.map((c) => c.z);
    return { label: `hex-${room.role}-${room.slot.cell.q},${room.slot.cell.r}`, rect: { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) } };
  });

  const failures: string[] = [];
  for (const a of rectRects) {
    for (const b of hexRects) {
      if (rectsOverlap(a.rect, b.rect)) failures.push(`${a.label} ${JSON.stringify(a.rect)} overlaps ${b.label} ${JSON.stringify(b.rect)}`);
    }
  }
  assert.deepEqual(failures, []);
});

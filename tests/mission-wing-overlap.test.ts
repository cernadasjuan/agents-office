import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

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
 * every rented room, every war room, the mission corridor and the hall itself, for a
 * realistic building (25 rented rooms) and an uncapped mission wing (issue #123: 40+ war
 * rooms, well past today's typical count), pairwise, must never overlap — and the mission
 * corridor's own door into the hall must stay clear of the hall's whiteboards, the one hall
 * fixture close enough to that door to matter (the hall's other decorations are flush
 * wall-mounted art, not floor obstructions a door path could actually walk into).
 */
const { slotFor, HALL, rectsOverlap } = await import('../src/addons/building/RoomPlanner.js');
const { missionSlot, missionCorridorRect, MISSION_CORRIDOR_DOOR } = await import('../src/addons/building/missionRooms.js');

const RENTED_ROOM_COUNT = 25;
/** Issue #123: the corridor grows without a cap. 42 (21 rows of 2) stands in for "40+",
 * the scale the issue asks this test to cover. */
const WAR_ROOM_COUNT = 42;

function allRects() {
  const rented = Array.from({ length: RENTED_ROOM_COUNT }, (_, i) => ({ label: `rented-${i}`, rect: slotFor(i).rect }));
  const war = Array.from({ length: WAR_ROOM_COUNT }, (_, i) => ({ label: `war-${i}`, rect: missionSlot(i).rect }));
  const corridor = { label: 'mission-corridor', rect: missionCorridorRect(WAR_ROOM_COUNT) };
  return [{ label: 'hall', rect: HALL }, corridor, ...rented, ...war];
}

test('issue #123 review: no rented room, war room, the mission corridor or the hall overlaps any other, at 40+ war rooms', () => {
  const rects = allRects();
  const failures: string[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      // The corridor is expected to be flush against every war room (that is its job); only
      // its touching, not overlapping, their shared wall matters, same tolerance `rectsOverlap`
      // already gives every other adjacent pair in this building (a shared edge is not an overlap).
      if (rectsOverlap(rects[i].rect, rects[j].rect)) {
        failures.push(`${rects[i].label} ${JSON.stringify(rects[i].rect)} overlaps ${rects[j].label} ${JSON.stringify(rects[j].rect)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('issue #123: every war room door opens directly onto the mission corridor, at any room count — never onto another room', () => {
  const corridor = missionCorridorRect(WAR_ROOM_COUNT);
  const failures: string[] = [];
  for (let i = 0; i < WAR_ROOM_COUNT; i++) {
    const slot = missionSlot(i);
    if (slot.door.side !== 'east' && slot.door.side !== 'west') {
      failures.push(`war room ${i} door side is ${slot.door.side}, not corridor-facing`);
      continue;
    }
    const sharedX = slot.door.side === 'east' ? slot.rect.maxX : slot.rect.minX;
    const corridorWallX = slot.door.side === 'east' ? corridor.minX : corridor.maxX;
    if (sharedX !== corridorWallX) failures.push(`war room ${i} door wall x=${sharedX} does not sit flush with the corridor's own wall x=${corridorWallX}`);
    if (!(slot.door.at >= corridor.minZ && slot.door.at <= corridor.maxZ)) {
      failures.push(`war room ${i} door gap at z=${slot.door.at} falls outside the corridor's own frontage [${corridor.minZ}, ${corridor.maxZ}]`);
    }
  }
  assert.deepEqual(failures, []);
});

// --- The mission corridor's own door into the hall must clear the hall's floor fixtures
// close enough to sit in its entrance lane: the two whiteboards, and the small corner plants
// near the back wall (the tall plants, the clock, the wall art and the meeting rug all sit
// too far from the hall's own z=-13 wall, or are wall-mounted, to matter here). This check
// reads the real `createWhiteboard` and `createDecorations` meshes and their actual positions
// (`Office.ts`, `Decorations.ts`) through `THREE.Box3`, not a hand-typed guess, so neither
// fixture's footprint can drift from what the scene actually builds. ---

const { createWhiteboard } = await import('../src/furniture/Whiteboard.js');
const { createDecorations } = await import('../src/furniture/Decorations.js');

/** The real x-footprint of a built, positioned object, from its own geometry. */
function footprintX(object: THREE.Object3D): { minX: number; maxX: number } {
  const box = new THREE.Box3().setFromObject(object);
  return { minX: box.min.x, maxX: box.max.x };
}

// Office.ts positions: wb1 at (-5, 0, -12), wb2 at (5, 0, -12).
const wb1 = createWhiteboard();
wb1.position.set(-5, 0, -12);
const wb2 = createWhiteboard();
wb2.position.set(5, 0, -12);

// Every decoration close enough to the hall's own back wall (z = -13) to sit in the
// corridor's door entrance lane; a piece further into the room, or mounted on a wall, never
// matters here.
const DOOR_LANE_MAX_Z = -9;
const decorations = createDecorations();
const nearWallDecorations = decorations.children.filter((child) => child.position.y < 0.5 && child.position.z < DOOR_LANE_MAX_Z);

const HALL_FLOOR_FIXTURES = [
  { ...footprintX(wb1), label: 'whiteboard wb1' },
  { ...footprintX(wb2), label: 'whiteboard wb2' },
  ...nearWallDecorations.map((child, i) => ({ ...footprintX(child), label: `near-wall decoration ${i} (x=${child.position.x}, z=${child.position.z})` })),
];
const DOOR_HALF_WIDTH = 1.2; // DOOR_WIDTH / 2, from RoomPlanner.ts

test('issue #123: the mission corridor\'s own door into the hall clears the hall whiteboards and floor decorations', () => {
  // Sanity: this building does have near-wall decorations to check against (else the test
  // would pass even if `createDecorations` were gutted, the exact blind spot this replaces).
  assert.ok(nearWallDecorations.length > 0, 'expected at least one near-wall hall decoration to check the door gap against');
  const gapMin = MISSION_CORRIDOR_DOOR.at - DOOR_HALF_WIDTH;
  const gapMax = MISSION_CORRIDOR_DOOR.at + DOOR_HALF_WIDTH;
  const failures: string[] = [];
  for (const fixture of HALL_FLOOR_FIXTURES) {
    const overlaps = gapMin < fixture.maxX && fixture.minX < gapMax;
    if (overlaps) failures.push(`mission corridor door gap [${gapMin}, ${gapMax}] crosses ${fixture.label} [${fixture.minX}, ${fixture.maxX}]`);
  }
  // The door gap must also land on the hall's own wall, not past its edge
  assert.ok(gapMin >= HALL.minX && gapMax <= HALL.maxX, `mission corridor door gap [${gapMin}, ${gapMax}] exceeds the hall's own wall (${HALL.minX}..${HALL.maxX})`);
  assert.deepEqual(failures, []);
});

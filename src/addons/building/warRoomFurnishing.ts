import { PIECES } from '../../furniture/index.js';
import { Colors } from '../../utils/Colors.js';
import { DOOR_WIDTH, ROOM_SIZE } from './RoomPlanner.js';
import type { Placement, SpotPlan } from './furnishing.js';

/** Fewer book colors than the full palette, so a room full of bookshelves still merges cheap. */
const BOOKSHELF_COLORS = Colors.books.slice(0, 2);

/**
 * One furnishing plan per war room (issue #125): a rule set, not a hand-placed
 * room. Every war room gets the must-have pieces; a few could-haves unlock by
 * live-agent tier; desk-like and debug stations grow with the peak concurrent
 * count and never shrink back. Placement is seeded by the mission id, so a
 * reload gives the same room, with a small jitter so it reads as lived-in, not
 * symmetric. No piece is built here: everything comes from `src/furniture/`.
 */

export interface WarRoomCounts {
  /** Peak concurrent agents whose activity needs a desk (implementing, reviewing, writing_docs, testing). */
  deskLike: number;
  /** Peak concurrent agents debugging. Shares the desk grid with a green-screen piece instead of blue. */
  debugging: number;
}

export interface WarRoomPlan {
  pieces: Placement[];
  stations: SpotPlan[];
}

/** FNV-1a hash, the same algorithm `AgentManager.ts` already uses for an agent's accent color. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The seed for a mission: the same mission id always furnishes the same way. */
export function seedFromMission(id: string): number {
  return fnv1a(id);
}

/** A small, dependency-free seeded PRNG (mulberry32), for deterministic jitter and piece choices. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitter(rand: () => number, base: number, spread: number): number {
  return base + (rand() * 2 - 1) * spread;
}

export type RoomTier = 'small' | 'medium' | 'large';

/** The live-agent tier (rulebook §2): not room size, there is only one, but how many desks are busy. */
export function tierFor(liveDeskAgents: number): RoomTier {
  if (liveDeskAgents >= 6) return 'large';
  if (liveDeskAgents >= 4) return 'medium';
  return 'small';
}

/**
 * Up to 4 desk slots (rulebook §3's physical-fit cap). Every desk and debug station
 * carries its own chair (`Desk.ts`, `DebugStation.ts`), so a piece's real depth reaches
 * past its own row. That rules out a second row at two of the three columns:
 * - `a = -2.4` and `a = 2.4` sit under the room's own meeting table and standing ring
 *   (`missionRooms.ts`'s `TABLE_SEATS`/`STANDING_SPOTS`, centered on the room at
 *   `d = 6.2`); a row deep enough to clear the row in front of it would land inside
 *   a seat or a standing spot there.
 * - `a = -4.6` would overlap the ended-session tombstone strip, the same reason the
 *   grid has only 3 columns instead of 4.
 * `a = 4.6` sits clear of both and is the only column with a second row.
 */
const DESK_SLOTS: ReadonlyArray<{ a: number; d: number }> = [
  { a: -2.4, d: 1.4 }, { a: 2.4, d: 1.4 }, { a: 4.6, d: 1.4 },
  { a: 4.6, d: 3.6 },
];
export const MAX_DESK_SLOTS = DESK_SLOTS.length;

const JITTER_POS = 0.12;
const JITTER_ROT = (8 * Math.PI) / 180;

/**
 * Half the door's physical lane, plus a desk or debug station's own worst-case
 * half-width (0.9 m) and the grid's own jitter (0.12 m), rounded up with a small margin.
 */
export const DOOR_PATH_CLEARANCE = DOOR_WIDTH / 2 + 1.1;

/**
 * The real door is not always centered on the room's door wall (missionSlot's first ring
 * has two wing columns, each with its own door offset). A column whose footprint would
 * sit inside the door's real lane is dropped from the grid rather than assumed clear,
 * the way the rest of the grid assumes a centered door. A room with an off-center door
 * loses the slot, not the door path.
 */
function clearsDoor(a: number, doorAlong: number): boolean {
  return Math.abs(a - doorAlong) >= DOOR_PATH_CLEARANCE;
}

export function furnishWarRoom(missionId: string, counts: WarRoomCounts, doorAlong = 0): WarRoomPlan {
  const rand = mulberry32(seedFromMission(missionId));
  const roomTier = tierFor(counts.deskLike + counts.debugging);
  const pieces: Placement[] = [];
  const stations: SpotPlan[] = [];

  // --- Desk grid: debug stations fill first, so a room with a debugger shows it even at low headcount ---
  const slots = DESK_SLOTS.filter((slot) => clearsDoor(slot.a, doorAlong));
  const deskSlotCount = Math.min(counts.deskLike + counts.debugging, MAX_DESK_SLOTS, slots.length);
  for (let i = 0; i < deskSlotCount; i++) {
    const { a, d } = slots[i];
    const ja = jitter(rand, a, JITTER_POS);
    const jd = jitter(rand, d, JITTER_POS);
    const turn = jitter(rand, 0, JITTER_ROT);
    const isDebug = i < counts.debugging;
    pieces.push({ piece: isDebug ? PIECES.debugStation() : PIECES.desk(), a: ja, d: jd, turn });
    stations.push({ type: isDebug ? 'debugging' : 'implementing', a: ja, d: jd - 0.9, look: [ja, jd, 1.2], posture: 'seated' });
  }

  // --- Must-haves: a clock, plants, a sofa, a bookshelf, a whiteboard ---
  const nearWall = ROOM_SIZE / 2 - 0.1; // just inside the side walls (a = ±6)
  pieces.push({ piece: PIECES.clock(), a: jitter(rand, -1.6, 0.1), d: jitter(rand, ROOM_SIZE - 0.15, 0.05), y: 2.3 });
  const whiteboardA = jitter(rand, -2.4, 0.08);
  const whiteboardD = jitter(rand, ROOM_SIZE - 0.6, 0.08);
  // The whiteboard and bookshelf stand against the far wall, not a side wall: a side wall on
  // this side also carries the ended-session tombstone strip (`missionRooms.ts`), which can
  // grow the full depth of the room, so nothing else stands against that wall. Facing the
  // door (no turn) like the far-wall shelves in `furnishLibrary`, clear of the door-wall gap
  // rule and of the statement/docs/issues boards mounted at a = 0, -3.6 and 3.6.
  pieces.push({ piece: PIECES.whiteboard(), a: whiteboardA, d: whiteboardD });
  // Issue #126: a planning agent stands at this board, facing it (a = same, standing closer to
  // the room, since the board now faces the door rather than the side wall it used to).
  stations.push({ type: 'planning', a: whiteboardA, d: whiteboardD - 0.9, look: [whiteboardA, whiteboardD, 1.5], posture: 'standing' });

  const bookshelfA = jitter(rand, 2.6, 0.08);
  const bookshelfD = jitter(rand, ROOM_SIZE - 0.6, 0.08);
  pieces.push({ piece: PIECES.bookshelf(rand, BOOKSHELF_COLORS), a: bookshelfA, d: bookshelfD });
  // Issue #126: a researching agent stands at the mission's own shelf, not the library
  stations.push({ type: 'researching', a: bookshelfA, d: bookshelfD - 0.9, look: [bookshelfA, bookshelfD, 1.2], posture: 'standing' });

  // Pushed back from the desk grid's row depth, so a debug station's chair in the back row
  // never reaches the sofa (rulebook §4, the same clearance every room's furniture keeps).
  const sofaA = jitter(rand, nearWall - 0.7, 0.1);
  const sofaD = jitter(rand, 6.2, 0.3);
  pieces.push({ piece: PIECES.sofa(), a: sofaA, d: sofaD, turn: -Math.PI / 2 });
  // Issue #126: an idle agent sits here instead of a trip to the lounge; 2 seats, the sofa's own width
  stations.push({ type: 'idle', a: sofaA - 0.6, d: sofaD - 0.6, look: [sofaA - 0.6, sofaD - 1.6, 1.0], posture: 'seated' });
  stations.push({ type: 'idle', a: sofaA - 0.6, d: sofaD + 0.6, look: [sofaA - 0.6, sofaD + 1.6, 1.0], posture: 'seated' });

  // The low table sits further from the sofa than a coffee table normally would: both carry
  // their own jitter, and the room has no room to spare between two independently-jittered pieces.
  pieces.push({ piece: PIECES.lowTable(), a: jitter(rand, nearWall - 2.0, 0.1), d: jitter(rand, 6.2, 0.3) });
  const plantCount = roomTier === 'small' ? 3 : roomTier === 'medium' ? 4 : 5;
  // Every spot is at a >= 0 or dead center: the whole -a wall carries the ended-session
  // tombstone strip (`missionRooms.ts`), which can grow the full depth of the room, and
  // the near-door corners are where the desk grid's first row already stands (a debug
  // station or desk, chair included). Five distinct spots, not a shorter list cycled: two
  // plants jittered around the same base position land on top of each other.
  const plantSpots: Array<[number, number]> = [
    [nearWall - 0.4, ROOM_SIZE - 1.4], [0, 9.2], [1.8, 9.2], [3.5, 9.6], [4.2, ROOM_SIZE - 1.1],
  ];
  for (let i = 0; i < plantCount; i++) {
    const [a, d] = plantSpots[i % plantSpots.length];
    pieces.push({ piece: rand() > 0.5 ? PIECES.tallPlant() : PIECES.plant(), a: jitter(rand, a, 0.15), d: jitter(rand, d, 0.15) });
  }
  pieces.push({ piece: PIECES.rug(2.6, 2.6, 0x2c3e50), a: 0, d: 6.2 });

  // --- Could-haves, gated by tier (rulebook §2) ---
  if (roomTier !== 'small') pieces.push({ piece: PIECES.waterCooler(), a: jitter(rand, nearWall - 0.7, 0.1), d: jitter(rand, 8.6, 0.3) });
  if (roomTier === 'large') {
    pieces.push({ piece: PIECES.tv(), a: jitter(rand, nearWall, 0.05), d: jitter(rand, 9.5, 0.3), y: 2.2, turn: -Math.PI / 2 });
    // Turned, so its long side runs along `d` (depth) and its thin side along `a`: it fits
    // the one lane clear of everything else in the room, between the ended-session
    // tombstone strip (its right edge near a = -4.25) and the meeting table's own ring of
    // seats and standing spots (its left-most point near a = -2.9), for the room's full
    // depth. A centered, untouched lane (a first pass tried d = 4.4, a = 0) lands on the
    // door-facing meeting seat at (0, 4.3) and, with the desk grid's row depth below, on
    // the standing ring too; this lane has neither.
    if (rand() > 0.5) pieces.push({ piece: PIECES.lowDivider(2.2), a: jitter(rand, -3.8, 0.05), d: jitter(rand, 5.5, 0.3), turn: Math.PI / 2 });
  }

  return { pieces, stations };
}

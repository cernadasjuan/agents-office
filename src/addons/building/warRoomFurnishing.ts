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
 *
 * Issue #209: a war room is a work space only, never a rest stop. The must-haves
 * are one workstation (desk), one debug station, one whiteboard and one small
 * bookshelf, present even with zero live agents (the base work set); more desks
 * and debug stations still grow with the peak count, on top of that base, and
 * never shrink. There is no sofa and no coffee table here any more: an idle
 * mission agent now goes to the main room's lounge instead (`BuildingLayout.ts`).
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
 * Issue #193: a war room's door-wall width, moderately wider than a generic room's
 * `ROOM_SIZE` (12, which stays the war room's own depth — unchanged, so every `d` position
 * below still lines up with the meeting table, the far wall and the tombstone strip exactly
 * as before). The extra 6 m of width is what fits the two new desk columns below.
 */
export const WAR_ROOM_WIDTH = 18;

/**
 * Up to 8 desk slots (rulebook §3's physical-fit cap, issue #193 review: was 4, at
 * `ROOM_SIZE`-wide rooms). Round 7 feedback (#214) dropped the two middle-column slots
 * (`a = -2.4`, `a = 2.4`) that used to sit right beside the door: "the worst place to put
 * a desk... everybody from the corridor is going to see" (Gabriel, verbatim). Every slot
 * now lives in one of three side-wall lanes instead, each turned to face the room center
 * ("looking from the wall to the center") rather than the door:
 * - `a = -4.6` is still out: the ended-session tombstone strip runs along the left side
 *   wall at `a` from about -5.3 to -4.25, the same reason the original grid (12-wide
 *   rooms) had only 3 columns instead of 4.
 * - `a = 4.6` sits clear of the tombstone strip and of the meeting table's standing ring
 *   (radius 3.0 around the room center at `d = 6.2`; `a = 4.6` is already past that
 *   radius, so every depth in the room is clear, not just the original two rows) — it
 *   gets a third row.
 * - `a = -7.0` and `a = 7.0` are the wider room's own outer pair (issue #193): clear of
 *   the tombstone strip (anchored on `ROOM_SIZE`, not `WAR_ROOM_WIDTH`, so it never
 *   moved), clear of the meeting ring for the same reason as `a = 4.6`, and clear of the
 *   near-wall furniture (the water cooler and TV, both anchored off `nearWall`, over 1.5
 *   m further out than this lane). `a = 7.0` gets the third row too; `a = -7.0` stays at
 *   two, since the gap to the left wall (bounded by the tombstone strip on one side) does
 *   not fit a second lane there.
 */
const DESK_SLOTS: ReadonlyArray<{ a: number; d: number }> = [
  { a: 4.6, d: 1.4 }, { a: 4.6, d: 3.6 }, { a: 4.6, d: 5.8 },
  { a: -7.0, d: 1.4 }, { a: -7.0, d: 3.6 },
  { a: 7.0, d: 1.4 }, { a: 7.0, d: 3.6 }, { a: 7.0, d: 5.8 },
];
export const MAX_DESK_SLOTS = DESK_SLOTS.length;

/** Faces a piece toward the room center (`a = 0`) from whichever side wall it stands on. */
function faceCenterTurn(a: number): number {
  return a < 0 ? Math.PI / 2 : -Math.PI / 2;
}

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

  // --- Desk grid: debug stations fill first, so a room with a debugger shows it even at low
  // headcount. Issue #209: the base work set keeps at least one of each, even in a fresh room
  // with no agents yet; the peak counts (which only ever grow) take over past that floor. ---
  const slots = DESK_SLOTS.filter((slot) => clearsDoor(slot.a, doorAlong));
  const baseDebugging = Math.max(counts.debugging, 1);
  const baseDeskLike = Math.max(counts.deskLike, 1);
  const deskSlotCount = Math.min(baseDeskLike + baseDebugging, MAX_DESK_SLOTS, slots.length);
  // The base set guarantees one of each (the floors above), but the room's own slot cap
  // (MAX_DESK_SLOTS, or fewer near an off-center door) can still fit less than the floors'
  // own sum once real debugging headcount grows past it — debug stations fill first (below),
  // so an uncapped debug count here would then leave zero desks (issue #209 review: a debugger
  // headcount of 8 or more, the room's own full cap, silently dropped the base desk). Reserve
  // at least one slot for the desk whenever the cap actually bites.
  const debugSlotCount = Math.min(baseDebugging, Math.max(deskSlotCount - 1, 0));
  for (let i = 0; i < deskSlotCount; i++) {
    const { a, d } = slots[i];
    const ja = jitter(rand, a, JITTER_POS);
    const jd = jitter(rand, d, JITTER_POS);
    const turn = faceCenterTurn(a) + jitter(rand, 0, JITTER_ROT);
    const isDebug = i < debugSlotCount;
    pieces.push({ piece: isDebug ? PIECES.debugStation() : PIECES.desk(), a: ja, d: jd, turn });
    // Round 7 (#214) review fix: `faceCenterTurn` rotates the piece's built-in chair (local
    // z = +0.7 in Desk.ts) toward the center side of the desk, not the wall side — an agent
    // placed on the wall side the way the first pass had it stands about 1.6 m from the chair
    // it is supposed to be sitting in. Seat the station on the same side the chair actually
    // lands on, so the agent sits in the chair.
    const seatA = ja + (a < 0 ? 0.9 : -0.9);
    stations.push({ type: isDebug ? 'debugging' : 'implementing', a: seatA, d: jd, look: [ja, jd, 1.2], posture: 'seated' });
  }

  // --- Must-haves: a clock, plants, a bookshelf, a whiteboard. Issue #209: no sofa, no low
  // table — a war room is a work space, not a place to relax; an idle mission agent goes to
  // the main room's lounge instead (`BuildingLayout.ts`'s routing). ---
  const nearWall = WAR_ROOM_WIDTH / 2 - 0.1; // just inside the side walls (a = ±9)
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
  pieces.push({ piece: PIECES.bookshelf(undefined, rand, BOOKSHELF_COLORS), a: bookshelfA, d: bookshelfD });
  // Issue #126: a researching agent stands at the mission's own shelf, not the library
  stations.push({ type: 'researching', a: bookshelfA, d: bookshelfD - 0.9, look: [bookshelfA, bookshelfD, 1.2], posture: 'standing' });

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

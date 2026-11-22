import { PIECES } from '../../furniture/index.js';
import { Colors } from '../../utils/Colors.js';
import type { Placement, SpotPlan } from './furnishing.js';

/** Fewer book colors than the full palette, so a room full of bookshelves still merges cheap. */
const BOOKSHELF_COLORS = Colors.books.slice(0, 2);

/**
 * One furnishing plan per hex war room (issue #259 review round 2, Gabriel's own round-6
 * complaint: "a bit too big and a bit too empty"). A rule set, not a hand-placed room. Every
 * war room gets exactly the base work set he named, nothing more: one work desk, one debug
 * station, one whiteboard, one small bookshelf. No sofa, no table, no clock, no plants, no
 * water cooler, no TV, no rug, no divider — the ornamental filler the old rect room carried to
 * fill a bigger floor is gone along with that floor; this room is sized to need none of it.
 * Desk-like and debug stations still grow with the peak concurrent count and never shrink.
 * Placement is seeded by the mission id, so a reload gives the same room, with a small jitter
 * so it reads as lived-in, not symmetric. No piece is built here: everything comes from
 * `src/furniture/`.
 *
 * A hex room's own stair (the door) sits on one edge; this plan uses 4 of its other 5 edges —
 * two "near" ones (`DESK_EDGE`, `DEBUG_EDGE`, one edge-step either side of the door) for the
 * desk grid, two "far" ones (`WHITEBOARD_EDGE`, `BOOKSHELF_EDGE`) for the must-have wall
 * pieces. The 6th edge, directly opposite the door, is the display wall
 * (`missionRooms.ts`'s own combined board) — reserved, no furniture of this plan's own stands
 * in front of it. Each edge number here is an *offset* from the room's own open (door) edge,
 * not an absolute index: `missionRooms.ts` resolves `(openEdge + offset) % 6` against the real
 * room before placing anything, so this file stays pure geometry, no hex room needed.
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

/** Edge offsets from the room's own open (door) edge — see this file's own doc comment. */
const DESK_EDGE = 1;
const DEBUG_EDGE = 5;
const WHITEBOARD_EDGE = 2;
const BOOKSHELF_EDGE = 4;

/**
 * Up to 6 desk-like slots (down from the old rect room's 8: a smaller room needs a smaller
 * cap). Two dedicated slots each on the desk and debug walls, plus one overflow slot each on
 * the whiteboard and bookshelf walls (clear of those pieces themselves, placed further along
 * the same wall) — so a busy room can still seat 6 concurrent desk-like/debugging agents
 * without crowding a 7th or 8th piece onto an already-furnished wall.
 */
const DESK_SLOTS: ReadonlyArray<{ edge: number; a: number; d: number }> = [
  { edge: DEBUG_EDGE, a: -1.3, d: 1.2 },
  { edge: DEBUG_EDGE, a: 1.3, d: 1.2 },
  { edge: DESK_EDGE, a: -1.3, d: 1.2 },
  { edge: DESK_EDGE, a: 1.3, d: 1.2 },
  { edge: WHITEBOARD_EDGE, a: -2.0, d: 1.2 },
  { edge: BOOKSHELF_EDGE, a: -2.0, d: 1.2 },
];
export const MAX_DESK_SLOTS = DESK_SLOTS.length;

const JITTER_POS = 0.06;
const JITTER_ROT = (6 * Math.PI) / 180;
/** How far into the room a seated station sits from its desk/debug station (its own chair is
 * built into the piece at this same offset, round 7 #214's own fix, carried over to the edge
 * frame's native "into the room" axis instead of a rect room's lateral one). */
const SEAT_INSET = 0.75;

export function furnishWarRoom(missionId: string, counts: WarRoomCounts): WarRoomPlan {
  const rand = mulberry32(seedFromMission(missionId));
  const pieces: Placement[] = [];
  const stations: SpotPlan[] = [];

  // --- Desk grid: debug stations fill first, so a room with a debugger shows it even at low
  // headcount. Issue #209: the base work set keeps at least one of each, even in a fresh room
  // with no agents yet; the peak counts (which only ever grow) take over past that floor. ---
  const baseDebugging = Math.max(counts.debugging, 1);
  const baseDeskLike = Math.max(counts.deskLike, 1);
  const deskSlotCount = Math.min(baseDeskLike + baseDebugging, MAX_DESK_SLOTS);
  // The base set guarantees one of each (the floors above), but the room's own slot cap can
  // still fit less than the floors' own sum once real debugging headcount grows past it —
  // debug stations fill first (below), so an uncapped debug count here would then leave zero
  // desks. Reserve at least one slot for the desk whenever the cap actually bites.
  const debugSlotCount = Math.min(baseDebugging, Math.max(deskSlotCount - 1, 0));
  for (let i = 0; i < deskSlotCount; i++) {
    const { edge, a, d } = DESK_SLOTS[i];
    const ja = jitter(rand, a, JITTER_POS);
    const jd = jitter(rand, d, JITTER_POS);
    const turn = jitter(rand, 0, JITTER_ROT);
    const isDebug = i < debugSlotCount;
    pieces.push({ piece: isDebug ? PIECES.debugStation() : PIECES.desk(), edge, a: ja, d: jd, turn });
    stations.push({ type: isDebug ? 'debugging' : 'implementing', edge, a: ja, d: jd - SEAT_INSET, look: [ja, jd, 1.2], posture: 'seated' });
  }

  // --- Must-haves: one whiteboard, one small bookshelf. No sofa, no table (issue #209/round
  // 6): a war room is a work space only, sized for exactly this set. ---
  const whiteboardA = jitter(rand, 1.2, 0.06);
  const whiteboardD = jitter(rand, 1.0, 0.05);
  pieces.push({ piece: PIECES.whiteboard(), edge: WHITEBOARD_EDGE, a: whiteboardA, d: whiteboardD });
  // Issue #126: a planning agent stands at this board, facing it.
  stations.push({ type: 'planning', edge: WHITEBOARD_EDGE, a: whiteboardA, d: whiteboardD + SEAT_INSET, look: [whiteboardA, whiteboardD, 1.5], posture: 'standing' });

  const bookshelfA = jitter(rand, 1.2, 0.06);
  const bookshelfD = jitter(rand, 0.9, 0.05);
  pieces.push({ piece: PIECES.bookshelf(undefined, rand, BOOKSHELF_COLORS), edge: BOOKSHELF_EDGE, a: bookshelfA, d: bookshelfD });
  // Issue #126: a researching agent stands at the mission's own shelf, not the library
  stations.push({ type: 'researching', edge: BOOKSHELF_EDGE, a: bookshelfA, d: bookshelfD + SEAT_INSET, look: [bookshelfA, bookshelfD, 1.2], posture: 'standing' });

  return { pieces, stations };
}

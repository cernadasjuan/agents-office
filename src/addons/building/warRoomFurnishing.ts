import { PIECES } from '../../furniture/index.js';
import { Colors } from '../../utils/Colors.js';
import { ROOM_SIZE } from './RoomPlanner.js';
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

/** Up to 8 desk slots, a 2x4 grid either side of the door lane (rulebook §3's physical-fit cap). */
const DESK_ROW_D = [1.4, 2.9];
const DESK_COL_A = [-4.6, -2.4, 2.4, 4.6];
export const MAX_DESK_SLOTS = DESK_ROW_D.length * DESK_COL_A.length;

const JITTER_POS = 0.12;
const JITTER_ROT = (8 * Math.PI) / 180;

export function furnishWarRoom(missionId: string, counts: WarRoomCounts): WarRoomPlan {
  const rand = mulberry32(seedFromMission(missionId));
  const roomTier = tierFor(counts.deskLike + counts.debugging);
  const pieces: Placement[] = [];
  const stations: SpotPlan[] = [];

  // --- Desk grid: debug stations fill first, so a room with a debugger shows it even at low headcount ---
  const slots: Array<{ a: number; d: number }> = [];
  for (const d of DESK_ROW_D) for (const a of DESK_COL_A) slots.push({ a, d });
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

  const whiteboardA = jitter(rand, -nearWall + 0.3, 0.1);
  const whiteboardD = jitter(rand, 5.0, 0.3);
  pieces.push({ piece: PIECES.whiteboard(), a: whiteboardA, d: whiteboardD, turn: Math.PI / 2 });
  // Issue #126: a planning agent stands at this board, facing it
  stations.push({ type: 'planning', a: whiteboardA + 0.9, d: whiteboardD, look: [whiteboardA, whiteboardD, 1.5], posture: 'standing' });

  const bookshelfA = jitter(rand, -nearWall + 0.3, 0.1);
  const bookshelfD = jitter(rand, 7.6, 0.3);
  pieces.push({ piece: PIECES.bookshelf(rand, BOOKSHELF_COLORS), a: bookshelfA, d: bookshelfD, turn: Math.PI / 2 });
  // Issue #126: a researching agent stands at the mission's own shelf, not the library
  stations.push({ type: 'researching', a: bookshelfA + 0.9, d: bookshelfD, look: [bookshelfA, bookshelfD, 1.2], posture: 'standing' });

  const sofaA = jitter(rand, nearWall - 0.7, 0.1);
  const sofaD = jitter(rand, 5.0, 0.3);
  pieces.push({ piece: PIECES.sofa(), a: sofaA, d: sofaD, turn: -Math.PI / 2 });
  // Issue #126: an idle agent sits here instead of a trip to the lounge; 2 seats, the sofa's own width
  stations.push({ type: 'idle', a: sofaA - 0.6, d: sofaD - 0.6, look: [sofaA - 0.6, sofaD - 1.6, 1.0], posture: 'seated' });
  stations.push({ type: 'idle', a: sofaA - 0.6, d: sofaD + 0.6, look: [sofaA - 0.6, sofaD + 1.6, 1.0], posture: 'seated' });

  pieces.push({ piece: PIECES.lowTable(), a: jitter(rand, nearWall - 1.6, 0.1), d: jitter(rand, 5.0, 0.3) });
  const plantCount = roomTier === 'small' ? 3 : roomTier === 'medium' ? 4 : 5;
  const plantSpots: Array<[number, number]> = [
    [-nearWall + 0.4, ROOM_SIZE - 1.4], [nearWall - 0.4, ROOM_SIZE - 1.4],
    [nearWall - 0.4, 2.0], [-nearWall + 0.4, 2.0], [0, 9.2],
  ];
  for (let i = 0; i < plantCount; i++) {
    const [a, d] = plantSpots[i % plantSpots.length];
    pieces.push({ piece: rand() > 0.5 ? PIECES.tallPlant() : PIECES.plant(), a: jitter(rand, a, 0.15), d: jitter(rand, d, 0.15) });
  }
  pieces.push({ piece: PIECES.rug(2.6, 2.6, 0x2c3e50), a: 0, d: 6.2 });

  // --- Could-haves, gated by tier (rulebook §2) ---
  if (roomTier !== 'small') pieces.push({ piece: PIECES.waterCooler(), a: jitter(rand, nearWall - 0.7, 0.1), d: jitter(rand, 7.8, 0.3) });
  if (roomTier === 'large') {
    pieces.push({ piece: PIECES.tv(), a: jitter(rand, nearWall, 0.05), d: jitter(rand, 9.5, 0.3), y: 2.2, turn: -Math.PI / 2 });
    if (rand() > 0.5) pieces.push({ piece: PIECES.lowDivider(2.2), a: jitter(rand, 3.3, 0.1), d: jitter(rand, 4.2, 0.2), turn: Math.PI / 2 });
  }

  return { pieces, stations };
}

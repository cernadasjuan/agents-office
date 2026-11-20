/**
 * Pure geometry for the growing building: where each new room goes, where its
 * door is, and which wall pieces to build around the doors. No Three.js here,
 * so the planner is easy to test.
 */

export type Side = 'north' | 'south' | 'east' | 'west';

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Door {
  side: Side;
  /** Position along the wall: x for north/south walls, z for east/west walls. */
  at: number;
}

export interface RoomSlot {
  rect: Rect;
  /** The door that leads toward the hall (or the inner room). */
  door: Door;
  /** Where the next room in this direction goes. */
  outward: Side;
  ring: number;
}

export const HALL: Rect = { minX: -15, maxX: 15, minZ: -13, maxZ: 13 };
export const ROOM_SIZE = 12;
export const DOOR_WIDTH = 2.4;

const OPPOSITE: Record<Side, Side> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/**
 * The first ring around the hall, in the order rooms are rented. The east-center
 * slot comes first: it is the user's office. Doors avoid the furniture on the
 * hall walls (whiteboards and boards on the back wall, shelves on the left wall).
 *
 * The south-east slot (positive z, the front of the hall) comes second: the building
 * rents the Library second, right after the office, so it always lands there (issue
 * #120 moves it from the north-east). The north-east slot (negative z, the back wall)
 * now comes third.
 */
const FIRST_RING: Array<Omit<RoomSlot, 'ring'>> = [
  { rect: { minX: 15, maxX: 27, minZ: -6, maxZ: 6 }, door: { side: 'west', at: 0 }, outward: 'east' },
  { rect: { minX: 15, maxX: 27, minZ: 6, maxZ: 18 }, door: { side: 'west', at: 9.5 }, outward: 'east' },
  { rect: { minX: 15, maxX: 27, minZ: -18, maxZ: -6 }, door: { side: 'west', at: -9.5 }, outward: 'east' },
  { rect: { minX: -15, maxX: -3, minZ: 13, maxZ: 25 }, door: { side: 'north', at: -9 }, outward: 'south' },
  { rect: { minX: -3, maxX: 9, minZ: 13, maxZ: 25 }, door: { side: 'north', at: 3 }, outward: 'south' },
  { rect: { minX: -27, maxX: -15, minZ: 1, maxZ: 13 }, door: { side: 'east', at: 4.5 }, outward: 'west' },
  { rect: { minX: -27, maxX: -15, minZ: -11, maxZ: 1 }, door: { side: 'east', at: -6 }, outward: 'west' },
];

function shift(rect: Rect, side: Side, distance: number): Rect {
  const dx = side === 'east' ? distance : side === 'west' ? -distance : 0;
  const dz = side === 'south' ? distance : side === 'north' ? -distance : 0;
  return { minX: rect.minX + dx, maxX: rect.maxX + dx, minZ: rect.minZ + dz, maxZ: rect.maxZ + dz };
}

/**
 * The slot for the n-th rented room (0-based). Rooms fill the first ring, then
 * the same pattern one room further out, and so on. Each outer room opens toward
 * the room inside it.
 */
export function slotFor(index: number): RoomSlot {
  const base = FIRST_RING[index % FIRST_RING.length];
  const ring = Math.floor(index / FIRST_RING.length);
  const rect = shift(base.rect, base.outward, ring * ROOM_SIZE);
  if (ring === 0) return { ...base, rect, ring };
  // An outer room's door faces inward, at the middle of its inner wall
  const inward = OPPOSITE[base.outward];
  const at = inward === 'north' || inward === 'south' ? (rect.minX + rect.maxX) / 2 : (rect.minZ + rect.maxZ) / 2;
  return { rect, door: { side: inward, at }, outward: base.outward, ring };
}

/** A wall piece from `from` to `to` along one side of a rect. */
export interface WallPiece {
  side: Side;
  from: number;
  to: number;
}

/**
 * The wall pieces of a rect, leaving a door-wide gap at each door. Doors on one
 * side may come from this room or from rooms attached to it.
 */
export function wallPieces(rect: Rect, doors: Door[]): WallPiece[] {
  const pieces: WallPiece[] = [];
  for (const side of ['north', 'south', 'east', 'west'] as Side[]) {
    const [start, end] = side === 'north' || side === 'south' ? [rect.minX, rect.maxX] : [rect.minZ, rect.maxZ];
    const gaps = doors.filter((door) => door.side === side).map((door) => door.at).sort((a, b) => a - b);
    let cursor = start;
    for (const at of gaps) {
      const gapStart = Math.max(start, at - DOOR_WIDTH / 2);
      const gapEnd = Math.min(end, at + DOOR_WIDTH / 2);
      if (gapStart > cursor) pieces.push({ side, from: cursor, to: gapStart });
      cursor = Math.max(cursor, gapEnd);
    }
    if (cursor < end) pieces.push({ side, from: cursor, to: end });
  }
  return pieces;
}

/** The door a room needs on the wall it shares with its inner neighbor (the hall for the first ring). */
export function matchingDoor(slot: RoomSlot): Door {
  return { side: OPPOSITE[slot.door.side], at: slot.door.at };
}

/** The point just inside a room's door, where agents enter. */
export function doorPoint(rect: Rect, door: Door, inset = 0.8): { x: number; z: number } {
  switch (door.side) {
    case 'north': return { x: door.at, z: rect.minZ + inset };
    case 'south': return { x: door.at, z: rect.maxZ - inset };
    case 'west': return { x: rect.minX + inset, z: door.at };
    case 'east': return { x: rect.maxX - inset, z: door.at };
  }
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

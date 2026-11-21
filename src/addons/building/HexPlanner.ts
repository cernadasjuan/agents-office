/**
 * Pure geometry for the hex office (issue #218, step 1 of the hex office build): axial hex
 * coordinates, hex corner math, and the contiguous ring-then-sector claim function that
 * decides which hex cell each room takes. No Three.js here, so the planner is easy to test
 * — the same shape as `RoomPlanner.ts`'s rectangle planner.
 *
 * The lattice is flat-edge-to-flat-edge (gapless): the same math the round 3 spike script
 * (`scripts/r3_mosaic.py` in the ticket folder) proved out as an SVG before any of this was
 * ported into real `src/` code.
 */

export interface HexCell {
  q: number;
  r: number;
}

export interface HexPoint {
  x: number;
  z: number;
}

export type ComponentRole = 'portal' | 'agents' | 'tooling' | 'infra';

/** Every role a hex cell can hold. `hub` is the fixed center cell (ring 0); the rest are
 * ordinary hex rooms. */
export type RoomRole = 'hub' | 'office' | 'library' | ComponentRole;

/** One claimed hex room. */
export interface HexSlot {
  cell: HexCell;
  /** Hex-ring distance from the hub (0 = the hub itself). */
  ring: number;
  /** Which of the 6 fixed 60-degree sectors this cell falls in. The hub has no sector (-1). */
  sector: number;
  role: RoomRole;
}

/** One room requested by growth, in claim order. The hub and the office need no request:
 * both are fixed and always present. */
export interface GrowthRequest {
  role: 'library' | ComponentRole;
}

/** Circumradius of one hex room, in world units. Matches the existing room scale
 * (`RoomPlanner.ts`'s `ROOM_SIZE`, 12) closely enough that a hex room and a rect room read
 * as the same size next to each other once step 2 builds them side by side. */
export const HEX_SIZE = 7;

/** The 6 axial step directions, 60 degrees apart, in ring-walk order. */
const AX_DIRS: HexCell[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function hexAdd(a: HexCell, b: HexCell): HexCell {
  return { q: a.q + b.q, r: a.r + b.r };
}

export function hexEquals(a: HexCell, b: HexCell): boolean {
  return a.q === b.q && a.r === b.r;
}

export function hexKey(cell: HexCell): string {
  return `${cell.q},${cell.r}`;
}

/** Hex-ring distance from the origin (0 at the hub, 1 for its 6 direct neighbors, and so on). */
export function ringOf(cell: HexCell): number {
  return (Math.abs(cell.q) + Math.abs(cell.r) + Math.abs(cell.q + cell.r)) / 2;
}

/** Every cell exactly `radius` rings out from the hub, in walk order around the ring. */
export function hexRing(radius: number): HexCell[] {
  if (radius === 0) return [{ q: 0, r: 0 }];
  const cells: HexCell[] = [];
  let cell = { q: AX_DIRS[4].q * radius, r: AX_DIRS[4].r * radius };
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      cells.push(cell);
      cell = hexAdd(cell, AX_DIRS[side]);
    }
  }
  return cells;
}

/** Cell center in world space (pointy-top hexes, the x/z ground plane). */
export function hexPixel(cell: HexCell, size = HEX_SIZE): HexPoint {
  return {
    x: size * Math.sqrt(3) * (cell.q + cell.r / 2),
    z: size * 1.5 * cell.r,
  };
}

/** The 6 corner points of a hex centered at `center`. */
export function hexCorners(center: HexPoint, size = HEX_SIZE): HexPoint[] {
  const corners: HexPoint[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    corners.push({ x: center.x + size * Math.cos(angle), z: center.z + size * Math.sin(angle) });
  }
  return corners;
}

/** Which of the 6 fixed 60-degree sectors a cell falls in. The hub itself has no sector. */
export function sectorOf(cell: HexCell): number {
  if (cell.q === 0 && cell.r === 0) return -1;
  const { x, z } = hexPixel(cell, 1);
  const angle = (Math.atan2(z, x) * 180) / Math.PI;
  const normalized = ((angle % 360) + 360) % 360;
  return Math.floor(((normalized + 30) % 360) / 60);
}

export interface SectorEntry {
  sector: number;
  /** The role of this sector's one ring-1 hex, fixed, never claimed again at any later ring. */
  fixedRole?: RoomRole;
  /** The role every hex in this sector claims once its fixed ring (if any) is past. */
  growthRole?: RoomRole;
}

/**
 * The sector-to-role table — the only place component-to-direction knowledge lives. The hex
 * math, the growth rule, and (later) the walkway builder read this table; they never
 * hard-code which component sits where. Rearranging the office (a new component, a reshuffle)
 * needs no change to any of the functions below, only new table entries.
 *
 * Sector 0 holds Gabriel's office (fixed, ring 1 only) with the Library growing behind it
 * (ring 2 onward, unbounded) — his round 7 decision. Sectors 1-4 hold the 4 components.
 * Sector 5 is reserved: no role assigned yet, so it never claims a room (ghost-only once a
 * debug overlay exists).
 */
export const SECTOR_TABLE: SectorEntry[] = [
  { sector: 0, fixedRole: 'office', growthRole: 'library' },
  { sector: 1, growthRole: 'portal' },
  { sector: 2, growthRole: 'agents' },
  { sector: 3, growthRole: 'tooling' },
  { sector: 4, growthRole: 'infra' },
  { sector: 5 },
];

function entryFor(sector: number): SectorEntry | undefined {
  return SECTOR_TABLE.find((entry) => entry.sector === sector);
}

/** The role a hex at this sector and ring claims, or null if this sector has no role to claim
 * at that ring (the reserved sector, or ring 2+ of a sector with no `growthRole`). */
export function roleFor(sector: number, ring: number): RoomRole | null {
  const entry = entryFor(sector);
  if (!entry || ring < 1) return null;
  if (ring === 1) return entry.fixedRole ?? entry.growthRole ?? null;
  return entry.growthRole ?? null;
}

/** Cells sorted by angular closeness to their sector's own center direction, so a partial ring
 * claims a contiguous arc nearest the sector's spine, not a scattered pick. */
function sortByAngularCloseness(cells: HexCell[], sector: number): HexCell[] {
  const centerAngle = sector * 60;
  const angleOf = (cell: HexCell) => {
    const { x, z } = hexPixel(cell, 1);
    return (((Math.atan2(z, x) * 180) / Math.PI) % 360 + 360) % 360;
  };
  const distance = (cell: HexCell) => {
    const d = ((angleOf(cell) - centerAngle + 540) % 360) - 180;
    return Math.abs(d);
  };
  return [...cells].sort((a, b) => distance(a) - distance(b));
}

/**
 * Contiguous ring-then-sector claim: growth claims whole rings outward, sector by sector, so
 * a wing is always one solid patch touching the Hub, never a thin chain. A partial final ring
 * claims a contiguous arc. Deterministic for a given `requests` order: the hub and the office
 * are always claimed first (ring 0 and ring 1), then every request tallies into a per-role
 * budget that the ring walk fills outward. Because each ring's take is always the N cells
 * nearest the sector's own center angle, adding one more request to the same role only ever
 * appends a cell — it never moves or reorders an already-claimed room.
 */
export function claimHexRegion(requests: GrowthRequest[], maxRing = 60): HexSlot[] {
  const budgets = new Map<RoomRole, number>();
  for (const request of requests) {
    budgets.set(request.role, (budgets.get(request.role) ?? 0) + 1);
  }

  const slots: HexSlot[] = [{ cell: { q: 0, r: 0 }, ring: 0, sector: -1, role: 'hub' }];

  for (let ring = 1; ring <= maxRing; ring++) {
    const budgetLeft = ring === 1 || [...budgets.values()].some((count) => count > 0);
    if (!budgetLeft) break;

    const cellsBySector = new Map<number, HexCell[]>();
    for (const cell of hexRing(ring)) {
      const sector = sectorOf(cell);
      const list = cellsBySector.get(sector);
      if (list) list.push(cell);
      else cellsBySector.set(sector, [cell]);
    }

    for (const entry of SECTOR_TABLE) {
      const role = roleFor(entry.sector, ring);
      if (!role) continue;
      const cells = sortByAngularCloseness(cellsBySector.get(entry.sector) ?? [], entry.sector);

      if (ring === 1 && entry.fixedRole) {
        const cell = cells[0];
        if (cell) slots.push({ cell, ring, sector: entry.sector, role: entry.fixedRole });
        continue;
      }

      const budget = budgets.get(role) ?? 0;
      if (budget <= 0) continue;
      const take = Math.min(cells.length, budget);
      for (let i = 0; i < take; i++) {
        slots.push({ cell: cells[i], ring, sector: entry.sector, role });
      }
      budgets.set(role, budget - take);
    }
  }

  return slots;
}

/**
 * Pure geometry for the hex Hub, Office and the walkway/stair between them (issue #218 steps
 * 2 and 3). No Three.js here, same shape as `HexPlanner.ts` and `RoomPlanner.ts`: world-space
 * points and polygons, testable without a scene.
 *
 * Rooms never touch: there is no room-to-room door (the build plan's own rule). Each hex room
 * sits on its own lattice cell, gapped from its neighbors, and is reached only by a stair up
 * to a walkway deck and back down — the "little wire mesh bridge" and "little staircase"
 * Gabriel described in round 7. This file places the first one: Hub to Office.
 */
import { claimHexRegion, hexPixel, type HexCell, type HexPoint, type HexSlot } from './HexPlanner.js';
import { OFFICE } from '../../utils/Constants.js';

/** World offset of the whole hex structure, clear of the existing rect building (whose rooms
 * grow outward from the origin in every direction) so the two coexist without touching, per
 * step 2's AC ("side by side with the old rect rooms, which keep working unconverted"). */
export const HEX_OFFSET: HexPoint = { x: 300, z: 0 };
/** Distance between neighboring lattice cell centers. Rooms are deliberately gapped (their
 * own drawn radius is smaller than this), since nothing but a walkway ever bridges two of
 * them — unlike the round 3 spike's decorative mosaic, where tiles touch edge to edge. Large
 * enough that each room's own stair ramp (`RAMP_LENGTH`) clears the other room's wall with a
 * real walkway span left over in between. */
export const LATTICE_SPACING = 24;
/** An ordinary hex room's own floor/wall circumradius. */
export const ROOM_RADIUS = 7;
/** The Hub's own radius: a larger hex, the old `HALL`'s role. */
export const HUB_RADIUS = 10;
/** Wall height, shared with the rect building's rooms (`rooms.ts`'s `WALL_HEIGHT`, issue #176:
 * every room is as tall as the main room — `OFFICE.height` directly here, so this stays pure
 * geometry with no Three.js import chain). Hex rooms have no ceiling (round 7 decision), so
 * this is their only height. */
export const HEX_WALL_HEIGHT = OFFICE.height;
/** The walkway deck's height above the floor: wall height plus a small clearance, so it sits
 * visibly above the open-topped rooms. */
export const WALKWAY_HEIGHT = HEX_WALL_HEIGHT + 0.6;
/** "A little bridge... very small": the deck and every ramp share this width. */
export const WALKWAY_WIDTH = 1.6;
export const HEX_WALL_THICKNESS = 0.2;
/** How far a stair ramp runs out from its room's wall before reaching the walkway's height
 * (a V1 approximation of "a little staircase": one straight incline, not discrete steps —
 * the visual detail to refine once the walking flow itself is proven). */
export const RAMP_LENGTH = 6;

function add(a: HexPoint, b: HexPoint): HexPoint {
  return { x: a.x + b.x, z: a.z + b.z };
}

function sub(a: HexPoint, b: HexPoint): HexPoint {
  return { x: a.x - b.x, z: a.z - b.z };
}

function scale(a: HexPoint, s: number): HexPoint {
  return { x: a.x * s, z: a.z * s };
}

function length(a: HexPoint): number {
  return Math.hypot(a.x, a.z);
}

function normalize(a: HexPoint): HexPoint {
  const len = length(a) || 1;
  return { x: a.x / len, z: a.z / len };
}

/** The 6 corners of a hex room drawn at `radius`, centered at `center`. Independent of
 * `HexPlanner.hexCorners`'s own fixed `HEX_SIZE` — a hex room's drawn size and the lattice
 * spacing between cells are deliberately different numbers (see `ROOM_RADIUS`/`LATTICE_SPACING`
 * above). */
export function hexRoomCorners(center: HexPoint, radius: number): HexPoint[] {
  const corners: HexPoint[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    corners.push({ x: center.x + radius * Math.cos(angle), z: center.z + radius * Math.sin(angle) });
  }
  return corners;
}

/** Ray-casting point-in-polygon, for any simple polygon (a hex room, a ramp or deck quad). */
export function pointInPolygon(point: HexPoint, polygon: HexPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.z > point.z !== b.z > point.z;
    if (crosses && point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** The index (0-5) of the edge of a hex room, at `center`/`radius`, nearest to `toward`: the
 * edge a room opens onto, facing its stair (here: facing the neighbor it connects to). */
export function nearestEdgeIndex(center: HexPoint, radius: number, toward: HexPoint): number {
  const corners = hexRoomCorners(center, radius);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 6; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 6];
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const dist = length(sub(mid, toward));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

export function edgeMidpoint(center: HexPoint, radius: number, edgeIndex: number): HexPoint {
  const corners = hexRoomCorners(center, radius);
  const a = corners[edgeIndex];
  const b = corners[(edgeIndex + 1) % 6];
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}

/** The 5 wall segments of a hex room (every edge but `openEdge`, left clear for its stair). */
export function hexWallSegments(center: HexPoint, radius: number, openEdge: number): Array<{ a: HexPoint; b: HexPoint }> {
  const corners = hexRoomCorners(center, radius);
  const segments: Array<{ a: HexPoint; b: HexPoint }> = [];
  for (let i = 0; i < 6; i++) {
    if (i === openEdge) continue;
    segments.push({ a: corners[i], b: corners[(i + 1) % 6] });
  }
  return segments;
}

/** A segment's own AABB, thickened by `half` on every side (issue #194's `WallRect` shape is
 * axis-aligned; a hex wall is usually diagonal, so this is a tight-but-conservative bound
 * around it — the same simplification every other room's wall collision already approximates
 * with a margin, just wider here since the real wall is not axis-aligned). */
export function segmentBounds(a: HexPoint, b: HexPoint, half: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return {
    minX: Math.min(a.x, b.x) - half,
    maxX: Math.max(a.x, b.x) + half,
    minZ: Math.min(a.z, b.z) - half,
    maxZ: Math.max(a.z, b.z) + half,
  };
}

/** A quad spanning `a` to `b`, `width` wide (a ramp's or deck's own floor footprint). */
export function quadAlong(a: HexPoint, b: HexPoint, width: number): HexPoint[] {
  const dir = normalize(sub(b, a));
  const perp = { x: -dir.z, z: dir.x };
  const half = scale(perp, width / 2);
  return [add(a, half), add(b, half), sub(b, half), sub(a, half)];
}

/** The height at `point` if it falls on the quad from `a` to `b`, linearly interpolated
 * between `fromHeight` (at `a`) and `toHeight` (at `b`) — a ramp when the two differ, a flat
 * deck when they are equal. `null` off the quad. */
export function segmentHeightAt(point: HexPoint, a: HexPoint, b: HexPoint, width: number, fromHeight: number, toHeight: number): number | null {
  if (!pointInPolygon(point, quadAlong(a, b, width))) return null;
  const dir = sub(b, a);
  const len2 = dir.x * dir.x + dir.z * dir.z || 1;
  const t = Math.max(0, Math.min(1, (sub(point, a).x * dir.x + sub(point, a).z * dir.z) / len2));
  return fromHeight + (toHeight - fromHeight) * t;
}

export interface HexRoomGeometry {
  center: HexPoint;
  radius: number;
  openEdge: number;
  corners: HexPoint[];
}

export interface HexWalkway {
  /** The room's own edge point the ramp starts from, on its floor (y = 0). */
  from: HexPoint;
  /** Where the ramp meets the walkway deck (y = `WALKWAY_HEIGHT`). */
  to: HexPoint;
}

/** Everything step 2/3 needs to place, build and walk: the Hub, the Office, and the one
 * walkway (with its two ramps) between them. Pure data — `HexRooms.ts` turns it into meshes
 * and colliders. */
export interface HexOfficeLayout {
  hub: HexRoomGeometry;
  office: HexRoomGeometry;
  hubRamp: HexWalkway;
  officeRamp: HexWalkway;
}

/** The hub and office slots from the planner (issue #218 step 1): always the first two
 * entries `claimHexRegion` returns, with no growth requests needed for either. */
function hubAndOfficeSlots(): { hub: HexSlot; office: HexSlot } {
  const slots = claimHexRegion([]);
  const hub = slots.find((s) => s.role === 'hub')!;
  const office = slots.find((s) => s.role === 'office')!;
  return { hub, office };
}

function worldCenter(cell: HexCell): HexPoint {
  const p = hexPixel(cell, LATTICE_SPACING);
  return add(p, HEX_OFFSET);
}

/** Builds the full layout from `HexPlanner`'s claim (deterministic, same input every time). */
export function buildHexOfficeLayout(): HexOfficeLayout {
  const { hub, office } = hubAndOfficeSlots();
  const hubCenter = worldCenter(hub.cell);
  const officeCenter = worldCenter(office.cell);

  const hubOpenEdge = nearestEdgeIndex(hubCenter, HUB_RADIUS, officeCenter);
  const officeOpenEdge = nearestEdgeIndex(officeCenter, ROOM_RADIUS, hubCenter);

  const hubEdgeMid = edgeMidpoint(hubCenter, HUB_RADIUS, hubOpenEdge);
  const officeEdgeMid = edgeMidpoint(officeCenter, ROOM_RADIUS, officeOpenEdge);

  const hubOutward = normalize(sub(hubEdgeMid, hubCenter));
  const officeOutward = normalize(sub(officeEdgeMid, officeCenter));

  return {
    hub: { center: hubCenter, radius: HUB_RADIUS, openEdge: hubOpenEdge, corners: hexRoomCorners(hubCenter, HUB_RADIUS) },
    office: { center: officeCenter, radius: ROOM_RADIUS, openEdge: officeOpenEdge, corners: hexRoomCorners(officeCenter, ROOM_RADIUS) },
    hubRamp: { from: hubEdgeMid, to: add(hubEdgeMid, scale(hubOutward, RAMP_LENGTH)) },
    officeRamp: { from: officeEdgeMid, to: add(officeEdgeMid, scale(officeOutward, RAMP_LENGTH)) },
  };
}

/** The walking height at a world position, across the whole hex structure: a room floor (0),
 * a stair ramp (0 to `WALKWAY_HEIGHT`), the walkway deck (`WALKWAY_HEIGHT`), or `null`. */
export function hexSurfaceHeightAt(layout: HexOfficeLayout, x: number, z: number): number | null {
  const point = { x, z };
  if (pointInPolygon(point, layout.hub.corners)) return 0;
  if (pointInPolygon(point, layout.office.corners)) return 0;
  const onHubRamp = segmentHeightAt(point, layout.hubRamp.from, layout.hubRamp.to, WALKWAY_WIDTH, 0, WALKWAY_HEIGHT);
  if (onHubRamp !== null) return onHubRamp;
  const onOfficeRamp = segmentHeightAt(point, layout.officeRamp.from, layout.officeRamp.to, WALKWAY_WIDTH, 0, WALKWAY_HEIGHT);
  if (onOfficeRamp !== null) return onOfficeRamp;
  const onDeck = segmentHeightAt(point, layout.hubRamp.to, layout.officeRamp.to, WALKWAY_WIDTH, WALKWAY_HEIGHT, WALKWAY_HEIGHT);
  if (onDeck !== null) return onDeck;
  return null;
}

/** Every hex wall segment's collision footprint, for `LayoutStrategy.wallColliders()`. */
export function hexWallColliders(layout: HexOfficeLayout): Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> {
  const half = HEX_WALL_THICKNESS / 2;
  const hub = hexWallSegments(layout.hub.center, layout.hub.radius, layout.hub.openEdge).map((s) => segmentBounds(s.a, s.b, half));
  const office = hexWallSegments(layout.office.center, layout.office.radius, layout.office.openEdge).map((s) => segmentBounds(s.a, s.b, half));
  return [...hub, ...office];
}

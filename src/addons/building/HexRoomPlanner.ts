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
import {
  claimHexRegion, hexNeighbors, hexPixel, hexKey, ringOf,
  type ComponentRole, type GrowthRequest, type HexCell, type HexPoint, type HexSlot, type RoomRole,
} from './HexPlanner.js';
export type { ComponentRole, RoomRole } from './HexPlanner.js';
import { OFFICE } from '../../utils/Constants.js';

/** World offset of the whole hex structure, clear of the existing rect building (whose rooms
 * grow outward from the origin in every direction) so the two coexist without touching, per
 * step 2's AC ("side by side with the old rect rooms, which keep working unconverted"). */
/**
 * Issue #259 review: an x-only offset coexists with the rect building fine while only the Hub,
 * Office and Library exist (every sector that could actually grow pointed away from the rect
 * building's own origin-centered spread) — but the office/library sector (0, angle 0°, `+x`)
 * and the `tooling` wing's own sector (3, angle 180°, `-x`) sit on exactly opposite sides of the
 * Hub. A busy `tooling` wing grows straight back down the same x-axis this offset sits on, and
 * at a realistic room count (`tests/mission-wing-overlap.test.ts`'s own 42-room stress case,
 * matching `tests/mission-corridor-render-budget.test.ts`'s scale) it crosses back through
 * x = 0 and overlaps the rect building's own rented rooms. A `z` offset, not just `x`, moves
 * every sector's own growth ray clear of the rect building's origin-centered spread (which
 * stays within roughly z = ±100 even at dozens of rented rooms): the Hub sits off to the side
 * in both axes, so no sector's ray, however far it grows, re-enters that spread.
 */
export const HEX_OFFSET: HexPoint = { x: 300, z: 200 };
/** Distance between neighboring lattice cell centers. Rooms are deliberately gapped (their
 * own drawn radius is smaller than this), since nothing but a walkway ever bridges two of
 * them — unlike the round 3 spike's decorative mosaic, where tiles touch edge to edge. Large
 * enough that each room's own stair ramp (`RAMP_LENGTH`) clears the other room's wall with a
 * real walkway span left over in between, and (issue #259) wide enough for two neighboring
 * `WAR_ROOM_HEX_RADIUS` wing rooms to sit side by side without overlapping. */
export const LATTICE_SPACING = 34;
/** An ordinary hex room's own floor/wall circumradius (the Hub, Office and Library). */
export const ROOM_RADIUS = 7;
/** The Hub's own radius: a larger hex, the old `HALL`'s role. */
export const HUB_RADIUS = 10;
/**
 * A component-wing war room's own circumradius (issue #259). Bigger than `ROOM_RADIUS`: a war
 * room reuses `warRoomFurnishing.ts`'s existing furniture plan as-is (the same `a`/`d`
 * coordinates the old rectangular `WAR_ROOM_WIDTH` (18) x `ROOM_SIZE` (12) room used), and a
 * hex interior that size needs a bigger circumradius than a plain hex room to actually contain
 * every piece. A hand-picked point check (every desk slot, wall board, plant spot, the meeting
 * table ring and the tombstone strip) found 13 enough with a 0.3 m wall margin to spare — but
 * `tests/mission-rooms.test.ts`'s own exhaustive mesh-bounds check (every mesh a built room
 * actually renders, at full desk/debug counts, several wings and ordinals) is the real gate:
 * it found a few outer pieces (plants, the low divider) still poking past 13-15. 16 is the
 * measured value that check passes at, not a guessed round number. A hex interior this much
 * bigger than the old rect's own footprint does mean a board authored to sit flush against the
 * old rect's side wall no longer touches this bigger hex's own wall — see
 * `tests/mission-rooms.test.ts`'s own "toward the hex room's own side" test and comment.
 */
export const WAR_ROOM_HEX_RADIUS = 16;

/** Whether a hex room role is one of the 4 component wings (not the hub, office or library). */
export function isComponentRole(role: RoomRole): role is ComponentRole {
  return role !== 'hub' && role !== 'office' && role !== 'library';
}
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

export function sub(a: HexPoint, b: HexPoint): HexPoint {
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

/** A hex room's own door-wall frame (issue #258 review: the floor-library plugin's old
 * `shelfPoint`/`doorAlong` assumed a rectangular room with an axis-aligned door wall — a hex
 * room's open edge is rarely axis-aligned). `doorMid` is where the door itself sits (the open
 * edge's own midpoint); `inward` points from there toward the room's center; `along` is
 * `inward` rotated 90°, the room's own "left-right" axis standing at the door looking in. A
 * caller places a shelf/sign/NPC at `doorMid + along * a + inward * d`, the same shape
 * `shelfPoint`'s own `a`/`d` coordinates already had for a rect room, just without that room's
 * own `doorAlong` correction — a hex frame's `doorMid` already IS the door, never off-center. */
export interface HexRoomFrame {
  doorMid: HexPoint;
  inward: HexPoint;
  along: HexPoint;
}

export function hexRoomFrame(room: HexRoomGeometry, openEdgeIndex: number): HexRoomFrame {
  const doorMid = edgeMidpoint(room.center, room.radius, openEdgeIndex);
  const inward = normalize(sub(room.center, doorMid));
  return { doorMid, inward, along: { x: -inward.z, z: inward.x } };
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

/** The wall segments of a hex room: every edge but the open ones, left clear for a stair.
 * Issue #258 (the library, behind the office): the office now has two stairs — one to the
 * Hub, one to the Library — so a room's open edges are a list, not a single index. */
export function hexWallSegments(center: HexPoint, radius: number, openEdges: number[]): Array<{ a: HexPoint; b: HexPoint }> {
  const corners = hexRoomCorners(center, radius);
  const segments: Array<{ a: HexPoint; b: HexPoint }> = [];
  for (let i = 0; i < 6; i++) {
    if (openEdges.includes(i)) continue;
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
  /** Issue #258: the office has two (Hub side, Library side); every other room still has one —
   * except a future branch point (round 7: "wings may branch"), not built yet. */
  openEdges: number[];
  corners: HexPoint[];
  /** Issue #258 steps 5/6: which role this room plays (`hub`/`office`/`library`, or a
   * component wing), and its full planner slot (cell/ring/sector) — a caller that needs to
   * tell rooms apart (`HexRooms.ts`'s per-room marker, a war-room builder) reads this instead
   * of a hardcoded field name. */
  role: RoomRole;
  slot: HexSlot;
}

export interface HexWalkway {
  /** The room's own edge point the ramp starts from, on its floor (y = 0). */
  from: HexPoint;
  /** Where the ramp meets the walkway deck (y = `WALKWAY_HEIGHT`). */
  to: HexPoint;
}

/** One claimed room's own walkway/stair connection to its parent (the already-claimed room one
 * ring closer to the Hub it docks onto) — issue #258 steps 5/6: a wing's rooms chain outward
 * exactly like Hub -> Office -> Library already did, just through an arbitrary tree instead of
 * one fixed 3-room path. */
export interface HexConnection {
  parent: HexRoomGeometry;
  child: HexRoomGeometry;
  /** The parent's own ramp, from its edge facing the child. */
  parentRamp: HexWalkway;
  /** The child's own ramp, from its edge facing the parent. */
  childRamp: HexWalkway;
}

/** Everything the hex office needs to place, build and walk: every claimed room (the Hub,
 * the Office, the Library behind it, and any component wings — issue #258 steps 5/6) and the
 * walkway connecting each one to its own parent. Pure data — `HexRooms.ts` turns it into
 * meshes and colliders. `hub`/`office`/`library` and the four named ramps stay as a
 * convenience (every caller from steps 2-4 already reads them by name); `rooms`/`connections`
 * generalize over however many wing rooms also exist. */
export interface HexOfficeLayout {
  rooms: HexRoomGeometry[];
  connections: HexConnection[];
  hub: HexRoomGeometry;
  office: HexRoomGeometry;
  library: HexRoomGeometry;
  hubRamp: HexWalkway;
  officeRamp: HexWalkway;
  /** The office's own stair toward the library (its second open edge). */
  officeLibraryRamp: HexWalkway;
  libraryRamp: HexWalkway;
}

/** How many more hex rooms each component wing (and the Library) should grow to, this build —
 * issue #258 steps 5/6: one `GrowthRequest` per unit, same as `library` already was. */
export interface HexWorldCounts {
  library: number;
  portal: number;
  agents: number;
  tooling: number;
  infra: number;
}

function worldCenter(cell: HexCell): HexPoint {
  const p = hexPixel(cell, LATTICE_SPACING);
  return add(p, HEX_OFFSET);
}

/** A room's one stair/ramp toward a neighbor: the open edge facing it, the ramp running
 * outward from that edge toward the walkway. */
function rampToward(center: HexPoint, radius: number, toward: HexPoint): { openEdge: number; ramp: HexWalkway } {
  const openEdge = nearestEdgeIndex(center, radius, toward);
  const edgeMid = edgeMidpoint(center, radius, openEdge);
  const outward = normalize(sub(edgeMid, center));
  return { openEdge, ramp: { from: edgeMid, to: add(edgeMid, scale(outward, RAMP_LENGTH)) } };
}

function requestsFor(counts: HexWorldCounts): GrowthRequest[] {
  const requests: GrowthRequest[] = [];
  const push = (role: 'library' | ComponentRole, count: number) => {
    for (let i = 0; i < count; i++) requests.push({ role });
  };
  push('library', counts.library);
  push('portal', counts.portal);
  push('agents', counts.agents);
  push('tooling', counts.tooling);
  push('infra', counts.infra);
  return requests;
}

/** The already-claimed room one ring closer to the hub that `slot` docks its own walkway onto:
 * among `slot.cell`'s 6 lattice neighbors (`hexNeighbors`), whichever is both one ring closer
 * and already claimed. Deterministic: `hexNeighbors`' own fixed direction order breaks a tie
 * at a sector boundary (rare, only possible where two sectors' own cells happen to share a
 * ring-(r-1) neighbor) the same way every time. The hub itself (ring 0) has no parent. */
function parentOf(slot: HexSlot, bySlotKey: Map<string, HexSlot>): HexSlot | null {
  if (slot.role === 'hub') return null;
  if (slot.ring === 1) return bySlotKey.get(hexKey({ q: 0, r: 0 })) ?? null;
  for (const neighbor of hexNeighbors(slot.cell)) {
    if (ringOf(neighbor) !== slot.ring - 1) continue;
    const candidate = bySlotKey.get(hexKey(neighbor));
    if (candidate) return candidate;
  }
  return null;
}

/** Builds the full hex world from `HexPlanner`'s claim (deterministic, same input every time):
 * every claimed room's own geometry, and a walkway connection from each one to its own parent.
 * Growth only ever appends a cell (`claimHexRegion`'s own doc comment) — raising any one count
 * never moves or reorders a room already placed, the same stability the old rect rented-room
 * system already guaranteed for its own room list. */
export function buildHexWorld(counts: HexWorldCounts): HexOfficeLayout {
  const slots = claimHexRegion(requestsFor(counts));
  const bySlotKey = new Map(slots.map((slot) => [hexKey(slot.cell), slot]));

  const rooms = new Map<string, HexRoomGeometry>();
  for (const slot of slots) {
    const center = worldCenter(slot.cell);
    const radius = slot.role === 'hub' ? HUB_RADIUS : isComponentRole(slot.role) ? WAR_ROOM_HEX_RADIUS : ROOM_RADIUS;
    rooms.set(hexKey(slot.cell), { center, radius, openEdges: [], corners: hexRoomCorners(center, radius), role: slot.role, slot });
  }

  const connections: HexConnection[] = [];
  for (const slot of slots) {
    const parentSlot = parentOf(slot, bySlotKey);
    if (!parentSlot) continue;
    const room = rooms.get(hexKey(slot.cell))!;
    const parent = rooms.get(hexKey(parentSlot.cell))!;
    const childSide = rampToward(room.center, room.radius, parent.center);
    const parentSide = rampToward(parent.center, parent.radius, room.center);
    room.openEdges.push(childSide.openEdge);
    parent.openEdges.push(parentSide.openEdge);
    connections.push({ parent, child: room, parentRamp: parentSide.ramp, childRamp: childSide.ramp });
  }

  const roomList = [...rooms.values()];
  const byRole = (role: RoomRole) => roomList.find((room) => room.role === role)!;
  const connectionBetween = (parent: HexRoomGeometry, child: HexRoomGeometry) =>
    connections.find((connection) => connection.parent === parent && connection.child === child)!;

  const hub = byRole('hub');
  const office = byRole('office');
  const library = byRole('library');
  const hubOffice = connectionBetween(hub, office);
  const officeLibrary = connectionBetween(office, library);

  return {
    rooms: roomList,
    connections,
    hub, office, library,
    hubRamp: hubOffice.parentRamp,
    officeRamp: hubOffice.childRamp,
    officeLibraryRamp: officeLibrary.parentRamp,
    libraryRamp: officeLibrary.childRamp,
  };
}

/** Steps 2-4's own default world: the Hub, the fixed Office, and one Library hex — no
 * component wings. Kept as its own function since every step-4-and-earlier caller and test
 * already calls this with no arguments. */
export function buildHexOfficeLayout(): HexOfficeLayout {
  return buildHexWorld({ library: 1, portal: 0, agents: 0, tooling: 0, infra: 0 });
}

/** The walking height at a world position, across the whole hex structure: any room's floor
 * (0), a stair ramp (0 to `WALKWAY_HEIGHT`), a walkway deck (`WALKWAY_HEIGHT`), or `null`. */
export function hexSurfaceHeightAt(layout: HexOfficeLayout, x: number, z: number): number | null {
  const point = { x, z };
  for (const room of layout.rooms) {
    if (pointInPolygon(point, room.corners)) return 0;
  }
  for (const connection of layout.connections) {
    const onParentRamp = segmentHeightAt(point, connection.parentRamp.from, connection.parentRamp.to, WALKWAY_WIDTH, 0, WALKWAY_HEIGHT);
    if (onParentRamp !== null) return onParentRamp;
    const onChildRamp = segmentHeightAt(point, connection.childRamp.from, connection.childRamp.to, WALKWAY_WIDTH, 0, WALKWAY_HEIGHT);
    if (onChildRamp !== null) return onChildRamp;
    const onDeck = segmentHeightAt(point, connection.parentRamp.to, connection.childRamp.to, WALKWAY_WIDTH, WALKWAY_HEIGHT, WALKWAY_HEIGHT);
    if (onDeck !== null) return onDeck;
  }
  return null;
}

/** Every hex wall segment's collision footprint, for `LayoutStrategy.wallColliders()`. */
export function hexWallColliders(layout: HexOfficeLayout): Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> {
  const half = HEX_WALL_THICKNESS / 2;
  return layout.rooms.flatMap((room) => hexWallSegments(room.center, room.radius, room.openEdges).map((segment) => segmentBounds(segment.a, segment.b, half)));
}

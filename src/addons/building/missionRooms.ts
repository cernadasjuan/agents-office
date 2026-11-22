import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { PIECES } from '../../furniture/index.js';
import { getToonMaterial } from '../../utils/Materials.js';
import type { Station } from '../../scene/Office.js';
import { markStatic } from '../../scene/StaticMerge.js';
import type { PickTarget } from '../../scene/Selection.js';
import type { WorldRoom } from '../../extensions.js';
import { ROOM_SIZE, type Door, type Rect, type RoomSlot, type Side } from './RoomPlanner.js';
import { buildCeiling, buildWalls, doorFrame, markCutaway, markDoorCutaway, place, roomLabel, RoomFrame, setRoomLabelText, station } from './rooms.js';
import { sceneOf, setTombstoneName, tombstoneNameBatchFor, tombstoneNameplate } from './tombstoneNames.js';
import { furnishWarRoom, WAR_ROOM_WIDTH, type WarRoomCounts } from './warRoomFurnishing.js';
import { sessionLines, sessionRows, type SessionEntry, type SessionRow } from './displayWall.js';

/**
 * The mission wing: war rooms north of the hall, behind its back wall, two columns either
 * side of the mission corridor, stacked further north one row at a time.
 *
 * Issue #123 review: before this, only row 0 opened directly onto the hall; every row after
 * it chained onto the room in front of it through `extraDoors` (`BuildingLayout.syncWorldRooms`),
 * so a deep room was reachable only by crossing another room's closed door. Fixed by running
 * the mission corridor (`missionCorridorRect`) up the old shared boundary between the two
 * columns (x = -9) and giving every row's room a door straight onto it, on the column's own
 * outward-facing side wall — never on the wall it shares with the row before or after it. The
 * corridor itself opens into the hall once, at its own south end (`MISSION_CORRIDOR_DOOR`), so
 * the hall still reads as the one place every wing ultimately connects back to.
 *
 * Issue #193: a war room's door-wall length is `WAR_ROOM_WIDTH` (18), wider than a generic
 * room's `ROOM_SIZE` (12, which stays its depth), so the desk grid fits 6-8 desks instead of
 * 4. Issue #123 review (blocking defect 1): that door-wall length is the rect's extent
 * *parallel* to the door, not always the rect's x-span — now the door sits on the east/west
 * wall, `WAR_ROOM_WIDTH` is each row's own z-span (the wing's growth direction), and the
 * rect's x-span (the depth from the door to the far wall) is `ROOM_SIZE`, same as any other
 * room's depth. Column 1's east edge (x <= `CORRIDOR_MAX_X + ROOM_SIZE`, well under 15) stays
 * clear of the east-side rented ring (`RoomPlanner.ts`'s `slotFor`, ring 0 index 2, x >= 15, z
 * in [-18, -6]) at any room count — the corridor only ever grows north (more negative z),
 * never widens, so this margin never erodes. Column 0's west edge is unconstrained by the
 * west-side rented ring: that ring sits at z in [-11, 13], never overlapping a war room's
 * z <= -13, by construction (`tests/mission-wing-overlap.test.ts`).
 */
export const MISSION_CORRIDOR_WIDTH = 5;
const CORRIDOR_CENTER_X = -9;
const CORRIDOR_MIN_X = CORRIDOR_CENTER_X - MISSION_CORRIDOR_WIDTH / 2;
const CORRIDOR_MAX_X = CORRIDOR_CENTER_X + MISSION_CORRIDOR_WIDTH / 2;

/** The mission corridor's own door into the hall (issue #123): fixed, since the corridor's south
 * frontage never moves as the wing grows north — only its far (north) end ever extends. */
export const MISSION_CORRIDOR_DOOR: Door = { side: 'south', at: CORRIDOR_CENTER_X };
/** The hall's own matching door for `MISSION_CORRIDOR_DOOR` (the wall it shares with the corridor). */
export const MISSION_CORRIDOR_HALL_DOOR: Door = { side: 'north', at: CORRIDOR_CENTER_X };

// Issue #123 review (blocking defect 1): a war room's door-wall length (the `a` axis every
// desk-grid/furniture position in `warRoomFurnishing.ts` is authored against) is `WAR_ROOM_WIDTH`,
// not `ROOM_SIZE` — true when the door sat on the north/south wall (that wall's own length is
// the rect's x-span), and still true now the door sits on the east/west wall instead (that
// wall's own length is the rect's z-span). So each row's rect runs `WAR_ROOM_WIDTH` along z
// (parallel to its door, the wing's growth direction) and only `ROOM_SIZE` along x (the depth
// from the door to the far wall) — the two dimensions from the pre-#123 room, kept on the same
// meaning they always had, just carried by the other world axis now that the door moved.
const WING_COLUMNS: Array<{ minX: number; maxX: number; side: Side }> = [
  { minX: CORRIDOR_MIN_X - ROOM_SIZE, maxX: CORRIDOR_MIN_X, side: 'east' },
  { minX: CORRIDOR_MAX_X, maxX: CORRIDOR_MAX_X + ROOM_SIZE, side: 'west' },
];

export function missionSlot(index: number): RoomSlot {
  const column = WING_COLUMNS[index % WING_COLUMNS.length];
  const row = Math.floor(index / WING_COLUMNS.length);
  const maxZ = -13 - row * WAR_ROOM_WIDTH;
  const rect = { minX: column.minX, maxX: column.maxX, minZ: maxZ - WAR_ROOM_WIDTH, maxZ };
  // Issue #123: every row's door opens onto its own frontage on the mission corridor, never
  // onto the row before or after it.
  const at = (rect.minZ + rect.maxZ) / 2;
  return { rect, door: { side: column.side, at }, outward: 'north', ring: row };
}

/**
 * The mission corridor's own rect (issue #123): the one shared frontage every war room's door
 * opens directly onto. Its south end is fixed, flush against the hall's own back wall; its
 * north end grows one `WAR_ROOM_WIDTH` further out each time a new row is rented (the row's
 * own height, issue #123 review defect 1), so there is no room-count cap on the wing it serves.
 */
export function missionCorridorRect(roomCount: number): Rect {
  const rows = Math.max(1, Math.ceil(roomCount / WING_COLUMNS.length));
  return { minX: CORRIDOR_MIN_X, maxX: CORRIDOR_MAX_X, minZ: -13 - rows * WAR_ROOM_WIDTH, maxZ: -13 };
}

/** The mission corridor's own floor (issue #123), the same open-mission tint every war room's
 * floor starts in, so the corridor reads as part of the same wing, not a separate room. */
export function missionCorridorFloor(rect: Rect): THREE.Mesh {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(rect.maxX - rect.minX, rect.maxZ - rect.minZ), getToonMaterial(FLOOR_OPEN));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((rect.minX + rect.maxX) / 2, 0.005, (rect.minZ + rect.maxZ) / 2);
  floor.receiveShadow = true;
  floor.userData.floor = true;
  return floor;
}

export const MAX_TOMBSTONES = 12;
const TABLE_SEATS = 8;
const STANDING_SPOTS = 12;

/** The one board-drawing recipe (title line, then up to as many lines as the height fits), at a given pixel offset within whatever canvas owns it — `canvasBoard`'s own canvas, or one region of `combinedBoard`'s shared one. */
function drawBoardContent(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title: string, lines: string[]): void {
  ctx.fillStyle = '#f7f3ea';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#2a2a3e';
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.fillText(title.slice(0, 34), x + 18, y + 42);
  ctx.font = '22px system-ui, sans-serif';
  lines.slice(0, Math.floor((h - 70) / 28)).forEach((line, i) => ctx.fillText(line.slice(0, 44), x + 18, y + 82 + i * 28));
}

export function canvasBoard(width: number, height: number): { mesh: THREE.Mesh; draw: (title: string, lines: string[]) => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round(512 * (height / width));
  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture }));
  const draw = (title: string, lines: string[]) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawBoardContent(ctx, 0, 0, canvas.width, canvas.height, title, lines);
    texture.needsUpdate = true;
  };
  return { mesh, draw };
}

/**
 * Several non-interactive wall boards sharing one canvas, one texture and one mesh (issue
 * #244): `canvasBoard`'s `MeshBasicMaterial` never merges through `StaticBatch` ("canvas
 * boards" are explicitly excluded, its own doc comment) — a war room with 4 of them cost 4
 * draw calls forever, the one real per-room growth cost `StaticBatch` could not absorb at the
 * 42-room scale issue #123 measures (#244's own honest re-measurement: 132 draw calls for 33
 * more rooms, exactly 4 per room). Each spec's own `position`/`rotationY` (the same values a
 * `mount()` call used to set on its own separate mesh) bake straight into its slice of the
 * merged geometry, so the one resulting mesh needs no transform of its own. Shared, reusable
 * room-furnishing code, not the mission corridor's own layout math (`missionSlot` etc.): the
 * hex war rooms step 5 brings should call this the same way, with their own positions.
 *
 * Not for a board that needs its own pick target: pick resolution is by object identity
 * (`Selection.ts`'s `pickAgent`), so a clickable board sharing an object with others here would
 * make a click anywhere on any of them wrongly resolve to the clickable one too. `buildMissionRoom`
 * keeps the issues board on its own plain `canvasBoard` for exactly this reason.
 *
 * Review fix: each spec gets `canvasBoard`'s own pixel sizing (a fixed 512 px width, height
 * scaled to the spec's own aspect ratio), not one `PX_PER_UNIT` shared across every spec. A
 * single shared density (the first version of this function) packs a narrower board (docs,
 * 2.4 wide) into fewer pixels than its old dedicated canvas gave it — `drawBoardContent`'s line
 * capacity is `Math.floor((h - 70) / 28)`, so the docs board silently dropped from 9 lines to 5,
 * truncating any mission with 6-9 documents, not just drawing them smaller. Keeping each spec's
 * own 512-px-wide density preserves its exact old line capacity and text size.
 */
export function combinedBoard(specs: ReadonlyArray<{ width: number; height: number; position: THREE.Vector3; rotationY: number }>): {
  mesh: THREE.Mesh;
  draw: (index: number, title: string, lines: string[]) => void;
  /**
   * Draws a spec's own region as horizontal sections (issue #223), the same recipe
   * `canvasBoardSections` uses on its own dedicated canvas — for a spec that needs more than
   * one title+lines block on its own board (the kanban board's sessions list, below its kanban
   * columns) without spending a second mesh and a second permanent draw call per war room.
   */
  drawSections: (index: number, sections: Array<{ title: string; lines: string[] }>) => void;
  /**
   * A spec's own region, in both canvas-pixel space (`x`/`y`/`w`/`h`) and UV space
   * (`vTop`/`vBottom`, the merged mesh's own `flipY` convention) — enough for a caller to
   * convert a raycast hit's `uv.y` (always in the shared canvas's full UV space, never a
   * region-local [0, 1]) into a position within its own region, the same math
   * `resolveSessionRow` below does for the kanban region.
   */
  regionOf: (index: number) => { x: number; y: number; w: number; h: number; vTop: number; vBottom: number };
} {
  const pixelSizes = specs.map((spec) => ({ w: 512, h: Math.round(512 * (spec.height / spec.width)) }));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(...pixelSizes.map((size) => size.w));
  canvas.height = pixelSizes.reduce((sum, size) => sum + size.h, 0);
  const texture = new THREE.CanvasTexture(canvas);
  const geometries: THREE.BufferGeometry[] = [];
  const regions: Array<{ x: number; y: number; w: number; h: number }> = [];
  const vBounds: Array<{ vTop: number; vBottom: number }> = [];
  let yTop = 0;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const { w, h } = pixelSizes[i];
    regions.push({ x: 0, y: yTop, w, h });
    // Canvas 2D draws top-down (y=0 at the top); a `CanvasTexture`'s default `flipY` reads a
    // texture bottom-up, so row 0 of the canvas is V=1, and row `canvas.height` is V=0 — the
    // region's own top edge (closer to row 0) gets the higher V. Only V is ever subdivided
    // here: every region keeps the canvas's full width (`PlaneGeometry`'s default U, 0 to the
    // region's own fraction of the shared canvas width), so there is no horizontal slicing to
    // get backwards the same way.
    const vTop = 1 - yTop / canvas.height;
    const vBottom = 1 - (yTop + h) / canvas.height;
    vBounds.push({ vTop, vBottom });
    const uRight = w / canvas.width;
    const geometry = new THREE.PlaneGeometry(spec.width, spec.height);
    const uv = geometry.attributes.uv;
    for (let v = 0; v < uv.count; v++) {
      uv.setXY(v, uv.getX(v) * uRight, vBottom + uv.getY(v) * (vTop - vBottom));
    }
    uv.needsUpdate = true;
    geometry.rotateY(spec.rotationY);
    geometry.translate(spec.position.x, spec.position.y, spec.position.z);
    geometries.push(geometry);
    yTop += h;
  }
  // `useGroups: true` (second arg) tags each input geometry's own vertex range as a group, in
  // order — lets a test (or a later caller) recover one board's own world-space footprint from
  // the merged geometry without assuming a fixed vertex count per plane. This costs nothing at
  // render time: `RenderBudget.ts`'s own `callsOf` counts groups as separate draw calls only
  // when `material` is an array; this mesh's material is one plain `MeshBasicMaterial`, never an array.
  const merged = mergeGeometries(geometries, true) ?? new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ map: texture }));
  const draw = (index: number, title: string, lines: string[]) => {
    const ctx = canvas.getContext('2d');
    const region = regions[index];
    if (!ctx || !region) return;
    drawBoardContent(ctx, region.x, region.y, region.w, region.h, title, lines);
    texture.needsUpdate = true;
  };
  const drawSections = (index: number, sections: Array<{ title: string; lines: string[] }>) => {
    const ctx = canvas.getContext('2d');
    const region = regions[index];
    if (!ctx || !region) return;
    drawSectionedBoardContent(ctx, region.x, region.y, region.w, region.h, sections);
    texture.needsUpdate = true;
  };
  const regionOf = (index: number) => {
    const region = regions[index];
    const bounds = vBounds[index];
    if (!region || !bounds) throw new Error(`combinedBoard: no region ${index}`);
    return { ...region, ...bounds };
  };
  return { mesh, draw, drawSections, regionOf };
}

// A section's own row geometry (issue #223 review): the title sits at `top + SECTION_TITLE_Y`,
// its first content line at `top + SECTION_FIRST_ROW_Y`, each one after it `SECTION_ROW_HEIGHT`
// px further down. `resolveSessionRow` below reads these same three numbers (not a separate,
// assumed-even split) so the row a click resolves to can never drift from the row actually
// drawn there again. Tuned so a 128 px section (a kanban board's own section height, with 2
// sections, whether drawn on its own dedicated canvas or inside `combinedBoard`'s shared one)
// fits all `MAX_SESSION_ROWS` (4) rows, not just 3 of them.
const SECTION_TITLE_Y = 30;
const SECTION_FIRST_ROW_Y = 60;
const SECTION_ROW_HEIGHT = 19;

/**
 * `canvasBoardSections`' and `combinedBoard`'s shared sections-drawing recipe (issue #223 round
 * 2): a board area split into equal horizontal bands, each its own title and lines, at a given
 * pixel offset within whatever canvas owns it — a dedicated one, or one region of
 * `combinedBoard`'s shared one. Kept as one function so a region embedded in `combinedBoard`
 * (the merged-mesh path, no extra draw call) and a board drawn on its own dedicated canvas paint
 * pixel-identical output, and so `resolveSessionRow` below only ever has to reason about one
 * layout.
 */
function drawSectionedBoardContent(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, sections: Array<{ title: string; lines: string[] }>): void {
  if (sections.length === 0) return;
  ctx.fillStyle = '#f7f3ea';
  ctx.fillRect(x, y, w, h);
  const sectionHeight = h / sections.length;
  const rowCapacity = Math.floor((sectionHeight - (SECTION_FIRST_ROW_Y - SECTION_ROW_HEIGHT / 2)) / SECTION_ROW_HEIGHT);
  sections.forEach((section, i) => {
    const top = y + i * sectionHeight;
    if (i > 0) {
      ctx.strokeStyle = '#cfc8b8';
      ctx.beginPath();
      ctx.moveTo(x + 10, top);
      ctx.lineTo(x + w - 10, top);
      ctx.stroke();
    }
    ctx.fillStyle = '#2a2a3e';
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.fillText(section.title.slice(0, 34), x + 16, top + SECTION_TITLE_Y);
    ctx.font = '16px system-ui, sans-serif';
    section.lines.slice(0, rowCapacity).forEach((line, j) => ctx.fillText(line.slice(0, 44), x + 16, top + SECTION_FIRST_ROW_Y + j * SECTION_ROW_HEIGHT));
  });
}

/**
 * A board split into equal horizontal sections, each its own title and lines (issue #223): the
 * kanban board also carries the live-sessions list, on the same mesh, so the display wall adds
 * no new per-room draw call (the growth-rate guard in
 * `tests/mission-corridor-render-budget.test.ts` polices exactly that cost; a canvas board's
 * material cannot merge into `StaticMerge`'s batch, so every extra board mesh is a real,
 * permanent cost per war room). Top to bottom, the same reading order `canvasBoard` uses.
 *
 * Review (issue #223 vs #244): a war room's kanban board actually lives inside `combinedBoard`
 * (its own region, alongside statement and docs — see `buildMissionRoom`'s own call), not on a
 * dedicated mesh of its own; this stays exported for the one test fixture that still exercises
 * the sections layout on its own canvas directly (`tests/mission-rooms.test.ts`), and as the
 * one place this board's layout is defined, `combinedBoard`'s own per-region draw delegates to
 * the same `drawSectionedBoardContent` this calls.
 */
export function canvasBoardSections(width: number, height: number): { mesh: THREE.Mesh; draw: (sections: Array<{ title: string; lines: string[] }>) => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round(512 * (height / width));
  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture }));
  const draw = (sections: Array<{ title: string; lines: string[] }>) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawSectionedBoardContent(ctx, 0, 0, canvas.width, canvas.height, sections);
    texture.needsUpdate = true;
  };
  return { mesh, draw };
}

/**
 * A war room sign. It is a detail sign: the label controller shows it only when
 * the camera is close or the pointer is over its room (`hoverOnly`: hover only).
 */
function sign(text: string, position: THREE.Vector3, rect: Rect, hoverOnly: boolean, background = 'rgba(30, 32, 48, 0.85)'): CSS2DObject {
  const element = document.createElement('div');
  element.textContent = text;
  element.dataset.sign = 'mission';
  Object.assign(element.style, {
    background, color: '#f5f0e8', padding: '2px 8px', borderRadius: '4px',
    font: '600 12px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none',
  });
  const label = new CSS2DObject(element);
  label.position.copy(position);
  label.userData.detailSign = { rect: { ...rect }, hoverOnly };
  return label;
}

export interface MissionRoom {
  id: string;
  index: number;
  slot: RoomSlot;
  group: THREE.Group;
  stations: Map<string, Station>;
  locked: boolean;
  /** The room's current displayed title (issue #89 review, fix 2): `#room=` matches a
   * slugified title against this, since `id` is the server's opaque hash of the mission key
   * and a client never sees the raw slug. */
  title: string;
  update(room: WorldRoom): void;
  /** War-room furniture (issue #125): grows with the peak live count, never shrinks. */
  updateCounts(counts: WarRoomCounts): void;
  /** The room's current peak (issue #129 review round 2): `BuildingLayout` persists this
   * with the room id, so a reload while the room happens to be empty does not reset it to
   * zero and undo the never-shrinks rule. */
  readonly peakCounts: WarRoomCounts;
  /** This room's tombstones, pickable by a click or hover (issue #127). */
  tombstonePickTargets(): PickTarget[];
  /** This room's issue board, pickable by a click (issue #146): opens the real-link list. */
  issuesBoardPickTarget(): PickTarget;
  /**
   * The live sessions board (issue #223 AC3): who works this mission right now, and whether
   * each one works, waits or is blocked. Refreshed on the agent poll (3 s), not the slower
   * world poll `update()` answers to — a mission's statement and issues barely change
   * minute to minute, but who is in the room does.
   */
  updateSessions(entries: SessionEntry[]): void;
  /** The sessions board, pickable by a click (issue #223 AC4): `resolve` turns the row the ray
   * hit into that session's own real agent id, so the click opens the normal agent card — no
   * new card type, the same selection every figure and triage row already drives, and no new
   * mesh per row either (the draw-call budget's growth-rate guard would catch exactly that). */
  sessionsBoardPickTarget(): PickTarget;
}

const FLOOR_OPEN = 0x6f7f9a;
const FLOOR_LOCKED = 0x4a4f5a;

export function buildMissionRoom(room: WorldRoom, index: number, initialCounts?: WarRoomCounts): MissionRoom {
  const slot = missionSlot(index);
  const frame = new RoomFrame(slot.rect, slot.door);
  const group = new THREE.Group();
  group.name = `mission-room-${index}`;
  markStatic(group, { zone: 'missions', castShadow: false });
  const stations = new Map<string, Station>();
  const key = (n: number) => `mission${index}_seat_${n}`;
  const type = `room:${room.id}`;

  // Issue #123 review round 2: the door-wall's own length (the `a` axis every along-the-wall
  // mount, the kanban board and the closed-door slab both included, is authored against) is
  // the rect's x-span for a north/south door, its z-span for an east/west one — same rule
  // `RoomFrame` uses for depth, just the complementary dimension.
  const doorIsNorthSouth = slot.door.side === 'north' || slot.door.side === 'south';
  const doorWallLength = doorIsNorthSouth ? slot.rect.maxX - slot.rect.minX : slot.rect.maxZ - slot.rect.minZ;

  // Issue #193: a war room's own width (`WAR_ROOM_WIDTH`) is wider than its depth
  // (`ROOM_SIZE`, unchanged), so the floor is the slot's real rect, not a square.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(slot.rect.maxX - slot.rect.minX, slot.rect.maxZ - slot.rect.minZ), getToonMaterial(FLOOR_OPEN));
  floor.rotation.x = -Math.PI / 2;
  floor.position.copy(frame.point(0, ROOM_SIZE / 2, 0.005));
  floor.userData.floor = true;
  group.add(floor);
  const walls = buildWalls(slot.rect, [slot.door]);
  walls.name = 'room-walls';
  markCutaway(walls);
  group.add(walls);
  const doorway = doorFrame(slot.rect, slot.door, FLOOR_OPEN);
  markDoorCutaway(doorway);
  group.add(doorway);
  group.add(buildCeiling(slot.rect));
  const label = roomLabel(room.title, frame.point(0, ROOM_SIZE / 2), slot.rect);
  group.add(label);

  // The table and its seats; more agents stand around it
  const center = frame.point(0, 6.2);
  const table = PIECES.meetingTable().create();
  table.position.copy(center);
  group.add(table);
  for (let i = 0; i < TABLE_SEATS; i++) {
    const angle = (i / TABLE_SEATS) * Math.PI * 2;
    const position = center.clone().add(new THREE.Vector3(Math.cos(angle) * 1.9, 0, Math.sin(angle) * 1.9));
    stations.set(key(i), { type, position, lookAt: center.clone().setY(1.0), occupied: false, posture: 'seated' });
  }
  for (let i = 0; i < STANDING_SPOTS; i++) {
    const angle = ((i + 0.5) / STANDING_SPOTS) * Math.PI * 2;
    const position = center.clone().add(new THREE.Vector3(Math.cos(angle) * 3.0, 0, Math.sin(angle) * 3.0));
    stations.set(key(TABLE_SEATS + i), { type, position, lookAt: center.clone().setY(1.2), occupied: false, posture: 'standing' });
  }

  // Wall boards: the statement on the far wall, docs and issues beside it, the kanban on a side
  // wall. Issue #244: statement, docs and kanban share one mesh (`combinedBoard`) — none of the
  // three is individually clickable at the board level, so merging them costs nothing
  // functionally and saves 2 of the 4 per-room draw calls a canvas board can never get back
  // through `StaticBatch`. `issues` stays its own plain `canvasBoard`: it is a pick target
  // (`issuesBoardPickTarget` below) resolved by plain object identity, so sharing its mesh with
  // the other three would make a click anywhere on them wrongly resolve to it too.
  //
  // Issue #223: the kanban region also carries the live-sessions list, as a second section on
  // the same region of the same shared canvas (`combined.drawSections`/`regionOf`, below) —
  // still no 5th mesh, the exact extra per-room draw call
  // `tests/mission-corridor-render-budget.test.ts`'s growth-rate guard exists to catch (a 5th
  // mesh, even merged into `combined.mesh`'s own geometry, cannot share `combined.mesh`'s pick
  // resolution the way `issues` avoids `combined.mesh` entirely above — sessions needs its own
  // resolver (`resolveSessionRow` below) reached through the SAME region a click on it already
  // lands on, which only works by splitting that region's own canvas area, never by adding a
  // 4th spec). This wall (a = doorWallLength / 2, opposite the tombstones) carries no floor
  // furniture at all, so nothing ever stands in front of it, the "no furniture in front" rule
  // (AC1) without needing a new wall-finding seam for a rectangle room: a war room's four walls
  // are already fixed roles (door, far, tombstones, kanban+sessions). The far wall's own
  // clock/whiteboard/bookshelf moved clear of its own board row for the same reason
  // (`warRoomFurnishing.ts`).
  const combined = combinedBoard([
    { width: 3.6, height: 1.6, position: frame.point(0, ROOM_SIZE - 0.12, 1.7), rotationY: frame.faceDoor },
    { width: 2.4, height: 1.6, position: frame.point(-3.6, ROOM_SIZE - 0.12, 1.7), rotationY: frame.faceDoor },
    // Issue #123 review round 2: this used the rect's x-span unconditionally, left over from
    // when the door wall always ran along x — once the corridor fix moved war room doors onto
    // the east/west wall, the door-wall's real length became the rect's z-span instead, and the
    // board floated 3+ meters off the side wall it is meant to sit flush against.
    { width: 3.6, height: 1.8, position: frame.point(doorWallLength / 2 - 0.12, 6, 1.7), rotationY: frame.faceDoor - Math.PI / 2 },
  ]);
  group.add(combined.mesh);
  const issuesCanvas = canvasBoard(2.4, 1.6);
  issuesCanvas.mesh.position.copy(frame.point(3.6, ROOM_SIZE - 0.12, 1.7));
  issuesCanvas.mesh.rotation.y = frame.faceDoor;
  group.add(issuesCanvas.mesh);
  const boards = {
    statement: { draw: (title: string, lines: string[]) => combined.draw(0, title, lines) },
    docs: { draw: (title: string, lines: string[]) => combined.draw(1, title, lines) },
    issues: issuesCanvas,
    kanban: { draw: (sections: Array<{ title: string; lines: string[] }>) => combined.drawSections(2, sections) },
  };

  // Issue #223: the kanban board's own two sections, top to bottom — kanban columns, then
  // live sessions. Each half redraws independently (`update()` on the slower world poll,
  // `updateSessions()` on the 3 s agent poll), so both share one `redrawKanban` that always
  // repaints from the latest of each, never half-stale.
  let lastKanbanLines: string[] = [];
  let currentSessionRows: SessionRow[] = [];
  let lastSessionsSignature = '';
  const redrawKanban = () => boards.kanban.draw([
    { title: 'Kanban', lines: lastKanbanLines },
    { title: 'Sessions', lines: sessionLines(currentSessionRows) },
  ]);

  // Issue #223 AC4: which session a click on the board landed on, from the ray hit's own UV
  // (`PickTarget.resolve`, `scene/Selection.ts`) — not an extra mesh per row. The sessions
  // section is the bottom half of the kanban region; a hit outside that region entirely (the
  // statement or docs regions of the same merged `combined.mesh`), in the kanban half, in the
  // section's own title band, or past the last row actually drawn, all resolve to no selection
  // (not the nearest row) — a stale row position must never pretend to be the session that
  // used to be there.
  //
  // Review fix: this must mirror `drawSectionedBoardContent`'s own pixel layout for this region
  // (two sections, each `SECTION_HEIGHT_PX` tall), not an assumed even split across title +
  // MAX_SESSION_ROWS slots. An even split drifts from the real layout: verified, the row
  // drawn at the top of the list resolved one row too low, and a click on the "Sessions"
  // title itself wrongly resolved to the first row. `SECTION_FIRST_ROW_Y`/`SECTION_ROW_HEIGHT`
  // are the same two constants `draw()` itself paints rows at, so this can never drift again.
  //
  // Issue #223 vs #244: `hit.uv.y` is always in `combined`'s shared canvas's full UV space
  // (`combinedBoard`'s own doc comment), never a region-local [0, 1] the way it would be for a
  // board on its own dedicated canvas — `kanbanRegion.vTop`/`vBottom` (this region's own band
  // within the shared canvas) converts it to region-local first, then the rest of this function
  // is the same math a dedicated `canvasBoardSections(3.6, 1.8)` mesh would use.
  const kanbanRegion = combined.regionOf(2);
  const SECTION_HEIGHT_PX = kanbanRegion.h / 2; // this region split into 2 equal sections
  const resolveSessionRow = (hit: THREE.Intersection): string | null => {
    if (!hit.uv) return null;
    if (hit.uv.y > kanbanRegion.vTop || hit.uv.y < kanbanRegion.vBottom) return null; // not even in this region
    const localV = (hit.uv.y - kanbanRegion.vBottom) / (kanbanRegion.vTop - kanbanRegion.vBottom);
    if (localV >= 0.5) return null; // the kanban-columns half, not sessions
    // flipY texture: localV = 0.5 is this section's top edge (the kanban/sessions divider),
    // localV = 0 is the region's own bottom edge.
    const yFromSectionTop = SECTION_HEIGHT_PX * (1 - localV / 0.5);
    const firstRowBoundary = SECTION_FIRST_ROW_Y - SECTION_ROW_HEIGHT / 2;
    if (yFromSectionTop < firstRowBoundary) return null; // the "Sessions" section title
    const rowIndex = Math.floor((yFromSectionTop - firstRowBoundary) / SECTION_ROW_HEIGHT);
    return currentSessionRows[rowIndex]?.id ?? null;
  };

  // Issue #124: the title and lock signs sit on the far wall, over the statement board, not
  // near the door frame (the narration: "they are in the door frames so it's kind of weird").
  const title = sign(room.title, frame.point(0, ROOM_SIZE - 0.3, 2.6), slot.rect, false);
  group.add(title);
  const tombstonesGroup = new THREE.Group();
  group.add(tombstonesGroup);
  // One tombstone per ended session, along the side wall opposite the kanban, keyed by its own id
  // (not by position): a session that returns removes its own tombstone, not whichever is oldest.
  // `nameplate` is a child of `object` (issue #159, review round 1: a texture decal, not a
  // floating `CSS2DObject`): it moves with the stone for free, and the scene's one shared
  // `TombstoneNameBatch` draws every tombstone's name in a single call regardless of count.
  const tombstones = new Map<string, { object: THREE.Object3D; nameplate: THREE.Object3D; name?: string }>();
  const door = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 0.1), getToonMaterial(0x5a4a3a));
  // Issue #123 review (blocking defect 2): `door.at` is a z-coordinate for an east/west door
  // (the gap axis `wallPieces` uses for that side), not always an x-coordinate — subtracting
  // the rect's x-center unconditionally put the closed-door slab in the wrong spot once the
  // corridor fix moved war room doors onto the east/west wall.
  const doorAlongCenter = doorIsNorthSouth
    ? (slot.rect.minX + slot.rect.maxX) / 2
    : (slot.rect.minZ + slot.rect.maxZ) / 2;
  door.position.copy(frame.point(slot.door.at - doorAlongCenter, 0.02, 1.2));
  // The slab's own width (2.4) runs along its local x axis; it only lines up with the door
  // wall's own length (the rect's x-span) for a north/south door. An east/west door's wall
  // runs along z instead, so the slab needs a quarter turn to stay flush with it, not poke
  // 1.2 m out the room's side wall (issue #123 review, found while fixing blocking defect 2).
  door.rotation.y = doorIsNorthSouth ? 0 : Math.PI / 2;
  door.visible = false;
  // The closed door stands in the doorway: it drops with the walls in the overview
  markCutaway(door);
  group.add(door);
  const lockSign = sign('Locked: mission closed', frame.point(0, ROOM_SIZE - 0.3, 2.3), slot.rect, false, 'rgba(120, 40, 40, 0.9)');
  lockSign.visible = false;
  group.add(lockSign);
  let sleepersSign: CSS2DObject | null = null;

  // War-room furniture (issue #125): a rule set, not hand-placed. `furniture` holds every
  // piece `furnishWarRoom` plans; it rebuilds only when the peak live count actually grows.
  const furniture = new THREE.Group();
  group.add(furniture);
  // A stable identity per piece (its station type and its ordinal among stations of that
  // same type), not the array position `furnishWarRoom` happens to place it at (issue #125/
  // #126 review round 3): the desk grid's slots come first in that array, so growing one
  // desk shifts every must-have after it by one index. Keying by array position carried an
  // existing occupant's `occupied` flag onto a now-different piece (a researcher's flag
  // landing on the whiteboard), so a planner found the real whiteboard falsely taken.
  const furnitureKey = (type: string, ordinal: number) => `mission${index}_furniture_${type}_${ordinal}`;
  let peakCounts: WarRoomCounts = initialCounts ? { ...initialCounts } : { deskLike: 0, debugging: 0 };
  let furnitureStationKeys: string[] = [];

  const rebuildFurniture = () => {
    for (const key of furnitureStationKeys) stations.delete(key);
    furnitureStationKeys = [];
    furniture.clear();
    const plan = furnishWarRoom(room.id, peakCounts, frame.doorAlong);
    plan.pieces.forEach((placement) => {
      const object = placement.piece.create();
      object.userData.piece = placement.piece.name;
      place(furniture, object, frame.point(placement.a, placement.d, placement.y ?? 0), frame.faceDoor + (placement.turn ?? 0));
    });
    const ordinalByType = new Map<string, number>();
    plan.stations.forEach((spot) => {
      const ordinal = ordinalByType.get(spot.type) ?? 0;
      ordinalByType.set(spot.type, ordinal + 1);
      const key = furnitureKey(spot.type, ordinal);
      // Room-scoped, issue #126: `room:<id>:<activity>` so BuildingLayout can route an agent to
      // this room's own piece without ever matching another war room's same-named station.
      stations.set(key, station(`room:${room.id}:${spot.type}`, frame.point(spot.a, spot.d), frame.point(...spot.look), spot.posture));
      furnitureStationKeys.push(key);
    });
  };
  rebuildFurniture();

  const result: MissionRoom = {
    id: room.id, index, slot, group, stations, locked: false, title: room.title,
    get peakCounts() {
      return peakCounts;
    },
    updateCounts(next: WarRoomCounts) {
      const deskLike = Math.max(peakCounts.deskLike, next.deskLike);
      const debugging = Math.max(peakCounts.debugging, next.debugging);
      if (deskLike === peakCounts.deskLike && debugging === peakCounts.debugging) return;
      peakCounts = { deskLike, debugging };
      rebuildFurniture();
    },
    tombstonePickTargets: () => [...tombstones].map(([id, { object }]) => ({ id, object })),
    issuesBoardPickTarget: () => ({ id: `issues:${room.id}`, object: boards.issues.mesh }),
    updateSessions(entries: SessionEntry[]) {
      // Review fix: `BuildingLayout.update()` calls this every animation frame (through
      // `growMissionFurniture`), not only on the 3 s agent poll the comment above assumed —
      // redraw (and texture upload) only when the rows actually changed, the same render-on-
      // change rule every other board redraw in this file already follows.
      const rows = sessionRows(entries);
      const signature = rows.map((row) => `${row.id}:${row.name}:${row.state}`).join('|');
      if (signature === lastSessionsSignature) return;
      lastSessionsSignature = signature;
      currentSessionRows = rows;
      redrawKanban();
    },
    // The sessions pick target shares `combined.mesh` with the statement/docs/kanban boards
    // (issue #223 vs #244: the kanban region lives inside `combined`, not on a mesh of its
    // own) — safe only because `resolveSessionRow` itself gates on the kanban region's own UV
    // band first, so a click anywhere else on `combined.mesh` already resolves to no selection,
    // the same as a click on the kanban half of this same region does.
    sessionsBoardPickTarget: () => ({ id: `sessions-board:${room.id}`, object: combined.mesh, resolve: resolveSessionRow }),
    update(next: WorldRoom) {
      result.locked = next.state === 'locked';
      result.title = next.title;
      title.element.textContent = next.title;
      setRoomLabelText(label, next.title);
      door.visible = result.locked;
      lockSign.visible = result.locked;
      // Swap the cached material, never recolor it: every open mission floor shares it
      floor.material = getToonMaterial(result.locked ? FLOOR_LOCKED : FLOOR_OPEN);
      boards.statement.draw('Mission', (next.walls.statement ?? '').match(/.{1,44}(\s|$)/g)?.map((line) => line.trim()) ?? []);
      boards.docs.draw('Documents', next.walls.docs ?? []);
      boards.issues.draw('Issues', (next.walls.issues ?? []).map((issue) => `${issue.state === 'closed' ? '✓' : '○'} #${issue.number} ${issue.title}`));
      lastKanbanLines = (next.walls.kanban ?? []).flatMap((column) =>
        [`${column.column} (${column.cards.length})`, ...column.cards.slice(0, 3).map((card) => `  T-${card.number} ${card.title}`)]);
      redrawKanban();
      // One tombstone per ended session, shown up to the cap; a session no longer in the list
      // (it returned, or scrolled past the cap) removes by id, never by trimming the oldest.
      const sleepers = next.sleepers ?? [];
      const shown = sleepers.slice(0, MAX_TOMBSTONES);
      const keep = new Set(shown.map((entry) => entry.id));
      for (const [id, { object, nameplate }] of [...tombstones]) {
        if (keep.has(id)) continue;
        // Issue #159 review round 1: stop drawing its nameplate first. The shared batch holds a
        // reference to this handle on its own, so a removed tombstone leaves nothing behind.
        const scene = sceneOf(object);
        if (scene) tombstoneNameBatchFor(scene).untrack(nameplate);
        tombstonesGroup.remove(object);
        tombstones.delete(id);
      }
      shown.forEach((entry, i) => {
        const position = frame.point(-ROOM_SIZE / 2 + 0.7 + (i % 2) * 1.05, 2.2 + Math.floor(i / 2) * 1.6, 0);
        const name = entry.name ?? 'Ended session';
        let item = tombstones.get(entry.id);
        if (!item) {
          const object = PIECES.tombstone().create();
          object.rotation.y = frame.faceDoor + Math.PI / 2;
          // Issue #159, review round 1: the engraved name is a texture decal flush with the
          // stone's grey face (`tombstoneNameplate`), not a floating `CSS2DObject`. It replaces
          // the old hover-only sign. A handle created before the room is attached to a scene
          // picks up its batch lazily (`BuildingLayout`'s `collect` call); one created afterward
          // (a later `update()` on an already-attached room) tracks itself right away.
          const nameplate = tombstoneNameplate(name);
          object.add(nameplate);
          tombstonesGroup.add(object);
          const scene = sceneOf(object);
          if (scene) tombstoneNameBatchFor(scene).track(nameplate);
          item = { object, nameplate, name: entry.name };
          tombstones.set(entry.id, item);
        } else if (item.name !== entry.name) {
          item.name = entry.name;
          setTombstoneName(item.nameplate, name);
        }
        item.object.position.copy(position);
      });
      const extra = sleepers.length - shown.length;
      if (sleepersSign) group.remove(sleepersSign);
      sleepersSign = sleepers.length > 0
        ? sign(`${sleepers.length} past session${sleepers.length === 1 ? '' : 's'}${extra > 0 ? ` (+${extra} not shown)` : ''}`, frame.point(-ROOM_SIZE / 2 + 1.2, 1.4, 1.8), slot.rect, true)
        : null;
      if (sleepersSign) group.add(sleepersSign);
    },
  };
  result.update(room);
  result.updateSessions([]);
  return result;
}

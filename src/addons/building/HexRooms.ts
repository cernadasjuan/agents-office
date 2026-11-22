/**
 * Three.js geometry for the hex Hub and Office (issue #218 steps 2 and 3): the first real
 * hex rooms, built side by side with the old rect rooms (`BuildingLayout`'s own `HALL` and
 * `slotFor` rooms), which keep working unconverted. Everything here reads `HexRoomPlanner.ts`
 * for positions — this module only turns that pure geometry into meshes, materials and
 * colliders.
 *
 * Draw-call budget (issue #218 step 1's own render-budget note: main sat at 424/430 before
 * this PR, only 6 calls of headroom): every hex wall shares one material, both hex floors
 * share one (review: a two-tone split was purely cosmetic and not worth a 5th call), the
 * walkway deck and both ramps share one, and the Hub's placeholder furniture (elevator,
 * kitchen, play corner) shares one more — 4 new draw calls total, regardless of room or
 * furniture count, the same `markStatic` merge story every other room in this fork already
 * uses. None of this new geometry casts a shadow (`castShadow: false` throughout): the
 * structure sits far from the main building and its own lights, and 6 calls of headroom has
 * no room for shadow-map passes on top of the main-pass cost. New pin: 428/430 — see the
 * budget rule in issue #217: every later step that adds hex geometry pays for itself by
 * deleting the rect-building code it replaces in the same PR (step 4 deletes the rect
 * library's room path, step 5 deletes the mission corridor), so this budget never needs a cap
 * raise before step 7 deletes the legacy rect system outright. Real, per-piece furniture (the
 * office desk, the queue station, the Hub's leftover desks) is explicitly deferred to the
 * plan's own step 7 ("ship the open-office leftover-desk furnishing"); this PR's AC only
 * needs the Hub reachable with an elevator and kitchen object present, not the full
 * furnishing pass.
 */
import * as THREE from 'three';
import { getToonMaterial } from '../../utils/Materials.js';
import { markStatic } from '../../scene/StaticMerge.js';
import type { WallRect } from '../../layout/LayoutStrategy.js';
import {
  buildHexOfficeLayout,
  buildHexWorld,
  hexWallSegments,
  hexWallColliders,
  hexSurfaceHeightAt,
  hexRoomFrame,
  pointInPolygon,
  type HexOfficeLayout,
  type HexRoomGeometry,
  type HexWorldCounts,
  HEX_WALL_HEIGHT,
  HEX_WALL_THICKNESS,
  WALKWAY_HEIGHT,
  WALKWAY_WIDTH,
} from './HexRoomPlanner.js';
import type { HexPoint } from './HexPlanner.js';
import { FIGURE_EYE_HEIGHT } from '../../characters/StickFigureParts.js';

/** A stone tone distinct from the rect building's own `Colors.wall`, so the two structures
 * read as separate at a glance in the isometric view. */
const HEX_WALL_COLOR = 0xcbbfa6;
/** One shared floor tone for the Hub and Office (review: a two-tone split cost a 5th draw
 * call for a purely cosmetic distinction — not worth it against a 1-point budget margin). */
const HEX_FLOOR_COLOR = 0x6f6456;
/** The walkway deck and both ramps: a cooler, metal-grate tone (the "wire mesh bridge"). */
const WALKWAY_COLOR = 0x5a6670;
/** The Hub's placeholder furniture (elevator, kitchen counter, play corner): one shared
 * accent material, so any number of these pieces still costs one draw call. */
const HEX_ACCENT_COLOR = 0x33363d;

const WALKWAY_DECK_THICKNESS = 0.15;

function v3(point: HexPoint, y: number): THREE.Vector3 {
  return new THREE.Vector3(point.x, y, point.z);
}

/** A box between two points, its local X axis stretched to the distance and turned to face
 * `from -> to` (a horizontal wall segment, or a tilted ramp when the two differ in height).
 * No shadow cast (issue #218 step 1's render-budget note): the structure sits far from the
 * main building and its own lights, so a cast shadow here buys little for 3 shadow-map
 * passes' worth of cost; every mesh still receives, for grounding. Revisit once more of the
 * hex office exists and the render-budget headroom can be rebalanced. */
function orientedBox(from: THREE.Vector3, to: THREE.Vector3, crossA: number, crossB: number, material: THREE.Material): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = direction.length();
  const geometry = new THREE.BoxGeometry(Math.max(length, 0.01), crossA, crossB);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(from).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction.clone().normalize());
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

/** A hex room's floor: a flat polygon fan from its center. Deliberately NOT tagged
 * `userData.floor` (unlike every rect room's floor): that tag feeds `overviewBounds`'
 * `floorUnder`, which unions every floor's world bounds into the isometric camera's default
 * pan/zoom limits. This structure sits `HEX_OFFSET` away from the rect building on purpose
 * (clear of its own growth); including it in those bounds by default zoomed the whole
 * isometric view out far enough to drop "Your office"'s label under the 22 px readability
 * floor (`tests/wayfinding.test.ts`) — a real regression for every existing room, not a cost
 * worth paying before this structure has its own reason to share the camera's default frame.
 * The structure is still fully reachable (`wallColliders`/`surfaceHeightAt` below) and its own
 * screenshot is taken by panning/zooming there deliberately, not by the default view. */
function buildHexFloor(room: HexRoomGeometry, color: number): THREE.Mesh {
  const positions: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = room.corners[i];
    const b = room.corners[(i + 1) % 6];
    // Review (#242): center -> b -> a, not center -> a -> b. `corners` is ordered by
    // increasing angle, which winds a center -> a -> b fan clockwise seen from above (+Y) —
    // its face normal points down, invisible to `FrontSide` `getToonMaterial()` from a
    // downward view or raycast. Swapping a/b flips the winding to counter-clockwise from
    // above, normal up, matching every rect room's floor.
    positions.push(room.center.x, 0, room.center.z, b.x, 0, b.z, a.x, 0, a.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, getToonMaterial(color));
  mesh.name = 'hex-floor';
  mesh.receiveShadow = true;
  return mesh;
}

/** The wall segments of a hex room (its stairs' own edges left open — the office has two,
 * everything else has one), one mesh per segment, all sharing the same material so they
 * merge into the room's shared wall batch. */
function buildHexWalls(room: HexRoomGeometry, material: THREE.Material): THREE.Mesh[] {
  return hexWallSegments(room.center, room.radius, room.openEdges).map((segment) =>
    orientedBox(v3(segment.a, HEX_WALL_HEIGHT / 2), v3(segment.b, HEX_WALL_HEIGHT / 2), HEX_WALL_HEIGHT, HEX_WALL_THICKNESS, material),
  );
}

/** A placeholder elevator: a tall frame with two inset "doors" — enough to read as an
 * elevator at a glance (AC: "elevator ... objects are present"), one shared material so it
 * costs nothing beyond the Hub's own accent draw call. */
function buildElevator(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'hex-hub-elevator';
  const material = getToonMaterial(HEX_ACCENT_COLOR);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.4, HEX_WALL_HEIGHT * 0.85, 0.3), material);
  frame.position.y = (HEX_WALL_HEIGHT * 0.85) / 2;
  frame.castShadow = false;
  frame.receiveShadow = true;
  group.add(frame);
  for (const x of [-0.55, 0.55]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(1, HEX_WALL_HEIGHT * 0.78, 0.08), material);
    door.position.set(x, (HEX_WALL_HEIGHT * 0.78) / 2, 0.19);
    door.castShadow = false;
    door.receiveShadow = true;
    group.add(door);
  }
  return group;
}

/** A placeholder kitchen/play corner: a counter and a low table, one shared material —
 * enough to read as "kitchen and play area" (AC: "kitchen ... objects are present"). Real
 * furniture (the existing `Kitchen.ts`/`FoosballTable.ts` factories) is deferred: each one
 * brings its own extra colors, which this PR's tight draw-call headroom (~6 of 430) does not
 * have room for yet — a follow-up visual pass once the walking flow is proven.
 */
function buildKitchenCorner(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'hex-hub-kitchen';
  const material = getToonMaterial(HEX_ACCENT_COLOR);
  const counter = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 0.6), material);
  counter.position.y = 0.45;
  counter.castShadow = false;
  counter.receiveShadow = true;
  group.add(counter);
  const playTable = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.9), material);
  playTable.position.y = 0.4;
  playTable.castShadow = false;
  playTable.receiveShadow = true;
  group.add(playTable);
  return group;
}

/**
 * Where the camera should go to show a hex room (issue #242 review: `#room=hub` /
 * `#room=hex-office`, the same `RoomView` shape `BuildingLayout.roomView` already returns for
 * a rect room). `hex-office`, not `office` (that name is already the rect office's own, and
 * both rooms exist side by side until step 7 deletes the rect system — resolving `office` to
 * the rect room keeps its existing behavior and tests unchanged). Standing a third of the way
 * in from the open (stair) edge, facing the center, the same framing rule `roomViewFromSlot`
 * uses for a rect room's door wall.
 */
function hexRoomView(room: HexRoomGeometry, kind?: string): { bounds: THREE.Box3; standing: { position: THREE.Vector3; lookAt: THREE.Vector3 }; kind?: string } {
  const xs = room.corners.map((c) => c.x);
  const zs = room.corners.map((c) => c.z);
  const bounds = new THREE.Box3(
    new THREE.Vector3(Math.min(...xs), 0, Math.min(...zs)),
    new THREE.Vector3(Math.max(...xs), HEX_WALL_HEIGHT, Math.max(...zs)),
  );
  // The room's first stair (the office has two — the hub-facing one stands in for "the door").
  const openEdge = room.openEdges[0];
  const a = room.corners[openEdge];
  const b = room.corners[(openEdge + 1) % 6];
  const openMid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const toward = new THREE.Vector3(room.center.x - openMid.x, 0, room.center.z - openMid.z).normalize();
  const position = new THREE.Vector3(openMid.x, 0, openMid.z).addScaledVector(toward, room.radius * 0.6);
  position.y = FIGURE_EYE_HEIGHT;
  const lookAt = position.clone().addScaledVector(toward, 4);
  return { bounds, standing: { position, lookAt }, ...(kind ? { kind } : {}) };
}

export interface BuiltHexOffice {
  group: THREE.Group;
  layout: HexOfficeLayout;
  wallColliders: WallRect[];
  surfaceHeightAt(x: number, z: number): number | null;
  /** `#room=hub` / `#room=hex-office` (issue #242 review). Unknown names return null, the
   * same contract `BuildingLayout.roomView` already keeps for a rect room. */
  roomView(name: string): { bounds: THREE.Box3; standing: { position: THREE.Vector3; lookAt: THREE.Vector3 }; kind?: string } | null;
  /** The hex room (if any) whose floor contains this world point (issue #249: a double-click
   * in isometric only ever checked the rect rooms, so clicking a hex room floor did nothing).
   * The same contract `BuildingLayout.roomAt` already keeps for a rect room. */
  roomAt(x: number, z: number): { bounds: THREE.Box3; standing: { position: THREE.Vector3; lookAt: THREE.Vector3 }; kind?: string } | null;
}

/** Builds the Hub and Office hex rooms and the walkway/stair between them, merged into one
 * static batch per shared material (4 draw calls total: walls, floors, walkway, Hub accents).
 * Pure placement comes from `buildHexOfficeLayout()` — deterministic, same every call. */
export function buildHexOffice(counts?: HexWorldCounts): BuiltHexOffice {
  const layout = counts ? buildHexWorld(counts) : buildHexOfficeLayout();
  const group = new THREE.Group();
  group.name = 'hex-office';

  // Issue #258 steps 5/6: every claimed room (`layout.rooms`), not just the 3 named ones —
  // a component wing's war rooms share these same 3 zones, so a wing of any size still costs
  // exactly these 3 draw calls, never one more per room (the render-budget note above).
  const wallMaterial = getToonMaterial(HEX_WALL_COLOR);
  const walls = new THREE.Group();
  walls.name = 'hex-walls';
  // overviewLower (review, #242): without it this zone has no cutaway height, so these
  // walls stay full height in isometric overview and occlude the Hub furniture behind them —
  // the same `overviewLower: WALL_HEIGHT` every rect room's walls already carry.
  markStatic(walls, { zone: 'hex-walls', castShadow: false, overviewLower: HEX_WALL_HEIGHT });
  for (const room of layout.rooms) {
    for (const wall of buildHexWalls(room, wallMaterial)) walls.add(wall);
  }
  group.add(walls);

  const floors = new THREE.Group();
  floors.name = 'hex-floors';
  markStatic(floors, { zone: 'hex-floors', castShadow: false });
  for (const room of layout.rooms) floors.add(buildHexFloor(room, HEX_FLOOR_COLOR));
  group.add(floors);

  const walkwayMaterial = getToonMaterial(WALKWAY_COLOR);
  const walkway = new THREE.Group();
  walkway.name = 'hex-walkway';
  markStatic(walkway, { zone: 'hex-walkway', castShadow: false });
  for (const connection of layout.connections) {
    walkway.add(orientedBox(v3(connection.parentRamp.from, 0), v3(connection.parentRamp.to, WALKWAY_HEIGHT), WALKWAY_DECK_THICKNESS, WALKWAY_WIDTH, walkwayMaterial));
    walkway.add(orientedBox(v3(connection.childRamp.from, 0), v3(connection.childRamp.to, WALKWAY_HEIGHT), WALKWAY_DECK_THICKNESS, WALKWAY_WIDTH, walkwayMaterial));
    walkway.add(orientedBox(v3(connection.parentRamp.to, WALKWAY_HEIGHT), v3(connection.childRamp.to, WALKWAY_HEIGHT), WALKWAY_DECK_THICKNESS, WALKWAY_WIDTH, walkwayMaterial));
  }
  group.add(walkway);

  const accents = new THREE.Group();
  accents.name = 'hex-hub-accents';
  markStatic(accents, { zone: 'hex-accents', castShadow: false });
  const elevator = buildElevator();
  // Opposite the stair, against the Hub's own back wall, clear of the walkway opening.
  const hubBack = layout.hub.corners[(layout.hub.openEdges[0] + 3) % 6];
  elevator.position.set((layout.hub.center.x + hubBack.x) / 2, 0, (layout.hub.center.z + hubBack.z) / 2);
  elevator.lookAt(layout.hub.center.x, 0, layout.hub.center.z);
  accents.add(elevator);
  const kitchen = buildKitchenCorner();
  const hubSide = layout.hub.corners[(layout.hub.openEdges[0] + 2) % 6];
  kitchen.position.set((layout.hub.center.x + hubSide.x) / 2, 0, (layout.hub.center.z + hubSide.z) / 2);
  kitchen.lookAt(layout.hub.center.x, 0, layout.hub.center.z);
  accents.add(kitchen);
  group.add(accents);

  // Issue #258 review (the floor-library plugin's NPC/shelves went dark the moment the rect
  // library room they keyed off, `room-N-library`, was deleted): an invisible, zero-geometry
  // marker, found by name the same way that plugin already finds a rect room, carrying the
  // hex library's own door-wall frame as plain data — no rect assumptions, no `RoomPlanner`
  // import needed on the plugin's side.
  const libraryMarker = new THREE.Object3D();
  libraryMarker.name = 'hex-library-room';
  libraryMarker.userData.libraryFrame = hexRoomFrame(layout.library, layout.library.openEdges[0]);
  // A plain axis-aligned bounding rect of the hexagon, for the same "is the camera/cursor
  // inside this room" checks `LabelDetail.ts`'s `DetailSign.rect` already does for a rect
  // room — conservative (a touch larger than the hex itself at the corners), fine for that
  // coarse a check.
  const libraryXs = layout.library.corners.map((c) => c.x);
  const libraryZs = layout.library.corners.map((c) => c.z);
  libraryMarker.userData.libraryBounds = {
    minX: Math.min(...libraryXs), maxX: Math.max(...libraryXs),
    minZ: Math.min(...libraryZs), maxZ: Math.max(...libraryZs),
  };
  group.add(libraryMarker);

  // Issue #242 review (root cause of the "very dark" finding): the scene's only real light
  // sources are 3 fixed ceiling spotlights over the rect hall (`SceneSetup.ts`'s
  // `addLighting`), each with `distance: 20` — nowhere near this structure's `HEX_OFFSET`.
  // Ambient and hemisphere light alone render a `MeshToonMaterial` quite dark. A real ceiling
  // lamp (`CeilingLamp.ts`) would fix it too, but its fixture mesh costs its own draw calls
  // per instance (no shared zone) — unaffordable at 2 points of headroom. A bare point light,
  // no fixture mesh, `castShadow: false`, costs nothing in `countDrawCalls` (lights only count
  // when they cast a shadow) and fixes the actual cause directly.
  const hubLight = new THREE.PointLight(0xfff5e6, 18, 25, 1);
  hubLight.position.set(layout.hub.center.x, HEX_WALL_HEIGHT - 0.5, layout.hub.center.z);
  hubLight.castShadow = false;
  group.add(hubLight);
  const officeLight = new THREE.PointLight(0xfff5e6, 14, 20, 1);
  officeLight.position.set(layout.office.center.x, HEX_WALL_HEIGHT - 0.5, layout.office.center.z);
  officeLight.castShadow = false;
  group.add(officeLight);

  return {
    group,
    layout,
    wallColliders: hexWallColliders(layout),
    surfaceHeightAt: (x: number, z: number) => hexSurfaceHeightAt(layout, x, z),
    roomView: (name: string) => {
      const query = name.trim().toLowerCase();
      if (query === 'hub') return hexRoomView(layout.hub);
      if (query === 'hex-office') return hexRoomView(layout.office);
      // Issue #258: `kind: 'library'` is load-bearing — `ViewController` already special-cases
      // it (walking in or double-clicking it swaps to the library's own scene, issue #239)
      // for whichever room carries it, rect or hex.
      if (query === 'library') return hexRoomView(layout.library, 'library');
      return null;
    },
    roomAt: (x: number, z: number) => {
      const point = { x, z };
      if (pointInPolygon(point, layout.hub.corners)) return hexRoomView(layout.hub);
      if (pointInPolygon(point, layout.office.corners)) return hexRoomView(layout.office);
      if (pointInPolygon(point, layout.library.corners)) return hexRoomView(layout.library, 'library');
      return null;
    },
  };
}

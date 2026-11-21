/**
 * Three.js geometry for the hex Hub and Office (issue #218 steps 2 and 3): the first real
 * hex rooms, built side by side with the old rect rooms (`BuildingLayout`'s own `HALL` and
 * `slotFor` rooms), which keep working unconverted. Everything here reads `HexRoomPlanner.ts`
 * for positions — this module only turns that pure geometry into meshes, materials and
 * colliders.
 *
 * Draw-call budget (issue #218 step 1's own render-budget note: main sat at 424/430 before
 * this PR, only 6 calls of headroom): every hex wall shares one material, the Hub and Office
 * floors use two (a deliberate two-tone distinction), the walkway deck and both ramps share
 * one, and the Hub's placeholder furniture (elevator, kitchen, play corner) shares one more —
 * 5 new draw calls total, regardless of room or furniture count, the same `markStatic` merge
 * story every other room in this fork already uses. None of this new geometry casts a shadow
 * (`castShadow: false` throughout): the structure sits far from the main building and its own
 * lights, and 6 calls of headroom has no room left for 3 shadow-map passes on top of 5 main
 * calls — a cost to revisit once more of the hex office exists. Real, per-piece furniture (the
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
  hexWallSegments,
  hexWallColliders,
  hexSurfaceHeightAt,
  type HexOfficeLayout,
  type HexRoomGeometry,
  HEX_WALL_HEIGHT,
  HEX_WALL_THICKNESS,
  WALKWAY_HEIGHT,
  WALKWAY_WIDTH,
} from './HexRoomPlanner.js';
import type { HexPoint } from './HexPlanner.js';

/** A stone tone distinct from the rect building's own `Colors.wall`, so the two structures
 * read as separate at a glance in the isometric view. */
const HEX_WALL_COLOR = 0xcbbfa6;
const HUB_FLOOR_COLOR = 0x6f6456;
const OFFICE_FLOOR_COLOR = 0x8a6f5a;
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
    positions.push(room.center.x, 0, room.center.z, a.x, 0, a.z, b.x, 0, b.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, getToonMaterial(color));
  mesh.name = 'hex-floor';
  mesh.receiveShadow = true;
  return mesh;
}

/** The 5 wall segments of a hex room (its stair's own edge left open), one mesh per segment,
 * all sharing the same material so they merge into the room's shared wall batch. */
function buildHexWalls(room: HexRoomGeometry, material: THREE.Material): THREE.Mesh[] {
  return hexWallSegments(room.center, room.radius, room.openEdge).map((segment) =>
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

export interface BuiltHexOffice {
  group: THREE.Group;
  layout: HexOfficeLayout;
  wallColliders: WallRect[];
  surfaceHeightAt(x: number, z: number): number | null;
}

/** Builds the Hub and Office hex rooms and the walkway/stair between them, merged into one
 * static batch per shared material (4 draw calls total: walls, floors, walkway, Hub accents).
 * Pure placement comes from `buildHexOfficeLayout()` — deterministic, same every call. */
export function buildHexOffice(): BuiltHexOffice {
  const layout = buildHexOfficeLayout();
  const group = new THREE.Group();
  group.name = 'hex-office';

  const wallMaterial = getToonMaterial(HEX_WALL_COLOR);
  const walls = new THREE.Group();
  walls.name = 'hex-walls';
  markStatic(walls, { zone: 'hex-walls', castShadow: false });
  for (const wall of [...buildHexWalls(layout.hub, wallMaterial), ...buildHexWalls(layout.office, wallMaterial)]) walls.add(wall);
  group.add(walls);

  const floors = new THREE.Group();
  floors.name = 'hex-floors';
  markStatic(floors, { zone: 'hex-floors', castShadow: false });
  floors.add(buildHexFloor(layout.hub, HUB_FLOOR_COLOR));
  floors.add(buildHexFloor(layout.office, OFFICE_FLOOR_COLOR));
  group.add(floors);

  const walkwayMaterial = getToonMaterial(WALKWAY_COLOR);
  const walkway = new THREE.Group();
  walkway.name = 'hex-walkway';
  markStatic(walkway, { zone: 'hex-walkway', castShadow: false });
  walkway.add(orientedBox(v3(layout.hubRamp.from, 0), v3(layout.hubRamp.to, WALKWAY_HEIGHT), WALKWAY_DECK_THICKNESS, WALKWAY_WIDTH, walkwayMaterial));
  walkway.add(orientedBox(v3(layout.officeRamp.from, 0), v3(layout.officeRamp.to, WALKWAY_HEIGHT), WALKWAY_DECK_THICKNESS, WALKWAY_WIDTH, walkwayMaterial));
  walkway.add(orientedBox(v3(layout.hubRamp.to, WALKWAY_HEIGHT), v3(layout.officeRamp.to, WALKWAY_HEIGHT), WALKWAY_DECK_THICKNESS, WALKWAY_WIDTH, walkwayMaterial));
  group.add(walkway);

  const accents = new THREE.Group();
  accents.name = 'hex-hub-accents';
  markStatic(accents, { zone: 'hex-accents', castShadow: false });
  const elevator = buildElevator();
  // Opposite the stair, against the Hub's own back wall, clear of the walkway opening.
  const hubBack = layout.hub.corners[(layout.hub.openEdge + 3) % 6];
  elevator.position.set((layout.hub.center.x + hubBack.x) / 2, 0, (layout.hub.center.z + hubBack.z) / 2);
  elevator.lookAt(layout.hub.center.x, 0, layout.hub.center.z);
  accents.add(elevator);
  const kitchen = buildKitchenCorner();
  const hubSide = layout.hub.corners[(layout.hub.openEdge + 2) % 6];
  kitchen.position.set((layout.hub.center.x + hubSide.x) / 2, 0, (layout.hub.center.z + hubSide.z) / 2);
  kitchen.lookAt(layout.hub.center.x, 0, layout.hub.center.z);
  accents.add(kitchen);
  group.add(accents);

  return {
    group,
    layout,
    wallColliders: hexWallColliders(layout),
    surfaceHeightAt: (x: number, z: number) => hexSurfaceHeightAt(layout, x, z),
  };
}

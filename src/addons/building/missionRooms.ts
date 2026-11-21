import * as THREE from 'three';
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
 * Issue #193: a war room's door-wall width is `WAR_ROOM_WIDTH` (18), wider than a generic
 * room's `ROOM_SIZE` (12, which stays its depth), so the desk grid fits 6-8 desks instead of
 * 4. Column 1's east edge stays pinned well clear of the east-side rented ring (`RoomPlanner.ts`'s
 * `slotFor`, ring 0 index 2, x >= 15, z in [-18, -6]) at any room count — the corridor only ever
 * grows north (more negative z), never widens, so this margin never erodes. Column 0's west
 * edge is unconstrained by the west-side rented ring: that ring sits at z in [-11, 13], never
 * overlapping a war room's z <= -13, by construction (`tests/mission-wing-overlap.test.ts`).
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

const WING_COLUMNS: Array<{ minX: number; maxX: number; side: Side }> = [
  { minX: CORRIDOR_MIN_X - WAR_ROOM_WIDTH, maxX: CORRIDOR_MIN_X, side: 'east' },
  { minX: CORRIDOR_MAX_X, maxX: CORRIDOR_MAX_X + WAR_ROOM_WIDTH, side: 'west' },
];

export function missionSlot(index: number): RoomSlot {
  const column = WING_COLUMNS[index % WING_COLUMNS.length];
  const row = Math.floor(index / WING_COLUMNS.length);
  const maxZ = -13 - row * ROOM_SIZE;
  const rect = { minX: column.minX, maxX: column.maxX, minZ: maxZ - ROOM_SIZE, maxZ };
  // Issue #123: every row's door opens onto its own frontage on the mission corridor, never
  // onto the row before or after it.
  const at = (rect.minZ + rect.maxZ) / 2;
  return { rect, door: { side: column.side, at }, outward: 'north', ring: row };
}

/**
 * The mission corridor's own rect (issue #123): the one shared frontage every war room's door
 * opens directly onto. Its south end is fixed, flush against the hall's own back wall; its
 * north end grows one `ROOM_SIZE` further out each time a new row is rented, so there is no
 * room-count cap on the wing it serves.
 */
export function missionCorridorRect(roomCount: number): Rect {
  const rows = Math.max(1, Math.ceil(roomCount / WING_COLUMNS.length));
  return { minX: CORRIDOR_MIN_X, maxX: CORRIDOR_MAX_X, minZ: -13 - rows * ROOM_SIZE, maxZ: -13 };
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

export function canvasBoard(width: number, height: number): { mesh: THREE.Mesh; draw: (title: string, lines: string[]) => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round(512 * (height / width));
  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture }));
  const draw = (title: string, lines: string[]) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#f7f3ea';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#2a2a3e';
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.fillText(title.slice(0, 34), 18, 42);
    ctx.font = '22px system-ui, sans-serif';
    lines.slice(0, Math.floor((canvas.height - 70) / 28)).forEach((line, i) => ctx.fillText(line.slice(0, 44), 18, 82 + i * 28));
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

  // Wall boards: the statement on the far wall, docs and issues beside it, the kanban on a side wall
  const boards = {
    statement: canvasBoard(3.6, 1.6),
    docs: canvasBoard(2.4, 1.6),
    issues: canvasBoard(2.4, 1.6),
    kanban: canvasBoard(3.6, 1.8),
  };
  const mount = (mesh: THREE.Mesh, a: number, d: number, y: number, rotationY: number) => {
    mesh.position.copy(frame.point(a, d, y));
    mesh.rotation.y = rotationY;
    group.add(mesh);
  };
  mount(boards.statement.mesh, 0, ROOM_SIZE - 0.12, 1.7, frame.faceDoor);
  mount(boards.docs.mesh, -3.6, ROOM_SIZE - 0.12, 1.7, frame.faceDoor);
  mount(boards.issues.mesh, 3.6, ROOM_SIZE - 0.12, 1.7, frame.faceDoor);
  mount(boards.kanban.mesh, (slot.rect.maxX - slot.rect.minX) / 2 - 0.12, 6, 1.7, frame.faceDoor - Math.PI / 2);

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
  door.position.copy(frame.point(slot.door.at - (slot.rect.minX + slot.rect.maxX) / 2, 0.02, 1.2));
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
      boards.kanban.draw('Kanban', (next.walls.kanban ?? []).flatMap((column) =>
        [`${column.column} (${column.cards.length})`, ...column.cards.slice(0, 3).map((card) => `  T-${card.number} ${card.title}`)]));
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
  return result;
}

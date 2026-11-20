import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { getToonMaterial } from '../../utils/Materials.js';
import { Colors } from '../../utils/Colors.js';
import type { Station } from '../../scene/Office.js';
import { markStatic } from '../../scene/StaticMerge.js';
import { DOOR_WIDTH, ROOM_SIZE, doorPoint, type Door, type Rect, type RoomSlot, type Side, wallPieces } from './RoomPlanner.js';
import { roomLabel } from './roomLabels.js';
import { roomFurnishing, type RoomPlan } from './furnishing.js';

export * from './roomLabels.js';

export type RoomKind = 'office' | 'desks' | 'library' | 'lab' | 'lounge';

/** The station type each room kind adds. 'queue' spots are where agents wait for the user. */
export const ROOM_STATION_TYPE: Record<RoomKind, string> = {
  office: 'queue',
  desks: 'implementing',
  library: 'researching',
  lab: 'testing',
  lounge: 'idle',
};

export const ROOM_TITLE: Record<RoomKind, string> = {
  office: 'Your office',
  desks: 'Desks',
  library: 'Library',
  lab: 'Test lab',
  lounge: 'Lounge',
};

const FLOOR_TINT: Record<RoomKind, number> = {
  office: 0x8a6f5a,
  desks: 0xcfc3a0,
  library: 0xa58a6a,
  lab: 0xb5cdb8,
  lounge: 0x9a8ab0,
};

export function roomFloorColor(kind: RoomKind): number {
  return FLOOR_TINT[kind];
}

/** The room name: lounges and waiting rooms are numbered in the order they are rented. */
export function roomTitle(kind: RoomKind, earlierKinds: RoomKind[]): string {
  if (kind === 'lounge') return `Lounge ${earlierKinds.filter((earlier) => earlier === 'lounge').length + 1}`;
  // Only the first office is the user's; later ones are overflow waiting rooms
  if (kind === 'office' && earlierKinds.includes('office')) return `Waiting room ${earlierKinds.filter((earlier) => earlier === 'office').length + 1}`;
  return ROOM_TITLE[kind];
}

export const WALL_HEIGHT = 2.6;
const WALL_THICKNESS = 0.15;
const DOOR_FRAME_HEIGHT = 2.35;
const DOOR_POST_WIDTH = 0.2;
/** Top of the lintel. */
export const DOOR_FRAME_TOP = DOOR_FRAME_HEIGHT + DOOR_POST_WIDTH;
/** Overview: door frames drop to this height, above the 0.5 walls. */
export const OVERVIEW_DOOR_HEIGHT = 1.2;
const DOOR_FRAME_DEPTH = 0.3;

/**
 * A room's local frame. `d` is the depth from the door wall into the room
 * (0 to ROOM_SIZE), `a` runs along the door wall (-ROOM_SIZE/2 to +ROOM_SIZE/2).
 */
export class RoomFrame {
  readonly inward: THREE.Vector3;
  readonly along: THREE.Vector3;
  private readonly doorWallCenter: THREE.Vector3;

  constructor(readonly rect: Rect, readonly door: Door) {
    const inwardBySide: Record<Side, [number, number]> = { west: [1, 0], east: [-1, 0], north: [0, 1], south: [0, -1] };
    const [nx, nz] = inwardBySide[door.side];
    this.inward = new THREE.Vector3(nx, 0, nz);
    this.along = new THREE.Vector3(-nz, 0, nx);
    const center = new THREE.Vector3((rect.minX + rect.maxX) / 2, 0, (rect.minZ + rect.maxZ) / 2);
    this.doorWallCenter = center.addScaledVector(this.inward, -ROOM_SIZE / 2);
  }

  point(a: number, d: number, y = 0): THREE.Vector3 {
    return this.doorWallCenter.clone().addScaledVector(this.along, a).addScaledVector(this.inward, d).setY(y);
  }

  /** Rotation that makes a piece of furniture face the door (its front looks along -inward). */
  get faceDoor(): number {
    return Math.atan2(-this.inward.x, -this.inward.z);
  }

  /** Rotation that makes a piece of furniture face away from the door. */
  get faceAway(): number {
    return Math.atan2(this.inward.x, this.inward.z);
  }

  /** Where the hall door is along the door wall (`a` of its center). */
  get doorAlong(): number {
    const door = doorPoint(this.rect, this.door, 0);
    return new THREE.Vector3(door.x, 0, door.z).sub(this.doorWallCenter).dot(this.along);
  }
}

export interface BuiltRoom {
  kind: RoomKind;
  slot: RoomSlot;
  group: THREE.Group;
  stations: Map<string, Station>;
}

function place(group: THREE.Group, object: THREE.Object3D, position: THREE.Vector3, rotationY: number): void {
  object.position.copy(position);
  object.rotation.y = rotationY;
  group.add(object);
}

function station(type: string, position: THREE.Vector3, lookAt: THREE.Vector3, posture?: Station['posture']): Station {
  return { type, position, lookAt, occupied: false, ...(posture ? { posture } : {}) };
}

/**
 * Put walls and door frames in the shared cutaway zone: they draw merged, and
 * the overview lowers the zone so the room floors show (`applyCutaway`).
 */
export function markCutaway(root: THREE.Object3D): void {
  markStatic(root, { zone: 'room-walls', castShadow: false, overviewLower: WALL_HEIGHT });
}

/**
 * Door frames get their own cutaway zone: in the overview they drop to
 * `OVERVIEW_DOOR_HEIGHT`, so the posts and the lintel stand above the low walls
 * and a doorway reads from above.
 */
export function markDoorCutaway(root: THREE.Object3D): void {
  markStatic(root, { zone: 'door-frames', castShadow: false, overviewLower: DOOR_FRAME_TOP, overviewHeight: OVERVIEW_DOOR_HEIGHT });
}

/** Low walls with gaps at the doors, so the overview can see in. */
export function buildWalls(rect: Rect, doors: Door[], height = WALL_HEIGHT, hideSides: Side[] = []): THREE.Group {
  const group = new THREE.Group();
  // Pieces on hidden sides go in one group the overview hides. It merges in place: one draw call, hidden with it
  const hidden = new THREE.Group();
  hidden.name = 'overview-hidden-walls';
  hidden.userData.overviewHidden = true;
  markStatic(hidden);
  const material = getToonMaterial(Colors.wall);
  for (const piece of wallPieces(rect, doors)) {
    const length = piece.to - piece.from;
    if (length < 0.05) continue;
    const horizontal = piece.side === 'north' || piece.side === 'south';
    const geometry = horizontal
      ? new THREE.BoxGeometry(length, height, WALL_THICKNESS)
      : new THREE.BoxGeometry(WALL_THICKNESS, height, length);
    const wall = new THREE.Mesh(geometry, material);
    const middle = (piece.from + piece.to) / 2;
    const fixed = { north: rect.minZ, south: rect.maxZ, west: rect.minX, east: rect.maxX }[piece.side];
    wall.position.set(horizontal ? middle : fixed, height / 2, horizontal ? fixed : middle);
    wall.castShadow = true;
    wall.receiveShadow = true;
    (hideSides.includes(piece.side) ? hidden : group).add(wall);
  }
  if (hidden.children.length > 0) group.add(hidden);
  return group;
}

/** Two posts and a lintel around a doorway, in the room floor color, so doors stand out from the walls. */
export function doorFrame(rect: Rect, door: Door, color: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'door-frame';
  group.userData.door = { ...door };
  const material = getToonMaterial(color);
  const horizontal = door.side === 'north' || door.side === 'south';
  const wallLine = { north: rect.minZ, south: rect.maxZ, west: rect.minX, east: rect.maxX }[door.side];
  const box = (along: number, across: number, height: number) =>
    (horizontal ? new THREE.BoxGeometry(along, height, across) : new THREE.BoxGeometry(across, height, along));
  const put = (mesh: THREE.Mesh, along: number, y: number) => {
    mesh.position.set(horizontal ? along : wallLine, y, horizontal ? wallLine : along);
    mesh.castShadow = true;
    group.add(mesh);
  };
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(box(DOOR_POST_WIDTH, DOOR_FRAME_DEPTH, DOOR_FRAME_HEIGHT), material);
    post.name = 'door-post';
    put(post, door.at + side * (DOOR_WIDTH / 2 + DOOR_POST_WIDTH / 2 - 0.05), DOOR_FRAME_HEIGHT / 2);
  }
  const lintel = new THREE.Mesh(box(DOOR_WIDTH + DOOR_POST_WIDTH * 2 - 0.1, DOOR_FRAME_DEPTH, DOOR_POST_WIDTH), material);
  lintel.name = 'door-lintel';
  put(lintel, door.at, DOOR_FRAME_HEIGHT + DOOR_POST_WIDTH / 2);
  return group;
}

/** The CSS2D sign under the portrait that counts the queue; `BuildingLayout` sets its text. */
export const QUEUE_COUNT_SIGN = 'queue-count-sign';

function sign(text: string, position: THREE.Vector3): CSS2DObject {
  const element = document.createElement('div');
  element.className = 'desk-sign';
  element.textContent = text;
  Object.assign(element.style, {
    background: 'rgba(30, 32, 48, 0.85)', color: '#f5f0e8', padding: '2px 8px', borderRadius: '4px',
    font: '600 12px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none',
  });
  const label = new CSS2DObject(element);
  label.position.copy(position);
  return label;
}

/**
 * Turn a room plan into objects: each piece from the furniture library at its
 * place (named in `userData.piece`), each spot a station, each sign a CSS2D sign.
 */
function furnish(group: THREE.Group, frame: RoomFrame, plan: RoomPlan, rect: Rect, stations: Map<string, Station>, key: (n: number) => string): void {
  for (const placement of plan.pieces) {
    const object = placement.piece.create();
    object.userData.piece = placement.piece.name;
    place(group, object, frame.point(placement.a, placement.d, placement.y ?? 0), frame.faceDoor + (placement.turn ?? 0));
  }
  plan.spots.forEach((spot, n) => {
    stations.set(key(n), station(spot.type, frame.point(spot.a, spot.d), frame.point(...spot.look), spot.posture));
  });
  for (const signPlan of plan.signs) {
    const at = frame.point(signPlan.a, signPlan.d, signPlan.y);
    if (signPlan.role === 'you') {
      // A detail sign: it shows when zoomed in or hovered, so it does not cover the queue in the overview
      const you = sign('You', at);
      you.userData.detailSign = { rect: { ...rect }, hoverOnly: false };
      group.add(you);
    } else {
      // Hidden until someone waits
      const count = sign('', at);
      count.name = QUEUE_COUNT_SIGN;
      count.userData.queueCount = 0;
      count.visible = false;
      group.add(count);
    }
  }
}

/** Build one room: floor, low walls, a framed door, a room label, furniture and its stations. */
export function buildRoom(kind: RoomKind, slot: RoomSlot, index: number, extraDoors: Door[], title?: string): BuiltRoom {
  const group = new THREE.Group();
  group.name = `room-${index}-${kind}`;
  // Rooms lie outside the hall lamps' cone: their merged furniture casts no shadow
  markStatic(group, { zone: 'rooms', castShadow: false });
  const frame = new RoomFrame(slot.rect, slot.door);
  const stations = new Map<string, Station>();
  const type = ROOM_STATION_TYPE[kind];
  const key = (n: number) => `room${index}_${type}_${n}`;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), getToonMaterial(FLOOR_TINT[kind]));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((slot.rect.minX + slot.rect.maxX) / 2, 0.005, (slot.rect.minZ + slot.rect.maxZ) / 2);
  floor.receiveShadow = true;
  floor.userData.floor = true;
  group.add(floor);
  const walls = buildWalls(slot.rect, [slot.door, ...extraDoors]);
  walls.name = 'room-walls';
  markCutaway(walls);
  group.add(walls);
  const doorway = doorFrame(slot.rect, slot.door, FLOOR_TINT[kind]);
  markDoorCutaway(doorway);
  group.add(doorway);
  group.add(roomLabel(title ?? roomTitle(kind, []), frame.point(0, ROOM_SIZE / 2), slot.rect));

  furnish(group, frame, roomFurnishing(kind, { doorAlong: frame.doorAlong, usersOffice: index === 0 }), slot.rect, stations, key);
  return { kind, slot, group, stations };
}

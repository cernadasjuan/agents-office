import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createDesk } from '../../furniture/Desk.js';
import { createWhiteboard } from '../../furniture/Whiteboard.js';
import { createBookshelf } from '../../furniture/Bookshelf.js';
import { createTestStation } from '../../furniture/TestStation.js';
import { createSofa } from '../../furniture/Sofa.js';
import { createCoffeeMachine } from '../../furniture/CoffeeMachine.js';
import { createPlant } from '../../furniture/Decorations.js';
import { getToonMaterial } from '../../utils/Materials.js';
import { Colors } from '../../utils/Colors.js';
import type { Station } from '../../scene/Office.js';
import { DOOR_WIDTH, ROOM_SIZE, type Door, type Rect, type RoomSlot, type Side, wallPieces } from './RoomPlanner.js';

export type RoomKind = 'office' | 'desks' | 'planning' | 'library' | 'lab' | 'review' | 'lounge';

/** The station type each room kind adds. 'queue' spots are where agents wait for the user. */
export const ROOM_STATION_TYPE: Record<RoomKind, string> = {
  office: 'queue',
  desks: 'implementing',
  planning: 'planning',
  library: 'researching',
  lab: 'testing',
  review: 'reviewing',
  lounge: 'idle',
};

export const ROOM_TITLE: Record<RoomKind, string> = {
  office: 'Your office',
  desks: 'Desks',
  planning: 'Planning room',
  library: 'Library',
  lab: 'Test lab',
  review: 'Writing room',
  lounge: 'Lounge',
};

const FLOOR_TINT: Record<RoomKind, number> = {
  office: 0x8a6f5a,
  desks: 0xcfc3a0,
  planning: 0xb8c4d4,
  library: 0xa58a6a,
  lab: 0xb5cdb8,
  review: 0xd4c4b0,
  lounge: 0x9a8ab0,
};

export function roomFloorColor(kind: RoomKind): number {
  return FLOOR_TINT[kind];
}

/**
 * The room name: lounges are numbered in the order they are rented, a workspace
 * desk room carries its workspace name.
 */
export function roomTitle(kind: RoomKind, earlierKinds: RoomKind[], tag?: string): string {
  if (kind === 'desks' && tag) return `Desks · ${tag}`;
  if (kind === 'lounge') return `Lounge ${earlierKinds.filter((earlier) => earlier === 'lounge').length + 1}`;
  return ROOM_TITLE[kind];
}

export const WALL_HEIGHT = 2.6;
const WALL_THICKNESS = 0.15;
/** Height of the center of a room label. The whole label stays below the wall top, so walls hide it in first person. */
export const ROOM_LABEL_Y = 1.55;
/** World height of a one-line and a two-line label. */
const ROOM_LABEL_HEIGHTS = [1.6, 2.0];
const ROOM_LABEL_MAX_WIDTH = ROOM_SIZE - 1;
const ROOM_LABEL_MAX_CHARS = 22;
const DOOR_FRAME_HEIGHT = 2.35;
const DOOR_POST_WIDTH = 0.2;
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

/** Low walls with gaps at the doors, so the overview can see in. */
export function buildWalls(rect: Rect, doors: Door[], height = WALL_HEIGHT, hideSides: Side[] = []): THREE.Group {
  const group = new THREE.Group();
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
    if (hideSides.includes(piece.side)) wall.userData.overviewHidden = true;
    else wall.userData.overviewLower = true;
    group.add(wall);
  }
  return group;
}

/** Up to two lines of at most `ROOM_LABEL_MAX_CHARS`, cut at word breaks, with an ellipsis when the text is longer. */
export function roomLabelLines(text: string): string[] {
  const cut = (part: string) => (part.length > ROOM_LABEL_MAX_CHARS ? `${part.slice(0, ROOM_LABEL_MAX_CHARS - 1)}…` : part);
  const lines: string[] = [];
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && `${last} ${word}`.length <= ROOM_LABEL_MAX_CHARS) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  if (lines.length <= 2) return lines.map(cut);
  const second = `${lines[1]} ${lines[2]}`;
  return [cut(lines[0]), `${second.slice(0, ROOM_LABEL_MAX_CHARS - 1)}…`];
}

/**
 * A room name in the world: a light plate with dark wide capitals above the room
 * center. It scales with distance, and geometry in front of it hides it.
 */
export function roomLabel(text: string, position: THREE.Vector3): THREE.Sprite {
  const material = new THREE.SpriteMaterial({ depthTest: true, depthWrite: false, transparent: true, toneMapped: false });
  const label = new THREE.Sprite(material);
  label.name = 'room-label';
  label.position.copy(position);
  setRoomLabelText(label, text);
  return label;
}

/** Draw the label text on a new canvas texture (a texture keeps its first size on the GPU). */
export function setRoomLabelText(label: THREE.Sprite, text: string): void {
  if (label.userData.roomLabel === text) return;
  label.userData.roomLabel = text;
  const lines = roomLabelLines(text.toUpperCase());
  if (lines.length === 0) lines.push('');
  const canvas = document.createElement('canvas');
  const lineHeightPx = 96;
  const font = `800 64px system-ui, 'Helvetica Neue', Arial, sans-serif`;
  const ctx = canvas.getContext('2d');
  const longest = Math.max(...lines.map((line) => line.length), 1);
  if (ctx) {
    ctx.font = font;
    ctx.letterSpacing = '6px';
  }
  const measured = ctx?.measureText ? Math.max(...lines.map((line) => ctx.measureText(line)?.width ?? 0)) : 0;
  const textWidth = Number.isFinite(measured) && measured > 0 ? measured : longest * 50;
  canvas.width = Math.ceil(textWidth + 80);
  canvas.height = lines.length * lineHeightPx + 24;
  if (ctx?.fillRect) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(247, 241, 228, 0.92)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(42, 42, 62, 0.85)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
    ctx.fillStyle = '#2a2a3e';
    ctx.font = font;
    ctx.letterSpacing = '6px';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => ctx.fillText(line, canvas.width / 2, 12 + lineHeightPx * (i + 0.5)));
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  label.material.map?.dispose();
  label.material.map = texture;
  label.material.needsUpdate = true;
  const height = ROOM_LABEL_HEIGHTS[Math.min(lines.length, 2) - 1];
  const width = Math.min(ROOM_LABEL_MAX_WIDTH, height * (canvas.width / canvas.height));
  label.scale.set(width, width * (canvas.height / canvas.width), 1);
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

/** Build one room: floor, low walls, a framed door, a room label, furniture and its stations. */
export function buildRoom(kind: RoomKind, slot: RoomSlot, index: number, extraDoors: Door[], title?: string): BuiltRoom {
  const group = new THREE.Group();
  group.name = `room-${index}-${kind}`;
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
  group.add(walls);
  group.add(doorFrame(slot.rect, slot.door, FLOOR_TINT[kind]));
  group.add(roomLabel(title ?? roomTitle(kind, []), frame.point(0, ROOM_SIZE / 2, ROOM_LABEL_Y)));

  const rows = (count: number, spacing: number) => Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * spacing);

  switch (kind) {
    case 'office': {
      // The user's desk at the far wall, facing the door. Agents that wait for the user queue in front of it.
      const deskDepth = ROOM_SIZE - 2.2;
      place(group, createDesk(true), frame.point(0, deskDepth), frame.faceAway);
      // A detail sign: it shows when zoomed in or hovered, so it does not cover the queue in the overview
      const you = sign('You', frame.point(0, deskDepth + 0.7, 2.2));
      you.userData.detailSign = { rect: { ...slot.rect }, hoverOnly: false };
      group.add(you);
      place(group, createPlant(1.2), frame.point(-5.2, ROOM_SIZE - 0.8), 0);
      place(group, createPlant(1.2), frame.point(5.2, ROOM_SIZE - 0.8), 0);
      const lookAt = frame.point(0, deskDepth + 0.7, 1.2);
      let n = 0;
      for (let row = 0; row < 6; row++) {
        const depth = deskDepth - 1.6 - row * 1.15;
        // Middle first, then outward, so the line fills from the front center
        for (const along of [0, -1.15, 1.15, -2.3, 2.3, -3.45, 3.45, -4.6, 4.6]) {
          stations.set(key(n++), station('queue', frame.point(along, depth), lookAt, 'standing'));
        }
      }
      break;
    }
    case 'desks': {
      for (const depth of [4, 8]) {
        for (const along of rows(4, 2.8)) {
          const desk = frame.point(along, depth);
          place(group, createDesk(true), desk, frame.faceDoor);
          stations.set(key(stations.size), station('implementing', frame.point(along, depth - 0.7), frame.point(along, depth + 0.15, 1.2)));
        }
      }
      break;
    }
    case 'planning': {
      for (const along of rows(3, 3.6)) {
        place(group, createWhiteboard(), frame.point(along, ROOM_SIZE - 0.3), frame.faceDoor);
        stations.set(key(stations.size), station('planning', frame.point(along, ROOM_SIZE - 1.1), frame.point(along, ROOM_SIZE - 0.3, 1.5)));
      }
      break;
    }
    case 'library': {
      // Shelves on the far wall and on both side walls: the knowledge base of the office
      for (const along of rows(4, 2.5)) {
        place(group, createBookshelf(), frame.point(along, ROOM_SIZE - 0.5), frame.faceDoor);
        stations.set(key(stations.size), station('researching', frame.point(along, ROOM_SIZE - 1.5), frame.point(along, ROOM_SIZE - 0.5, 1.0)));
      }
      for (const side of [-1, 1]) {
        for (const depth of [3.5, 6, 8.5]) {
          const wallAlong = side * (ROOM_SIZE / 2 - 0.5);
          place(group, createBookshelf(), frame.point(wallAlong, depth), frame.faceDoor + side * Math.PI / 2);
          stations.set(key(stations.size), station('researching', frame.point(wallAlong - side, depth), frame.point(wallAlong, depth, 1.0)));
        }
      }
      break;
    }
    case 'lab': {
      for (const along of rows(4, 2.8)) {
        place(group, createTestStation(), frame.point(along, 7), frame.faceDoor);
        stations.set(key(stations.size), station('testing', frame.point(along, 6.2), frame.point(along, 7, 1.4)));
      }
      break;
    }
    case 'review': {
      for (const along of rows(4, 2.8)) {
        place(group, createDesk(true), frame.point(along, 7), frame.faceDoor);
        stations.set(key(stations.size), station('reviewing', frame.point(along, 6.3), frame.point(along, 7.15, 1.2)));
      }
      break;
    }
    case 'lounge': {
      place(group, createCoffeeMachine(), frame.point(-5.2, ROOM_SIZE - 0.8), frame.faceDoor);
      for (const along of rows(3, 3.6)) {
        // A sofa faces the door; its back is toward the far wall
        place(group, createSofa(0x6a5acd), frame.point(along, 7.5), frame.faceDoor);
        for (const offset of [-0.6, 0, 0.6]) {
          stations.set(key(stations.size), station('idle', frame.point(along + offset, 7.45), frame.point(along + offset, 6.4, 0.8), 'seated'));
        }
      }
      break;
    }
  }
  return { kind, slot, group, stations };
}

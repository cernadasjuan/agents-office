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
import { markStatic } from '../../scene/StaticMerge.js';
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
/** First person: a small plate high in the room; its top (2.55) stays below the wall top, so walls hide it. */
export const FIRST_PERSON_LABEL_Y = 2.2;
export const FIRST_PERSON_LABEL_HEIGHT = 0.7;
/** Overview: plate height at the reference zoom distance; it grows with the distance beyond it. */
export const OVERVIEW_LABEL_HEIGHT = 1.6;
export const OVERVIEW_LABEL_REFERENCE_ZOOM = 40;
/** Overview: the plate bottom, above the lowered walls and the door frames. */
export const OVERVIEW_LABEL_BOTTOM = 1.3;
/** A plate is never wider than this, so labels of two neighbor rooms do not overlap. */
export const ROOM_LABEL_MAX_WIDTH = ROOM_SIZE - 1;
/** Overview: a plate is never taller than this, so labels of two rooms in a column do not overlap. */
export const OVERVIEW_LABEL_MAX_HEIGHT = 5;
/** Characters per line: the full face, and the compact face of the default overview. */
export const FULL_LABEL_CHARS = 16;
export const COMPACT_LABEL_CHARS = 7;
const LABEL_FONT_PX = 64;
const LABEL_LINE_PX = 68;
const LABEL_PAD_X = 8;
const LABEL_PAD_Y = 6;
/** Capitals are drawn condensed (narrower), so a name fits a room width at a readable height. */
const LABEL_CONDENSE = 0.58;
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
    group.add(wall);
  }
  return group;
}

/**
 * Up to two lines of at most `maxChars`, cut at word breaks, with an ellipsis
 * when the text is longer. A " · " starts a new line ("DESKS" / "WS10").
 */
export function roomLabelLines(text: string, maxChars: number): string[] {
  const cut = (part: string) => (part.length > maxChars ? `${part.slice(0, maxChars - 1)}…` : part);
  const lines: string[] = [];
  for (const part of text.trim().split(/\s+·\s+/)) {
    let first = true;
    for (const word of part.split(/\s+/).filter(Boolean)) {
      const last = lines[lines.length - 1];
      if (!first && last !== undefined && `${last} ${word}`.length <= maxChars) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
      first = false;
    }
  }
  if (lines.length <= 2) return lines.map(cut);
  // More than two lines: the second line ends with an ellipsis after a whole word when it fits
  return [cut(lines[0]), lines[1].length <= maxChars ? `${lines[1]}…` : `${lines[1].slice(0, maxChars - 1)}…`];
}

/** What the label controller tells a room label each refresh. */
export interface RoomLabelView {
  viewMode: 'overview' | 'first-person';
  zoomDistance: number;
  /** Zoomed in, pointed at or labels: all: the full name. */
  detail: boolean;
}

interface LabelFace {
  lines: string[];
  texture: THREE.CanvasTexture;
  /** Canvas width over height. */
  aspect: number;
}

/** Draw a plate with dark wide capitals on a canvas texture. */
function drawLabelFace(lines: string[]): LabelFace {
  const canvas = document.createElement('canvas');
  const font = `800 ${LABEL_FONT_PX}px system-ui, 'Helvetica Neue', Arial, sans-serif`;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = font;
    ctx.letterSpacing = '2px';
  }
  const longest = Math.max(...lines.map((line) => line.length), 1);
  const measured = ctx?.measureText ? Math.max(...lines.map((line) => ctx.measureText(line)?.width ?? 0)) : 0;
  const textWidth = Number.isFinite(measured) && measured > 0 ? measured : longest * LABEL_FONT_PX * 0.75;
  canvas.width = Math.ceil(textWidth * LABEL_CONDENSE + LABEL_PAD_X * 2);
  canvas.height = lines.length * LABEL_LINE_PX + LABEL_PAD_Y * 2;
  if (ctx?.fillRect) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(247, 241, 228, 0.92)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(42, 42, 62, 0.85)';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
    ctx.fillStyle = '#2a2a3e';
    ctx.font = font;
    ctx.letterSpacing = '2px';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.scale(LABEL_CONDENSE, 1);
    lines.forEach((line, i) => ctx.fillText(line, canvas.width / 2 / LABEL_CONDENSE, LABEL_PAD_Y + LABEL_LINE_PX * (i + 0.5)));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { lines, texture, aspect: canvas.width / canvas.height };
}

/**
 * Where and how big a room label is. First person: a small plate high in the
 * room, below the wall top, hidden by walls (depth test). Overview: a plate that
 * grows with the zoom distance, so it keeps its size on screen, but never wider
 * than a room, so two room labels do not overlap; it draws on top.
 */
export function roomLabelPose(view: RoomLabelView, aspect: number): { height: number; width: number; y: number; onTop: boolean } {
  if (view.viewMode === 'first-person') {
    const height = Math.min(FIRST_PERSON_LABEL_HEIGHT, ROOM_LABEL_MAX_WIDTH / aspect);
    return { height, width: height * aspect, y: FIRST_PERSON_LABEL_Y, onTop: false };
  }
  const wanted = OVERVIEW_LABEL_HEIGHT * Math.max(1, view.zoomDistance / OVERVIEW_LABEL_REFERENCE_ZOOM);
  const height = Math.min(wanted, OVERVIEW_LABEL_MAX_HEIGHT, ROOM_LABEL_MAX_WIDTH / aspect);
  return { height, width: height * aspect, y: OVERVIEW_LABEL_BOTTOM + height / 2, onTop: true };
}

/**
 * A room name in the world: a light plate with dark capitals above the room
 * center. It has a full face (first person, zoomed in, pointed at) and a compact
 * face of short lines (the default overview). The label controller calls
 * `userData.applyView` each refresh; until then it shows the first person pose.
 */
export function roomLabel(text: string, position: THREE.Vector3, rect: Rect): THREE.Sprite {
  const material = new THREE.SpriteMaterial({ depthTest: true, depthWrite: false, transparent: true, toneMapped: false });
  const label = new THREE.Sprite(material);
  label.name = 'room-label';
  label.position.set(position.x, FIRST_PERSON_LABEL_Y, position.z);
  // The label controller hides it in first person while the camera is inside this room
  label.userData.roomRect = { ...rect };
  let view: RoomLabelView = { viewMode: 'first-person', zoomDistance: 0, detail: true };
  label.userData.applyView = (next: RoomLabelView) => {
    view = next;
    const faces = label.userData.faces as { full: LabelFace; compact: LabelFace };
    const face = next.viewMode === 'overview' && !next.detail ? faces.compact : faces.full;
    if (material.map !== face.texture) {
      material.map = face.texture;
      material.needsUpdate = true;
    }
    label.userData.labelLines = face.lines;
    const pose = roomLabelPose(next, face.aspect);
    label.scale.set(pose.width, pose.height, 1);
    label.position.y = pose.y;
    material.depthTest = !pose.onTop;
    label.renderOrder = pose.onTop ? 10 : 0;
  };
  label.userData.refreshView = () => (label.userData.applyView as (v: RoomLabelView) => void)(view);
  setRoomLabelText(label, text);
  return label;
}

/** Draw both faces of the label for a new text (a texture keeps its first size on the GPU). */
export function setRoomLabelText(label: THREE.Sprite, text: string): void {
  if (label.userData.roomLabel === text) return;
  label.userData.roomLabel = text;
  const old = label.userData.faces as { full: LabelFace; compact: LabelFace } | undefined;
  const upper = text.toUpperCase();
  const lines = (maxChars: number) => {
    const found = roomLabelLines(upper, maxChars);
    return found.length > 0 ? found : [''];
  };
  label.userData.faces = { full: drawLabelFace(lines(FULL_LABEL_CHARS)), compact: drawLabelFace(lines(COMPACT_LABEL_CHARS)) };
  old?.full.texture.dispose();
  old?.compact.texture.dispose();
  (label.userData.refreshView as () => void)();
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

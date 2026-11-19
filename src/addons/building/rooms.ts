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
import { ROOM_SIZE, type Door, type Rect, type RoomSlot, type Side, wallPieces } from './RoomPlanner.js';

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

const WALL_HEIGHT = 2.6;
const WALL_THICKNESS = 0.15;

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
    group.add(wall);
  }
  return group;
}

function sign(text: string, position: THREE.Vector3): CSS2DObject {
  const element = document.createElement('div');
  element.className = 'room-sign';
  element.textContent = text;
  Object.assign(element.style, {
    background: 'rgba(30, 32, 48, 0.85)', color: '#f5f0e8', padding: '2px 8px', borderRadius: '4px',
    font: '600 12px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none',
  });
  const label = new CSS2DObject(element);
  label.position.copy(position);
  return label;
}

/** Build one room: floor, low walls, furniture, a door sign and its stations. */
export function buildRoom(kind: RoomKind, slot: RoomSlot, index: number, extraDoors: Door[]): BuiltRoom {
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
  group.add(sign(ROOM_TITLE[kind], frame.point(0, 0.4, WALL_HEIGHT + 0.4)));

  const rows = (count: number, spacing: number) => Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * spacing);

  switch (kind) {
    case 'office': {
      // The user's desk at the far wall, facing the door. Agents that wait for the user queue in front of it.
      const deskDepth = ROOM_SIZE - 2.2;
      place(group, createDesk(true), frame.point(0, deskDepth), frame.faceAway);
      group.add(sign('You', frame.point(0, deskDepth + 0.7, 2.2)));
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
      for (const along of rows(4, 2.5)) {
        place(group, createBookshelf(), frame.point(along, ROOM_SIZE - 0.5), frame.faceDoor);
        stations.set(key(stations.size), station('researching', frame.point(along, ROOM_SIZE - 1.5), frame.point(along, ROOM_SIZE - 0.5, 1.0)));
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

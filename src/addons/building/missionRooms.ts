import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createMeetingTable } from '../../furniture/MeetingTable.js';
import { getToonMaterial } from '../../utils/Materials.js';
import type { Station } from '../../scene/Office.js';
import { markStatic } from '../../scene/StaticMerge.js';
import type { WorldRoom } from '../../extensions.js';
import { ROOM_SIZE, type Rect, type RoomSlot } from './RoomPlanner.js';
import { buildWalls, doorFrame, markCutaway, markDoorCutaway, roomLabel, RoomFrame, setRoomLabelText } from './rooms.js';

/**
 * The mission wing: war rooms north of the hall, behind its back wall, two per
 * row. Doors open between the whiteboards. Further rows open into the row before.
 */
const WING_COLUMNS = [{ minX: -15, maxX: -3, door: -10 }, { minX: -3, maxX: 9, door: 0 }];

export function missionSlot(index: number): RoomSlot {
  const column = WING_COLUMNS[index % WING_COLUMNS.length];
  const row = Math.floor(index / WING_COLUMNS.length);
  const maxZ = -13 - row * ROOM_SIZE;
  const rect = { minX: column.minX, maxX: column.maxX, minZ: maxZ - ROOM_SIZE, maxZ };
  const at = row === 0 ? column.door : (column.minX + column.maxX) / 2;
  return { rect, door: { side: 'south', at }, outward: 'north', ring: row };
}

const MAX_BEDS = 12;
const TABLE_SEATS = 8;
const STANDING_SPOTS = 12;

function canvasBoard(width: number, height: number): { mesh: THREE.Mesh; draw: (title: string, lines: string[]) => void } {
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

/** A bed with an agent asleep in it: one finished session of the mission. */
function bed(): THREE.Group {
  const group = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 1.9), getToonMaterial(0x7a5c42));
  frame.position.y = 0.18;
  const blanket = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.12, 1.3), getToonMaterial(0x5a7aad));
  blanket.position.set(0, 0.42, 0.25);
  const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.35), getToonMaterial(0xf5f5f0));
  pillow.position.set(0, 0.41, -0.7);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), getToonMaterial(0xf5deb3));
  head.position.set(0, 0.55, -0.62);
  group.add(frame, blanket, pillow, head);
  return group;
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
  update(room: WorldRoom): void;
}

const FLOOR_OPEN = 0x6f7f9a;
const FLOOR_LOCKED = 0x4a4f5a;

export function buildMissionRoom(room: WorldRoom, index: number): MissionRoom {
  const slot = missionSlot(index);
  const frame = new RoomFrame(slot.rect, slot.door);
  const group = new THREE.Group();
  group.name = `mission-room-${index}`;
  markStatic(group, { zone: 'missions', castShadow: false });
  const stations = new Map<string, Station>();
  const key = (n: number) => `mission${index}_seat_${n}`;
  const type = `room:${room.id}`;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), getToonMaterial(FLOOR_OPEN));
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
  const label = roomLabel(room.title, frame.point(0, ROOM_SIZE / 2), slot.rect);
  group.add(label);

  // The table and its seats; more agents stand around it
  const center = frame.point(0, 6.2);
  const table = createMeetingTable();
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
  mount(boards.kanban.mesh, ROOM_SIZE / 2 - 0.12, 6, 1.7, frame.faceDoor - Math.PI / 2);

  const title = sign(room.title, frame.point(0, 0.4, 3.0), slot.rect, false);
  group.add(title);
  const beds = new THREE.Group();
  group.add(beds);
  const door = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 0.1), getToonMaterial(0x5a4a3a));
  door.position.copy(frame.point(slot.door.at - (slot.rect.minX + slot.rect.maxX) / 2, 0.02, 1.2));
  door.visible = false;
  // The closed door stands in the doorway: it drops with the walls in the overview
  markCutaway(door);
  group.add(door);
  const lockSign = sign('Locked: mission closed', frame.point(0, 0.4, 2.6), slot.rect, false, 'rgba(120, 40, 40, 0.9)');
  lockSign.visible = false;
  group.add(lockSign);
  let sleepersSign: CSS2DObject | null = null;

  const result: MissionRoom = {
    id: room.id, index, slot, group, stations, locked: false,
    update(next: WorldRoom) {
      result.locked = next.state === 'locked';
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
      // One bed per finished session, along the side wall opposite the kanban
      const count = Math.min(next.sleepers ?? 0, MAX_BEDS);
      while (beds.children.length > count) beds.remove(beds.children[beds.children.length - 1]);
      while (beds.children.length < count) {
        const i = beds.children.length;
        const item = bed();
        item.position.copy(frame.point(-ROOM_SIZE / 2 + 0.7 + (i % 2) * 1.05, 2.2 + Math.floor(i / 2) * 1.6, 0));
        item.rotation.y = frame.faceDoor + Math.PI / 2;
        beds.add(item);
      }
      const extra = (next.sleepers ?? 0) - count;
      if (sleepersSign) group.remove(sleepersSign);
      sleepersSign = (next.sleepers ?? 0) > 0
        ? sign(`${next.sleepers} past session${next.sleepers === 1 ? '' : 's'}${extra > 0 ? ` (+${extra} not shown)` : ''}`, frame.point(-ROOM_SIZE / 2 + 1.2, 1.4, 1.8), slot.rect, true)
        : null;
      if (sleepersSign) group.add(sleepersSign);
    },
  };
  result.update(room);
  return result;
}

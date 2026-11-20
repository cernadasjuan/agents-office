import * as THREE from 'three';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Activity } from '../../agents/ActivityAnimations.js';
import { OFFICE_WALLS, type Station } from '../../scene/Office.js';
import { OFFICE } from '../../utils/Constants.js';
import type { LayoutAgent, LayoutMove, LayoutStrategy, RoomView, Seat } from '../../layout/LayoutStrategy.js';
import { HALL, ROOM_SIZE, matchingDoor, slotFor, type Door, type RoomSlot } from './RoomPlanner.js';
import { buildRoom, buildWalls, QUEUE_COUNT_SIGN, ROOM_STATION_TYPE, RoomFrame, WALL_HEIGHT, roomTitle, type RoomKind } from './rooms.js';
import { showLoadedPortrait } from './portrait.js';
import { roomLabelBatchFor } from './roomLabels.js';
import { buildMissionRoom, missionSlot, type MissionRoom } from './missionRooms.js';
import type { WarRoomCounts } from './warRoomFurnishing.js';
import type { WorldRoom } from '../../extensions.js';
import { attentionBand, compareWaits, queuesForYou } from '../../ui/attention.js';
import { markStatic } from '../../scene/StaticMerge.js';
import type { PickTarget } from '../../scene/Selection.js';
import { createMissionsBoard, placeMissionsBoard, type MissionBoardEntry } from './missionsBoard.js';

/**
 * Work that happens at the agent's own desk. Everything else is a trip. Planning,
 * reviewing and writing docs stay here too: a war-room agent does them at that
 * room's furniture (handled before this check); an agent with no war room has
 * nowhere dedicated for them, so it stays at its desk instead of a trip that
 * would otherwise fall back to the lounge.
 */
const DESK_WORK = new Set<Activity>(['implementing', 'debugging', 'deploying', 'planning', 'reviewing', 'writing_docs']);
/** War-room furniture growth (issue #125): activities that use the room's generic desk-like grid. */
const WAR_ROOM_DESK_LIKE = new Set<Activity>(['implementing', 'reviewing', 'testing', 'writing_docs', 'deploying']);
/**
 * War-room routing (issue #126): an agent's activity maps to a piece in its own war room first.
 * A desk-like activity (not debugging) shares the room's desk grid, same as the growth rule above.
 */
const WAR_ROOM_STATION_FOR: Partial<Record<Activity, string>> = {
  debugging: 'debugging',
  planning: 'planning',
  researching: 'researching',
  idle: 'idle',
};
for (const activity of WAR_ROOM_DESK_LIKE) WAR_ROOM_STATION_FOR[activity] = 'implementing';
const TRIP_STATION: Partial<Record<Activity, string>> = {
  researching: 'researching',
  testing: 'testing',
  idle: 'idle',
};
const ROOM_FOR_STATION: Record<string, RoomKind> = Object.fromEntries(
  Object.entries(ROOM_STATION_TYPE).map(([kind, type]) => [type, kind as RoomKind]),
) as Record<string, RoomKind>;

export const BUILDING_STORAGE_KEY = 'agents-office.building.rooms';
const DEFAULT_DWELL_MS = 4000;
const QUEUE_REFRESH_MS = 500;
const MISSIONS_BOARD_REFRESH_MS = 1000;
const ROOM_KINDS: readonly string[] = ['office', 'desks', 'library', 'lab', 'lounge'];
/** A plausible standing eye height (issue #89, `#room=` first person), not a floor minimum like `MIN_EYE_HEIGHT`. */
const ROOM_VIEW_EYE_HEIGHT = 1.6;

/**
 * Lowercased, non-alphanumeric runs collapsed to one `-`, leading/trailing `-` trimmed
 * (issue #89 review, fix 2): `#room=<mission id>` matches a human-typed name against a
 * mission room's own displayed title this way, never against `id` (the server's opaque hash
 * of the mission key; a client never sees the raw slug the server hashed).
 */
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The camera framing for a room's slot (issue #89, `#room=`): its world bounds, floor to
 * wall height, and a first-person standing pose a third of the way in from the door,
 * looking further inward toward the room's main (far) wall. Pure: no scene, no layout state.
 */
export function roomViewFromSlot(slot: RoomSlot): RoomView {
  const bounds = new THREE.Box3(
    new THREE.Vector3(slot.rect.minX, 0, slot.rect.minZ),
    new THREE.Vector3(slot.rect.maxX, WALL_HEIGHT, slot.rect.maxZ),
  );
  const frame = new RoomFrame(slot.rect, slot.door);
  const position = frame.point(0, ROOM_SIZE * 0.35, ROOM_VIEW_EYE_HEIGHT);
  const lookAt = position.clone().addScaledVector(frame.inward, 4);
  return { bounds, standing: { position, lookAt } };
}

type Target = 'home' | 'pod' | 'queue' | `trip:${string}` | `room:${string}`;

interface AgentState {
  agent: LayoutAgent;
  target: Target | null;
  seat: string | null;
  home: string | null;
  pending: { target: Target; since: number } | null;
  queuedAt: number | null;
}

interface RoomRecord {
  kind: RoomKind;
  index: number;
  group: THREE.Group;
  extraDoors: Door[];
}

export interface BuildingOptions {
  now?: () => number;
  dwellMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** A real wall clock (epoch ms), for the missions board's elapsed/duration timer. Defaults to `Date.now`. */
  wallClock?: () => number;
}

/**
 * The fork's building layout. Each session has a home desk for its life and
 * walks to shared stations for other work. Agents that wait for the user queue
 * in the user's office. Subagents gather at their parent's desk. When a kind of
 * station runs out, the building rents a new room next to the others and never
 * gives it back.
 */
export class BuildingLayout implements LayoutStrategy {
  readonly id = 'building';
  private agents = new Map<string, AgentState>();
  private rooms: RoomRecord[] = [];
  private hallWalls: THREE.Group | null = null;
  private missionRooms = new Map<string, MissionRoom & { extraDoors: Door[] }>();
  private now: () => number;
  private wallClock: () => number;
  private dwellMs: number;
  private storage: BuildingOptions['storage'];
  private lastQueueRefresh = -Infinity;
  private lastMissionsBoardRefresh = -Infinity;
  private missionBoardEntries: MissionBoardEntry[] = [];
  private missionsBoard = createMissionsBoard();

  constructor(private scene: THREE.Scene, private stations: Map<string, Station>, options: BuildingOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallClock = options.wallClock ?? (() => Date.now());
    this.dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;
    this.storage = options.storage;
    this.hideHallSideWalls();
    placeMissionsBoard(this.missionsBoard.mesh, this.scene);
    this.missionsBoard.draw([], this.wallClock());
    const remembered = this.rememberedRooms();
    for (const kind of remembered.length > 0 ? remembered : (['office'] as RoomKind[])) this.addRoom(kind, false);
    // The Library is its own room from the start: research trips and librarians go there
    if (!this.roomKinds.includes('library')) this.addRoom('library', false);
    this.saveRooms();
  }

  get roomKinds(): RoomKind[] {
    return this.rooms.map((room) => room.kind);
  }

  /**
   * Rooms from server plugins (mission war rooms). A new room gets the next slot in
   * the mission wing; a known room updates its walls. A locked room keeps standing,
   * and its agents leave.
   */
  syncWorldRooms(rooms: WorldRoom[]): LayoutMove[] {
    for (const room of rooms) {
      const known = this.missionRooms.get(room.id);
      if (known) {
        known.update(room);
        continue;
      }
      const index = this.missionRooms.size;
      const built = Object.assign(buildMissionRoom(room, index), { extraDoors: [] as Door[] });
      this.missionRooms.set(room.id, built);
      this.scene.add(built.group);
      roomLabelBatchFor(this.scene).collect(built.group);
      for (const [key, station] of built.stations) this.stations.set(key, station);
      if (built.slot.ring === 0) this.rebuildHallWalls();
      else {
        const inner = [...this.missionRooms.values()][index - 2];
        inner.extraDoors.push(matchingDoor(built.slot));
        const old = inner.group.getObjectByName('room-walls');
        if (old) inner.group.remove(old);
        const walls = buildWalls(missionSlot(inner.index).rect, [missionSlot(inner.index).door, ...inner.extraDoors]);
        walls.name = 'room-walls';
        inner.group.add(walls);
      }
    }
    this.missionBoardEntries = rooms.filter((room) => room.kind === 'mission')
      .map((room) => ({ title: room.title, state: room.state, createdAt: room.createdAt, closedAt: room.closedAt }));
    this.missionsBoard.draw(this.missionBoardEntries, this.wallClock());
    return [];
  }

  get missionRoomCount(): number {
    return this.missionRooms.size;
  }

  /** Every war room's tombstones, pickable by a click or hover (issue #127). */
  tombstonePickTargets(): PickTarget[] {
    return [...this.missionRooms.values()].flatMap((room) => room.tombstonePickTargets());
  }

  /** Every war room's issue board, pickable by a click (issue #146). */
  issuesBoardPickTargets(): PickTarget[] {
    return [...this.missionRooms.values()].map((room) => room.issuesBoardPickTarget());
  }

  /**
   * Where the camera should go to show a named room (issue #89, `#room=`). A room kind
   * ("office": always the first one, "Your office", never a later overflow waiting room;
   * "desks", "library", "lab", "lounge": the first room of that kind), or a mission room.
   * A mission room never matches by a raw `mission:<slug>` key: `id` is the server's opaque
   * hash of that key (`projectWorld`'s `publicId`), so a client never sees the slug it was
   * hashed from (issue #89 review, fix 2). It matches instead by the room's own displayed
   * title, slugified (`#room=media-plan` against the title "Media Plan"), or by the exact
   * public id a reviewer could copy from `/api/world`. Unknown names return null; this never
   * changes the scene, only reports where a camera could go.
   */
  roomView(name: string): RoomView | null {
    const query = name.trim().toLowerCase();
    if (!query) return null;
    let slot: RoomSlot | null = null;
    if (ROOM_KINDS.includes(query)) {
      const record = this.rooms.find((room) => room.kind === query);
      if (record) slot = slotFor(record.index);
    }
    if (!slot) {
      const byId = [...this.missionRooms.values()].find((room) => room.id === name);
      if (byId) {
        slot = byId.slot;
      } else {
        // Two mission rooms can slugify to the same title (issue #89 review, fix round 2):
        // picking the first one silently would show the wrong room. The exact public id
        // always disambiguates them; a title match only resolves when exactly one applies.
        const byTitle = [...this.missionRooms.values()].filter((room) => slugify(room.title) === query);
        if (byTitle.length === 1) slot = byTitle[0]!.slot;
        else if (byTitle.length > 1) console.debug(`roomView("${name}") matches more than one mission room by title; none resolved`);
      }
    }
    return slot ? roomViewFromSlot(slot) : null;
  }

  seatFor(agent: LayoutAgent, previous: Activity | null): Seat | null {
    const state = this.stateOf(agent);
    const desired = this.targetFor(state);
    if (previous === null || state.target === null) return this.assign(state, desired);
    if (desired === state.target) {
      state.pending = null;
      return null;
    }
    // Waiting for the user is urgent; any other change waits for the dwell time
    if (desired === 'queue') return this.assign(state, desired);
    if (state.pending?.target !== desired) state.pending = { target: desired, since: this.now() };
    return null;
  }

  release(agentId: string): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    this.free(state.seat);
    if (state.home !== state.seat) this.free(state.home);
    this.agents.delete(agentId);
  }

  update(): LayoutMove[] {
    const now = this.now();
    const moves: LayoutMove[] = [];
    for (const state of this.agents.values()) {
      if (!state.pending || now - state.pending.since < this.dwellMs) continue;
      const seat = this.assign(state, state.pending.target);
      if (seat) moves.push({ agentId: state.agent.id, seat });
    }
    if (now - this.lastQueueRefresh >= QUEUE_REFRESH_MS) {
      this.lastQueueRefresh = now;
      moves.push(...this.orderQueue());
    }
    // The missions board's running timer ticks on its own schedule (issue #144), not tied to
    // new mission data (every ~10 s poll): it must visibly move while nothing else changes.
    if (now - this.lastMissionsBoardRefresh >= MISSIONS_BOARD_REFRESH_MS) {
      this.lastMissionsBoardRefresh = now;
      this.missionsBoard.draw(this.missionBoardEntries, this.wallClock());
    }
    this.growMissionFurniture();
    return moves;
  }

  /**
   * War-room furniture grows with the peak concurrent count of desk-like and
   * debugging agents (issue #125, rulebook §3), and never shrinks back; each
   * room tracks its own peak and only rebuilds when a count actually grows.
   */
  private growMissionFurniture(): void {
    if (this.missionRooms.size === 0) return;
    const counts = new Map<string, WarRoomCounts>();
    for (const state of this.agents.values()) {
      const roomId = state.target?.startsWith('room:') ? state.target.slice('room:'.length) : null;
      if (!roomId || !this.missionRooms.has(roomId)) continue;
      const entry = counts.get(roomId) ?? { deskLike: 0, debugging: 0 };
      if (state.agent.activity === 'debugging') entry.debugging++;
      else if (WAR_ROOM_DESK_LIKE.has(state.agent.activity)) entry.deskLike++;
      counts.set(roomId, entry);
    }
    for (const [id, room] of this.missionRooms) room.updateCounts(counts.get(id) ?? { deskLike: 0, debugging: 0 });
  }

  // --- Targets ---

  private targetFor(state: AgentState): Target {
    const { agent } = state;
    const parentId = agent.extras?.parentId;
    const cold = attentionBand(agent.extras) === 'cold';
    if (!parentId && (queuesForYou(agent.extras) || (agent.activity === 'meeting' && !cold))) return 'queue';
    const room = agent.extras?.room ? this.missionRooms.get(agent.extras.room) : undefined;
    if (!parentId && room && !room.locked) return `room:${room.id}`;
    const parent = parentId ? this.agents.get(parentId) : undefined;
    // A librarian fetches from the Library while it researches, and brings it back to its agent otherwise
    if (agent.extras?.role === 'librarian' && agent.activity === 'researching') return 'trip:researching';
    if (parent && (parent.home || parent.target?.startsWith('room:'))) return 'pod';
    if (DESK_WORK.has(agent.activity)) return 'home';
    return `trip:${TRIP_STATION[agent.activity] ?? 'idle'}`;
  }

  private assign(state: AgentState, target: Target): Seat {
    if (state.seat && state.seat !== state.home) this.free(state.seat);
    state.pending = null;
    state.queuedAt = target === 'queue' ? (state.queuedAt ?? this.now()) : null;
    state.target = target;

    let key: string;
    if (target === 'home') key = this.homeOf(state);
    else if (target === 'pod') key = this.claim(this.podKeys(this.agents.get(state.agent.extras!.parentId!)!), 'pod');
    else if (target.startsWith('room:')) key = this.claimInRoom(target.slice('room:'.length), state.agent.activity);
    else if (target === 'queue') key = this.claimOfType('queue');
    else key = this.claimOfType(target.slice('trip:'.length));
    state.seat = key;
    return this.seat(key);
  }

  /**
   * The agent's desk for life, in the shared desk pool (the hall desks, then a
   * rented `desks` room when those run out). A session in a herdr workspace
   * prefers a free desk next to one already held by the same workspace.
   */
  private homeOf(state: AgentState): string {
    if (state.home) return state.home;
    const workspace = this.workspaceOf(state);
    let free = this.pickDesk(workspace);
    if (!free) {
      this.addRoom('desks');
      free = this.pickDesk(workspace)!;
    }
    this.stations.get(free)!.occupied = true;
    state.home = free;
    return free;
  }

  private workspaceOf(state: AgentState): string | undefined {
    return state.agent.extras?.parentId ? undefined : state.agent.extras?.group?.label;
  }

  /** A free desk next to one already held by the same workspace, else any free desk. */
  private pickDesk(workspace: string | undefined): string | undefined {
    const free = this.keysOfType('implementing').filter((key) => !this.stations.get(key)!.occupied);
    if (free.length === 0) return undefined;
    if (workspace === undefined) return free[0];
    const occupiedByWorkspace = [...this.agents.values()].filter((other) => other.home && this.workspaceOf(other) === workspace).map((other) => other.home!);
    if (occupiedByWorkspace.length === 0) return free[0];
    // "Next to" is physical, not a key suffix: desks stand in rows, so an adjacent
    // suffix can be a row apart while the true nearest desk carries a far suffix.
    const distanceToWorkspace = (key: string): number => {
      const position = this.stations.get(key)!.position;
      return Math.min(...occupiedByWorkspace.map((occupied) => position.distanceTo(this.stations.get(occupied)!.position)));
    };
    return free.reduce((closest, key) => (distanceToWorkspace(key) < distanceToWorkspace(closest) ? key : closest));
  }

  /**
   * A seat in a war room: its own piece for the current activity first (issue #126), so a
   * researching agent stands at that room's bookshelf and a planning agent at its whiteboard,
   * never at the library or a dedicated room. Without a free piece for the activity, or without
   * one at all, the agent takes any free seat in the room's generic ring. Only a room with no
   * free seat of any kind falls back to the lounge.
   */
  private claimInRoom(roomId: string, activity: Activity): string {
    const preferredType = WAR_ROOM_STATION_FOR[activity];
    const preferred = preferredType && this.keysOfType(`room:${roomId}:${preferredType}`).find((key) => !this.stations.get(key)!.occupied);
    if (preferred) return this.claim([preferred], 'room');
    const free = this.keysOfType(`room:${roomId}`).find((key) => !this.stations.get(key)!.occupied);
    return free ? this.claim([free], 'room') : this.claimOfType('idle');
  }

  /** Spots around the parent's anchor (its war room seat, else its home desk) for its subagents. */
  private podKeys(parent: AgentState): string[] {
    const anchorKey = parent.target?.startsWith('room:') && parent.seat ? parent.seat : parent.home!;
    const desk = this.stations.get(anchorKey)!;
    const facing = new THREE.Vector3().subVectors(desk.lookAt, desk.position).setY(0).normalize();
    const side = new THREE.Vector3(-facing.z, 0, facing.x);
    const keys: string[] = [];
    const offsets: Array<[number, number]> = [[1.0, 0.1], [-1.0, 0.1], [0.55, -0.9], [-0.55, -0.9], [1.4, -0.9], [-1.4, -0.9]];
    offsets.forEach(([across, ahead], i) => {
      const key = `${anchorKey}_pod${i}`;
      if (!this.stations.has(key)) {
        const position = desk.position.clone().addScaledVector(side, across).addScaledVector(facing, ahead);
        this.stations.set(key, { type: 'pod', position, lookAt: desk.lookAt.clone(), occupied: false, posture: 'standing' });
      }
      keys.push(key);
    });
    return keys;
  }

  // --- Queue ---

  private orderQueue(): LayoutMove[] {
    const waiting = [...this.agents.values()]
      .filter((state) => state.target === 'queue')
      .sort((a, b) => compareWaits(a.agent.extras, b.agent.extras) || (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
    const spots = this.keysOfType('queue');
    while (spots.length < waiting.length) {
      this.addRoom('office');
      spots.splice(0, spots.length, ...this.keysOfType('queue'));
    }
    // A meeting without a wait also queues, but only fresh and aging waits count for you
    this.showQueueCount(waiting.filter((state) => queuesForYou(state.agent.extras)).length);
    const moves: LayoutMove[] = [];
    for (const state of waiting) this.free(state.seat);
    waiting.forEach((state, i) => {
      const key = spots[i];
      this.stations.get(key)!.occupied = true;
      if (state.seat !== key) {
        state.seat = key;
        moves.push({ agentId: state.agent.id, seat: this.seat(key) });
      }
    });
    return moves;
  }

  /** The sign under the portrait of the first office: "N waiting", hidden when nobody waits. */
  private showQueueCount(count: number): void {
    const sign = this.rooms.find((room) => room.kind === 'office')?.group.getObjectByName(QUEUE_COUNT_SIGN) as CSS2DObject | undefined;
    if (!sign || sign.userData.queueCount === count) return;
    sign.userData.queueCount = count;
    sign.element.textContent = `${count} waiting`;
    sign.visible = count > 0;
  }

  // --- Stations and rooms ---

  private keysOfType(type: string): string[] {
    return [...this.stations.entries()].filter(([, station]) => station.type === type).map(([key]) => key);
  }

  private claimOfType(type: string): string {
    // Research prefers the Library room's shelves over the two hall shelves
    const keys = type === 'researching'
      ? [...this.keysOfType(type).filter((key) => key.startsWith('room')), ...this.keysOfType(type).filter((key) => !key.startsWith('room'))]
      : this.keysOfType(type);
    const free = keys.find((key) => !this.stations.get(key)!.occupied);
    if (free) return this.claim([free], type);
    this.addRoom(ROOM_FOR_STATION[type] ?? 'lounge');
    return this.claimOfType(type);
  }

  private claim(keys: string[], type: string): string {
    const free = keys.find((key) => !this.stations.get(key)!.occupied);
    if (!free) {
      // More subagents than pod spots: they stand at the next free lounge seat
      return type === 'pod' ? this.claimOfType('idle') : this.claimOfType(type);
    }
    this.stations.get(free)!.occupied = true;
    return free;
  }

  private free(key: string | null): void {
    if (!key) return;
    const station = this.stations.get(key);
    if (station) station.occupied = false;
  }

  private seat(key: string): Seat {
    const station = this.stations.get(key)!;
    return { key, position: station.position, lookAt: station.lookAt, posture: station.posture };
  }

  private stateOf(agent: LayoutAgent): AgentState {
    let state = this.agents.get(agent.id);
    if (!state) {
      state = { agent, target: null, seat: null, home: null, pending: null, queuedAt: null };
      this.agents.set(agent.id, state);
    }
    state.agent = agent;
    return state;
  }

  private addRoom(kind: RoomKind, save = true): void {
    const index = this.rooms.length;
    const slot = slotFor(index);
    const built = buildRoom(kind, slot, index, [], roomTitle(kind, this.roomKinds));
    const record: RoomRecord = { kind, index, group: built.group, extraDoors: [] };
    this.rooms.push(record);
    this.scene.add(built.group);
    if (kind === 'office') showLoadedPortrait(built.group);
    // Every room label of the scene draws in one call
    roomLabelBatchFor(this.scene).collect(built.group);
    for (const [key, station] of built.stations) this.stations.set(key, station);

    if (slot.ring === 0) this.rebuildHallWalls();
    else {
      // Open the wall of the room inside this one, so the new room has a way in
      const inner = this.rooms[index - 7];
      inner.extraDoors.push(matchingDoor(slot));
      this.rebuildRoomWalls(inner);
    }
    if (save) this.saveRooms();
  }

  private rebuildRoomWalls(room: RoomRecord): void {
    const slot = slotFor(room.index);
    const old = room.group.getObjectByName('room-walls');
    if (old) room.group.remove(old);
    const walls = buildWalls(slot.rect, [slot.door, ...room.extraDoors]);
    walls.name = 'room-walls';
    room.group.add(walls);
  }

  /** The hall keeps its furniture; its four side walls are replaced by walls with a door for each attached room. */
  private hideHallSideWalls(): void {
    const original = this.scene.getObjectByName(OFFICE_WALLS);
    original?.children.forEach((child) => {
      if (!(child instanceof THREE.Mesh) || !(child.geometry instanceof THREE.BoxGeometry)) return;
      if (child.geometry.parameters.height === OFFICE.height) child.visible = false;
    });
  }

  private rebuildHallWalls(): void {
    if (this.hallWalls) this.scene.remove(this.hallWalls);
    const doors = [
      ...this.rooms.map((room) => slotFor(room.index)).filter((slot) => slot.ring === 0),
      ...[...this.missionRooms.values()].map((room) => room.slot).filter((slot) => slot.ring === 0),
    ].map(matchingDoor);
    this.hallWalls = buildWalls(HALL, doors, OFFICE.height, ['south', 'west']);
    this.hallWalls.name = 'building-hall-walls';
    // Its own zone: the overview lowers the hall walls like the room walls
    markStatic(this.hallWalls, { zone: 'hall-walls', overviewLower: OFFICE.height });
    this.scene.add(this.hallWalls);
  }

  /**
   * Remembered rooms, one kind each. A `kind@<tag>` entry is a retired
   * per-workspace desk room (roadmap item 20, superseded by floors, #118): it
   * is dropped, without error, and its sessions resettle in the shared pool.
   */
  private rememberedRooms(): RoomKind[] {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(BUILDING_STORAGE_KEY) ?? '[]');
      const kinds = Object.keys(ROOM_STATION_TYPE);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 200)
        .filter((entry) => !entry.includes('@'))
        .filter((kind): kind is RoomKind => kinds.includes(kind));
    } catch {
      return [];
    }
  }

  private saveRooms(): void {
    try {
      this.storage?.setItem(BUILDING_STORAGE_KEY, JSON.stringify(this.rooms.map((room) => room.kind)));
    } catch {
      // Storage full or blocked: the building still works for this page
    }
  }
}

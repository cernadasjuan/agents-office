import * as THREE from 'three';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Activity } from '../../agents/ActivityAnimations.js';
import { OFFICE_WALLS, type Station } from '../../scene/Office.js';
import { OFFICE } from '../../utils/Constants.js';
import type { LayoutAgent, LayoutMove, LayoutStrategy, RoomView, Seat } from '../../layout/LayoutStrategy.js';
import { HALL, ROOM_SIZE, matchingDoor, slotFor, type Door, type Rect, type RoomSlot } from './RoomPlanner.js';
import { buildCeiling, buildRoom, buildWalls, markCutaway, QUEUE_COUNT_SIGN, ROOM_STATION_TYPE, RoomFrame, WALL_HEIGHT, roomTitle, wallRects, type RoomKind, type WallRect } from './rooms.js';
import { deskCameraPose, deskTalkSpotPose, monitorWorldCorners } from './deskGeometry.js';
import { showLoadedPortrait } from './portrait.js';
import { roomLabelBatchFor } from './roomLabels.js';
import {
  buildMissionRoom,
  MISSION_CORRIDOR_DOOR,
  MISSION_CORRIDOR_HALL_DOOR,
  missionCorridorFloor,
  missionCorridorRect,
  missionSlot,
  type MissionRoom,
} from './missionRooms.js';
import { tombstoneNameBatchFor } from './tombstoneNames.js';
import type { WarRoomCounts } from './warRoomFurnishing.js';
import type { WorldRoom } from '../../extensions.js';
import { matchesFloor } from '../../floors/FloorRegistry.js';
import { attentionBand, compareWaits, queuesForYou } from '../../ui/attention.js';
import { markStatic } from '../../scene/StaticMerge.js';
import { createStool } from '../../furniture/Stool.js';
import type { PickTarget } from '../../scene/Selection.js';
import { FIGURE_EYE_HEIGHT } from '../../characters/StickFigureParts.js';
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
 * Issue #209: no `idle` entry here any more — a war room has no sofa left to send it to; an
 * idle mission agent's `targetFor` below never reaches the room branch at all.
 */
const WAR_ROOM_STATION_FOR: Partial<Record<Activity, string>> = {
  debugging: 'debugging',
  planning: 'planning',
  researching: 'researching',
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

/**
 * The Librarian persona badge (issue #128, Prospero's own review on the issue): the real
 * signal the `bmad` plugin's hat detection reports (`bmad.py agent librarian`, a Skill
 * call, or a subagent type that resolves to it, `plugins/bmad/roster.ts`), never a name
 * or role tag an agent's own session metadata could claim on its own.
 */
function isLibrarian(extras: LayoutAgent['extras']): boolean {
  return Array.isArray(extras?.badges) && extras.badges.includes('librarian');
}

export const BUILDING_STORAGE_KEY = 'agents-office.building.rooms';
/** Marks the one-time legacy-rooms migration as done (issue #191, `migrateLegacyRooms`), so it
 * never runs a second time no matter which floor is focused afterward. */
const ROOMS_MIGRATED_KEY = 'agents-office.building.rooms.migrated';
/**
 * Each floor keeps its own room-kind list under its own storage key (issue #118 floors
 * design: `BUILDING_STORAGE_KEY` becomes `BUILDING_STORAGE_KEY:<floor>`). Without a floor
 * name (`BuildingOptions.floor` unset, the shape every building-layout test used before
 * floors shipped), the legacy bare key stays untouched: a feature appears only when its
 * data exists (rule 3).
 */
export function floorStorageKey(floor?: string): string {
  return floor ? `${BUILDING_STORAGE_KEY}:${floor}` : BUILDING_STORAGE_KEY;
}
/** A war room's peak desk/debug counts, by room id (issue #129 review round 2): without
 * this, a reload while the room happens to be empty resets its peak to zero in memory,
 * undoing the never-shrinks rule the furniture itself otherwise keeps. */
export const MISSION_COUNTS_STORAGE_KEY = 'agents-office.building.missionCounts';
const DEFAULT_DWELL_MS = 4000;
const QUEUE_REFRESH_MS = 500;
const MISSIONS_BOARD_REFRESH_MS = 1000;
const ROOM_KINDS: readonly string[] = ['office', 'desks', 'library', 'lab', 'lounge'];
/** A standing agent's own eye height (issue #89, `#room=` first person; issue #174 aligned this with `FreeCamera`'s own ground-walk eye height). */
const ROOM_VIEW_EYE_HEIGHT = FIGURE_EYE_HEIGHT;

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
  /** The war-room piece type `seat` currently satisfies (`room:<id>:<type>`'s `<type>`), or
   * null for a generic-ring seat, a non-room target, or no seat yet. Lets `seatFor` notice
   * an activity change inside the same room (issue #126 review round 2: the target string
   * alone, `room:<id>`, is the same for every activity in that room, so comparing only that
   * swallowed the change before `claimInRoom` ever ran again). */
  roomStationType: string | null;
  pending: { target: Target; roomStationType: string | null; since: number } | null;
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
  /** The focused floor's name (issue #118): its own room-kind list lives at `floorStorageKey(floor)`. Unset keeps the legacy single-building key. */
  floor?: string;
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
  /** Issue #123: the one shared frontage every war room's door opens onto, grown each time a new row is rented. */
  private missionCorridor: THREE.Group | null = null;
  private missionRooms = new Map<string, MissionRoom>();
  private now: () => number;
  private wallClock: () => number;
  private dwellMs: number;
  private storage: BuildingOptions['storage'];
  private floor: string | undefined;
  private lastQueueRefresh = -Infinity;
  private lastMissionsBoardRefresh = -Infinity;
  private missionBoardEntries: MissionBoardEntry[] = [];
  private missionsBoard = createMissionsBoard();

  constructor(private scene: THREE.Scene, private stations: Map<string, Station>, options: BuildingOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallClock = options.wallClock ?? (() => Date.now());
    this.dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;
    this.storage = options.storage;
    this.floor = options.floor;
    this.migrateLegacyRooms();
    this.hideHallSideWalls();
    placeMissionsBoard(this.missionsBoard.mesh, this.scene);
    this.missionsBoard.draw([], this.wallClock());
    // `rememberedRooms` always returns the office first (issue #192: it is the lobby, not one
    // floor's own room, so a floor can never come up without it), so there is no fallback
    // list to fall through to here.
    for (const kind of this.rememberedRooms()) this.addRoom(kind, false);
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
  syncWorldRooms(worldRooms: WorldRoom[]): LayoutMove[] {
    // Issue #191: a specific floor builds only its own repo's war rooms (`matchesFloor` compares
    // the room's own bare repo tag against this floor's trailing segment, org-qualified or not).
    // Unset `this.floor` is `ALL_FLOORS` (`src/addons/building.ts` never passes a floor option
    // for it), the original behavior: every room shows, repo tag or none.
    const rooms = this.floor === undefined ? worldRooms : worldRooms.filter((room) => matchesFloor(this.floor!, room.repo));
    let grew = false;
    for (const room of rooms) {
      const known = this.missionRooms.get(room.id);
      if (known) {
        known.update(room);
        continue;
      }
      const index = this.missionRooms.size;
      const built = buildMissionRoom(room, index, this.rememberedMissionCounts(room.id));
      this.missionRooms.set(room.id, built);
      this.scene.add(built.group);
      roomLabelBatchFor(this.scene).collect(built.group);
      // Issue #159 review round 1: a room built with sleepers already present (a reload, not a
      // fresh mission) creates its nameplates before `this.scene.add` above; this catches them.
      tombstoneNameBatchFor(this.scene).collect(built.group);
      for (const [key, station] of built.stations) this.stations.set(key, station);
      grew = true;
    }
    // Issue #123: every war room's door opens directly onto the mission corridor, never
    // through another room, so a new room never touches another room's own walls — only the
    // hall (once, for the corridor's own doorway) and the corridor itself need a rebuild.
    if (grew) {
      this.rebuildHallWalls();
      this.rebuildMissionCorridor();
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

  /**
   * Where the fixed desk-view camera (issue #161, key `H`) sits: behind the user's own desk,
   * a little lower than a standing first-person pose, looking at the queue in front of it.
   * Null without a rented office room yet (graceful degradation, rule 3) — a layout only ever
   * has one at construction, so this should not happen in practice, but a fresh office render
   * mid-rebuild is still handled the same way `roomView` handles an unknown name.
   */
  deskView(): { position: THREE.Vector3; lookAt: THREE.Vector3; fov: number } | null {
    if (!this.rooms.some((room) => room.kind === 'office')) return null;
    return deskCameraPose();
  }

  /**
   * World corners of each desk monitor's bezel, left then right (issue #161 review): lets the
   * label declutter keep a queued agent's label clear of them in desk mode. Delegates to the
   * pure geometry in `deskGeometry.ts` — the one source of where a monitor actually sits, the
   * same one the desk camera pose above and the mesh builder in `deskMonitors.ts` read, so
   * none of the three can drift from the others (review round 2's own root cause).
   */
  deskMonitorCorners(): THREE.Vector3[][] {
    return monitorWorldCorners();
  }

  /**
   * Where a selected queued agent walks to address Gabriel directly (issue #162, desk mode
   * only): a fixed spot in front of the desk, standing, facing the desk camera. Null without a
   * rented office room yet — the same graceful degradation `deskView` uses.
   */
  deskTalkSpot(): Seat | null {
    if (!this.rooms.some((room) => room.kind === 'office')) return null;
    const pose = deskTalkSpotPose();
    return { key: 'desk-talk-spot', position: pose.position, lookAt: pose.lookAt, posture: 'standing' };
  }

  /**
   * Whether this agent currently queues in front of the user's own desk (issue #162): the only
   * agents eligible to walk up to `deskTalkSpot`. A subagent, a war-room agent or anyone else
   * waiting somewhere other than the queue never qualifies, even while selected.
   */
  isQueued(agentId: string): boolean {
    return this.agents.get(agentId)?.target === 'queue';
  }

  /**
   * The room (building or mission) whose floor contains a world point, or null between rooms
   * or outside the building (issue #175, double-click a room in isometric). Pure rect
   * containment: cheap, and exact since rooms never overlap.
   */
  roomAt(x: number, z: number): RoomView | null {
    const inside = (rect: Rect) => x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
    for (const record of this.rooms) {
      const slot = slotFor(record.index);
      // `kind` (issue #239): lets a caller special-case the library door (it swaps to the
      // library's own scene) without this layout needing to know what a "scene swap" is.
      if (inside(slot.rect)) return { ...roomViewFromSlot(slot), kind: record.kind };
    }
    for (const room of this.missionRooms.values()) {
      if (inside(room.slot.rect)) return roomViewFromSlot(room.slot);
    }
    return null;
  }

  /**
   * Every wall in the building, as a flat 2D collision list (issue #194): the hall's own
   * outer walls, every rented room's walls (with the doors it has grown), and every war
   * room's walls. The same `rect`/`doors` pairs `rebuildHallWalls`, `rebuildRoomWalls` and
   * `syncWorldRooms` already build real wall meshes from, run through `wallRects` instead
   * of `buildWalls` — so the collision list can never drift from what actually draws.
   * `ViewController` feeds this to `FreeCamera`'s ground-walk every frame; empty before any
   * room exists, which `setWallColliders([])` already treats as unobstructed.
   */
  wallColliders(): WallRect[] {
    const hallDoors = [
      ...this.rooms.map((room) => slotFor(room.index)).filter((slot) => slot.ring === 0).map(matchingDoor),
      ...(this.missionRooms.size > 0 ? [MISSION_CORRIDOR_HALL_DOOR] : []),
    ];
    const colliders: WallRect[] = [...wallRects(HALL, hallDoors)];
    for (const record of this.rooms) {
      const slot = slotFor(record.index);
      colliders.push(...wallRects(slot.rect, [slot.door, ...record.extraDoors]));
    }
    // Issue #123: every war room has only its own door now (no `extraDoors` chain), plus the
    // mission corridor's own walls, the one shared frontage they all open onto.
    for (const room of this.missionRooms.values()) {
      colliders.push(...wallRects(room.slot.rect, [room.slot.door]));
    }
    if (this.missionRooms.size > 0) {
      colliders.push(...wallRects(missionCorridorRect(this.missionRooms.size), this.missionCorridorDoors()));
    }
    return colliders;
  }

  seatFor(agent: LayoutAgent, previous: Activity | null): Seat | null {
    const state = this.stateOf(agent);
    const desired = this.targetFor(state);
    if (previous === null || state.target === null) return this.assign(state, desired);
    // A room target alone (`room:<id>`) is the same string for every activity in that room;
    // an activity change that wants a different piece there (researching -> planning, say)
    // must still re-run `claimInRoom`, not be swallowed by the "same target" no-op below.
    const desiredRoomStationType = desired.startsWith('room:') ? WAR_ROOM_STATION_FOR[state.agent.activity] ?? null : null;
    if (desired === state.target && desiredRoomStationType === state.roomStationType) {
      state.pending = null;
      return null;
    }
    // Waiting for the user is urgent; any other change waits for the dwell time
    if (desired === 'queue') return this.assign(state, desired);
    if (state.pending?.target !== desired || state.pending?.roomStationType !== desiredRoomStationType) {
      state.pending = { target: desired, roomStationType: desiredRoomStationType, since: this.now() };
    }
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
    let grew = false;
    for (const [id, room] of this.missionRooms) {
      const before = room.peakCounts;
      const previousKeys = new Set(room.stations.keys());
      room.updateCounts(counts.get(id) ?? { deskLike: 0, debugging: 0 });
      if (room.peakCounts.deskLike !== before.deskLike || room.peakCounts.debugging !== before.debugging) grew = true;
      // `updateCounts` rebuilds the room's own furniture stations (its `stations` map,
      // `missionRooms.ts`); this routing table only ever copied them in once, at the room's
      // first construction (`syncWorldRooms`), before any growth happened — so a grown desk
      // or debug station was never actually reachable (issue #126 review round 2: the very
      // first implementing agent in a fresh war room sat at the generic ring, not a desk).
      // A key still present after a rebuild keeps its own occupied flag, not the freshly
      // built one's false. A key a rebuild dropped (the must-haves' own furniture keys are
      // now keyed by station type and an ordinal within that type, issue #126 review round
      // 3: the desk grid's slots sit first in the plan, so growing one shifts every
      // must-have's array position, but never its type or ordinal) is removed here too, so
      // no stale entry for a piece that no longer exists stays routable.
      for (const key of previousKeys) if (!room.stations.has(key)) this.stations.delete(key);
      for (const [key, station] of room.stations) {
        const existing = this.stations.get(key);
        this.stations.set(key, existing ? { ...station, occupied: existing.occupied } : station);
      }
    }
    // Only on an actual change: a reload while every room happens to be empty must not
    // reset a room's peak to zero (issue #129 review round 2), but writing on every tick
    // regardless would be wasted work.
    if (grew) this.saveMissionCounts();
  }

  // --- Targets ---

  private targetFor(state: AgentState): Target {
    const { agent } = state;
    const parentId = agent.extras?.parentId;
    const cold = attentionBand(agent.extras) === 'cold';
    if (!parentId && (queuesForYou(agent.extras) || (agent.activity === 'meeting' && !cold))) return 'queue';
    const room = agent.extras?.room ? this.missionRooms.get(agent.extras.room) : undefined;
    // Issue #209: an idle mission agent skips its own war room (no sofa there any more) and
    // falls through to the generic `trip:idle` branch below, the main room's lounge/cafeteria.
    if (!parentId && room && !room.locked && agent.activity !== 'idle') return `room:${room.id}`;
    const parent = parentId ? this.agents.get(parentId) : undefined;
    // Only the Librarian persona fetches from the library-knowledge shelves (issue #128):
    // a real persona-hat badge, not a name or role tag (Prospero's own review on the issue).
    // It brings what it found back to its agent otherwise, through the pod branch below.
    if (isLibrarian(agent.extras) && agent.activity === 'researching') return 'trip:researching';
    if (parent && (parent.home || parent.target?.startsWith('room:'))) return 'pod';
    // A non-librarian's research trip never reaches the library-knowledge room either: with
    // a war room it already stayed there (the room check above). Without one it keeps its
    // own desk, the same as desk work (issue #128 AC2) — this covers a subagent whose parent
    // has no seat yet too (the pod check above falls through on that exact timing, issue #128
    // review), not only a main session; the generic trip below is never reached for research.
    if (DESK_WORK.has(agent.activity) || agent.activity === 'researching') return 'home';
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
    // The piece actually claimed, not just the one wanted: `claimInRoom` falls back to the
    // generic ring (or the lounge) when its preferred piece is taken, and that still counts
    // as "no specific piece", not the preferred type, for the next activity-change check.
    const roomMatch = target.startsWith('room:') ? /^room:[^:]+:(.+)$/.exec(this.stations.get(key)!.type) : null;
    state.roomStationType = roomMatch ? roomMatch[1] : null;
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
   * one at all, the agent takes a free spot in the room's generic ring: a standing spot first
   * (issue #129 AC4, a desk-cap overflow stands, it does not sit at the meeting table), a table
   * seat only once every standing spot is taken too. The table seats and the standing ring
   * share one station type (`room:${roomId}`, `missionRooms.ts`); `posture` is the only thing
   * that tells them apart. Only a room with no free spot of any kind falls back to the lounge.
   */
  private claimInRoom(roomId: string, activity: Activity): string {
    const preferredType = WAR_ROOM_STATION_FOR[activity];
    const preferred = preferredType && this.keysOfType(`room:${roomId}:${preferredType}`).find((key) => !this.stations.get(key)!.occupied);
    if (preferred) return this.claim([preferred], 'room');
    const ring = this.keysOfType(`room:${roomId}`).filter((key) => !this.stations.get(key)!.occupied);
    const free = ring.find((key) => this.stations.get(key)!.posture !== 'seated') ?? ring[0];
    return free ? this.claim([free], 'room') : this.claimOfType('idle');
  }

  /**
   * Spots around the parent's anchor (its war room seat, else its home desk) for
   * its subagents. Each pod gets its own small stool (issue #164): a pod stood by
   * design before, for any activity, which read as "something is wrong" once idle
   * lost its continuous sway (#163) — a standing figure with no activity-driven
   * reason to stand. A stool next to the parent's desk gives every pod subagent a
   * seated posture instead, the same `postureOverride` mechanism the sofa's idle
   * seats already use (`ActivityAnimations.ts`), so a busy or idle pod subagent
   * both read as "has a place," not as a crowd that needs attention.
   *
   * Issue #209 review: `targetFor`'s `pod` decision reads the parent's state at the
   * child's own dwell time, not at assign time; if the parent goes idle (leaving its
   * room, `home` still unset — a mission parent only ever gets a `home` desk through
   * the plain desk-work branch, never through the room branch) in the same tick its
   * child's own pending `pod` assignment matures, `parent.home!` reads `undefined`
   * and this throws. `parent.seat` is always set once a parent has been assigned at
   * all, room or no room, so it is the safe fallback, not a bare `home!`.
   */
  private podKeys(parent: AgentState): string[] {
    const anchorKey = (parent.target?.startsWith('room:') && parent.seat ? parent.seat : parent.home) ?? parent.seat!;
    const desk = this.stations.get(anchorKey)!;
    const facing = new THREE.Vector3().subVectors(desk.lookAt, desk.position).setY(0).normalize();
    const side = new THREE.Vector3(-facing.z, 0, facing.x);
    const keys: string[] = [];
    const offsets: Array<[number, number]> = [[1.0, 0.1], [-1.0, 0.1], [0.55, -0.9], [-0.55, -0.9], [1.4, -0.9], [-1.4, -0.9]];
    offsets.forEach(([across, ahead], i) => {
      const key = `${anchorKey}_pod${i}`;
      if (!this.stations.has(key)) {
        const position = desk.position.clone().addScaledVector(side, across).addScaledVector(facing, ahead);
        const stool = createStool();
        stool.position.copy(position);
        stool.rotation.y = Math.atan2(facing.x, facing.z);
        markStatic(stool, { zone: 'pods' });
        this.scene.add(stool);
        this.stations.set(key, { type: 'pod', position, lookAt: desk.lookAt.clone(), occupied: false, posture: 'seated' });
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
      state = { agent, target: null, seat: null, home: null, roomStationType: null, pending: null, queuedAt: null };
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
      ...this.rooms.map((room) => slotFor(room.index)).filter((slot) => slot.ring === 0).map(matchingDoor),
      // Issue #123: the hall's own one doorway into the whole mission wing, through the
      // corridor — never a door per war room (that chained through `extraDoors` before).
      ...(this.missionRooms.size > 0 ? [MISSION_CORRIDOR_HALL_DOOR] : []),
    ];
    this.hallWalls = buildWalls(HALL, doors, OFFICE.height, ['south', 'west']);
    this.hallWalls.name = 'building-hall-walls';
    // Its own zone: the overview lowers the hall walls like the room walls
    markStatic(this.hallWalls, { zone: 'hall-walls', overviewLower: OFFICE.height });
    this.scene.add(this.hallWalls);
  }

  /** Every war room's own door onto the mission corridor (issue #123), the corridor's one
   * doorway back into the hall included. Shared by `rebuildMissionCorridor` and `wallColliders`
   * so the collision list can never drift from what the corridor's walls actually build. */
  private missionCorridorDoors(): Door[] {
    return [MISSION_CORRIDOR_DOOR, ...[...this.missionRooms.values()].map((room) => matchingDoor(room.slot))];
  }

  private rebuildMissionCorridor(): void {
    if (this.missionRooms.size === 0) return;
    if (this.missionCorridor) this.scene.remove(this.missionCorridor);
    const rect = missionCorridorRect(this.missionRooms.size);
    const group = new THREE.Group();
    group.name = 'mission-corridor';
    group.add(missionCorridorFloor(rect));
    const walls = buildWalls(rect, this.missionCorridorDoors());
    walls.name = 'room-walls';
    markCutaway(walls);
    group.add(walls);
    group.add(buildCeiling(rect));
    this.scene.add(group);
    this.missionCorridor = group;
  }

  /**
   * One-time migration (issue #191): today's single building's room list (the legacy bare
   * `BUILDING_STORAGE_KEY`) becomes the first specific floor ever focused, so none of a user's
   * already-grown rooms are lost once floors exist. `ALL_FLOORS` (`this.floor` unset) never
   * migrates: it keeps reading the legacy key directly, same as before floors existed — the
   * migration only matters the first time a user actually narrows to one floor. A marker key,
   * not a legacy-key scan, makes this run at most once ever, for whichever floor that first is;
   * a floor that already has its own room list is never overwritten, and the legacy key itself
   * is left behind, read but never deleted or rewritten (review: a dual-read path was explicitly
   * ruled out by the design, but "leave the key behind" still means never touching it).
   *
   * Not covered (issue #191 review, documented rather than fixed): a floor renamed after a user
   * already grew its room list there — the remote-naming revision renamed every repo with a
   * remote, `projects/agents-office` to `gabriel-amyot/agents-office` for example — has no
   * migration from the old `floorStorageKey` to the new one. The client never sees a repo's raw
   * directory path (S4), so it has no way to recompute what the old parent-dir-qualified name
   * would have been from the new one; only the server, which resolved both, could have made
   * that link, and it only ever hands the client the final name. A renamed floor's grown rooms
   * (beyond office and library) regrow from scratch under the new name, the same cold-start
   * experience a floor gets the first time it is ever focused.
   */
  private migrateLegacyRooms(): void {
    if (this.floor === undefined) return;
    try {
      if (this.storage?.getItem(ROOMS_MIGRATED_KEY)) return;
      const legacy = this.storage?.getItem(BUILDING_STORAGE_KEY);
      const already = this.storage?.getItem(floorStorageKey(this.floor));
      if (legacy && !already) this.storage?.setItem(floorStorageKey(this.floor), legacy);
      this.storage?.setItem(ROOMS_MIGRATED_KEY, this.floor);
    } catch {
      // Storage full or blocked: the building still works for this page, just without migrated rooms
    }
  }

  /**
   * Remembered rooms, one kind each, the office always first. A `kind@<tag>` entry is a
   * retired per-workspace desk room (roadmap item 20, superseded by floors, #118): it is
   * dropped, without error, and its sessions resettle in the shared pool.
   *
   * The office is Gabriel's lobby, not this floor's own room (issue #192: he has one office,
   * never one per floor) — every floor's own stored list keeps it anyway, for the same reason
   * every floor's building keeps rebuilding it at index 0, but a malformed or pre-office
   * stored list must never leave it out: `addRoom` only ever runs for what this returns, so
   * this is the one place "the office always renders" actually has to hold.
   */
  private rememberedRooms(): RoomKind[] {
    let stored: RoomKind[];
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(floorStorageKey(this.floor)) ?? '[]');
      const kinds = Object.keys(ROOM_STATION_TYPE);
      stored = !Array.isArray(parsed) ? [] : parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 200)
        .filter((entry) => !entry.includes('@'))
        .filter((kind): kind is RoomKind => kinds.includes(kind));
    } catch {
      stored = [];
    }
    return stored[0] === 'office' ? stored : ['office', ...stored.filter((kind) => kind !== 'office')];
  }

  private saveRooms(): void {
    try {
      this.storage?.setItem(floorStorageKey(this.floor), JSON.stringify(this.rooms.map((room) => room.kind)));
    } catch {
      // Storage full or blocked: the building still works for this page
    }
  }

  /** A remembered peak for one mission id, read back when that room is (re)built. A
   * malformed or missing entry is treated the same as no history: start at zero. */
  private rememberedMissionCounts(roomId: string): WarRoomCounts | undefined {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(MISSION_COUNTS_STORAGE_KEY) ?? '{}');
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const entry = (parsed as Record<string, unknown>)[roomId];
      if (typeof entry !== 'object' || entry === null) return undefined;
      const { deskLike, debugging } = entry as Record<string, unknown>;
      if (typeof deskLike !== 'number' || typeof debugging !== 'number') return undefined;
      return { deskLike, debugging };
    } catch {
      return undefined;
    }
  }

  private saveMissionCounts(): void {
    try {
      const byRoomId = Object.fromEntries([...this.missionRooms].map(([id, room]) => [id, room.peakCounts]));
      this.storage?.setItem(MISSION_COUNTS_STORAGE_KEY, JSON.stringify(byRoomId));
    } catch {
      // Storage full or blocked: the building still works for this page
    }
  }
}

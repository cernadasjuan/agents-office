import type * as THREE from 'three';
import type { Activity } from '../agents/ActivityAnimations.js';
import type { AgentExtras } from '../agents/AgentData.js';

/** A place where one agent stands or sits, and the point it faces. */
export interface Seat {
  key: string;
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
  /**
   * Force a body posture at this seat. A sofa seats every agent; an open-floor
   * spot has no chair, so every agent stands. Without it, the activity decides.
   */
  posture?: Posture;
}

export type Posture = 'seated' | 'standing';

/**
 * Where a camera should go to show a named room (issue #89, `#room=`): the room's world
 * bounds, for a view from above, and a first-person standing pose inside it, facing its main
 * wall. A layout with no rooms (the original activity layout) implements no `roomView`.
 */
export interface RoomView {
  bounds: THREE.Box3;
  standing: { position: THREE.Vector3; lookAt: THREE.Vector3 };
}

/** A seat change the layout decides on its own, applied by the manager. */
export interface LayoutMove {
  agentId: string;
  seat: Seat;
}

/** What a layout knows about an agent when it chooses a seat. */
export interface LayoutAgent {
  id: string;
  activity: Activity;
  extras?: AgentExtras;
  /** The caller (`AgentManager`) always passes the full `AgentInfo`, which has a name; declared
   * optional here only because a layout's own seat-choosing logic has never needed it before
   * issue #223's display wall, which reads it off the same object `BuildingLayout` already
   * tracks per agent, rather than carry a second, parallel agent list just for a name. */
  name?: string;
}

/**
 * A layout decides where each agent goes. The manager asks it for a seat when an
 * agent arrives and when its activity changes, and tells it when an agent leaves.
 */
export interface LayoutStrategy {
  readonly id: string;
  /**
   * The seat for the agent's current activity. `previous` is the activity before
   * the change, or null for a new agent. When only the extras changed (attention,
   * room, group), `previous` equals the current activity. Return null to keep the
   * current seat.
   * A new agent always gets a seat.
   */
  seatFor(agent: LayoutAgent, previous: Activity | null): Seat | null;
  /** Free the seat of an agent that left. */
  release(agentId: string): void;
  /**
   * Optional per-frame hook. A layout can return moves that do not come from an
   * activity change: a trip that starts after a dwell time, a queue that moves up.
   */
  update?(elapsed: number, delta: number): LayoutMove[] | void;
  /** Where the camera should go to show a named room (issue #89, `#room=`), or null when the name matches no room. */
  roomView?(name: string): RoomView | null;
  /**
   * Where the fixed desk-view camera sits (issue #161, key `H`), or null without a desk. `fov`
   * (issue #199) is optional — a layout that omits it keeps the shared camera's normal lens,
   * the old behavior (graceful degradation).
   */
  deskView?(): { position: THREE.Vector3; lookAt: THREE.Vector3; fov?: number } | null;
  /** The room whose floor contains this world point (issue #175, double-click a room in isometric), or null between rooms. */
  roomAt?(x: number, z: number): RoomView | null;
  /** World corners of each desk monitor's face, left then right (issue #161 review, defect 4): lets the label declutter keep queued labels clear of them in desk mode. */
  deskMonitorCorners?(): THREE.Vector3[][];
  /** Where a selected queued agent walks to address Gabriel directly (issue #162, desk mode only), or null without a desk. */
  deskTalkSpot?(): Seat | null;
  /** Whether this agent currently queues in front of the user's own desk — the only agents eligible for `deskTalkSpot` (issue #162). */
  isQueued?(agentId: string): boolean;
  /**
   * Every wall in the layout, as a flat 2D collision list (issue #194), for first-person
   * ground-walk. Without it (the original activity layout implements no `wallColliders`),
   * `FreeCamera` keeps the old, unobstructed walk — the same graceful degradation as every
   * other optional method here.
   */
  wallColliders?(): WallRect[];
}

/** A wall's 2D floor footprint, world space (issue #194). The same shape `FreeCamera`'s own `WallRect` and `BuildingLayout`'s `wallRects` use; kept here too so a layout can implement `wallColliders` without importing an addon module. */
export interface WallRect { minX: number; maxX: number; minZ: number; maxZ: number }

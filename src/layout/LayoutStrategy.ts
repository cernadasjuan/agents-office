import type * as THREE from 'three';
import type { Activity } from '../agents/ActivityAnimations.js';

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

/** What a layout knows about an agent when it chooses a seat. */
export interface LayoutAgent {
  id: string;
  parentId?: string;
  activity: Activity;
}

/**
 * A layout decides where each agent goes. The manager asks it for a seat when an
 * agent arrives and when its activity changes, and tells it when an agent leaves.
 */
export interface LayoutStrategy {
  readonly id: string;
  /**
   * The seat for the agent's current activity. `previous` is the activity before
   * the change, or null for a new agent. Return null to keep the current seat.
   * A new agent always gets a seat.
   */
  seatFor(agent: LayoutAgent, previous: Activity | null): Seat | null;
  /** Free the seat of an agent that left. */
  release(agentId: string): void;
  /** Optional per-frame hook, for layouts that animate their own scenery. */
  update?(elapsed: number, delta: number): void;
}

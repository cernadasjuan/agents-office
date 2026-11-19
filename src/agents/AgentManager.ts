import * as THREE from 'three';
import { StickFigure } from '../characters/StickFigure.js';
import { AgentExtras, AgentInfo } from './AgentData.js';
import { Activity } from './ActivityAnimations.js';
import { Station } from '../scene/Office.js';
import { Colors } from '../utils/Colors.js';
import { ActivityLayout } from '../layout/ActivityLayout.js';
import type { LayoutStrategy, Seat } from '../layout/LayoutStrategy.js';
import { isAnimationAsleep } from '../scene/AnimationSleep.js';

// FNV-1a hash of the agent ID, so an agent keeps its color across polls and reloads
function accentColorFor(agentId: string): THREE.Color {
  let hash = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    hash ^= agentId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Colors.accents[(hash >>> 0) % Colors.accents.length];
}

const SUBAGENT_SCALE = 0.85;
/** A figure this close to its seat has arrived (StickFigure snaps at 0.05). */
const ARRIVED_SQUARED = 0.05 * 0.05;

export interface ManagedAgent {
  info: AgentInfo;
  figure: StickFigure;
  seat: Seat | null;
}

/**
 * Owns the figures. Where each figure goes is the layout's decision: the
 * manager asks the layout for a seat and moves the figure there.
 */
export class AgentManager {
  private agents = new Map<string, ManagedAgent>();
  private scene: THREE.Scene;
  readonly layout: LayoutStrategy;

  constructor(scene: THREE.Scene, layout: LayoutStrategy | Map<string, Station>) {
    this.scene = scene;
    this.layout = layout instanceof Map ? new ActivityLayout(layout) : layout;
  }

  addAgent(info: AgentInfo): StickFigure {
    // A subagent wears its parent's color and stands a little smaller, so you see whose helper it is
    const parentId = info.extras?.parentId;
    const figure = new StickFigure(info.name, accentColorFor(parentId ?? info.id));
    if (parentId) figure.group.scale.setScalar(SUBAGENT_SCALE);
    figure.setTag(info.extras?.provider);
    const managed: ManagedAgent = { info, figure, seat: null };
    this.agents.set(info.id, managed);
    this.scene.add(figure.group);

    // A new agent appears at its seat (no walk from the origin)
    this.goToSeat(managed, this.layout.seatFor(info, null), true);
    figure.setActivity(info.activity);
    figure.setAttention(info.extras?.attention, info.extras?.waitMinutes);
    return figure;
  }

  setActivity(agentId: string, activity: Activity): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    const previous = managed.info.activity;
    managed.info.activity = activity;
    const seat = this.layout.seatFor(managed.info, previous);
    if (seat) this.goToSeat(managed, seat, false);
    managed.figure.setActivity(activity);
  }

  /** New display data from plugins. The layout may move the agent (for example to a room). */
  setExtras(agentId: string, extras: AgentExtras | undefined): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;
    managed.info.extras = extras;
    managed.figure.setTag(extras?.provider);
    managed.figure.setAttention(extras?.attention, extras?.waitMinutes);
    const seat = this.layout.seatFor(managed.info, managed.info.activity);
    if (seat) this.goToSeat(managed, seat, false);
  }

  update(elapsed: number, delta: number): void {
    for (const move of this.layout.update?.(elapsed, delta) ?? []) {
      const managed = this.agents.get(move.agentId);
      if (managed) this.goToSeat(managed, move.seat, false);
    }
    for (const managed of this.agents.values()) {
      // Out of view or far: no idle animation, but a walk goes on
      if (isAnimationAsleep(managed.figure.group) && !this.isWalking(managed)) continue;
      managed.figure.update(elapsed, delta);
    }
  }

  private isWalking(managed: ManagedAgent): boolean {
    return managed.seat !== null && managed.figure.group.position.distanceToSquared(managed.seat.position) > ARRIVED_SQUARED;
  }

  removeAgent(agentId: string): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    this.layout.release(agentId);
    this.scene.remove(managed.figure.group);
    managed.figure.dispose();
    this.agents.delete(agentId);
  }

  getAgents(): ManagedAgent[] {
    return Array.from(this.agents.values());
  }

  private goToSeat(managed: ManagedAgent, seat: Seat | null, teleport: boolean): void {
    if (!seat) return;
    managed.seat = seat;
    managed.figure.setPosture(seat.posture);
    if (teleport) managed.figure.teleportTo(seat.position, seat.lookAt);
    else managed.figure.moveTo(seat.position, seat.lookAt);
  }
}

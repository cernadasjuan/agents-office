import * as THREE from 'three';
import { StickFigure } from '../characters/StickFigure.js';
import { AgentExtras, AgentInfo, shortAgentId } from './AgentData.js';
import { Activity } from './ActivityAnimations.js';
import { Station } from '../scene/Office.js';
import { Colors } from '../utils/Colors.js';
import { ActivityLayout } from '../layout/ActivityLayout.js';
import type { LayoutStrategy, Seat } from '../layout/LayoutStrategy.js';
import { isAnimationAsleep } from '../scene/AnimationSleep.js';

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// FNV-1a hash of the agent ID, so an agent keeps its color across polls and reloads
function accentColorFor(agentId: string): THREE.Color {
  return Colors.accents[fnv1a(agentId) % Colors.accents.length];
}

/**
 * A mission's own 2 colors (issue #125 part 3), the same idea as a subagent
 * wearing its parent's color: every agent and subagent of a mission wears that
 * mission's pair, in every view, not only inside its war room. Seeded by
 * `roomKey` (the mission's own public room id, already stable per mission), so
 * the same mission always picks the same pair. Drawn only from `Colors.accents`
 * (never a new hex): the figure batch already paid for these materials.
 */
function missionColorsFor(roomKey: string): [THREE.Color, THREE.Color] {
  const [a, b] = Colors.missionPalettes[fnv1a(roomKey) % Colors.missionPalettes.length];
  return [Colors.accents[a], Colors.accents[b]];
}

const SUBAGENT_SCALE = 0.85;

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
  /** The pose a sleeping figure last settled into. */
  private settledPose = new WeakMap<ManagedAgent, string>();
  private scene: THREE.Scene;
  readonly layout: LayoutStrategy;
  /**
   * The one agent visually walked up to the desk's talk spot (issue #162), and the real seat
   * to walk it back to once it stops. A visual stand-in only: `realSeat` is what the layout
   * still tracks as occupied the whole time, so nothing here ever double-books a station.
   */
  private talker: { agentId: string; realSeat: Seat } | null = null;

  constructor(scene: THREE.Scene, layout: LayoutStrategy | Map<string, Station>) {
    this.scene = scene;
    this.layout = layout instanceof Map ? new ActivityLayout(layout) : layout;
  }

  addAgent(info: AgentInfo): StickFigure {
    // A subagent wears its parent's color and stands a little smaller, so you see whose helper it is.
    // A mission agent (and its subagents) wears that mission's own 2 colors instead (issue #125).
    const parentId = info.extras?.parentId;
    const [accent, second] = this.colorsFor(info);
    const figure = new StickFigure(info.name, accent, second);
    // A multiply, not a `setScalar` overwrite: the constructor already seeded a per-agent
    // x/z body width (issue #165 round 2); overwriting it would make every subagent the
    // same width regardless of name, losing the crowd-variety feature for that whole group.
    if (parentId) figure.group.scale.multiplyScalar(SUBAGENT_SCALE);
    figure.setSubagent(parentId !== undefined);
    figure.setTag(info.extras?.provider);
    figure.setId(shortAgentId(info.id));
    const managed: ManagedAgent = { info, figure, seat: null };
    this.agents.set(info.id, managed);
    this.scene.add(figure.group);

    // A new agent appears at its seat (no walk from the origin)
    this.goToSeat(managed, this.layout.seatFor(info, null), true);
    figure.setActivity(info.activity);
    figure.setAttention(info.extras?.attention, info.extras?.waitMinutes, info.extras?.orchestrating);
    figure.setStuck(info.extras?.stuck === true);
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

  /**
   * Which 2 colors a figure wears: a mission's own pair if its `extras.room` names one,
   * else the plain per-agent-id accent and no second color. `room` can arrive after
   * `addAgent` (issue #125 part 3 review round 2: a mission's own enricher attaches
   * `roomKey` to a session's extras as it scans the transcript, not always at the agent's
   * first appearance), so `setExtras` recomputes this the same way, every time.
   */
  private colorsFor(info: AgentInfo): [THREE.Color, THREE.Color | undefined] {
    const mission = info.extras?.room ? missionColorsFor(info.extras.room) : undefined;
    return [mission?.[0] ?? accentColorFor(info.extras?.parentId ?? info.id), mission?.[1]];
  }

  /** New display data from plugins. The layout may move the agent (for example to a room). */
  setExtras(agentId: string, extras: AgentExtras | undefined): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;
    managed.info.extras = extras;
    const [accent, second] = this.colorsFor(managed.info);
    managed.figure.setAccentColor(accent, second);
    managed.figure.setSubagent(extras?.parentId !== undefined);
    managed.figure.setTag(extras?.provider);
    managed.figure.setAttention(extras?.attention, extras?.waitMinutes, extras?.orchestrating);
    managed.figure.setStuck(extras?.stuck === true);
    const seat = this.layout.seatFor(managed.info, managed.info.activity);
    if (seat) this.goToSeat(managed, seat, false);
  }

  update(elapsed: number, delta: number): void {
    for (const move of this.layout.update?.(elapsed, delta) ?? []) {
      // Issue #162: the talker's true seat still moves with the queue (and keeps the layout's
      // own occupancy correct), but the figure itself stays put at the desk until deselected —
      // applying this move now would walk it back into line mid-conversation.
      if (this.talker?.agentId === move.agentId) {
        this.talker.realSeat = move.seat;
        continue;
      }
      const managed = this.agents.get(move.agentId);
      if (managed) this.goToSeat(managed, move.seat, false);
    }
    for (const managed of this.agents.values()) {
      const figure = managed.figure;
      if (!isAnimationAsleep(figure.group)) {
        this.settledPose.delete(managed);
        figure.update(elapsed, delta);
        continue;
      }
      // Out of view or far: a walk goes on to its arrival snap and turn
      if (figure.walking) {
        this.settledPose.delete(managed);
        figure.update(elapsed, delta);
        if (figure.walking) continue;
      }
      // No sway, but each new pose (activity, posture, raised hand) shows at once
      if (this.settledPose.get(managed) === figure.poseKey) continue;
      figure.settle(elapsed);
      this.settledPose.set(managed, figure.poseKey);
    }
  }

  /**
   * Issue #162: walk the one selected queued agent to the front of the desk, as if addressing
   * Gabriel, and walk back whoever was there before. A null id (deselected, left desk mode, or
   * a selection that is not a queued agent) just releases the previous talker, if there was
   * one. A visual stand-in only, the brief's own words: it never changes what the layout
   * tracks for any agent, so a reload or a queue reorder mid-conversation still lands the
   * real seat correctly once the agent walks back to it.
   */
  setDeskTalker(agentId: string | null): void {
    if (this.talker && this.talker.agentId !== agentId) {
      const previous = this.agents.get(this.talker.agentId);
      if (previous) this.goToSeat(previous, this.talker.realSeat, false);
      this.talker = null;
    }
    if (!agentId || this.talker) return;
    const managed = this.agents.get(agentId);
    const spot = this.layout.deskTalkSpot?.();
    if (!managed?.seat || !spot || !(this.layout.isQueued?.(agentId) ?? false)) return;
    this.talker = { agentId, realSeat: managed.seat };
    this.goToSeat(managed, spot, false);
  }

  removeAgent(agentId: string): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;
    if (this.talker?.agentId === agentId) this.talker = null;

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

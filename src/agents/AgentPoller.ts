import { AgentManager } from './AgentManager.js';
import { AgentExtras, AgentInfo } from './AgentData.js';
import type { Activity } from './ActivityAnimations.js';
import { GENERAL_FLOOR } from '../floors/FloorRegistry.js';
import { queuesForYou } from '../ui/attention.js';

export interface DetectedAgent extends AgentExtras {
  id: string;
  name: string;
  activity: string;
}

/**
 * Every optional field `projectAgents` (server/seam.ts) can put on a live agent. A key the
 * server can emit but this array omits is silently dropped here — no client code ever sees it,
 * however correctly the server projects it (the third time this exact bug has shipped: skills,
 * then orchestrating). `tests/poller.test.ts` guards this by comparing against a real
 * `projectAgents` call with every field set, so a future field fails in CI instead of only in
 * the office.
 */
export const EXTRA_KEYS: Array<keyof AgentExtras> = ['parentId', 'provider', 'attention', 'orchestrating', 'waitMinutes', 'group', 'badges', 'skills', 'tools', 'lastEquipSource', 'issues', 'room', 'role', 'actions', 'stuck', 'floor'];

/** The optional fields the server sent, or undefined when there are none. */
function extrasOf(agent: DetectedAgent): AgentExtras | undefined {
  const extras: Record<string, unknown> = {};
  for (const key of EXTRA_KEYS) if (agent[key] !== undefined) extras[key] = agent[key];
  return Object.keys(extras).length > 0 ? (extras as AgentExtras) : undefined;
}

const POLL_TIMEOUT_MS = 5000;

/** How the polls go: the first answer arrived, the time of the last good answer, failed polls in a row. */
export interface PollHealth {
  loaded: boolean;
  lastSuccessAt: number | null;
  failures: number;
}

export class AgentPoller {
  private agentManager: AgentManager;
  private intervalId: number | null = null;
  private knownIds = new Set<string>();
  private onUpdate: (() => void) | null = null;
  private onHealth: ((health: PollHealth) => void) | null = null;
  private onAgents: ((agents: DetectedAgent[]) => void) | null = null;
  private pollInFlight = false;
  private health: PollHealth = { loaded: false, lastSuccessAt: null, failures: 0 };

  /**
   * `focusFloor` (issue #118 AC4, lazy render): when set, only an agent on that floor is
   * added or kept. An agent with no `extras.floor` (an old server, or floors inactive) is
   * treated as the shared general floor, never silently dropped. Unset (the default, and
   * every layout that is not floor-aware): no filter, every agent shows, the old behavior.
   *
   * One carve-out (issue #192): an agent that queues for Gabriel keeps showing even from
   * another floor. Gabriel has one office, not one per floor — it is the lobby's own queue,
   * not that agent's own floor, so the floor filter must never be the thing that makes a
   * waiting agent invisible. `queuesForYou` is the same predicate the building's own physical
   * queue and the triage panel's groups already use, so a session counts as "in the queue"
   * exactly once, not by a second, slightly different rule here.
   */
  constructor(agentManager: AgentManager, private now: () => number = () => Date.now(), private focusFloor?: string) {
    this.agentManager = agentManager;
  }

  get pollHealth(): PollHealth {
    return { ...this.health };
  }

  /**
   * `onHealth` runs after every finished poll, good or failed. `onAgents` (issue #118),
   * when given, runs after every good poll with the raw, unfiltered answer: the floor
   * switch menu needs every floor with a tracked session, not only the focused one.
   */
  start(intervalMs = 3000, onUpdate?: () => void, onHealth?: (health: PollHealth) => void, onAgents?: (agents: DetectedAgent[]) => void): void {
    this.onUpdate = onUpdate ?? null;
    this.onHealth = onHealth ?? null;
    this.onAgents = onAgents ?? null;
    this.poll();
    this.intervalId = window.setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const res = await fetch('/api/agents', { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error('malformed agents response: expected an array');
      const agents = body as DetectedAgent[];

      // Mark the poll a success only once reconcile has accepted the body, so a
      // malformed 200 never resets the failure count, and a later good answer
      // still counts as the first one.
      const firstAnswer = !this.health.loaded;
      this.reconcile(agents, firstAnswer);
      this.health = { loaded: true, lastSuccessAt: this.now(), failures: 0 };
    } catch (error) {
      // API not available, too slow or broken: keep the current state and count the failure
      console.debug('agent poll failed', error);
      this.health = { ...this.health, failures: this.health.failures + 1 };
    } finally {
      this.pollInFlight = false;
    }
    this.onHealth?.(this.pollHealth);
  }

  /** The first answer always counts as a change, so an empty office replaces the loading text. */
  private reconcile(rawAgents: DetectedAgent[], firstAnswer = false): void {
    this.onAgents?.(rawAgents);
    const agents = this.focusFloor === undefined
      ? rawAgents
      : rawAgents.filter((a) => (a.floor ?? GENERAL_FLOOR) === this.focusFloor || queuesForYou(a));
    const currentIds = new Set(agents.map((a) => a.id));
    let changed = firstAnswer;

    // Add new agents
    for (const agent of agents) {
      if (!this.knownIds.has(agent.id)) {
        const displayName = agent.parentId
          ? `>> ${agent.name}`
          : agent.name;
        const extras = extrasOf(agent);
        const info: AgentInfo = {
          id: agent.id,
          name: displayName,
          activity: agent.activity as Activity,
          ...(extras ? { extras } : {}),
        };
        this.agentManager.addAgent(info);
        this.knownIds.add(agent.id);
        changed = true;
      } else {
        // Update activity if changed
        const managed = this.agentManager
          .getAgents()
          .find((a) => a.info.id === agent.id);
        if (managed && managed.info.activity !== agent.activity) {
          this.agentManager.setActivity(agent.id, agent.activity as Activity);
          changed = true;
        }
        const extras = extrasOf(agent);
        if (managed && JSON.stringify(managed.info.extras) !== JSON.stringify(extras)) {
          this.agentManager.setExtras(agent.id, extras);
          changed = true;
        }
      }
    }

    // Remove agents that disappeared
    for (const knownId of this.knownIds) {
      if (!currentIds.has(knownId)) {
        this.agentManager.removeAgent(knownId);
        this.knownIds.delete(knownId);
        changed = true;
      }
    }

    if (changed && this.onUpdate) {
      this.onUpdate();
    }
  }
}

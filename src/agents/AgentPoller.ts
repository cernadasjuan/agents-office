import { AgentManager } from './AgentManager.js';
import { AgentInfo } from './AgentData.js';
import type { Activity } from './ActivityAnimations.js';

interface DetectedAgent {
  id: string;
  name: string;
  activity: string;
  parentId?: string;
}

const POLL_TIMEOUT_MS = 5000;

export class AgentPoller {
  private agentManager: AgentManager;
  private intervalId: number | null = null;
  private knownIds = new Set<string>();
  private onUpdate: (() => void) | null = null;
  private pollInFlight = false;

  constructor(agentManager: AgentManager) {
    this.agentManager = agentManager;
  }

  start(intervalMs = 3000, onUpdate?: () => void): void {
    this.onUpdate = onUpdate ?? null;
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

      const agents: DetectedAgent[] = await res.json();
      this.reconcile(agents);
    } catch {
      // API not available or too slow: keep the current state
    } finally {
      this.pollInFlight = false;
    }
  }

  private reconcile(agents: DetectedAgent[]): void {
    const currentIds = new Set(agents.map((a) => a.id));
    let changed = false;

    // Add new agents
    for (const agent of agents) {
      if (!this.knownIds.has(agent.id)) {
        const displayName = agent.parentId
          ? `>> ${agent.name}`
          : agent.name;
        const info: AgentInfo = {
          id: agent.id,
          name: displayName,
          activity: agent.activity as Activity,
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

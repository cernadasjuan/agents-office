import { AgentManager } from './AgentManager.js';
import { AgentInfo, getMockAgents } from './AgentData.js';
import type { Activity } from './ActivityAnimations.js';

interface DetectedAgent {
  id: string;
  name: string;
  pid: number;
  cwd: string;
  startedAt: number;
  alive: boolean;
  activity: string;
  lastCommand?: string;
}

export class AgentPoller {
  private agentManager: AgentManager;
  private intervalId: number | null = null;
  private knownIds = new Set<string>();
  private onUpdate: (() => void) | null = null;
  private usedMockFallback = false;

  constructor(agentManager: AgentManager) {
    this.agentManager = agentManager;
  }

  start(intervalMs = 3000, onUpdate?: () => void): void {
    this.onUpdate = onUpdate ?? null;
    this.poll(); // immediate first poll
    this.intervalId = window.setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const agents: DetectedAgent[] = await res.json();

      // If real agents found, remove mock fallback if it was used
      if (agents.length > 0 && this.usedMockFallback) {
        this.removeMockAgents();
        this.usedMockFallback = false;
      }

      // If no real agents and no agents at all, use mock fallback
      if (agents.length === 0 && this.knownIds.size === 0) {
        this.loadMockFallback();
        return;
      }

      this.reconcile(agents);
    } catch {
      // API not available — use mock fallback if no agents
      if (this.knownIds.size === 0) {
        this.loadMockFallback();
      }
    }
  }

  private reconcile(agents: DetectedAgent[]): void {
    const currentIds = new Set(agents.map((a) => a.id));
    let changed = false;

    // Add new agents
    for (const agent of agents) {
      if (!this.knownIds.has(agent.id)) {
        const info: AgentInfo = {
          id: agent.id,
          name: agent.name,
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

  private loadMockFallback(): void {
    const mocks = getMockAgents();
    for (const mock of mocks) {
      if (!this.knownIds.has(mock.id)) {
        this.agentManager.addAgent(mock);
        this.knownIds.add(mock.id);
      }
    }
    this.usedMockFallback = true;
    if (this.onUpdate) this.onUpdate();
  }

  private removeMockAgents(): void {
    const mockIds = getMockAgents().map((m) => m.id);
    for (const id of mockIds) {
      if (this.knownIds.has(id)) {
        this.agentManager.removeAgent(id);
        this.knownIds.delete(id);
      }
    }
  }
}

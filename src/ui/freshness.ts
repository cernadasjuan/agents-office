import type { PollHealth } from '../agents/AgentPoller.js';

/** Failed polls in a row before the footer turns amber, then red. Change the thresholds here. */
export const FRESHNESS = { warnAfterFailures: 2, downAfterFailures: 5 } as const;

export type FreshnessLevel = 'loading' | 'ok' | 'warn' | 'down';

const TICK_MS = 1000;

export function freshnessLevel(health: PollHealth): FreshnessLevel {
  // The failure count wins over "no success yet": a cold start that keeps
  // failing must turn amber, then red, not sit on "loading" until failure 5.
  if (health.failures >= FRESHNESS.downAfterFailures) return 'down';
  if (health.failures >= FRESHNESS.warnAfterFailures) return 'warn';
  if (health.lastSuccessAt === null) return 'loading';
  return 'ok';
}

/** The footer line: the age of the data, and what went wrong when the polls fail. */
export function freshnessText(health: PollHealth, now: number): string {
  const level = freshnessLevel(health);
  if (level === 'loading') return 'Loading agents…';
  if (health.lastSuccessAt === null) {
    return level === 'down' ? 'Server not reachable' : 'Loading agents… · retrying';
  }
  const age = formatAge(now - health.lastSuccessAt);
  if (level === 'down') return `Server not reachable · updated ${age} ago`;
  return `Updated ${age} ago${level === 'warn' ? ' · retrying' : ''}`;
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h`;
}

type Every = (callback: () => void, ms: number) => void;

/**
 * The panel footer: "Updated N s ago", amber after 2 failed polls, red with
 * "Server not reachable" after 5. It ticks once a second on its own, so the age
 * grows while the server is silent. It changes text only: no new frame renders.
 */
export class FreshnessFooter {
  private health: PollHealth = { loaded: false, lastSuccessAt: null, failures: 0 };

  constructor(
    private element: HTMLElement,
    private now: () => number = () => Date.now(),
    every: Every = (callback, ms) => window.setInterval(callback, ms),
  ) {
    this.refresh();
    every(() => this.refresh(), TICK_MS);
  }

  show(health: PollHealth): void {
    this.health = health;
    this.refresh();
  }

  private refresh(): void {
    const text = freshnessText(this.health, this.now());
    const level = freshnessLevel(this.health);
    if (this.element.textContent !== text) this.element.textContent = text;
    if (this.element.dataset.level !== level) this.element.dataset.level = level;
  }
}

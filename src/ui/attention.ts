import type { AgentExtras } from '../agents/AgentData.js';

const TITLE = 'Agents Office';

/**
 * Age bands of a wait for the user, in minutes: fresh under 15 min, aging up to
 * 24 h, cold from 24 h. Only a fresh wait calls for the user. Change the bands here.
 */
export const ATTENTION_BANDS = { freshUnderMinutes: 15, coldFromMinutes: 24 * 60 } as const;

export type AttentionBand = 'fresh' | 'aging' | 'cold';

export type Wait = Pick<AgentExtras, 'attention' | 'waitMinutes'> | undefined;

/** The band of a wait, or undefined without attention or without a wait time. */
export function attentionBand(wait: Wait): AttentionBand | undefined {
  if (wait?.attention === undefined || wait.waitMinutes === undefined) return undefined;
  if (wait.waitMinutes < ATTENTION_BANDS.freshUnderMinutes) return 'fresh';
  return wait.waitMinutes < ATTENTION_BANDS.coldFromMinutes ? 'aging' : 'cold';
}

/** Beacon and raised hand: a fresh wait. Without a wait time, a block only (the old behavior). */
export function callsForYou(wait: Wait): boolean {
  const band = attentionBand(wait);
  return band === undefined ? wait?.attention === 'waiting' : band === 'fresh';
}

/** A spot in the queue: a fresh or aging wait. Without a wait time, a block only (the old behavior). */
export function queuesForYou(wait: Wait): boolean {
  const band = attentionBand(wait);
  return band === undefined ? wait?.attention === 'waiting' : band !== 'cold';
}

/** The tab count: a fresh wait. Without a wait time, every wait (the old behavior). */
export function countsInTab(wait: Wait): boolean {
  const band = attentionBand(wait);
  return band === undefined ? wait?.attention !== undefined : band === 'fresh';
}

/** Queue order: fresh (or no wait time) before aging, then the longest wait first. */
export function compareWaits(a: Wait, b: Wait): number {
  const rank = (wait: Wait) => (attentionBand(wait) === 'aging' ? 1 : attentionBand(wait) === 'cold' ? 2 : 0);
  return rank(a) - rank(b) || (b?.waitMinutes ?? -1) - (a?.waitMinutes ?? -1);
}

/**
 * The agent with the longest fresh wait, or undefined without one. Shared by
 * the off-screen marker and the top-count click (#86), and meant for #85's
 * "next" key too: one helper for "which fresh wait comes first".
 */
export function oldestFreshWait<T extends { extras?: Wait }>(agents: T[]): T | undefined {
  let best: T | undefined;
  let bestMinutes = -1;
  for (const agent of agents) {
    if (attentionBand(agent.extras) !== 'fresh') continue;
    const minutes = agent.extras?.waitMinutes ?? 0;
    if (minutes > bestMinutes) {
      best = agent;
      bestMinutes = minutes;
    }
  }
  return best;
}

/** Browser tab title: blocked agents in parentheses, then agents whose turn is yours. */
export function tabTitle(blocked: number, yourTurn: number): string {
  const parts = [blocked > 0 ? `(${blocked})` : '', yourTurn > 0 ? `+${yourTurn}` : ''].filter(Boolean);
  return parts.length === 0 ? TITLE : `${parts.join(' ')}${yourTurn > 0 ? ' ·' : ''} ${TITLE}`;
}

/** The tab title for a list of agents: only the waits that count in the tab. */
export function tabTitleFor(waits: Wait[]): string {
  const counted = waits.filter(countsInTab);
  return tabTitle(counted.filter((w) => w!.attention === 'waiting').length, counted.filter((w) => w!.attention === 'your-turn').length);
}

/** The label line: the activity, then how long the agent has waited for the user. */
export function attentionLine(activityLabel: string, attention: string | undefined, waitMinutes: number | undefined): string {
  if (attention === 'waiting') return `Waiting for you${waitMinutes !== undefined ? ` · ${formatWait(waitMinutes)}` : ''}`;
  if (attention === 'your-turn') return `Your turn${waitMinutes !== undefined ? ` · ${formatWait(waitMinutes)}` : ''}`;
  return activityLabel;
}

export function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} d`;
}

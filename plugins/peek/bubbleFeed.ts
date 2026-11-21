/**
 * Speech-bubble scheduling (issue #81, SBE-2): pure state, no DOM and no scene. The browser
 * part (`client.ts`) feeds it `/api/bubbles` answers and asks it, every frame, which agents get
 * a bubble right now. Kept separate and pure for the same reason `LabelDeclutter.ts` is: the
 * priority rule and the rate limit are easy to get wrong, and a unit test should not need a
 * scene, a card or a network call to prove them.
 */

export interface BubbleEvent {
  kind: 'text' | 'tool';
  text: string;
}

export interface VisibleBubble extends BubbleEvent {
  agentId: string;
  /** 1 while fresh, easing to 0 over the last `BUBBLE_FADE_MS` of its life (AC1: "then fades"). */
  opacity: number;
}

/** AC1: 5 s life. */
export const BUBBLE_DURATION_MS = 5000;
/** The last stretch of the life that fades out, rather than cutting off abruptly. */
export const BUBBLE_FADE_MS = 1000;
/** AC3: at most one bubble shown per agent per 8 s, even if it writes faster. */
export const BUBBLE_RATE_LIMIT_MS = 8000;
/** AC2: at most 6 bubbles at once in the overview. */
export const BUBBLE_CAP = 6;

interface Entry extends BubbleEvent {
  agentId: string;
  shownAt: number;
}

export interface BubbleContext {
  now: number;
  /** AC2 priority 1: the selected agent's bubble always wins a cap slot. */
  selectedId: string | null;
  /** AC2 priority 2: agents with a fresh beacon ("hot attention", the same predicate the beacon
   * itself uses, `callsForYou` in `ui/attention.ts`). */
  hotIds: ReadonlySet<string>;
}

/**
 * Tracks the one live bubble per agent and picks the winners under the cap. `ingest` applies
 * the rate limit; `winners` applies the cap and the priority order and drops anything whose
 * 5 s life is over. Nothing here owns a timer: the caller decides when to call each method.
 */
export class BubbleScheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly lastShownAt = new Map<string, number>();

  /** One event per agent, from the latest `/api/bubbles` answer. The server already reports
   * only what is new since the last ask (`PeekReader.bubble`), so every entry here counts as
   * "just happened" — the rate limit below is the only thing standing between a burst of tool
   * calls and a burst of bubbles. */
  ingest(events: ReadonlyMap<string, BubbleEvent>, now: number): void {
    for (const [agentId, event] of events) {
      const last = this.lastShownAt.get(agentId);
      if (last !== undefined && now - last < BUBBLE_RATE_LIMIT_MS) continue;
      this.lastShownAt.set(agentId, now);
      this.entries.set(agentId, { agentId, kind: event.kind, text: event.text, shownAt: now });
    }
  }

  /** Drop any agent an `/api/agents` poll no longer reports: its bubble (and rate limit) must
   * not survive a reload of a long-gone session under a reused id. */
  forget(knownAgentIds: ReadonlySet<string>): void {
    for (const id of [...this.entries.keys()]) if (!knownAgentIds.has(id)) this.entries.delete(id);
    for (const id of [...this.lastShownAt.keys()]) if (!knownAgentIds.has(id)) this.lastShownAt.delete(id);
  }

  /** The agents to show right now, ranked and capped (AC2), each with a fade opacity (AC1).
   * Expired bubbles (AC1's 5 s) are pruned as a side effect, so this is the only method that
   * needs calling every frame to keep the feed current. */
  winners(context: BubbleContext): VisibleBubble[] {
    for (const [id, entry] of this.entries) if (context.now - entry.shownAt >= BUBBLE_DURATION_MS) this.entries.delete(id);
    const rank = (entry: Entry): number => {
      if (entry.agentId === context.selectedId) return 0;
      if (context.hotIds.has(entry.agentId)) return 1;
      return 2;
    };
    return [...this.entries.values()]
      .sort((a, b) => rank(a) - rank(b) || b.shownAt - a.shownAt)
      .slice(0, BUBBLE_CAP)
      .map((entry) => ({
        agentId: entry.agentId,
        kind: entry.kind,
        text: entry.text,
        opacity: Math.max(0, Math.min(1, (BUBBLE_DURATION_MS - (context.now - entry.shownAt)) / BUBBLE_FADE_MS)),
      }));
  }
}

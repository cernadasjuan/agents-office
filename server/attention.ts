import type { Enricher } from './seam.js';

/**
 * Built-in enricher: who needs the user. A waiting session is blocked on a
 * permission or an answer. An idle session finished its turn and waits for the
 * next prompt. Subagents never ask; their parent does. Without a status field,
 * nothing changes.
 *
 * `your-turn` has two different causes that look the same from the status field
 * alone: a session that truly has nothing to do, and an orchestrator whose own
 * subagents are still busy under it (issue #168). `detectSubagents` only ever
 * reports a subagent whose transcript is still active, so "any observation with
 * this agent as its `parentId`" already means "a subagent is running now" — no
 * extra activity check needed. `orchestrating` lets the raised-hand/beacon
 * signal and the figure's posture tell the two cases apart; it is never set for
 * `waiting` (a true block on the user keeps the raised hand regardless) and
 * never for a subagent itself (subagents never ask).
 */
export function attentionEnricher(now: () => number = Date.now): Enricher {
  return {
    id: 'attention',
    enrich(observations) {
      const parentIds = new Set(observations.map((agent) => agent.parentId).filter((id): id is string => id !== undefined));
      for (const agent of observations) {
        if (agent.parentId) continue;
        const attention = agent.status === 'waiting' ? 'waiting' : agent.status === 'idle' ? 'your-turn' : undefined;
        if (!attention) continue;
        agent.display.attention = attention;
        if (attention === 'your-turn' && parentIds.has(agent.id)) agent.display.orchestrating = true;
        if (agent.statusSince !== undefined && agent.statusSince <= now()) {
          agent.display.waitMinutes = Math.floor((now() - agent.statusSince) / 60_000);
        }
      }
    },
  };
}

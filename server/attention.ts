import type { Enricher } from './seam.js';

/**
 * Built-in enricher: who needs the user. A waiting session is blocked on a
 * permission or an answer. An idle session finished its turn and waits for the
 * next prompt. Subagents never ask; their parent does. Without a status field,
 * nothing changes.
 */
export function attentionEnricher(now: () => number = Date.now): Enricher {
  return {
    id: 'attention',
    enrich(observations) {
      for (const agent of observations) {
        if (agent.parentId) continue;
        const attention = agent.status === 'waiting' ? 'waiting' : agent.status === 'idle' ? 'your-turn' : undefined;
        if (!attention) continue;
        agent.display.attention = attention;
        if (agent.statusSince !== undefined && agent.statusSince <= now()) {
          agent.display.waitMinutes = Math.floor((now() - agent.statusSince) / 60_000);
        }
      }
    },
  };
}

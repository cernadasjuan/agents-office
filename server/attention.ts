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
 *
 * Known lag (accepted, not fixed here): `detectSubagents` (server/agentDetector.ts,
 * `ACTIVE_THRESHOLD`) still counts a subagent as active up to 30 s after its last
 * transcript write, the same staleness window every other "is this subagent still
 * running" read in this codebase already lives with. A parent can keep
 * `orchestrating` for up to that long after its last subagent actually finishes —
 * it shows hands on hips a little after it should show the raised hand again. No
 * cheap, more precise signal exists today (no subagent "finished" marker); fixing
 * this would mean changing `ACTIVE_THRESHOLD` itself, which every other active-
 * subagent read (seats, the card's subagent list, the figure count) also relies
 * on, so it is out of scope here.
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

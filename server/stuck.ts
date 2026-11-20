import fs from 'node:fs';
import type { Enricher } from './seam.js';
import { STUCK_AFTER_MINUTES } from '../src/ui/attention.js';

function defaultMtimeMs(transcriptPath: string): number | undefined {
  try {
    return fs.statSync(transcriptPath).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Built-in enricher: a session can stay busy with no progress, and today it
 * looks the same as a working one. Without a transcript write for
 * STUCK_AFTER_MINUTES, mark it stuck. Subagents never qualify; their parent
 * does. A session without a status, a transcript, or a write time keeps the
 * old behavior. Stateless: every poll recomputes it from the file's mtime, so
 * a session that writes again clears the mark on its own on the next poll.
 */
export function stuckEnricher(now: () => number = Date.now, mtimeMs: (path: string) => number | undefined = defaultMtimeMs): Enricher {
  return {
    id: 'stuck',
    enrich(observations) {
      for (const agent of observations) {
        if (agent.parentId) continue;
        if (agent.status !== 'busy') continue;
        const transcriptPath = agent.internal.transcriptPath;
        if (!transcriptPath) continue;
        const lastWriteAt = mtimeMs(transcriptPath);
        if (lastWriteAt === undefined) continue;
        if ((now() - lastWriteAt) / 60_000 >= STUCK_AFTER_MINUTES) agent.display.stuck = true;
      }
    },
  };
}

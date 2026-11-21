import fs from 'node:fs';
import path from 'node:path';
import type { Enricher } from './seam.js';

/** The shared floor every session with no resolvable repo lands on (issue #118 scope item 2). */
export const GENERAL_FLOOR = 'general';

const MAX_WALK_DEPTH = 40;
const MAX_CACHED_DIRS = 500;

/** Same token shape `server/seam.ts`'s `REPO_SHORT` whitelists: a floor name is always a short
 * repo name, or `GENERAL_FLOOR`, so it survives the projection boundary unchanged. */
const FLOOR_NAME = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * The main repository name from a worktree `.git` file (`gitdir: <main>/.git/worktrees/<name>`).
 * Duplicated from `plugins/peek/transcript.ts`'s own `worktreeMain` (same shape): a core
 * enricher must not import from an opt-in plugin, and the plugin must not import from core
 * for one helper either, so each keeps its own small copy.
 */
function worktreeMain(gitFile: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(gitFile, 'r');
    const buffer = Buffer.alloc(1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const gitdir = /^gitdir:\s*(.+)$/m.exec(buffer.subarray(0, bytes).toString('utf8'))?.[1].trim();
    const main = gitdir ? /^(.*)[\\/]\.git[\\/]worktrees[\\/]/.exec(gitdir)?.[1] : undefined;
    return main ? path.basename(main) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Resolves a working directory to the short name of the git repository that holds it (a
 * worktree maps to its main repository, the same rule `plugins/peek/transcript.ts`'s
 * `repoOf` uses), walking up at most `MAX_WALK_DEPTH` directories. A directory with no
 * repository, or whose name does not fit the whitelist, resolves to `GENERAL_FLOOR` (scope
 * item 2), never left undefined. Caches by directory, capped at `MAX_CACHED_DIRS` (cleared
 * wholesale past the cap, the same bound `PeekReader.repoByDir` uses) so a busy office does
 * not re-walk the filesystem for the same session on every 3 s poll.
 */
export class FloorResolver {
  private cache = new Map<string, string>();

  resolve(cwd: string | undefined): string {
    if (!cwd) return GENERAL_FLOOR;
    const cached = this.cache.get(cwd);
    if (cached !== undefined) return cached;
    const floor = this.resolveUncached(cwd);
    if (this.cache.size >= MAX_CACHED_DIRS) this.cache.clear();
    this.cache.set(cwd, floor);
    return floor;
  }

  private resolveUncached(cwd: string): string {
    let current = path.resolve(cwd);
    for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
      const git = path.join(current, '.git');
      try {
        const stat = fs.lstatSync(git);
        const name = stat.isFile() ? worktreeMain(git) ?? path.basename(current) : path.basename(current);
        return name !== '.' && name !== '..' && FLOOR_NAME.test(name) ? name : GENERAL_FLOOR;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return GENERAL_FLOOR;
        current = parent;
      }
    }
    return GENERAL_FLOOR;
  }
}

/**
 * Built-in enricher (issue #118 scope items 1-2): resolves every session's repo from its
 * own working directory and sets `display.floor`. Stateless like every enricher (P12): the
 * resolver's cache is a performance bound, not state the result depends on. A subagent
 * shares its parent's `internal.cwd` (`server/agentDetector.ts`'s `detectSubagents`), so it
 * always resolves to the same floor as its parent with no special case here. A missing
 * `internal.cwd` (an unusual source) lands on the general floor, never breaks the pipeline.
 */
export function floorEnricher(resolver: FloorResolver = new FloorResolver()): Enricher {
  return {
    id: 'floor',
    enrich(observations) {
      for (const agent of observations) agent.display.floor = resolver.resolve(agent.internal.cwd);
    },
  };
}

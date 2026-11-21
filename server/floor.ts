import fs from 'node:fs';
import path from 'node:path';
import type { Enricher } from './seam.js';

/** The shared floor every session with no resolvable repo lands on (issue #118 scope item 2). */
export const GENERAL_FLOOR = 'general';

const MAX_WALK_DEPTH = 40;
const MAX_CACHED_DIRS = 500;

/**
 * One floor-name segment: the same short token shape `server/seam.ts`'s `REPO_SHORT`
 * whitelists. A floor name is one segment (`GENERAL_FLOOR`, or a repo with no distinguishing
 * parent directory), or two segments joined by a slash — the repo's own immediate parent
 * directory name, then the repo name (review: two differently-rooted repos that happen to
 * share a leaf folder name, for example two separate `project-management` checkouts under
 * different organizations, must not collapse onto the same floor). Never `.` or `..`.
 */
const SEGMENT = /^[A-Za-z0-9_.-]{1,40}$/;

function validSegment(name: string): boolean {
  return name !== '.' && name !== '..' && SEGMENT.test(name);
}

/**
 * The main repository's own absolute directory from a worktree `.git` file
 * (`gitdir: <main>/.git/worktrees/<name>`, resolved against `worktreeDir` when the gitdir
 * value itself is relative, for example `../../.git/worktrees/x`). Returns the directory,
 * not its name, so the caller can still qualify it with its own parent directory. Duplicated
 * from `plugins/peek/transcript.ts`'s own `worktreeMain` (there it goes straight to a short
 * name, since the peek plugin has no floor-qualifying rule to apply): a core enricher must
 * not import from an opt-in plugin, and the plugin must not import from core for one helper
 * either, so each keeps its own small copy.
 */
function worktreeMainDir(gitFile: string, worktreeDir: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(gitFile, 'r');
    const buffer = Buffer.alloc(1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const gitdir = /^gitdir:\s*(.+)$/m.exec(buffer.subarray(0, bytes).toString('utf8'))?.[1].trim();
    if (!gitdir) return undefined;
    const absoluteGitdir = path.isAbsolute(gitdir) ? gitdir : path.resolve(worktreeDir, gitdir);
    const main = /^(.*)[\\/]\.git[\\/]worktrees[\\/]/.exec(absoluteGitdir)?.[1];
    return main || undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The `url = ...` value of a git config's `[remote "origin"]` section, or undefined without
 * one. A plain text scan, not an ini parser: finds the named section, then the first `url`
 * line inside it, stopping at the next `[section]` header (or the end of the file). */
function originUrl(configText: string): string | undefined {
  const section = /\[remote "origin"\]([\s\S]*?)(?=\n\s*\[|$)/.exec(configText);
  if (!section) return undefined;
  return /^\s*url\s*=\s*(.+)$/m.exec(section[1])?.[1].trim();
}

const SSH_REMOTE = /^[\w.-]+@[\w.-]+:(.+)$/;
const HTTP_REMOTE = /^https?:\/\/[^/]+\/(.+)$/;

/**
 * A remote URL's own owner/repo, Gabriel's own expectation for a floor name (review: a
 * filesystem accident like `projects/agents-office`, the repo's bare parent directory, is not
 * what he expects to see — the remote he actually pushes to is). GitHub (`owner/repo`) and a
 * GitLab group (`group/.../repo`, any subgroup depth) both reduce to the same two-segment
 * shape: the last path segment before the repo name, then the repo name itself, dropping any
 * deeper subgroup nesting as `matchesFloor`'s own trailing-segment fallback would anyway once a
 * tag has no owner to compare. Undefined when the URL does not parse into at least two
 * segments, or either segment fails the floor-name whitelist (never half a floor name).
 */
function ownerRepoFromRemote(url: string): string | undefined {
  const afterHost = SSH_REMOTE.exec(url)?.[1] ?? HTTP_REMOTE.exec(url)?.[1];
  if (!afterHost) return undefined;
  const segments = afterHost.replace(/\.git\/?$/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  const repo = segments[segments.length - 1];
  const owner = segments[segments.length - 2];
  return validSegment(owner) && validSegment(repo) ? `${owner}/${repo}` : undefined;
}

/** A repo directory's own remote owner/repo, read straight from its `.git/config` (never a
 * shell-out: `server/floor.ts` is core, not an opt-in plugin, and P-no-shell applies everywhere
 * here, not only inside a plugin). Undefined on any read or parse failure — a repo with no
 * `.git/config`, no `origin` remote, or an unparsable URL, falls back to the parent-dir
 * qualifier below, exactly as before this existed. */
function remoteOwnerRepo(repoDir: string): string | undefined {
  try {
    const url = originUrl(fs.readFileSync(path.join(repoDir, '.git', 'config'), 'utf8'));
    return url ? ownerRepoFromRemote(url) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A repository's own floor name: its remote `origin`'s own owner/repo when one resolves,
 * else its directory name, qualified by its immediate parent directory's name when that
 * parent exists and fits the whitelist too (review: the org separation fix). `GENERAL_FLOOR`
 * when the repo's own directory name itself does not fit the whitelist (never half a floor
 * name, and never a crash).
 */
function qualifiedFloorName(repoDir: string): string {
  const fromRemote = remoteOwnerRepo(repoDir);
  if (fromRemote) return fromRemote;
  const repoName = path.basename(repoDir);
  if (!validSegment(repoName)) return GENERAL_FLOOR;
  const parentDir = path.dirname(repoDir);
  const parentName = parentDir === repoDir ? '' : path.basename(parentDir);
  return parentName && validSegment(parentName) ? `${parentName}/${repoName}` : repoName;
}

/**
 * Resolves a working directory to the floor name of the git repository that holds it (a
 * worktree maps to its main repository), walking up at most `MAX_WALK_DEPTH` directories. A
 * relative `cwd` (review: never meaningful to resolve against the office server's own
 * working directory), a directory with no repository, or an unreadable or malformed
 * worktree `.git` file (review: never falls back to naming the worktree's own directory),
 * resolves to `GENERAL_FLOOR`, never left undefined. Caches by directory, capped at
 * `MAX_CACHED_DIRS` (cleared wholesale past the cap, the same bound `PeekReader.repoByDir`
 * uses) so a busy office does not re-walk the filesystem for the same session on every 3 s poll.
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
    if (!path.isAbsolute(cwd)) return GENERAL_FLOOR;
    let current = path.resolve(cwd);
    for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
      const git = path.join(current, '.git');
      try {
        const stat = fs.lstatSync(git);
        if (!stat.isFile()) return qualifiedFloorName(current);
        const mainDir = worktreeMainDir(git, current);
        return mainDir ? qualifiedFloorName(mainDir) : GENERAL_FLOOR;
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

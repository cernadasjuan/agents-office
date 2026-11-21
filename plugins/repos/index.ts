import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FloorResolver } from '../../server/floor.js';
import type { Enricher, Observation, OfficePlugin } from '../../server/seam.js';

/**
 * Repos plugin (issue #249). `server/floor.ts`'s own `floorEnricher` already sets
 * `display.repos` to a one-entry list, the session's own floor repo — the same, narrower
 * signal review-222 flagged against the older, async peek view's richer "every repo this
 * session touched" listing. A session often spans several repos at once (a worktree sibling
 * it edits by absolute path, or a `git` command run with an explicit directory): this adds
 * those, from the transcript, after the floor's own entry — same "bounded, incremental,
 * capped" shape `plugins/skills/index.ts` already established for its own transcript scan,
 * copied here rather than shared, the same core/plugin boundary `server/floor.ts`'s own
 * `worktreeMainDir` doc comment already draws ("a core enricher must not import from an
 * opt-in plugin, and the plugin must not import from core for one helper either").
 *
 * Only two signals count, both resolved through `FloorResolver.remoteOwnerRepoOf` — real
 * remotes only, never the floor's own directory-name fallback (this module's own doc comment
 * on that method says why): an `Edit`/`Write`/`NotebookEdit` tool call's own absolute file
 * path, and a `cd <dir>` (or `cd <dir> && ...`) that opens a `Bash` tool call. Reading a file,
 * or a `git`/`gh` call with no directory change, says nothing about which repo a session
 * touched that its own floor does not already say.
 */

const MAX_REPOS = 8;
const READ_CHUNK = 256 * 1024;
const MAX_BYTES_PER_POLL = 4 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
/** A `cd` target this short is already implausible as a real path; never worth resolving. */
const MAX_CD_ARG = 4096;

interface TranscriptState {
  offset: number;
  carry: string;
  skippingLongLine: boolean;
  decoder: TextDecoder;
  repos: string[];
}

function freshState(): TranscriptState {
  return { offset: 0, carry: '', skippingLongLine: false, decoder: new TextDecoder('utf-8'), repos: [] };
}

/** Keeps `value` at the end of `list` (newest last), adding it only the first time it appears — the same rule `plugins/skills/index.ts`'s own `remember` follows, so "newest" means "newest introduced", not "most recently repeated". */
function pushNewest(list: string[], value: string, max: number): void {
  if (list.includes(value)) return;
  list.push(value);
  if (list.length > max) list.shift();
}

/** `cd <dir>`, or `cd <dir> && <rest>`: the directory argument of a leading `cd`, unquoted, or undefined for any other leading command. Only the first simple command of the line counts — a `cd` buried after `&&`/`;` changed the directory for what follows it, not for the line's own first command, and matters no more here than it would for `plugins/skills`'s own single-command scan. */
function cdTarget(command: string): string | undefined {
  const first = command.slice(0, MAX_CD_ARG).split(/&&|\|\||;|\n/)[0]?.trim();
  if (!first) return undefined;
  const match = /^cd\s+(.+)$/.exec(first);
  if (!match) return undefined;
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function filePathOf(name: string, input: Record<string, unknown>): string | undefined {
  if (name !== 'Edit' && name !== 'Write' && name !== 'NotebookEdit') return undefined;
  const file = input.file_path ?? input.notebook_path;
  return typeof file === 'string' ? file : undefined;
}

/** A `cd` target as a real filesystem path: absolute as-is, `~` or `~/...` expanded against
 * the home directory (review #249 round 2 — a shell expands a leading `~` itself, so `cd
 * ~/Developer/other-repo` never sees `cwd` at all; resolving it against `cwd` instead, as
 * this used to, built the nonsense path `<cwd>/~/Developer/other-repo` and silently dropped
 * the real second repo), else resolved against `cwd` same as before. */
function resolveCdTarget(target: string, cwd: string | undefined): string {
  if (path.isAbsolute(target)) return target;
  if (target === '~' || target.startsWith('~/')) return path.join(os.homedir(), target.slice(1));
  return cwd ? path.resolve(cwd, target) : target;
}

function dirsIn(name: string, input: Record<string, unknown>, cwd: string | undefined): string[] {
  const dirs: string[] = [];
  const file = filePathOf(name, input);
  if (file && path.isAbsolute(file)) dirs.push(path.dirname(file));
  if (name === 'Bash' && typeof input.command === 'string') {
    const target = cdTarget(input.command);
    if (target) dirs.push(resolveCdTarget(target, cwd));
  }
  return dirs;
}

function takeLine(state: TranscriptState, line: string, cwd: string | undefined, resolver: FloorResolver): void {
  if (!line.includes('"tool_use"')) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const message = (entry as { message?: { role?: unknown; content?: unknown } })?.message;
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    for (const dir of dirsIn(block.name, input, cwd)) {
      const repo = resolver.remoteOwnerRepoOf(dir);
      if (repo) pushNewest(state.repos, repo, MAX_REPOS);
    }
  }
}

function takeLines(state: TranscriptState, text: string, cwd: string | undefined, resolver: FloorResolver): void {
  const parts = (state.carry + text).split('\n');
  state.carry = parts.pop() ?? '';
  for (const [index, line] of parts.entries()) {
    if (index === 0 && state.skippingLongLine) {
      state.skippingLongLine = false;
      continue;
    }
    takeLine(state, line, cwd, resolver);
  }
  if (state.carry.length > MAX_LINE) {
    state.carry = '';
    state.skippingLongLine = true;
  }
}

/** Read the bytes added since the last poll (up to a cap per poll) — identical shape to `plugins/skills/index.ts`'s own `readNewBytes`, kept as its own small copy for the same reason `server/floor.ts` keeps its own `worktreeMainDir`. */
function readNewBytes(transcriptPath: string, state: TranscriptState, cwd: string | undefined, resolver: FloorResolver): TranscriptState {
  let fd: number | undefined;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size < state.offset) state = freshState();
    const end = Math.min(size, state.offset + MAX_BYTES_PER_POLL);
    if (end <= state.offset) return state;
    fd = fs.openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(READ_CHUNK);
    while (state.offset < end) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(READ_CHUNK, end - state.offset), state.offset);
      if (bytesRead <= 0) break;
      state.offset += bytesRead;
      takeLines(state, state.decoder.decode(buffer.subarray(0, bytesRead), { stream: true }), cwd, resolver);
    }
    return state;
  } catch {
    return state;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function createReposEnricher(resolver: FloorResolver = new FloorResolver()): Enricher {
  const cache = new Map<string, TranscriptState>();
  return {
    id: 'repos-in-context',
    enrich(observations: Observation[]) {
      const seen = new Set<string>();
      for (const agent of observations) {
        const transcriptPath = agent.internal.transcriptPath;
        if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) continue;
        seen.add(transcriptPath);
        const state = readNewBytes(transcriptPath, cache.get(transcriptPath) ?? freshState(), agent.internal.cwd, resolver);
        cache.set(transcriptPath, state);
        if (state.repos.length === 0) continue;
        // The floor repo (set earlier in the enricher pipeline, `server/vitePlugin.ts`'s own
        // ordering) always stays first and is never evicted by the cap below — it is the
        // session's own primary repo, not an aging transcript find.
        const floorPart = Array.isArray(agent.display.repos) ? agent.display.repos.slice(0, 1) : [];
        const extra = state.repos.filter((repo) => !floorPart.includes(repo));
        const room = Math.max(MAX_REPOS - floorPart.length, 0);
        agent.display.repos = [...floorPart, ...extra.slice(-room)];
      }
      for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    },
  };
}

const plugin: OfficePlugin = { name: 'repos', enrichers: [createReposEnricher()] };
export default plugin;

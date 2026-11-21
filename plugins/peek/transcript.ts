import fs from 'node:fs';
import path from 'node:path';
import { displayText, type BubbleReply, type Observation, type PeekInput } from '../../server/seam.js';
import { lastWords, maskedLine } from '../../server/secrets.js';

/**
 * Peek reader: the last lines, the assets (links) and the equipment (skills,
 * repos) of one agent, from its own transcript. Only assistant text and tool
 * calls count. A tool call shows its name and a short safe summary, never its
 * raw input. Text collapses, then is masked, then cut (`maskedLine`), so a cut
 * never leaves part of a token.
 *
 * `BubbleTailReader` (below, issue #81) is a separate, lighter reader for speech bubbles:
 * review found that sharing this reader's own 20-file cache between "one selected agent,
 * changes rarely" (this class) and "every known agent, every 3 s" (bubbles) thrashed the
 * cache past ~20 live agents, re-reading full tails and re-emitting old lines as new bubbles.
 */

export const PEEK_MAX_LINES = 10;
/** The card's "Show 100 lines" tail (issue #81 AC5): the cache itself keeps this many lines,
 * so the tail is already warm the moment the button is pressed. */
export const PEEK_TAIL_LINES = 100;
export const PEEK_LINE_MAX = 200;
export const PEEK_MAX_ASSETS = 10;
/** A bubble's "last words" (issue #81 AC1, SBE-2: locked at 40 characters). */
export const BUBBLE_TEXT_MAX = 40;
const MAX_EQUIPMENT = 10;
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_BYTES_PER_READ = 4 * 1024 * 1024;
const READ_CHUNK = 256 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_INPUT_CHARS = 20_000;
const MAX_CACHED_FILES = 20;
const MAX_CACHED_DIRS = 500;

/** Jira sites by key prefix. The fork default; AGENTS_OFFICE_PEEK_JIRA overrides it. */
export const DEFAULT_JIRA_SITES: Readonly<Record<string, string>> = Object.freeze({
  KTP: 'https://beklever.atlassian.net/browse/',
  INS: 'https://beklever.atlassian.net/browse/',
  SPV: 'https://origin8cares.atlassian.net/browse/',
});

const JIRA_PREFIX = /^[A-Z][A-Z0-9]{1,9}$/;

/** `PREFIX=https://site/browse/,…` to a map. Invalid pairs are dropped. Unset: the default map. */
export function parseJiraSites(list: string | undefined): Record<string, string> {
  if (list === undefined) return { ...DEFAULT_JIRA_SITES };
  const sites: Record<string, string> = {};
  for (const pair of list.split(',')) {
    const [prefix, url] = pair.split('=').map((part) => part?.trim() ?? '');
    if (!JIRA_PREFIX.test(prefix) || !url) continue;
    try {
      if (new URL(url).protocol === 'https:') sites[prefix] = url.endsWith('/') ? url : `${url}/`;
    } catch {
      // not a URL: skip
    }
  }
  return sites;
}

type Line = PeekInput['lines'][number];
type Asset = PeekInput['assets'][number];

interface FileState {
  offset: number;
  carry: string;
  skipFirst: boolean;
  decoder: TextDecoder;
  lines: Line[];
  assets: Asset[];
  skills: string[];
  repos: string[];
}

function freshState(offset = 0): FileState {
  return { offset, carry: '', skipFirst: offset > 0, decoder: new TextDecoder('utf-8'), lines: [], assets: [], skills: [], repos: [] };
}

const TOKEN = /^[A-Za-z0-9:_.-]{1,64}$/;
const PROGRAM = /^[A-Za-z0-9._+-]{1,30}$/;
const SUBCOMMAND = /^[a-z][a-z0-9-]{0,20}$/;
const WITH_SUBCOMMAND = new Set(['git', 'gh', 'glab', 'npm', 'pnpm', 'yarn', 'npx', 'docker', 'kubectl', 'gcloud', 'cargo', 'go', 'make', 'uv', 'pip', 'brew', 'terraform']);
const GIT_WRITES = new Set(['commit', 'push', 'add', 'merge', 'rm', 'mv', 'am', 'apply', 'cherry-pick', 'revert']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function cleanText(value: string, max: number): string {
  return maskedLine(value, max);
}

function unquote(token: string): string {
  return token.replace(/^["']|["']$/g, '');
}

/** Simple commands of a shell line, each as tokens without leading VAR=value assignments. */
function simpleCommands(command: string): string[][] {
  return command.slice(0, MAX_INPUT_CHARS).split(/&&|\|\||;|\||\n/).map((segment) => {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    while (tokens.length > 0 && ENV_ASSIGNMENT.test(tokens[0])) tokens.shift();
    return tokens;
  }).filter((tokens) => tokens.length > 0);
}

/** The first argument that is not an option (skips `-C <dir>` and `-c <conf>` values). */
function subcommandOf(args: string[]): { sub?: string; dir?: string } {
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-C' || arg === '-c') {
      if (arg === '-C') dir = unquote(args[i + 1] ?? '');
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return { sub: SUBCOMMAND.test(arg) ? arg : undefined, dir };
  }
  return { dir };
}

function bashSummary(command: string): string {
  const first = simpleCommands(command)[0];
  if (!first) return 'Bash';
  const program = path.posix.basename(unquote(first[0]));
  if (!PROGRAM.test(program)) return 'Bash';
  const sub = WITH_SUBCOMMAND.has(program) ? subcommandOf(first.slice(1)).sub : undefined;
  return `Bash · ${program}${sub ? ` ${sub}` : ''}`;
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === 'string' ? input[key] as string : '');
  switch (name) {
    case 'Bash': return bashSummary(str('command'));
    case 'Edit': case 'Write': case 'Read': case 'NotebookEdit': {
      const file = str('file_path') || str('notebook_path');
      const base = file ? cleanText(path.basename(file), 60) : '';
      return base ? `${name} · ${base}` : name;
    }
    case 'Skill': return TOKEN.test(str('skill')) ? `Skill · ${str('skill')}` : 'Skill';
    case 'Agent': case 'Task': return TOKEN.test(str('subagent_type')) ? `${name} · ${str('subagent_type')}` : name;
    case 'WebFetch': {
      try {
        return `WebFetch · ${new URL(str('url')).hostname}`;
      } catch {
        return 'WebFetch';
      }
    }
    default: return TOKEN.test(name) ? name : 'Tool';
  }
}

/**
 * A tool-call bubble's own text (issue #81 review): the verb and tool name only, nothing
 * derived from the call's input — not even a file's base name or a command's first word,
 * both of which `toolSummary` above puts in the card's "Recent" panel. The card is opt-in and
 * per-agent; a bubble floats over every agent's head without a click, so it needs the
 * stricter rule, not a cut-down version of the same string. Unknown tool names still show
 * literally (the same closed `TOKEN` shape `toolSummary` checks), never silently as "Tool".
 */
const BUBBLE_TOOL_LABEL: Readonly<Record<string, string>> = Object.freeze({
  Read: 'Reading a file',
  Write: 'Writing a file',
  Edit: 'Editing a file',
  NotebookEdit: 'Editing a notebook',
  Bash: 'Running a command',
  Grep: 'Searching',
  Glob: 'Finding files',
  WebFetch: 'Fetching a page',
  WebSearch: 'Searching the web',
  Skill: 'Using a skill',
  Agent: 'Running a subagent',
  Task: 'Running a subagent',
  TodoWrite: 'Updating the to-do list',
});

function bubbleToolSummary(name: string): string {
  return BUBBLE_TOOL_LABEL[name] ?? (TOKEN.test(name) ? name : 'Tool');
}

/** Every string in a tool input, depth and size capped. */
function inputStrings(value: unknown, out: string[] = [], depth = 0, budget = { left: MAX_INPUT_CHARS }): string[] {
  if (budget.left <= 0 || depth > 4) return out;
  if (typeof value === 'string') {
    out.push(value.slice(0, budget.left));
    budget.left -= value.length;
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) inputStrings(item, out, depth + 1, budget);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value).slice(0, 50)) inputStrings(item, out, depth + 1, budget);
  }
  return out;
}

const GITHUB_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(issues|pull)\/(\d{1,9})\b/g;
const GITLAB_MR = /https:\/\/([A-Za-z0-9.-]{1,253}(?::\d{1,5})?)\/((?:[A-Za-z0-9_.-]{1,100}\/){1,10})-\/merge_requests\/(\d{1,9})\b/g;
const GH_COMMAND = /\bgh\s+(issue|pr)\s+(?:view|comment|edit|close|reopen|merge|checkout|diff|review|ready)\b([^\n;&|]*)/g;
const REPO_FLAG = /(?:^|\s)(?:-R|--repo)(?:\s+|=)["']?([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})/;
const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;

interface Hit { at: number; asset: Asset }

function assetsIn(text: string, jiraSites: Record<string, string>): Asset[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(GITHUB_URL)) {
    const kind = m[3] === 'pull' ? 'pr' : 'issue';
    hits.push({ at: m.index ?? 0, asset: { kind, label: `${m[2]}#${m[4]}`, url: `https://github.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}` } });
  }
  for (const m of text.matchAll(GITLAB_MR)) {
    if (m[1] === 'github.com') continue;
    const segments = m[2].split('/').filter(Boolean);
    const project = segments[segments.length - 1] ?? '';
    hits.push({ at: m.index ?? 0, asset: { kind: 'mr', label: `${project}!${m[3]}`, url: `https://${m[1]}/${m[2]}-/merge_requests/${m[3]}` } });
  }
  for (const m of text.matchAll(GH_COMMAND)) {
    const repo = REPO_FLAG.exec(m[2]);
    const number = m[2].trim().split(/\s+/).map(unquote).find((token) => /^#?\d{1,9}$/.test(token))?.replace('#', '');
    if (!repo || !number) continue;
    const kind = m[1] === 'pr' ? 'pr' : 'issue';
    hits.push({ at: m.index ?? 0, asset: { kind, label: `${repo[2]}#${number}`,
      url: `https://github.com/${repo[1]}/${repo[2]}/${kind === 'pr' ? 'pull' : 'issues'}/${number}` } });
  }
  for (const m of text.matchAll(JIRA_KEY)) {
    const site = jiraSites[m[1]];
    if (site) hits.push({ at: m.index ?? 0, asset: { kind: 'jira', label: `${m[1]}-${m[2]}`, url: `${site}${m[1]}-${m[2]}` } });
  }
  return hits.sort((a, b) => a.at - b.at).map((hit) => hit.asset);
}

function pushNewest<T>(list: T[], item: T, same: (a: T, b: T) => boolean, max: number): void {
  const index = list.findIndex((known) => same(known, item));
  if (index >= 0) list.splice(index, 1);
  list.unshift(item);
  if (list.length > max) list.length = max;
}

const REPO_SHORT = /^[A-Za-z0-9_.-]{1,40}$/;

export interface PeekReaderOptions {
  jiraSites?: Record<string, string>;
  /** Bytes read from the end of a transcript seen for the first time. */
  tailBytes?: number;
}

export class PeekReader {
  private readonly files = new Map<string, FileState>();
  private readonly repoByDir = new Map<string, string | null>();
  private readonly jiraSites: Record<string, string>;
  private readonly tailBytes: number;

  constructor(options: PeekReaderOptions = {}) {
    this.jiraSites = options.jiraSites ?? { ...DEFAULT_JIRA_SITES };
    this.tailBytes = options.tailBytes ?? TAIL_BYTES;
  }

  /** `maxLines`: how many of the cached lines to return (default 10, the card's "Recent"; up to
   * `PEEK_TAIL_LINES` for the "Show 100 lines" tail, issue #81 AC5). The cache itself always
   * keeps `PEEK_TAIL_LINES`, so asking for more costs no extra read. */
  read(agent: Observation, maxLines = PEEK_MAX_LINES): PeekInput {
    const file = agent.internal.transcriptPath;
    const empty: PeekInput = { lines: [], assets: [], skills: [], repos: [] };
    if (typeof file !== 'string' || !file.endsWith('.jsonl')) return empty;
    const cwd = typeof agent.internal.cwd === 'string' ? agent.internal.cwd : undefined;
    const state = this.update(file, cwd);
    if (!state) return empty;
    const newest = state.lines[state.lines.length - 1];
    const waits = agent.display?.attention === 'waiting' || agent.display?.attention === 'your-turn';
    // An out-of-range request (negative, not a whole number) falls back to the normal default,
    // the same rule `projectPeek` applies on the way out: a route-level guess is never trusted
    // over the view's own sane default.
    const limit = Number.isInteger(maxLines) && maxLines >= 1 ? maxLines : PEEK_MAX_LINES;
    return {
      lines: state.lines.slice(-limit),
      assets: state.assets.slice(),
      skills: state.skills.slice(),
      repos: state.repos.slice(),
      ...(waits && newest?.kind === 'text' ? { question: newest.text } : {}),
    };
  }

  private update(file: string, cwd: string | undefined): FileState | undefined {
    let fd: number | undefined;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) return undefined;
      let state = this.files.get(file);
      if (!state || stat.size < state.offset || stat.size - state.offset > MAX_BYTES_PER_READ) {
        state = freshState(Math.max(0, stat.size - this.tailBytes));
      }
      if (!this.files.has(file) && this.files.size >= MAX_CACHED_FILES) this.files.clear();
      this.files.set(file, state);
      if (stat.size <= state.offset) return state;
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(READ_CHUNK);
      while (state.offset < stat.size) {
        const bytesRead = fs.readSync(fd, buffer, 0, Math.min(READ_CHUNK, stat.size - state.offset), state.offset);
        if (bytesRead <= 0) break;
        state.offset += bytesRead;
        this.takeText(state, state.decoder.decode(buffer.subarray(0, bytesRead), { stream: true }), cwd);
      }
      return state;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private takeText(state: FileState, text: string, cwd: string | undefined): void {
    const parts = (state.carry + text).split('\n');
    state.carry = parts.pop() ?? '';
    for (const line of parts) {
      if (state.skipFirst) {
        state.skipFirst = false;
        continue;
      }
      this.takeLine(state, line, cwd);
    }
    if (state.carry.length > MAX_LINE) {
      state.carry = '';
      state.skipFirst = true;
    }
  }

  private takeLine(state: FileState, line: string, cwd: string | undefined): void {
    if (!line.includes('"assistant"')) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const message = (entry as { message?: { role?: unknown; content?: unknown } } | null)?.message;
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const text = cleanText(block.text, PEEK_LINE_MAX);
        if (text) this.addLine(state, { kind: 'text', text });
      } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
        this.addLine(state, { kind: 'tool', text: displayText(toolSummary(block.name, input), PEEK_LINE_MAX) });
        this.takeTool(state, block.name, input, cwd);
      }
    }
  }

  private addLine(state: FileState, line: Line): void {
    state.lines.push(line);
    if (state.lines.length > PEEK_TAIL_LINES) state.lines.shift();
  }

  private takeTool(state: FileState, name: string, input: Record<string, unknown>, cwd: string | undefined): void {
    for (const text of inputStrings(input)) {
      for (const asset of assetsIn(text, this.jiraSites)) pushNewest(state.assets, asset, (a, b) => a.url === b.url, PEEK_MAX_ASSETS);
    }
    if (name === 'Skill' && typeof input.skill === 'string' && TOKEN.test(input.skill)) {
      pushNewest(state.skills, input.skill, (a, b) => a === b, MAX_EQUIPMENT);
    }
    const repos: Array<string | undefined> = [];
    if (['Edit', 'Write', 'NotebookEdit'].includes(name)) {
      const file = typeof input.file_path === 'string' ? input.file_path : input.notebook_path;
      if (typeof file === 'string' && path.isAbsolute(file)) repos.push(this.repoOf(path.dirname(file)));
    }
    if (name === 'Bash' && typeof input.command === 'string') {
      for (const tokens of simpleCommands(input.command)) {
        if (path.posix.basename(unquote(tokens[0])) !== 'git') continue;
        const { sub, dir } = subcommandOf(tokens.slice(1));
        if (!sub || !GIT_WRITES.has(sub)) continue;
        const where = dir ? (path.isAbsolute(dir) ? dir : cwd ? path.resolve(cwd, dir) : undefined) : cwd;
        if (where) repos.push(this.repoOf(where));
      }
    }
    for (const repo of repos) if (repo) pushNewest(state.repos, repo, (a, b) => a === b, MAX_EQUIPMENT);
  }

  /** The short name of the git repository that holds a folder; a worktree maps to its main repository. */
  private repoOf(dir: string): string | undefined {
    const cached = this.repoByDir.get(dir);
    if (cached !== undefined) return cached ?? undefined;
    let name: string | undefined;
    let current = path.resolve(dir);
    for (let depth = 0; depth < 40; depth++) {
      const git = path.join(current, '.git');
      try {
        const stat = fs.lstatSync(git);
        name = stat.isFile() ? worktreeMain(git) ?? path.basename(current) : path.basename(current);
        break;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    const short = name && REPO_SHORT.test(name) && name !== '.' && name !== '..' ? name : undefined;
    if (this.repoByDir.size >= MAX_CACHED_DIRS) this.repoByDir.clear();
    this.repoByDir.set(dir, short ?? null);
    return short;
  }
}

/** The main repository name from a worktree `.git` file (`gitdir: <main>/.git/worktrees/<name>`). */
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

interface TailLine {
  kind: 'text' | 'tool';
  /** Masked assistant text for a `'text'` line; empty for a `'tool'` line — its own text
   * (`bubbleToolSummary`) never depends on anything in the transcript but the tool name. */
  text: string;
  toolName?: string;
}

interface TailState {
  offset: number;
  carry: string;
  skipFirst: boolean;
  decoder: TextDecoder;
  /** Every line ever appended (issue #81): the only way to tell "a new line arrived" from
   * "no change since last call", since this reader keeps just the newest one, not a window. */
  totalLines: number;
  /** How many of `totalLines` a bubble has already reported. */
  bubbleSeen: number;
  newest?: TailLine;
}

function freshTailState(offset = 0): TailState {
  return { offset, carry: '', skipFirst: offset > 0, decoder: new TextDecoder('utf-8'), totalLines: 0, bubbleSeen: 0 };
}

/**
 * A separate, lighter transcript reader just for speech bubbles (issue #81 review). The
 * all-agent `/api/bubbles` poll touches every known agent's transcript every 3 s — a very
 * different access pattern from `PeekReader`'s "one selected agent, changes rarely" cache.
 * Sharing one 20-file cache between them thrashed it past ~20 live agents: `PeekReader.update`
 * clears its whole cache (not one entry) the moment a 21st distinct file shows up, so a busy
 * office re-read full transcript tails and re-emitted old lines as "new" bubbles on every
 * poll. This reader tracks only what a bubble needs (the newest line, its kind, and the raw
 * tool name `bubbleToolSummary` turns into a safe label) and is bounded by `forget()`, not a
 * fixed cache size: the set of agents a poll still knows already excludes a session the
 * moment it ends, so this reader's own size is bounded by the real, live agent count.
 */
export class BubbleTailReader {
  private readonly files = new Map<string, TailState>();

  read(agent: Observation): BubbleReply | undefined {
    const file = agent.internal.transcriptPath;
    if (typeof file !== 'string' || !file.endsWith('.jsonl')) return undefined;
    const state = this.update(file);
    if (!state || !state.newest || state.totalLines <= state.bubbleSeen) return undefined;
    state.bubbleSeen = state.totalLines;
    const { kind, text, toolName } = state.newest;
    return kind === 'tool' ? { kind, text: bubbleToolSummary(toolName ?? '') } : { kind, text: lastWords(text, BUBBLE_TEXT_MAX) };
  }

  /** Drops any cached file not among the agents the latest `/api/agents` poll still knows,
   * so this reader's size tracks the real agent count instead of an arbitrary cap. */
  forget(liveTranscriptPaths: ReadonlySet<string>): void {
    for (const file of [...this.files.keys()]) if (!liveTranscriptPaths.has(file)) this.files.delete(file);
  }

  private update(file: string): TailState | undefined {
    let fd: number | undefined;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) return undefined;
      let state = this.files.get(file);
      if (!state || stat.size < state.offset || stat.size - state.offset > MAX_BYTES_PER_READ) {
        state = freshTailState(Math.max(0, stat.size - TAIL_BYTES));
      }
      this.files.set(file, state);
      if (stat.size <= state.offset) return state;
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(READ_CHUNK);
      while (state.offset < stat.size) {
        const bytesRead = fs.readSync(fd, buffer, 0, Math.min(READ_CHUNK, stat.size - state.offset), state.offset);
        if (bytesRead <= 0) break;
        state.offset += bytesRead;
        this.takeText(state, state.decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
      }
      return state;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private takeText(state: TailState, text: string): void {
    const parts = (state.carry + text).split('\n');
    state.carry = parts.pop() ?? '';
    for (const line of parts) {
      if (state.skipFirst) {
        state.skipFirst = false;
        continue;
      }
      this.takeLine(state, line);
    }
    if (state.carry.length > MAX_LINE) {
      state.carry = '';
      state.skipFirst = true;
    }
  }

  private takeLine(state: TailState, line: string): void {
    if (!line.includes('"assistant"')) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const message = (entry as { message?: { role?: unknown; content?: unknown } } | null)?.message;
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const text = cleanText(block.text, PEEK_LINE_MAX);
        if (text) {
          state.newest = { kind: 'text', text };
          state.totalLines++;
        }
      } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
        state.newest = { kind: 'tool', text: '', toolName: block.name };
        state.totalLines++;
      }
    }
  }
}

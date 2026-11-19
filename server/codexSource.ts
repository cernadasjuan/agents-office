import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inferBashActivity } from './agentDetector.js';
import type { AgentSource, Observation } from './seam.js';

/**
 * Codex rollouts are passive files. A changed file proves recent activity, not
 * a live process: a long silent command or an open idle thread looks the same
 * as a closed one. "Recently active" is the honest claim, so the window is a
 * named constant and the README states the limit.
 */
export const RECENT_WINDOW_MS = 10 * 60_000;

const MAX_FILES_VISITED = 10_000;
const MAX_AGENTS = 50;
const MAX_DEPTH = 3; // sessions/YYYY/MM/DD/rollout-*.jsonl
const HEADER_BYTES = 256_000;
const TAIL_BYTES = 256_000;
const MAX_LINE_BYTES = 128_000;
const MAX_COMMAND_LENGTH = 4_000;
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;
const INTERNAL_SOURCE = /memory|guardian/i;

type Json = Record<string, unknown>;

interface Header {
  threadId: string;
  parentThreadId?: string;
  cwd?: string;
  historyStart?: number;
}

interface Rollout {
  file: string;
  mtimeMs: number;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(line: string): Json | undefined {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Resolve the Codex home: CODEX_HOME when set, else ~/.codex. */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

async function readRange(file: string, start: number, length: number): Promise<string> {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await handle.close();
  }
}

// --- Discovery ---

async function listRollouts(sessionsRoot: string, cutoffMs: number): Promise<Rollout[]> {
  const found: Rollout[] = [];
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_FILES_VISITED) return;
      visited++;
      const full = path.join(dir, entry.name);
      // Dirent types do not follow symlinks, so a linked file or folder is never entered.
      if (entry.isDirectory() && depth < MAX_DEPTH) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && ROLLOUT_FILE.test(entry.name)) {
        try {
          const stat = await fsp.lstat(full);
          if (stat.isFile() && stat.mtimeMs >= cutoffMs) found.push({ file: full, mtimeMs: stat.mtimeMs });
        } catch {
          // The file disappeared between listing and stat.
        }
      }
    }
  }

  await walk(sessionsRoot, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_AGENTS);
}

async function isInside(root: string, file: string): Promise<boolean> {
  try {
    const real = await fsp.realpath(file);
    return real.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

// --- Header: the first session_meta record is canonical ---

function parentOf(payload: Json): string | undefined {
  const direct = text(payload.parent_thread_id);
  if (direct) return direct;
  const source = payload.source;
  const subagent = isObject(source) ? source.subagent : undefined;
  const spawn = isObject(subagent) ? subagent.thread_spawn : undefined;
  return isObject(spawn) ? text(spawn.parent_thread_id) : undefined;
}

function isInternalSession(payload: Json): boolean {
  const source = payload.source;
  if (typeof source === 'string') return INTERNAL_SOURCE.test(source);
  if (!isObject(source)) return false;
  const subagent = source.subagent;
  return typeof subagent === 'string' ? INTERNAL_SOURCE.test(subagent)
    : isObject(subagent) && Object.keys(subagent).some((key) => INTERNAL_SOURCE.test(key));
}

async function readHeader(file: string): Promise<Header | undefined> {
  const head = await readRange(file, 0, HEADER_BYTES);
  const end = head.indexOf('\n');
  if (end < 0) return undefined;
  const record = parseJson(head.slice(0, end));
  const payload = record?.payload;
  if (record?.type !== 'session_meta' || !isObject(payload)) return undefined;
  const threadId = text(payload.id);
  if (!threadId || isInternalSession(payload)) return undefined;
  const historyStart = payload.subagent_history_start_ordinal;
  return {
    threadId,
    parentThreadId: parentOf(payload),
    cwd: text(payload.cwd),
    historyStart: typeof historyStart === 'number' ? historyStart : undefined,
  };
}

// --- Activity ---

function shellCommand(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_COMMAND_LENGTH);
  if (!Array.isArray(value) || !value.every((part) => typeof part === 'string')) return undefined;
  const flag = value.findIndex((part) => /^-[a-z]*c$/.test(part));
  const command = flag >= 0 && flag + 1 < value.length ? value[flag + 1] : value.join(' ');
  return command.slice(0, MAX_COMMAND_LENGTH);
}

function argumentsOf(payload: Json): Json {
  return typeof payload.arguments === 'string' ? parseJson(payload.arguments) ?? {} : {};
}

const SHELL_TOOLS = new Set(['shell', 'shell_command', 'local_shell', 'exec_command', 'container.exec']);
const PLANNING_TOOLS = new Set(['update_plan', 'spawn_agent', 'send_message', 'followup_task', 'wait_agent',
  'list_agents', 'close_agent']);
const WAITING_TOOLS = new Set(['sleep', 'wait']);

function functionCallActivity(payload: Json): string | undefined {
  const name = text(payload.name) ?? '';
  if (SHELL_TOOLS.has(name)) {
    const args = argumentsOf(payload);
    const command = shellCommand(args.command ?? args.cmd);
    return command ? inferBashActivity(command) : 'implementing';
  }
  if (name.startsWith('request_user_input')) return 'meeting';
  if (PLANNING_TOOLS.has(name)) return 'planning';
  if (name === 'web_search' || name === 'view_image') return 'researching';
  if (WAITING_TOOLS.has(name)) return undefined;
  return 'implementing';
}

function completedItemActivity(item: unknown): string | undefined {
  if (!isObject(item)) return undefined;
  switch (item.type) {
    case 'CommandExecution': {
      const command = shellCommand(item.command);
      return command ? inferBashActivity(command) : 'implementing';
    }
    case 'FileChange': return 'implementing';
    case 'McpToolCall': return item.readOnlyHint === true ? 'researching' : 'implementing';
    case 'Extension': return item.kind === 'web.search' ? 'researching' : undefined;
    case 'SubAgentActivity':
    case 'CollabAgentToolCall': return 'planning';
    default: return undefined;
  }
}

/** The activity a record decides, or undefined to keep looking at older records. */
function recordActivity(record: Json): string | undefined {
  const payload = record.payload;
  if (!isObject(payload)) return undefined;
  if (record.type === 'event_msg') {
    if (payload.type === 'task_complete' || payload.type === 'turn_complete' || payload.type === 'turn_aborted') return 'idle';
    if (payload.type === 'task_started' || payload.type === 'turn_started') return 'planning';
    if (payload.type === 'item_completed') return completedItemActivity(payload.item);
    return undefined;
  }
  if (record.type !== 'response_item') return undefined;
  switch (payload.type) {
    case 'message':
      if (payload.role === 'assistant') return 'idle';
      return payload.role === 'user' ? 'planning' : undefined;
    case 'reasoning': return 'planning';
    case 'function_call': return functionCallActivity(payload);
    case 'local_shell_call': {
      const action = isObject(payload.action) ? payload.action : {};
      const command = shellCommand(action.command);
      return command ? inferBashActivity(command) : 'implementing';
    }
    // A wrapped exec script may run anything; it is never evaluated to guess more.
    case 'custom_tool_call': return 'implementing';
    default: return undefined;
  }
}

async function inferActivity(file: string, header: Header): Promise<string> {
  const { size } = await fsp.stat(file);
  const start = Math.max(0, size - TAIL_BYTES);
  const tail = await readRange(file, start, Math.min(size, TAIL_BYTES));
  const lines = tail.split('\n');
  if (start > 0) lines.shift(); // partial first line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const record = parseJson(line);
    if (!record) continue;
    // A child rollout repeats parent history before its own boundary; those records are not the child's.
    if (header.historyStart !== undefined && typeof record.ordinal === 'number' && record.ordinal < header.historyStart) continue;
    const activity = recordActivity(record);
    if (activity) return activity;
  }
  return 'idle';
}

async function observeRollout(rollout: Rollout): Promise<(Observation & { parentThreadId?: string }) | undefined> {
  try {
    const header = await readHeader(rollout.file);
    if (!header) return undefined;
    return {
      id: `codex:${header.threadId}`,
      provider: 'codex',
      name: header.cwd ? path.basename(header.cwd) || 'codex' : 'codex',
      activity: await inferActivity(rollout.file, header),
      parentThreadId: header.parentThreadId,
      internal: { cwd: header.cwd, sessionId: header.threadId, transcriptPath: rollout.file },
      display: {},
    };
  } catch {
    return undefined;
  }
}

/** Find Codex threads whose rollout changed within the recent window. */
export async function scanCodex(codexHome: string, now = Date.now()): Promise<Observation[]> {
  let sessionsRoot: string;
  try {
    sessionsRoot = await fsp.realpath(path.join(codexHome, 'sessions'));
  } catch {
    return [];
  }
  const rollouts = await listRollouts(sessionsRoot, now - RECENT_WINDOW_MS);
  const contained = await Promise.all(rollouts.map((rollout) => isInside(sessionsRoot, rollout.file)));
  const found = await Promise.all(rollouts.filter((_, i) => contained[i]).map(observeRollout));

  const agents = found.filter((agent): agent is NonNullable<typeof agent> => agent !== undefined);
  const unique = new Map<string, (typeof agents)[number]>();
  for (const agent of agents) if (!unique.has(agent.id)) unique.set(agent.id, agent); // newest rollout wins
  return [...unique.values()].map(({ parentThreadId, ...agent }) => {
    const parentId = parentThreadId ? `codex:${parentThreadId}` : undefined;
    // Link only to a parent that is shown; a missing parent is never guessed from a shared cwd.
    return parentId && parentId !== agent.id && unique.has(parentId) ? { ...agent, parentId } : agent;
  });
}

/** Built-in Codex source. Without a Codex home it finds nothing. */
export function codexSource(codexHome?: string): AgentSource {
  return { id: 'codex', scan: () => scanCodex(codexHome ?? defaultCodexHome()) };
}

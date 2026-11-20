import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { Enricher, Observation, OfficePlugin, RoomInput, WorldProvider } from '../../server/seam.js';

/**
 * Mission war rooms. Reads mission records (`<root>/missions/<slug>/mission.yaml`)
 * from the folders in AGENTS_OFFICE_MISSION_ROOTS. Each mission becomes a room:
 * open while active or parked, locked when done or abandoned. A session joins a
 * mission's room when its own tool calls touch that mission (P4): a `mission`
 * script command with the slug, or a file under `missions/<slug>/`.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_RECORD_BYTES = 1_000_000;
const MAX_SCAN_BYTES = 4_000_000;
const RECORD_CACHE_MS = 30_000;

export interface MissionSummary {
  slug: string;
  title: string;
  state: 'open' | 'locked';
  statement: string;
  docs: string[];
  issues: Array<{ number: number; title: string; state: 'open' | 'closed' }>;
  kanban: Array<{ column: string; cards: Array<{ number: number; title: string }> }>;
  /** One entry per ended session (a tombstone), its own journey id and the day it ended. */
  sleepers: Array<{ id: string; endedAt?: string }>;
}

export function parseRoots(list: string | undefined): string[] {
  return (list ?? '').split(',').map((root) => root.trim()).filter((root) => path.isAbsolute(root) && !root.includes('\0'));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : [];
}

/** The issue number of a GitHub member reference such as "owner/repo#46" or "#46". */
function issueNumber(ref: unknown): number | undefined {
  const match = /#(\d{1,7})$/.exec(text(ref));
  return match ? Number(match[1]) : undefined;
}

function threadNumber(id: unknown): number | undefined {
  const match = /^T-(\d{1,5})$/.exec(text(id));
  return match ? Number(match[1]) : undefined;
}

/** Turn one mission record into what its room shows. Unknown or missing fields give empty walls. */
export function summarizeMission(slug: string, record: unknown): MissionSummary | null {
  if (typeof record !== 'object' || record === null) return null;
  const mission = record as Record<string, unknown>;
  const status = text(mission.status);
  const threads = list(mission.threads);
  const column = (states: string[]) => threads
    .filter((thread) => states.includes(text(thread.state)))
    .map((thread) => ({ number: threadNumber(thread.id), title: text(thread.title) }))
    .filter((card): card is { number: number; title: string } => card.number !== undefined)
    .slice(-10);
  return {
    slug,
    title: text(mission.title) || slug,
    state: status === 'done' || status === 'abandoned' ? 'locked' : 'open',
    statement: text(mission.destination),
    docs: list(mission.artifacts).map((artifact) => text(artifact.title)).filter(Boolean),
    issues: list(mission.members)
      .filter((member) => text(member.kind) === 'gh')
      .map((member) => ({ number: issueNumber(member.ref), title: text(member.title),
        state: (text(member.role) === 'done' || text(member.role) === 'superseded' ? 'closed' : 'open') as 'open' | 'closed' }))
      .filter((issue): issue is { number: number; title: string; state: 'open' | 'closed' } => issue.number !== undefined),
    kanban: [
      { column: 'Needs you', cards: column(['needs_you']) },
      { column: 'Open', cards: column(['open', 'ready']) },
      { column: 'Done', cards: column(['resolved']) },
    ],
    sleepers: list(mission.journey)
      .filter((entry) => text(entry.kind) === 'session' || text(entry.kind) === 'night_run')
      .map((entry) => ({ id: text(entry.id), ...(text(entry.end) ? { endedAt: text(entry.end) } : {}) }))
      .filter((entry) => entry.id !== ''),
  };
}

/** Read every mission record under the roots. Unreadable or oversized records are skipped. */
export function readMissions(roots: string[]): MissionSummary[] {
  const missions: MissionSummary[] = [];
  for (const root of roots) {
    const missionsDir = path.join(root, 'missions');
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(missionsDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SLUG.test(entry.name)) continue;
      const file = path.join(missionsDir, entry.name, 'mission.yaml');
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
        const summary = summarizeMission(entry.name, parse(fs.readFileSync(file, 'utf-8')));
        if (summary) missions.push(summary);
      } catch {
        // skip a record that does not parse
      }
    }
  }
  return missions;
}

/** Mission slugs touched by tool calls in one transcript chunk, in order of appearance. */
export function missionsInToolCalls(chunk: string, known: Set<string>): string[] {
  const found: string[] = [];
  for (const line of chunk.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let entry: { message?: { role?: string; content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block.type !== 'tool_use') continue;
      const input = block.input ?? {};
      const haystack = [input.command, input.file_path, input.path, input.notebook_path].filter((v) => typeof v === 'string').join(' ');
      const pattern = /(?:\/missions\/([a-z0-9][a-z0-9-]{0,63})(?:\/|\b)|mission\s+(?:new|lint|fetch|render|sync|log|closeout|thread|threads|debrief)\s+(?:[a-z]+\s+)?([a-z0-9][a-z0-9-]{0,63}))/g;
      for (const match of haystack.matchAll(pattern)) {
        const slug = match[1] ?? match[2];
        if (slug && known.has(slug)) found.push(slug);
      }
    }
  }
  return found;
}

interface ScanState { size: number; offset: number; latest: string | null }

export function missionsPlugin(roots: string[], now: () => number = Date.now): OfficePlugin {
  let cached: { at: number; missions: MissionSummary[] } | null = null;
  const scans = new Map<string, ScanState>();

  const missions = (): MissionSummary[] => {
    if (!cached || now() - cached.at > RECORD_CACHE_MS) cached = { at: now(), missions: readMissions(roots) };
    return cached.missions;
  };

  /** The mission this transcript touched last. Reads only bytes added since the last poll. */
  const latestMission = (file: string, known: Set<string>): string | null => {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return null; }
    let state = scans.get(file);
    if (!state || stat.size < state.size) state = { size: 0, offset: Math.max(0, stat.size - MAX_SCAN_BYTES), latest: null };
    if (stat.size > state.offset) {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - state.offset);
        fs.readSync(fd, buffer, 0, buffer.length, state.offset);
        const chunk = buffer.toString('utf-8');
        const lastNewline = chunk.lastIndexOf('\n');
        const complete = lastNewline >= 0 ? chunk.slice(0, lastNewline) : '';
        const hits = missionsInToolCalls(complete, known);
        if (hits.length > 0) state.latest = hits[hits.length - 1];
        state.offset += Buffer.byteLength(complete) + (lastNewline >= 0 ? 1 : 0);
      } finally {
        fs.closeSync(fd);
      }
    }
    state.size = stat.size;
    scans.set(file, state);
    return state.latest;
  };

  const enricher: Enricher = {
    id: 'missions',
    enrich(observations: Observation[]) {
      const open = new Set(missions().filter((mission) => mission.state === 'open').map((mission) => mission.slug));
      if (open.size === 0) return;
      const roomOf = new Map<string, string>();
      for (const agent of observations) {
        if (agent.parentId || !agent.internal.transcriptPath) continue;
        const slug = latestMission(agent.internal.transcriptPath, open);
        if (slug) roomOf.set(agent.id, slug);
      }
      for (const agent of observations) {
        const slug = roomOf.get(agent.parentId ?? agent.id);
        if (slug) agent.display.roomKey = `mission:${slug}`;
      }
      const seen = new Set(observations.map((agent) => agent.internal.transcriptPath).filter(Boolean));
      for (const file of scans.keys()) if (!seen.has(file)) scans.delete(file);
    },
  };

  const world: WorldProvider = {
    id: 'mission-rooms',
    world: () => ({
      rooms: missions().map((mission): RoomInput => ({
        key: `mission:${mission.slug}`,
        kind: 'mission',
        title: mission.title,
        state: mission.state,
        sleepers: mission.sleepers,
        walls: { statement: mission.statement, docs: mission.docs, issues: mission.issues, kanban: mission.kanban },
      })),
    }),
  };

  return { name: 'missions', enrichers: [enricher], world: [world] };
}

export default missionsPlugin(parseRoots(process.env.AGENTS_OFFICE_MISSION_ROOTS));

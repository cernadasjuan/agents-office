import fs from 'node:fs';
import type { Enricher, Observation, OfficePlugin } from '../../server/seam.js';

/**
 * Skills plugin, server part (issue #166, extended issue #167 round 2: raw
 * tool activity). Finds every `Skill` tool call in an agent's own transcript
 * and sets the skill names it used, newest-loaded last, as `display.skills`,
 * the "Persona / Skills" row's half the card doesn't get from `bmad`. Also
 * tracks a fixed allow-list of built-in tool calls (`display.tools`): the
 * equipment catalog's spike (issue #167) wanted a search/bash/edit-triggered
 * item, and `Skill` tool calls alone can never carry that — a raw built-in
 * tool name is a structurally different kind of call. Only tool calls count
 * for either list (P4, same rule `bmad` follows): the `Skill` tool's own
 * `input.skill`, or the allow-listed tool's own `name`, never prompt or
 * assistant text.
 */

/**
 * Review (issue #167 round 2): `display.skills`/`display.tools` are rebuilt from an empty
 * `agent.display` every poll (`server/claudeSource.ts`'s `toObservation` always starts it at
 * `{}`), so the "combine with existing, then cap" below used to always cap a session's FULL
 * skill history from the front (`.slice(0, MAX_SKILLS)`), keeping the first 8 skills ever used
 * and freezing there forever once a session passed 8 distinct skills — the exact "newest"
 * entry the equipment catalog's hand item depends on would silently go stale. Capping from the
 * end (`.slice(-MAX_SKILLS)`) keeps the most recent `MAX_SKILLS` instead, in the same
 * newest-last order, so the hand item never freezes on a session that outgrows the cap.
 */
const MAX_SKILLS = 8;
const READ_CHUNK = 256 * 1024;
const MAX_BYTES_PER_POLL = 4 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
/** The same token shape `plugins/peek` already validates a skill name against. */
const SKILL_TOKEN = /^[A-Za-z0-9:_.-]{1,64}$/;
/**
 * A fixed, small allow-list (issue #167 round 2): every other built-in tool
 * (the ones that would leak the most about what an agent did, or just add
 * noise) never reaches `display.tools`, whatever its own name looks like.
 */
const TOOL_ALLOWLIST = new Set(['Bash', 'Grep', 'Glob', 'Read', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Task']);
const MAX_TOOLS = TOOL_ALLOWLIST.size;

interface EquipEvent {
  kind: 'skill' | 'tool';
  value: string;
}

interface TranscriptState {
  offset: number;
  carry: string;
  skippingLongLine: boolean;
  decoder: TextDecoder;
  skills: string[];
  tools: string[];
  /** Which list's most recent genuinely-new entry came later (issue #167 round 2): the
   * equipment catalog's hand item needs one true "newest" across both skills and raw
   * tools, not two separately-newest lists with no way to compare them. Set only when a
   * value is added for the first time this session (a repeat call never moves it), the
   * same "newest means newest *introduced*" rule `skills` already followed alone. */
  lastKind: 'skill' | 'tool' | undefined;
}

function freshState(): TranscriptState {
  return { offset: 0, carry: '', skippingLongLine: false, decoder: new TextDecoder('utf-8'), skills: [], tools: [], lastKind: undefined };
}

function equipEventsInLine(line: string): EquipEvent[] {
  // Cheap filter before parsing: most lines hold no tool call at all.
  if (!line.includes('"tool_use"')) return [];
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const message = (entry as { message?: { role?: unknown; content?: unknown } })?.message;
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
  const found: EquipEvent[] = [];
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (block?.type !== 'tool_use') continue;
    if (block.name === 'Skill') {
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (typeof input.skill === 'string' && SKILL_TOKEN.test(input.skill)) found.push({ kind: 'skill', value: input.skill });
    } else if (typeof block.name === 'string' && TOOL_ALLOWLIST.has(block.name)) {
      found.push({ kind: 'tool', value: block.name });
    }
  }
  return found;
}

function remember(state: TranscriptState, events: EquipEvent[]): void {
  for (const event of events) {
    const list = event.kind === 'skill' ? state.skills : state.tools;
    if (list.includes(event.value)) continue;
    list.push(event.value);
    state.lastKind = event.kind;
  }
}

function takeLines(state: TranscriptState, text: string): void {
  const parts = (state.carry + text).split('\n');
  state.carry = parts.pop() ?? '';
  for (const [index, line] of parts.entries()) {
    if (index === 0 && state.skippingLongLine) {
      state.skippingLongLine = false;
      continue;
    }
    remember(state, equipEventsInLine(line));
  }
  if (state.carry.length > MAX_LINE) {
    state.carry = '';
    state.skippingLongLine = true;
  }
}

/** Read the bytes added since the last poll (up to a cap per poll). */
function readNewBytes(transcriptPath: string, state: TranscriptState): TranscriptState {
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
      takeLines(state, state.decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
    }
    return state;
  } catch {
    return state;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function createSkillsEnricher(): Enricher {
  const cache = new Map<string, TranscriptState>();
  return {
    id: 'skills-in-context',
    enrich(observations: Observation[]) {
      const seen = new Set<string>();
      for (const agent of observations) {
        const transcriptPath = agent.internal.transcriptPath;
        if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) continue;
        seen.add(transcriptPath);
        const state = readNewBytes(transcriptPath, cache.get(transcriptPath) ?? freshState());
        cache.set(transcriptPath, state);
        if (state.skills.length > 0) {
          const existing = Array.isArray(agent.display.skills) ? agent.display.skills : [];
          agent.display.skills = [...existing, ...state.skills.filter((skill) => !existing.includes(skill))].slice(-MAX_SKILLS);
        }
        if (state.tools.length > 0) {
          const existing = Array.isArray(agent.display.tools) ? agent.display.tools : [];
          agent.display.tools = [...existing, ...state.tools.filter((tool) => !existing.includes(tool))].slice(-MAX_TOOLS);
        }
        if (state.lastKind) agent.display.lastEquipSource = state.lastKind;
      }
      for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    },
  };
}

const plugin: OfficePlugin = { name: 'skills', enrichers: [createSkillsEnricher()] };
export default plugin;

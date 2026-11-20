import fs from 'node:fs';
import type { Enricher, Observation, OfficePlugin } from '../../server/seam.js';

/**
 * Skills plugin, server part (issue #166). Finds every `Skill` tool call in an
 * agent's own transcript and sets the skill names it used, newest-loaded last,
 * as `display.skills`, the "Persona / Skills" row's half the card doesn't get
 * from `bmad`. Only tool calls count (P4, same rule `bmad` follows): the
 * `Skill` tool's own `input.skill`, never prompt or assistant text.
 */

const MAX_SKILLS = 8;
const READ_CHUNK = 256 * 1024;
const MAX_BYTES_PER_POLL = 4 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
/** The same token shape `plugins/peek` already validates a skill name against. */
const SKILL_TOKEN = /^[A-Za-z0-9:_.-]{1,64}$/;

interface TranscriptState {
  offset: number;
  carry: string;
  skippingLongLine: boolean;
  decoder: TextDecoder;
  skills: string[];
}

function freshState(): TranscriptState {
  return { offset: 0, carry: '', skippingLongLine: false, decoder: new TextDecoder('utf-8'), skills: [] };
}

function skillsInLine(line: string): string[] {
  // Cheap filter before parsing: most lines hold no Skill tool call at all.
  if (!line.includes('"tool_use"') || !line.includes('"Skill"')) return [];
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const message = (entry as { message?: { role?: unknown; content?: unknown } })?.message;
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
  const found: string[] = [];
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (block?.type !== 'tool_use' || block.name !== 'Skill') continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    if (typeof input.skill === 'string' && SKILL_TOKEN.test(input.skill)) found.push(input.skill);
  }
  return found;
}

function remember(state: TranscriptState, skills: string[]): void {
  for (const skill of skills) if (!state.skills.includes(skill)) state.skills.push(skill);
}

function takeLines(state: TranscriptState, text: string): void {
  const parts = (state.carry + text).split('\n');
  state.carry = parts.pop() ?? '';
  for (const [index, line] of parts.entries()) {
    if (index === 0 && state.skippingLongLine) {
      state.skippingLongLine = false;
      continue;
    }
    remember(state, skillsInLine(line));
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
        if (state.skills.length === 0) continue;
        const existing = Array.isArray(agent.display.skills) ? agent.display.skills : [];
        agent.display.skills = [...existing, ...state.skills.filter((skill) => !existing.includes(skill))].slice(0, MAX_SKILLS);
      }
      for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    },
  };
}

const plugin: OfficePlugin = { name: 'skills', enrichers: [createSkillsEnricher()] };
export default plugin;

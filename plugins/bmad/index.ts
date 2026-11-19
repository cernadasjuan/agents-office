import fs from 'node:fs';
import type { Enricher, Observation, OfficePlugin } from '../../server/seam.js';
import { personaIdFor } from './roster.js';

/**
 * BMAD plugin, server part. Finds the personas an agent loaded and sets them as
 * badges, in first-loaded order. Only tool calls count (P4): a `bmad.py agent <name>`
 * Bash call, a Skill call for a persona, or a subagent type that is a persona.
 * Prompt and assistant text never count.
 */

const MAX_BADGES = 6;
const READ_CHUNK = 256 * 1024;
const MAX_BYTES_PER_POLL = 4 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const AGENT_CALL = /bmad\.py\s+(?:--project-root(?:=|\s+)\S+\s+)?agent\s+["']?([A-Za-z][\w.-]{0,40})/g;

interface TranscriptState {
  offset: number;
  carry: string;
  skippingLongLine: boolean;
  decoder: TextDecoder;
  personas: string[];
}

function freshState(): TranscriptState {
  return { offset: 0, carry: '', skippingLongLine: false, decoder: new TextDecoder('utf-8'), personas: [] };
}

function personasInBash(command: string): string[] {
  return Array.from(command.matchAll(AGENT_CALL), (match) => personaIdFor(match[1]))
    .filter((id): id is string => id !== undefined);
}

function personaInSkill(skill: string, args: string): string | undefined {
  const name = skill.trim().toLowerCase().replace(/^[\w-]+:/, '');
  if (name === 'bmad') {
    const words = args.trim().split(/\s+/);
    return personaIdFor((words[0]?.toLowerCase() === 'agent' ? words[1] : words[0]) ?? '');
  }
  return personaIdFor(name) ?? personaIdFor(name.replace(/^bmad-(agent-)?/, ''));
}

function personasInLine(line: string): string[] {
  // Cheap filter before parsing: most lines hold neither a Bash bmad.py call nor a Skill call.
  if (!line.includes('"tool_use"') || !(line.includes('bmad.py') || line.includes('"Skill"'))) return [];
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
    if (block?.type !== 'tool_use') continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    if (block.name === 'Bash' && typeof input.command === 'string') found.push(...personasInBash(input.command));
    if (block.name === 'Skill' && typeof input.skill === 'string') {
      const persona = personaInSkill(input.skill, typeof input.args === 'string' ? input.args : '');
      if (persona) found.push(persona);
    }
  }
  return found;
}

function remember(state: TranscriptState, personas: string[]): void {
  for (const persona of personas) if (!state.personas.includes(persona)) state.personas.push(persona);
}

function takeLines(state: TranscriptState, text: string): void {
  const parts = (state.carry + text).split('\n');
  state.carry = parts.pop() ?? '';
  for (const [index, line] of parts.entries()) {
    if (index === 0 && state.skippingLongLine) {
      state.skippingLongLine = false;
      continue;
    }
    remember(state, personasInLine(line));
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

export function createBmadEnricher(): Enricher {
  const cache = new Map<string, TranscriptState>();
  return {
    id: 'bmad-personas',
    enrich(observations: Observation[]) {
      const seen = new Set<string>();
      for (const agent of observations) {
        const personas: string[] = [];
        const fromType = typeof agent.internal.agentType === 'string'
          ? personaIdFor(agent.internal.agentType.replace(/^[\w-]+:/, ''))
          : undefined;
        if (fromType) personas.push(fromType);
        const transcriptPath = agent.internal.transcriptPath;
        if (typeof transcriptPath === 'string' && transcriptPath.endsWith('.jsonl')) {
          seen.add(transcriptPath);
          const state = readNewBytes(transcriptPath,
            cache.get(transcriptPath) ?? freshState());
          cache.set(transcriptPath, state);
          for (const persona of state.personas) if (!personas.includes(persona)) personas.push(persona);
        }
        if (personas.length === 0) continue;
        const existing = Array.isArray(agent.display.badges) ? agent.display.badges : [];
        agent.display.badges = [...existing, ...personas.filter((id) => !existing.includes(id))].slice(0, MAX_BADGES);
      }
      for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    },
  };
}

const plugin: OfficePlugin = { name: 'bmad', enrichers: [createBmadEnricher()] };
export default plugin;

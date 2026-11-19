import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import type { Observation } from '../server/seam.js';
import { projectAgents } from '../server/seam.js';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-bmad-test-'));
// Never read the real home folder: redirect it before the plugin loads.
const homeMock = mock.method(os, 'homedir', () => fixture);
const { default: plugin, createBmadEnricher } = await import('../plugins/bmad/index.js');
after(() => {
  homeMock.mock.restore();
  fs.rmSync(fixture, { recursive: true, force: true });
});

const transcripts = path.join(fixture, 'transcripts');
beforeEach(() => {
  fs.rmSync(transcripts, { recursive: true, force: true });
  fs.mkdirSync(transcripts, { recursive: true });
});

function toolUse(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });
}

function userText(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

function assistantText(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

function writeTranscript(name: string, lines: string[]): string {
  const file = path.join(transcripts, name);
  fs.writeFileSync(file, lines.map((line) => `${line}\n`).join(''));
  return file;
}

function observation(internal: Observation['internal']): Observation {
  return { id: 'a', provider: 'claude', name: 'A', activity: 'implementing', internal, display: {} };
}

async function badgesFor(internal: Observation['internal'], enricher = createBmadEnricher()): Promise<string[] | undefined> {
  const agent = observation(internal);
  await enricher.enrich([agent]);
  return agent.display.badges;
}

test('the plugin is named bmad and has one enricher', () => {
  assert.equal(plugin.name, 'bmad');
  assert.equal(plugin.enrichers?.length, 1);
});

test('personas loaded with bmad.py agent become badges in first-loaded order', async () => {
  const transcriptPath = writeTranscript('s.jsonl', [
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py agent sally' }),
    toolUse('Read', { file_path: '/x.ts' }),
    toolUse('Bash', { command: 'python3 /home/u/.claude-shared-config/bmad/bmad.py agent architect && echo ok' }),
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py agent Sally' }),
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py agent "Dexter"' }),
  ]);

  assert.deepEqual(await badgesFor({ transcriptPath }), ['ux-designer', 'architect', 'debugger']);
});

test('text that mentions bmad.py does not count, only tool calls do', async () => {
  const transcriptPath = writeTranscript('s.jsonl', [
    userText('Play Sally: run python3 ~/.claude-shared-config/bmad/bmad.py agent sally first'),
    assistantText('I will run bmad.py agent winston next.'),
    toolUse('Read', { file_path: '/notes/bmad.py agent quinn.md' }),
  ]);

  assert.equal(await badgesFor({ transcriptPath }), undefined);
});

test('bmad.py resolve, list and unknown names do not count as playing a persona', async () => {
  const transcriptPath = writeTranscript('s.jsonl', [
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py resolve sally' }),
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py list' }),
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py agent nobody' }),
  ]);

  assert.equal(await badgesFor({ transcriptPath }), undefined);
});

test('a Skill call for a persona or for bmad with a persona counts', async () => {
  const transcriptPath = writeTranscript('s.jsonl', [
    toolUse('Skill', { skill: 'bmad', args: 'agent quinn' }),
    toolUse('Skill', { skill: 'bmad-debrief' }),
    toolUse('Skill', { skill: 'dexter' }),
    toolUse('Skill', { skill: 'bmad', args: 'list' }),
    toolUse('Skill', { skill: 'bmad', args: 'John write the PRD' }),
  ]);

  assert.deepEqual(await badgesFor({ transcriptPath }), ['qa', 'debugger', 'pm']);
});

test('a subagent whose type is a persona wears that hat first', async () => {
  const transcriptPath = writeTranscript('s.jsonl', [
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py agent leo' }),
  ]);

  assert.deepEqual(await badgesFor({ agentType: 'dexter', transcriptPath }), ['debugger', 'spec-coach']);
  assert.deepEqual(await badgesFor({ agentType: 'Dexter' }), ['debugger']);
  assert.equal(await badgesFor({ agentType: 'Explore' }), undefined);
});

test('an agent without a transcript or persona gets no badges', async () => {
  assert.equal(await badgesFor({}), undefined);
  assert.equal(await badgesFor({ transcriptPath: path.join(transcripts, 'missing.jsonl') }), undefined);
});

test('each poll reads only the new bytes and keeps the first-loaded order', async () => {
  const enricher = createBmadEnricher();
  const transcriptPath = writeTranscript('s.jsonl', [
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py agent mary' }),
  ]);
  assert.deepEqual(await badgesFor({ transcriptPath }, enricher), ['analyst']);

  // A half-written line is kept until its end arrives.
  const next = toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py agent bob' });
  fs.appendFileSync(transcriptPath, next.slice(0, 20));
  assert.deepEqual(await badgesFor({ transcriptPath }, enricher), ['analyst']);
  fs.appendFileSync(transcriptPath, `${next.slice(20)}\n`);
  assert.deepEqual(await badgesFor({ transcriptPath }, enricher), ['analyst', 'sm']);
});

test('a shorter transcript is read again from the start', async () => {
  const enricher = createBmadEnricher();
  const transcriptPath = writeTranscript('s.jsonl', [
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py agent mary' }),
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py agent bob' }),
  ]);
  assert.deepEqual(await badgesFor({ transcriptPath }, enricher), ['analyst', 'sm']);

  writeTranscript('s.jsonl', [toolUse('Skill', { skill: 'winston' })]);
  assert.deepEqual(await badgesFor({ transcriptPath }, enricher), ['architect']);
});

test('the badges pass the API projection', async () => {
  const transcriptPath = writeTranscript('s.jsonl', [
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py agent creative-problem-solver' }),
    toolUse('Bash', { command: 'python3 ~/.claude-shared-config/bmad/bmad.py agent quick-flow-solo-dev' }),
  ]);
  const agent = observation({ transcriptPath });
  await createBmadEnricher().enrich([agent]);

  const [projected] = projectAgents([agent], (raw) => `id-${raw}`);
  assert.deepEqual(projected.badges, ['creative-problem-solver', 'quick-flow-solo-dev']);
});

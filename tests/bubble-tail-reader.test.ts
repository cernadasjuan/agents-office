import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Observation } from '../server/seam.js';
import { BUBBLE_TEXT_MAX, BubbleTailReader } from '../plugins/peek/transcript.js';

// Synthetic transcripts in a temp folder. No test reads the user's ~/.claude.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-bubble-tail-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const FAKE_GHP = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

let counter = 0;
function transcript(lines: unknown[]): string {
  const file = path.join(root, `t${counter++}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

const text = (value: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: value }] } });
const tool = (name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] } });

function agent(transcriptPath: string | undefined, id = 'raw-session'): Observation {
  return { id, provider: 'claude', name: 'n', activity: 'implementing', internal: { cwd: root, ...(transcriptPath ? { transcriptPath } : {}) }, display: {} };
}

test('a new line since the last call for this agent, once, with the last words (not the first)', () => {
  const file = transcript([text('this opens long but the only thing to show is THE LAST WORDS')]);
  const reader = new BubbleTailReader();
  const first = reader.read(agent(file));
  assert.ok(first);
  assert.equal(first!.kind, 'text');
  assert.ok(first!.text.length <= BUBBLE_TEXT_MAX);
  assert.ok(first!.text.endsWith('THE LAST WORDS'), first!.text);
  // Nothing new since: undefined, not the same line again.
  assert.equal(reader.read(agent(file)), undefined);
  fs.appendFileSync(file, JSON.stringify(tool('Bash', { command: 'echo hi' })) + '\n');
  assert.deepEqual(reader.read(agent(file)), { kind: 'tool', text: 'Running a command' });
  assert.equal(reader.read(agent(file)), undefined, 'still nothing new after being asked once');
});

test('no transcript, a missing file or a non-jsonl path gives undefined, never throws', () => {
  const reader = new BubbleTailReader();
  for (const transcriptPath of [undefined, path.join(root, 'missing.jsonl'), path.join(root, 'x.txt')]) {
    assert.equal(reader.read(agent(transcriptPath)), undefined);
  }
});

// --- Review item 2: tool-call bubbles are the verb and tool name only, nothing from the
// input — a hostile fixture per tool, asserting none of the input reaches the reply. ---

test('a Read of a private path never shows the path, only "Reading a file"', () => {
  const file = transcript([tool('Read', { file_path: '/private/clients/customer-plan.md' })]);
  const reply = new BubbleTailReader().read(agent(file));
  assert.deepEqual(reply, { kind: 'tool', text: 'Reading a file' });
  assert.equal(JSON.stringify(reply).includes('customer-plan'), false);
  assert.equal(JSON.stringify(reply).includes('private'), false);
});

test('a Bash git commit never shows the command, only "Running a command"', () => {
  const file = transcript([tool('Bash', { command: 'git commit -m "secret plan, do not tell anyone"' })]);
  const reply = new BubbleTailReader().read(agent(file));
  assert.deepEqual(reply, { kind: 'tool', text: 'Running a command' });
  assert.equal(JSON.stringify(reply).includes('secret plan'), false);
  assert.equal(JSON.stringify(reply).includes('commit'), false);
});

test('a Bash command carrying a live token never shows it, only "Running a command"', () => {
  const file = transcript([tool('Bash', { command: `curl -H "Authorization: Bearer ${FAKE_GHP}" https://internal.example/x` })]);
  const reply = new BubbleTailReader().read(agent(file));
  assert.deepEqual(reply, { kind: 'tool', text: 'Running a command' });
  assert.equal(JSON.stringify(reply).includes(FAKE_GHP), false);
  assert.equal(JSON.stringify(reply).includes('internal.example'), false);
});

test('a WebFetch never shows the URL, only "Fetching a page"', () => {
  const file = transcript([tool('WebFetch', { url: 'https://docs.example.com/private/customer-plan?token=abc123' })]);
  const reply = new BubbleTailReader().read(agent(file));
  assert.deepEqual(reply, { kind: 'tool', text: 'Fetching a page' });
  assert.equal(JSON.stringify(reply).includes('docs.example.com'), false);
  assert.equal(JSON.stringify(reply).includes('customer-plan'), false);
});

test('an unrecognized tool name still shows literally (never silently "Tool"), still nothing from its input', () => {
  const file = transcript([tool('SomeFutureTool', { secretArg: 'do not show this' })]);
  const reply = new BubbleTailReader().read(agent(file));
  assert.deepEqual(reply, { kind: 'tool', text: 'SomeFutureTool' });
});

// --- Review item 3: bounded for 40+ agents, without PeekReader's shared, thrashing cache ---

test('30 fixture agents across 3 polls: no old line re-emitted as new, and forget() bounds the cache to the live set', () => {
  const reader = new BubbleTailReader();
  const files = Array.from({ length: 30 }, (_, i) => transcript([text(`agent ${i} says hello`)]));
  const agents = files.map((file, i) => agent(file, `agent-${i}`));
  const liveTranscriptPaths = new Set(files);

  // Poll 1: every agent has a fresh line.
  reader.forget(liveTranscriptPaths);
  const poll1 = agents.map((a) => reader.read(a));
  assert.equal(poll1.filter((reply) => reply !== undefined).length, 30, 'every agent bubbles once');

  // Poll 2: nothing new anywhere — the earlier line must never resurface as "new".
  reader.forget(liveTranscriptPaths);
  const poll2 = agents.map((a) => reader.read(a));
  assert.ok(poll2.every((reply) => reply === undefined), 'no stale line re-emitted as new');

  // One agent writes again; only that one bubbles on poll 3.
  fs.appendFileSync(files[5], JSON.stringify(text('agent 5 says something new')) + '\n');
  reader.forget(liveTranscriptPaths);
  const poll3 = agents.map((a) => reader.read(a));
  assert.equal(poll3.filter((reply) => reply !== undefined).length, 1);
  assert.ok(poll3[5]?.text.includes('something new'));

  // A session ends (drops out of the live set): forget() prunes it, bounding the cache to the
  // real agent count rather than letting it grow forever.
  const stillLive = new Set(files.slice(0, 29));
  reader.forget(stillLive);
  const filesField = (reader as unknown as { files: Map<string, unknown> }).files;
  assert.equal(filesField.size, 29, 'the ended session\'s cached state is gone, not accumulating');
});

test('forget() with an empty live set clears every cached entry', () => {
  const reader = new BubbleTailReader();
  const file = transcript([text('hello')]);
  reader.read(agent(file));
  reader.forget(new Set());
  const filesField = (reader as unknown as { files: Map<string, unknown> }).files;
  assert.equal(filesField.size, 0);
});

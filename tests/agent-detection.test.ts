import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-detection-test-'));
const sessions = path.join(fixture, '.claude', 'sessions');
const cwd = '/work/shared-project';
const projectDir = path.join(fixture, '.claude', 'projects', cwd.replace(/\//g, '-'));
// Import only after redirecting discovery to synthetic metadata.
const homeMock = mock.method(os, 'homedir', () => fixture);
const { detectAgents } = await import('../server/agentDetector.js');
homeMock.mock.restore();
const killMock = mock.method(process, 'kill', () => true as const);

function writeSession(file: string, sessionId: string, pid: number): void {
  fs.writeFileSync(path.join(sessions, file), JSON.stringify({ pid, sessionId, cwd, startedAt: 1 }));
}

function toolUseLine(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });
}

function writeTranscript(file: string, line: string, mtime: Date): void {
  const transcript = path.join(projectDir, file);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${line}\n`);
  fs.utimesSync(transcript, mtime, mtime);
}

beforeEach(() => {
  fs.rmSync(path.join(fixture, '.claude'), { recursive: true, force: true });
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
});
after(() => {
  killMock.mock.restore();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('sessions that share a folder each report the activity of their own transcript', () => {
  writeSession('a.json', 'session-a', 101);
  writeSession('b.json', 'session-b', 102);
  writeTranscript('session-a.jsonl', toolUseLine('Read', { file_path: '/x.ts' }), new Date(Date.now() - 60_000));
  writeTranscript('session-b.jsonl', toolUseLine('Edit', { file_path: '/x.ts' }), new Date());

  const activityById = new Map(detectAgents().map((agent) => [agent.id, agent.activity]));

  assert.equal(activityById.get('session-a'), 'researching');
  assert.equal(activityById.get('session-b'), 'implementing');
});

test('a session without its own transcript does not borrow the transcript of another session', () => {
  writeSession('a.json', 'session-a', 101);
  writeTranscript('other-session.jsonl', toolUseLine('Bash', { command: 'git push' }), new Date());

  assert.equal(detectAgents()[0].activity, 'idle');
});

test('a session ID that is not a plain file name never selects a transcript', () => {
  writeSession('a.json', '../escape', 101);
  writeTranscript('escape.jsonl', toolUseLine('Edit', { file_path: '/x.ts' }), new Date());

  assert.equal(detectAgents()[0].activity, 'idle');
});

test('an active subagent appears once, under the session that started it', () => {
  writeSession('a.json', 'session-a', 101);
  writeSession('b.json', 'session-b', 102);
  const subagentsDir = path.join(projectDir, 'session-a', 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(path.join(subagentsDir, 'agent-1.meta.json'), JSON.stringify({ description: 'Find the bug' }));
  writeTranscript(path.join('session-a', 'subagents', 'agent-1.jsonl'), toolUseLine('Grep', {}), new Date());

  const subagents = detectAgents().filter((agent) => agent.parentId);

  assert.equal(subagents.length, 1);
  assert.equal(subagents[0].parentId, 'session-a');
});

test('a tool call whose line crosses a read-chunk edge is still the newest activity', () => {
  writeSession('a.json', 'session-a', 101);
  const older = toolUseLine('Read', { file_path: '/x.ts' });
  const newestToolCall = toolUseLine('Edit', { file_path: '/x.ts', new_string: 'e'.repeat(2_000) });
  const toolResult = JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', content: 'r'.repeat(49_000) }] } });
  writeTranscript('session-a.jsonl', `${older}\n${newestToolCall}\n${toolResult}`, new Date());

  assert.equal(detectAgents()[0].activity, 'implementing');
});

test('a newest line longer than one read chunk is still parsed', () => {
  writeSession('a.json', 'session-a', 101);
  const older = toolUseLine('Read', { file_path: '/x.ts' });
  const newest = toolUseLine('Write', { file_path: '/x.ts', content: 'w'.repeat(1_200_000) });
  writeTranscript('session-a.jsonl', `${older}\n${newest}`, new Date());

  assert.equal(detectAgents()[0].activity, 'implementing');
});

test('a session in a folder with a dot in its path finds its transcript and subagents', () => {
  const dottedCwd = '/work/my.app';
  const dottedDir = path.join(fixture, '.claude', 'projects', '-work-my-app');
  fs.writeFileSync(path.join(sessions, 'd.json'), JSON.stringify({ pid: 103, sessionId: 'session-d', cwd: dottedCwd, startedAt: 1 }));
  fs.mkdirSync(path.join(dottedDir, 'session-d', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dottedDir, 'session-d.jsonl'), `${toolUseLine('Read', {})}\n`);
  fs.writeFileSync(path.join(dottedDir, 'session-d', 'subagents', 'agent-9.meta.json'), JSON.stringify({ description: 'Look' }));
  fs.writeFileSync(path.join(dottedDir, 'session-d', 'subagents', 'agent-9.jsonl'), `${toolUseLine('Grep', {})}\n`);

  const agents = detectAgents();

  assert.equal(agents.find((agent) => agent.id === 'session-d')?.activity, 'researching');
  assert.equal(agents.filter((agent) => agent.parentId === 'session-d').length, 1);
});

test('a session whose folder uses the older encoding with the dot kept still finds its transcript', () => {
  const legacyDir = path.join(fixture, '.claude', 'projects', '-work-old.app');
  fs.writeFileSync(path.join(sessions, 'e.json'), JSON.stringify({ pid: 104, sessionId: 'session-e', cwd: '/work/old.app', startedAt: 1 }));
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'session-e.jsonl'), `${toolUseLine('Read', {})}\n`);

  assert.equal(detectAgents().find((agent) => agent.id === 'session-e')?.activity, 'researching');
});

function writeSessionWithStatus(sessionId: string, status: string | undefined, lastLine: string): void {
  const session: Record<string, unknown> = { pid: 101, sessionId, cwd, startedAt: 1 };
  if (status !== undefined) session.status = status;
  fs.writeFileSync(path.join(sessions, `${sessionId}.json`), JSON.stringify(session));
  writeTranscript(`${sessionId}.jsonl`, lastLine, new Date());
}

const textOnlyLine = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });

for (const [status, lastLine, expected] of [
  ['waiting', toolUseLine('Edit', { file_path: '/x.ts' }), 'meeting'],
  ['idle', toolUseLine('Edit', { file_path: '/x.ts' }), 'idle'],
  ['busy', textOnlyLine, 'planning'],
  ['busy', toolUseLine('Read', {}), 'researching'],
  ['shell', toolUseLine('Read', {}), 'researching'],
  [undefined, toolUseLine('Edit', { file_path: '/x.ts' }), 'implementing'],
  [undefined, textOnlyLine, 'idle'],
] as const) {
  test(`session status ${status ?? 'missing'} with a ${lastLine === textOnlyLine ? 'text' : 'tool'} tail gives ${expected}`, () => {
    writeSessionWithStatus('session-s', status, lastLine);
    assert.equal(detectAgents()[0].activity, expected);
  });
}

test('the API never returns the raw session status', () => {
  writeSessionWithStatus('session-s', 'waiting', textOnlyLine);
  assert.equal('status' in detectAgents()[0], false);
});

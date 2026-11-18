import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-session-test-'));
const sessions = path.join(fixture, '.claude', 'sessions');
fs.mkdirSync(sessions, { recursive: true });
// Import only after redirecting discovery to synthetic metadata.
const homeMock = mock.method(os, 'homedir', () => fixture);
const { detectAgents } = await import('../server/agentDetector.js');
homeMock.mock.restore();
const probes: Array<[number, NodeJS.Signals | number | undefined]> = [];
const killMock = mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
  probes.push([pid, signal]);
  return true as const;
});
const valid = { pid: 12345, sessionId: 'synthetic-session', cwd: '/work/synthetic-project', startedAt: 1 };
function writeSession(value: unknown): void {
  fs.writeFileSync(path.join(sessions, 'test.json'), JSON.stringify(value));
}
beforeEach(() => {
  for (const name of fs.readdirSync(sessions)) fs.unlinkSync(path.join(sessions, name));
  probes.length = 0;
});
after(() => {
  killMock.mock.restore();
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('a valid session uses a zero-signal process probe and remains discoverable', () => {
  writeSession(valid);
  const agents = detectAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, 'synthetic-project');
  assert.deepEqual(probes, [[valid.pid, 0]]);
});

test('untrusted PID values never reach a process probe or a shell', () => {
  const marker = path.join(fixture, 'must-not-exist');
  for (const pid of [`0; printf injected > ${marker}`, '12345', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, {}, []]) {
    writeSession({ ...valid, pid });
    assert.deepEqual(detectAgents(), [], `accepted PID ${JSON.stringify(pid)}`);
  }
  assert.deepEqual(probes, []);
  assert.equal(fs.existsSync(marker), false);
});

test('malformed session fields are skipped before any process probe', () => {
  for (const value of [null, [], {}, { ...valid, sessionId: '' }, { ...valid, sessionId: 42 },
    { ...valid, cwd: null }, { ...valid, cwd: '..' }, { ...valid, cwd: '/tmp/\0bad' },
    { ...valid, startedAt: 'yesterday' }, { ...valid, startedAt: -1 }]) {
    writeSession(value);
    assert.deepEqual(detectAgents(), [], `accepted metadata ${JSON.stringify(value)}`);
  }
  fs.writeFileSync(path.join(sessions, 'test.json'), '{ invalid JSON');
  assert.deepEqual(detectAgents(), []);
  assert.deepEqual(probes, []);
});

test('dead processes are excluded without breaking discovery', () => {
  writeSession(valid);
  killMock.mock.mockImplementation(() => { throw Object.assign(new Error('not found'), { code: 'ESRCH' }); });
  assert.deepEqual(detectAgents(), []);
  killMock.mock.mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
    probes.push([pid, signal]);
    return true as const;
  });
});

test('permission denial still counts as a live process', () => {
  writeSession(valid);
  killMock.mock.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  assert.equal(detectAgents().length, 1);
});

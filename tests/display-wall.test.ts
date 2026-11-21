import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_SESSION_ROWS, sessionLines, sessionRows, sessionState, type SessionEntry } from '../src/addons/building/displayWall.js';

test('AC3: a session that calls for you (a fresh wait) reads as "waiting"', () => {
  assert.equal(sessionState({ attention: 'waiting', waitMinutes: 2 }), 'waiting');
  assert.equal(sessionState({ attention: 'your-turn', waitMinutes: 1 }), 'waiting');
});

test('AC3: busy with no transcript write for a long while reads as "blocked", stuck wins over a wait', () => {
  assert.equal(sessionState({ stuck: true }), 'blocked');
  assert.equal(sessionState({ stuck: true, attention: 'waiting', waitMinutes: 1 }), 'blocked');
});

test('AC3: an aging or cold wait, or no wait at all, reads as plain "working"', () => {
  assert.equal(sessionState({ attention: 'waiting', waitMinutes: 60 }), 'working');
  assert.equal(sessionState(undefined), 'working');
  assert.equal(sessionState({}), 'working');
});

test('an orchestrator whose own subagent still runs never reads as "waiting" (same rule the beacon uses)', () => {
  assert.equal(sessionState({ attention: 'your-turn', orchestrating: true, waitMinutes: 1 }), 'working');
});

test('sessionRows ranks blocked first, then waiting, then working, and caps at MAX_SESSION_ROWS', () => {
  const entries: SessionEntry[] = [
    { id: 'a', name: 'alpha', extras: {} },
    { id: 'b', name: 'beta', extras: { stuck: true } },
    { id: 'c', name: 'gamma', extras: { attention: 'waiting', waitMinutes: 1 } },
    { id: 'd', name: 'delta', extras: {} },
    { id: 'e', name: 'epsilon', extras: {} },
  ];
  const rows = sessionRows(entries, 3);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.state), ['blocked', 'waiting', 'working']);
  assert.equal(rows[0].id, 'b');
  assert.equal(rows[1].id, 'c');
});

test('MAX_SESSION_ROWS is sessionRows\' own default cap', () => {
  const entries: SessionEntry[] = Array.from({ length: MAX_SESSION_ROWS + 5 }, (_, i) => ({ id: `s${i}`, name: `s${i}` }));
  assert.equal(sessionRows(entries).length, MAX_SESSION_ROWS);
});

test('sessionLines: one marked line per row, a plain placeholder with none at all', () => {
  const rows = sessionRows([{ id: 'a', name: 'alpha', extras: { stuck: true } }, { id: 'b', name: 'beta' }]);
  assert.deepEqual(sessionLines(rows), ['■ alpha — blocked', '○ beta — working']);
  assert.deepEqual(sessionLines([]), ['No live sessions']);
});

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { formatDuration, missionBoardLines } = await import('../src/addons/building/missionsBoard.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

// --- Issue #144: a small board near the mission corridor, missions closed and running ---

test('formatDuration reads coarse: minutes, then hours, then days', () => {
  assert.equal(formatDuration(5 * 60_000), '5m');
  assert.equal(formatDuration(135 * 60_000), '2h 15m');
  assert.equal(formatDuration((3 * 24 + 4) * 3_600_000), '3d 4h');
  assert.equal(formatDuration(-1000), '0m', 'never a negative duration');
});

test('AC1: a running mission shows its elapsed time, computed from when it started', () => {
  const now = Date.parse('2026-11-20T02:15:00Z');
  const created = '2026-11-20T00:00:00Z'; // 2h 15m before "now"
  const lines = missionBoardLines([{ title: 'Office roadmap', state: 'open', createdAt: created }], now);
  assert.deepEqual(lines, ['○ Office roadmap — running 2h 15m']);
});

test('AC1: the elapsed time moves as time passes', () => {
  const created = '2026-11-20T00:00:00Z';
  const mission = { title: 'Office roadmap', state: 'open' as const, createdAt: created };
  const first = missionBoardLines([mission], Date.parse('2026-11-20T00:05:00Z'))[0];
  const later = missionBoardLines([mission], Date.parse('2026-11-20T00:20:00Z'))[0];
  assert.notEqual(first, later);
  assert.match(first, /5m/);
  assert.match(later, /20m/);
});

test('AC2: a closed mission shows its total running time, and does not disappear once closed', () => {
  const mission = { title: 'Old mission', state: 'locked' as const, createdAt: '2026-11-18T00:00:00Z', closedAt: '2026-11-18T03:30:00Z' };
  const atCloseTime = missionBoardLines([mission], Date.parse('2026-11-18T03:30:00Z'))[0];
  const muchLater = missionBoardLines([mission], Date.parse('2026-12-01T00:00:00Z'))[0];
  assert.equal(atCloseTime, '✓ Old mission — closed, ran 3h 30m');
  assert.equal(muchLater, atCloseTime, 'a closed mission\'s duration is fixed, and it is still listed');
});

test('AC3: no missions yet shows an empty state, not an error', () => {
  assert.deepEqual(missionBoardLines([], Date.now()), []);
});

test('a mission with no known createdAt still lists, as "unknown" rather than a bad calculation', () => {
  const lines = missionBoardLines([{ title: 'No dates', state: 'open' }], Date.now());
  assert.deepEqual(lines, ['○ No dates — running unknown']);
});

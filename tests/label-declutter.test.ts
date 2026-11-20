import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declutterLabels, labelPriority, labelRect, type DeclutterCandidate, type Rect } from '../src/ui/LabelDeclutter.js';

// --- labelPriority: selected > hovered > fresh wait > stuck > aging wait > cold > working > idle ---

function facts(overrides: Partial<Parameters<typeof labelPriority>[0]> = {}) {
  return { selected: false, hovered: false, stuck: false, attention: undefined, waitMinutes: undefined, idle: false, ...overrides };
}

test('priority order: selected, then hovered, beat everything else', () => {
  assert.equal(labelPriority(facts({ selected: true, attention: 'waiting', waitMinutes: 5 })), 0);
  assert.equal(labelPriority(facts({ hovered: true, stuck: true })), 1);
  assert.ok(labelPriority(facts({ selected: true })) < labelPriority(facts({ hovered: true })));
});

test('a fresh wait (under 15 min, or no known wait time) outranks a stuck mark', () => {
  const fresh = labelPriority(facts({ attention: 'waiting', waitMinutes: 5 }));
  const freshUnknown = labelPriority(facts({ attention: 'your-turn' }));
  const stuck = labelPriority(facts({ stuck: true }));
  assert.ok(fresh < stuck);
  assert.ok(freshUnknown < stuck, 'without a wait time: the old behavior, treated as fresh');
});

test('an aging wait outranks a cold wait, which outranks a working agent, which outranks an idle one', () => {
  const aging = labelPriority(facts({ attention: 'waiting', waitMinutes: 60 }));
  const cold = labelPriority(facts({ attention: 'waiting', waitMinutes: 2 * 24 * 60 }));
  const working = labelPriority(facts({ idle: false }));
  const idle = labelPriority(facts({ idle: true }));
  assert.ok(aging < cold);
  assert.ok(cold < working);
  assert.ok(working < idle);
});

// --- declutterLabels: the pure geometry, rects in, a visible-id set out ---

const box = (left: number, top: number, width = 100, height = 20): Rect => ({ left, top, right: left + width, bottom: top + height });

function candidate(id: string, rect: Rect, priority: number, waitMinutes = -1): DeclutterCandidate {
  return { id, rect, priority, waitMinutes };
}

test('two labels that do not overlap both stay visible, whatever their priority', () => {
  const visible = declutterLabels([
    candidate('a', box(0, 0), 7),
    candidate('b', box(500, 500), 0),
  ]);
  assert.deepEqual([...visible].sort(), ['a', 'b']);
});

test('two overlapping labels: only the higher priority (lower number) one stays', () => {
  const visible = declutterLabels([
    candidate('low', box(0, 0), 6),
    candidate('high', box(10, 5), 2),
  ]);
  assert.deepEqual([...visible], ['high']);
});

test('a cluster of three overlapping labels keeps only the single highest-priority one', () => {
  const visible = declutterLabels([
    candidate('a', box(0, 0), 4),
    candidate('b', box(5, 2), 1),
    candidate('c', box(8, 4), 7),
  ]);
  assert.deepEqual([...visible], ['b']);
});

test('a tie in priority breaks by the longer wait', () => {
  const visible = declutterLabels([
    candidate('short-wait', box(0, 0), 4, 5),
    candidate('long-wait', box(10, 5), 4, 400),
  ]);
  assert.deepEqual([...visible], ['long-wait']);
});

test('labelRect sizes a full label larger than a compact one, both centered on the point', () => {
  const full = labelRect(100, 50, 'full');
  const compact = labelRect(100, 50, 'compact');
  assert.ok(full.right - full.left > compact.right - compact.left, 'full is wider');
  assert.ok(full.bottom - full.top > compact.bottom - compact.top, 'full is taller');
  assert.equal((full.left + full.right) / 2, 100);
  assert.equal((full.top + full.bottom) / 2, 50);
});

test('declutterLabels never keeps state: a candidate missing from one call is simply absent from the result, not remembered', () => {
  const first = declutterLabels([candidate('a', box(0, 0), 4), candidate('b', box(5, 2), 1)]);
  assert.deepEqual([...first], ['b']);
  const second = declutterLabels([candidate('a', box(0, 0), 4)]);
  assert.deepEqual([...second], ['a'], 'with "b" gone, "a" is free to show again, with no memory of the last call');
});

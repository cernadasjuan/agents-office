import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attentionEnricher } from '../server/attention.js';
import { tabTitle } from '../src/ui/attention.js';
import type { Observation } from '../server/seam.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

function session(status: string | undefined, minutesAgo?: number, parentId?: string): Observation {
  return { id: `s-${status}-${minutesAgo}`, provider: 'claude', name: 'agent', activity: 'idle',
    ...(status ? { status } : {}), ...(minutesAgo !== undefined ? { statusSince: NOW - minutesAgo * 60_000 } : {}),
    ...(parentId ? { parentId } : {}), internal: {}, display: {} };
}

test('a waiting session is blocked on you, with its wait in minutes', async () => {
  const list = [session('waiting', 12)];
  await attentionEnricher(() => NOW).enrich(list);
  assert.deepEqual(list[0].display, { attention: 'waiting', waitMinutes: 12 });
});

test('an idle session is your turn, with the minutes since its last reply', async () => {
  const list = [session('idle', 3)];
  await attentionEnricher(() => NOW).enrich(list);
  assert.deepEqual(list[0].display, { attention: 'your-turn', waitMinutes: 3 });
});

test('busy, unknown or missing status needs no attention', async () => {
  const list = [session('busy', 1), session('shell', 1), session(undefined)];
  await attentionEnricher(() => NOW).enrich(list);
  assert.ok(list.every((o) => o.display.attention === undefined));
});

test('a status without a timestamp still gets attention, without minutes', async () => {
  const list = [session('waiting')];
  await attentionEnricher(() => NOW).enrich(list);
  assert.deepEqual(list[0].display, { attention: 'waiting' });
});

test('subagents never ask for attention', async () => {
  const list = [session('waiting', 2, 'parent')];
  await attentionEnricher(() => NOW).enrich(list);
  assert.equal(list[0].display.attention, undefined);
});

test('the tab title counts blocked agents first, then your turn', () => {
  assert.equal(tabTitle(0, 0), 'Agents Office');
  assert.equal(tabTitle(2, 0), '(2) Agents Office');
  assert.equal(tabTitle(2, 5), '(2) +5 · Agents Office');
  assert.equal(tabTitle(0, 5), '+5 · Agents Office');
});

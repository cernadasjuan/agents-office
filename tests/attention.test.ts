import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attentionEnricher } from '../server/attention.js';
import { oldestFreshWait, tabTitle, type Wait } from '../src/ui/attention.js';
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

// --- Orchestrating (issue #168): tell an agent that finished its own turn and now waits on its
// own busy subagents from one that is genuinely idle with nothing running under it ---

test('an idle session with an active subagent is orchestrating, not a plain your-turn', async () => {
  const parent = session('idle', 3);
  const child = session('busy', 0, parent.id);
  const list = [parent, child];
  await attentionEnricher(() => NOW).enrich(list);
  assert.equal(list[0].display.attention, 'your-turn');
  assert.equal(list[0].display.orchestrating, true);
});

test('an idle session with no subagents at all is not orchestrating (the plain your-turn case)', async () => {
  const list = [session('idle', 3)];
  await attentionEnricher(() => NOW).enrich(list);
  assert.equal(list[0].display.attention, 'your-turn');
  assert.equal(list[0].display.orchestrating, undefined);
});

test('a waiting (blocked) session is never orchestrating, even with a subagent under it', async () => {
  const parent = session('waiting', 3);
  const child = session('busy', 0, parent.id);
  const list = [parent, child];
  await attentionEnricher(() => NOW).enrich(list);
  assert.equal(list[0].display.attention, 'waiting');
  assert.equal(list[0].display.orchestrating, undefined);
});

test('a subagent itself never gets the orchestrating flag either (subagents never ask)', async () => {
  const parent = session('idle', 3);
  const child = session('busy', 0, parent.id);
  const grandchild = session('busy', 1, child.id);
  const list = [parent, child, grandchild];
  await attentionEnricher(() => NOW).enrich(list);
  assert.equal(list[1].display.attention, undefined);
  assert.equal(list[1].display.orchestrating, undefined);
});

test('the tab title counts blocked agents first, then your turn', () => {
  assert.equal(tabTitle(0, 0), 'Agents Office');
  assert.equal(tabTitle(2, 0), '(2) Agents Office');
  assert.equal(tabTitle(2, 5), '(2) +5 · Agents Office');
  assert.equal(tabTitle(0, 5), '+5 · Agents Office');
});

function wait(id: string, waitMinutes?: number): { id: string; extras: Wait } {
  return { id, extras: { attention: 'waiting', waitMinutes } };
}

test('the oldest fresh wait is the fresh agent that has waited the longest', () => {
  const agents = [wait('a', 2), wait('b', 12), wait('c', 5)];
  assert.equal(oldestFreshWait(agents)?.id, 'b');
});

test('an aging or cold wait never wins over a fresh one, even with a longer wait', () => {
  const agents = [wait('fresh', 10), wait('aging', 60), wait('cold', 2000)];
  assert.equal(oldestFreshWait(agents)?.id, 'fresh');
});

test('without any fresh wait, there is no oldest fresh wait', () => {
  const agents = [wait('aging', 60), wait('cold', 2000)];
  assert.equal(oldestFreshWait(agents), undefined);
});

test('an empty list has no oldest fresh wait', () => {
  assert.equal(oldestFreshWait([]), undefined);
});

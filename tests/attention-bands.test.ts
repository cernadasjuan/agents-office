import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { attentionEnricher } from '../server/attention.js';
import {
  ATTENTION_BANDS,
  attentionBand,
  callsForYou,
  compareWaits,
  countsInTab,
  nextInQueue,
  queueBucket,
  queuesForYou,
  tabTitleFor,
  triageQueue,
} from '../src/ui/attention.js';
import type { Observation } from '../server/seam.js';
import type { AgentInfo } from '../src/agents/AgentData.js';

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

function waitedFor(status: string, seconds?: number): Observation {
  return { id: `s-${seconds}`, provider: 'claude', name: 'agent', activity: 'idle', status,
    ...(seconds !== undefined ? { statusSince: NOW - seconds * 1000 } : {}), internal: {}, display: {} };
}

async function bandAfter(status: string, seconds?: number) {
  const list = [waitedFor(status, seconds)];
  await attentionEnricher(() => NOW).enrich(list);
  return attentionBand(list[0].display);
}

test('the thresholds live in one constant: fresh under 15 min, cold from 24 h', () => {
  assert.deepEqual(ATTENTION_BANDS, { freshUnderMinutes: 15, coldFromMinutes: 24 * 60 });
});

test('each band edge falls in the right band, for a block and for your turn', async () => {
  for (const status of ['waiting', 'idle']) {
    assert.equal(await bandAfter(status, 14 * 60 + 59), 'fresh', `${status} 14:59`);
    assert.equal(await bandAfter(status, 15 * 60), 'aging', `${status} 15:00`);
    assert.equal(await bandAfter(status, 24 * 3600 - 1), 'aging', `${status} 23:59:59`);
    assert.equal(await bandAfter(status, 24 * 3600), 'cold', `${status} 24:00:00`);
  }
});

test('a fresh wait calls for you: beacon, queue and tab count', () => {
  for (const attention of ['waiting', 'your-turn'] as const) {
    const extras = { attention, waitMinutes: 3 };
    assert.equal(callsForYou(extras), true, attention);
    assert.equal(queuesForYou(extras), true, attention);
    assert.equal(countsInTab(extras), true, attention);
  }
});

test('an aging wait stays in the queue, with no beacon and no tab count', () => {
  for (const attention of ['waiting', 'your-turn'] as const) {
    const extras = { attention, waitMinutes: 120 };
    assert.equal(callsForYou(extras), false, attention);
    assert.equal(queuesForYou(extras), true, attention);
    assert.equal(countsInTab(extras), false, attention);
  }
});

test('a cold wait leaves the queue and the tab count', () => {
  for (const attention of ['waiting', 'your-turn'] as const) {
    const extras = { attention, waitMinutes: 3 * 24 * 60 };
    assert.equal(attentionBand(extras), 'cold');
    assert.equal(callsForYou(extras), false, attention);
    assert.equal(queuesForYou(extras), false, attention);
    assert.equal(countsInTab(extras), false, attention);
  }
});

test('without a wait time a session keeps the old behavior (S8)', async () => {
  assert.equal(await bandAfter('waiting'), undefined);
  const blocked = { attention: 'waiting' as const };
  const yourTurn = { attention: 'your-turn' as const };
  assert.equal(callsForYou(blocked), true, 'a block keeps its beacon');
  assert.equal(queuesForYou(blocked), true, 'a block keeps its queue spot');
  assert.equal(countsInTab(blocked), true);
  assert.equal(callsForYou(yourTurn), false, 'your turn keeps no beacon');
  assert.equal(queuesForYou(yourTurn), false, 'your turn keeps no queue spot');
  assert.equal(countsInTab(yourTurn), true);
  assert.equal(attentionBand(undefined), undefined);
  assert.equal(callsForYou(undefined), false);
});

test('the queue puts fresh before aging, and the oldest wait first inside each band', () => {
  const waits = [
    { id: 'aging-young', waitMinutes: 20 },
    { id: 'fresh-young', waitMinutes: 1 },
    { id: 'aging-old', waitMinutes: 600 },
    { id: 'fresh-old', waitMinutes: 14 },
  ].map(({ id, waitMinutes }) => ({ id, extras: { attention: 'waiting' as const, waitMinutes } }));
  const ordered = [...waits].sort((a, b) => compareWaits(a.extras, b.extras)).map((w) => w.id);
  assert.deepEqual(ordered, ['fresh-old', 'fresh-young', 'aging-old', 'aging-young']);
});

test('key N (issue #85): the queue holds only the fresh and aging bands', () => {
  const agents = [
    { id: 'cold-1', name: 'cold-1', extras: { attention: 'waiting' as const, waitMinutes: 3 * 24 * 60 } },
    { id: 'aging-young', name: 'aging-young', extras: { attention: 'waiting' as const, waitMinutes: 20 } },
    { id: 'fresh-young', name: 'fresh-young', extras: { attention: 'your-turn' as const, waitMinutes: 1 } },
    { id: 'idle', name: 'idle', extras: undefined },
  ];
  assert.deepEqual(triageQueue(agents).map((a) => a.id).sort(), ['aging-young', 'fresh-young']);
});

test('issue #85 fix: key N lists every Needs-you agent before any Your-turn agent, matching the panel’s group order', () => {
  // A fresh Needs-you wait (short) must still come before a far longer Your-turn wait.
  const agents = [
    { id: 'your-turn-long-wait', name: 'your-turn-long-wait', extras: { attention: 'your-turn' as const, waitMinutes: 600 } },
    { id: 'needs-you-fresh', name: 'needs-you-fresh', extras: { attention: 'waiting' as const, waitMinutes: 2 } },
    { id: 'your-turn-short-wait', name: 'your-turn-short-wait', extras: { attention: 'your-turn' as const, waitMinutes: 1 } },
    { id: 'needs-you-aging', name: 'needs-you-aging', extras: { attention: 'waiting' as const, waitMinutes: 30 } },
  ];
  assert.deepEqual(triageQueue(agents).map((a) => a.id),
    ['needs-you-fresh', 'needs-you-aging', 'your-turn-short-wait', 'your-turn-long-wait']);
});

test('issue #86 follow-up: key N breaks an equal-wait tie the same way the panel does, by name', () => {
  // Zulu, Mike and Alpha arrive in that order, all waiting the same 2 minutes.
  // The panel lists them Alpha, Mike, Zulu (byName); N must cycle them the same way.
  const agents = [
    { id: 'zulu', name: 'Zulu', extras: { attention: 'waiting' as const, waitMinutes: 2 } },
    { id: 'mike', name: 'Mike', extras: { attention: 'waiting' as const, waitMinutes: 2 } },
    { id: 'alpha', name: 'Alpha', extras: { attention: 'waiting' as const, waitMinutes: 2 } },
  ];
  assert.deepEqual(triageQueue(agents).map((a) => a.id), ['alpha', 'mike', 'zulu']);
});

test('issue #85 fix: queueBucket is the one function behind both the panel’s groups and key N’s queue', () => {
  assert.equal(queueBucket({ attention: 'waiting', waitMinutes: 2 }), 'needs-you');
  assert.equal(queueBucket({ attention: 'your-turn', waitMinutes: 2 }), 'your-turn');
  assert.equal(queueBucket({ attention: 'waiting', waitMinutes: 2 * 24 * 60 }), undefined, 'a cold wait is not queued');
  assert.equal(queueBucket(undefined), undefined);
});

test('key N: from no selection, the next agent is the first in queue', () => {
  const queue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(nextInQueue(queue, null)?.id, 'a');
});

test('key N: steps to the next agent, and cycles from the last back to the first', () => {
  const queue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(nextInQueue(queue, 'a')?.id, 'b');
  assert.equal(nextInQueue(queue, 'b')?.id, 'c');
  assert.equal(nextInQueue(queue, 'c')?.id, 'a', 'cycles back to the first');
});

test('key N: a selection that left the queue (clicked, or moved to cold) restarts at the first', () => {
  const queue = [{ id: 'a' }, { id: 'b' }];
  assert.equal(nextInQueue(queue, 'gone')?.id, 'a');
});

test('key N: an empty queue (cold start, nobody needs you) selects nothing', () => {
  assert.equal(nextInQueue([], null), null);
  assert.equal(nextInQueue([], 'a'), null);
});

test('the tab title counts fresh blocks, then fresh your-turn waits', () => {
  assert.equal(tabTitleFor([
    { attention: 'waiting', waitMinutes: 2 },
    { attention: 'waiting', waitMinutes: 200 },
    { attention: 'your-turn', waitMinutes: 5 },
    { attention: 'your-turn', waitMinutes: 3000 },
    undefined,
  ]), '(1) +1 · Agents Office');
});

test('replay of the 2026-11-19 snapshot: the tab shows at most 1, not (6) +22', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/attention-replay-2026-11-19.json', import.meta.url), 'utf8')) as { agents: AgentInfo[] };
  const flagged = fixture.agents.filter((agent) => agent.extras?.attention !== undefined);
  assert.equal(fixture.agents.length, 38);
  assert.equal(flagged.filter((agent) => (agent.extras!.waitMinutes ?? 0) < 60).length, 1);

  const withoutWaits = fixture.agents.map((agent) => (agent.extras ? { attention: agent.extras.attention } : undefined));
  assert.equal(tabTitleFor(withoutWaits), '(6) +22 · Agents Office', 'the old count, for reference');

  const title = tabTitleFor(fixture.agents.map((agent) => agent.extras));
  assert.equal(title, '+1 · Agents Office');
  const bands = flagged.map((agent) => attentionBand(agent.extras));
  assert.deepEqual(['fresh', 'aging', 'cold'].map((band) => bands.filter((b) => b === band).length), [1, 7, 20]);
});

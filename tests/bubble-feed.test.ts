import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUBBLE_CAP, BUBBLE_DURATION_MS, BUBBLE_RATE_LIMIT_MS, BubbleScheduler } from '../plugins/peek/bubbleFeed.js';

const ctx = (now: number, selectedId: string | null = null, hotIds: ReadonlySet<string> = new Set()) => ({ now, selectedId, hotIds });

test('AC1: a bubble shows, then is gone after its 5 s life', () => {
  const scheduler = new BubbleScheduler();
  scheduler.ingest(new Map([['a', { kind: 'text' as const, text: 'hi' }]]), 0);
  assert.deepEqual(scheduler.winners(ctx(0)).map((w) => w.agentId), ['a']);
  assert.deepEqual(scheduler.winners(ctx(BUBBLE_DURATION_MS - 1)).map((w) => w.agentId), ['a']);
  assert.deepEqual(scheduler.winners(ctx(BUBBLE_DURATION_MS)).map((w) => w.agentId), []);
});

test('AC1: opacity eases to 0 over the last stretch of the life, 1 while fresh', () => {
  const scheduler = new BubbleScheduler();
  scheduler.ingest(new Map([['a', { kind: 'text' as const, text: 'hi' }]]), 0);
  assert.equal(scheduler.winners(ctx(0))[0].opacity, 1);
  const fading = scheduler.winners(ctx(BUBBLE_DURATION_MS - 500))[0].opacity;
  assert.ok(fading > 0 && fading < 1, String(fading));
});

test('AC2: at most BUBBLE_CAP at once, selected first, then hot attention, then the newest', () => {
  const scheduler = new BubbleScheduler();
  const events = new Map(Array.from({ length: BUBBLE_CAP + 3 }, (_, i) => [`agent-${i}`, { kind: 'text' as const, text: `line ${i}` }]));
  scheduler.ingest(events, 0);
  const winners = scheduler.winners(ctx(0, null, new Set()));
  assert.equal(winners.length, BUBBLE_CAP);

  const selected = new BubbleScheduler();
  selected.ingest(events, 0);
  const withSelection = selected.winners(ctx(0, 'agent-0', new Set(['agent-1'])));
  assert.equal(withSelection[0].agentId, 'agent-0', 'the selected agent always wins a slot');
  assert.equal(withSelection[1].agentId, 'agent-1', 'a hot-attention agent is next');
});

test('AC2: without a selection or hot attention, the newest bubbles win the cap', () => {
  const scheduler = new BubbleScheduler();
  scheduler.ingest(new Map([['old', { kind: 'text' as const, text: 'old' }]]), 0);
  scheduler.ingest(new Map([['new', { kind: 'text' as const, text: 'new' }]]), 1000);
  const winners = scheduler.winners(ctx(1000));
  assert.deepEqual(winners.map((w) => w.agentId), ['new', 'old']);
});

test('AC3: at most one bubble per agent per 8 s, even with several events in between', () => {
  const scheduler = new BubbleScheduler();
  scheduler.ingest(new Map([['a', { kind: 'text' as const, text: 'first' }]]), 0);
  scheduler.ingest(new Map([['a', { kind: 'text' as const, text: 'second' }]]), 1000);
  assert.equal(scheduler.winners(ctx(1000))[0]?.text, 'first', 'the rate limit holds the first line, not the newest');
  scheduler.ingest(new Map([['a', { kind: 'text' as const, text: 'third' }]]), BUBBLE_RATE_LIMIT_MS);
  assert.equal(scheduler.winners(ctx(BUBBLE_RATE_LIMIT_MS))[0]?.text, 'third', 'once the rate limit passes, a new line replaces it');
});

test('a tool call event carries kind "tool" through to the winner', () => {
  const scheduler = new BubbleScheduler();
  scheduler.ingest(new Map([['a', { kind: 'tool', text: 'Bash · git commit' }]]), 0);
  assert.equal(scheduler.winners(ctx(0))[0]?.kind, 'tool');
});

test('forget(): an agent no longer known loses its bubble and its rate-limit memory', () => {
  const scheduler = new BubbleScheduler();
  scheduler.ingest(new Map([['a', { kind: 'text' as const, text: 'hi' }]]), 0);
  scheduler.forget(new Set());
  assert.deepEqual(scheduler.winners(ctx(0)), []);
  // The rate limit is forgotten too: the same agent id (perhaps reused after a reload) can
  // bubble again immediately, not wait out the old agent's 8 s window.
  scheduler.ingest(new Map([['a', { kind: 'text' as const, text: 'again' }]]), 1);
  assert.equal(scheduler.winners(ctx(1))[0]?.text, 'again');
});

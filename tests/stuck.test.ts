import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stuckEnricher } from '../server/stuck.js';
import type { Observation } from '../server/seam.js';

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

function session(status: string | undefined, transcriptPath?: string, parentId?: string): Observation {
  return {
    id: `s-${status}-${transcriptPath ?? 'none'}`,
    provider: 'claude',
    name: 'agent',
    activity: 'implementing',
    ...(status ? { status } : {}),
    ...(parentId ? { parentId } : {}),
    internal: { ...(transcriptPath ? { transcriptPath } : {}) },
    display: {},
  };
}

function mtimeMap(map: Record<string, number>) {
  return (path: string) => map[path];
}

test('a busy session with no write for 60 min is stuck', async () => {
  const list = [session('busy', 't.jsonl')];
  await stuckEnricher(() => NOW, mtimeMap({ 't.jsonl': NOW - 60 * 60_000 })).enrich(list);
  assert.equal(list[0].display.stuck, true);
});

test('a busy session with no write for 59 min is not stuck', async () => {
  const list = [session('busy', 't.jsonl')];
  await stuckEnricher(() => NOW, mtimeMap({ 't.jsonl': NOW - 59 * 60_000 })).enrich(list);
  assert.equal(list[0].display.stuck, undefined);
});

test('a long tool call with a recent write is not stuck', async () => {
  const list = [session('busy', 't.jsonl')];
  await stuckEnricher(() => NOW, mtimeMap({ 't.jsonl': NOW - 5 * 60_000 })).enrich(list);
  assert.equal(list[0].display.stuck, undefined);
});

test('a stuck session clears the mark once it writes again', async () => {
  const enricher = stuckEnricher(() => NOW, mtimeMap({ 't.jsonl': NOW - 60 * 60_000 }));
  const stuckList = [session('busy', 't.jsonl')];
  await enricher.enrich(stuckList);
  assert.equal(stuckList[0].display.stuck, true);

  const recoveredList = [session('busy', 't.jsonl')];
  await stuckEnricher(() => NOW, mtimeMap({ 't.jsonl': NOW - 1 * 60_000 })).enrich(recoveredList);
  assert.equal(recoveredList[0].display.stuck, undefined);
});

test('waiting, idle and unknown status never get stuck', async () => {
  const list = [session('waiting', 't.jsonl'), session('idle', 't.jsonl'), session(undefined, 't.jsonl')];
  await stuckEnricher(() => NOW, mtimeMap({ 't.jsonl': NOW - 120 * 60_000 })).enrich(list);
  assert.ok(list.every((o) => o.display.stuck === undefined));
});

test('a session without a write time keeps the old behavior', async () => {
  const list = [session('busy')];
  await stuckEnricher(() => NOW, () => undefined).enrich(list);
  assert.equal(list[0].display.stuck, undefined);
});

test('subagents never get stuck', async () => {
  const list = [session('busy', 't.jsonl', 'parent')];
  await stuckEnricher(() => NOW, mtimeMap({ 't.jsonl': NOW - 120 * 60_000 })).enrich(list);
  assert.equal(list[0].display.stuck, undefined);
});

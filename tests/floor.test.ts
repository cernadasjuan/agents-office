import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Observation } from '../server/seam.js';
import { FloorResolver, floorEnricher, GENERAL_FLOOR } from '../server/floor.js';

// Synthetic repos in a temp folder, never the user's real ~/.claude or git checkouts.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-floor-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function makeRepo(name: string): string {
  const repo = path.join(root, 'repos', name);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  return repo;
}

function makeWorktree(mainRepo: string, name: string): string {
  const worktree = path.join(root, 'worktrees', name);
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(mainRepo, '.git', 'worktrees', name)}\n`);
  return worktree;
}

function agent(cwd: string | undefined): Observation {
  return { id: 'a', provider: 'claude', name: 'n', activity: 'implementing', internal: { cwd }, display: {} };
}

test('resolve finds the git root a few directories up and reports its name', () => {
  const repo = makeRepo('widget-service');
  const nested = path.join(repo, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(new FloorResolver().resolve(nested), 'widget-service');
});

test('resolve maps a worktree to its main repository, not the worktree folder name', () => {
  const repo = makeRepo('agents-office');
  const worktree = makeWorktree(repo, '118-floors-step1');

  assert.equal(new FloorResolver().resolve(worktree), 'agents-office');
});

test('a directory with no repository resolves to the general floor', () => {
  const plain = path.join(root, 'no-repo-here');
  fs.mkdirSync(plain, { recursive: true });

  assert.equal(new FloorResolver().resolve(plain), GENERAL_FLOOR);
});

test('a missing cwd resolves to the general floor', () => {
  assert.equal(new FloorResolver().resolve(undefined), GENERAL_FLOOR);
});

test('floorEnricher sets display.floor for every observation, subagents included', () => {
  const repo = makeRepo('kiosk-app');
  const observations = [agent(repo), { ...agent(repo), id: 'sub', parentId: 'a' }, agent(undefined)];

  floorEnricher(new FloorResolver()).enrich(observations);

  assert.equal(observations[0].display.floor, 'kiosk-app');
  assert.equal(observations[1].display.floor, 'kiosk-app', 'a subagent shares its parent cwd, so the same floor');
  assert.equal(observations[2].display.floor, GENERAL_FLOOR);
});

test('a resolved name caches by directory, so a second resolve for the same session does not re-walk the filesystem', () => {
  const repo = makeRepo('cache-check');
  const resolver = new FloorResolver();
  const lstatSync = fs.lstatSync;
  let calls = 0;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
    calls++;
    return lstatSync(...args);
  }) as typeof fs.lstatSync;
  try {
    resolver.resolve(repo);
    const callsAfterFirst = calls;
    resolver.resolve(repo);
    assert.equal(calls, callsAfterFirst, 'the second resolve for the same directory reused the cache');
  } finally {
    fs.lstatSync = lstatSync;
  }
});

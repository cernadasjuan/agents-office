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

function makeRepo(name: string, parent = 'repos'): string {
  const repo = path.join(root, parent, name);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  return repo;
}

function makeWorktree(mainRepo: string, name: string, gitdir?: string): string {
  const worktree = path.join(root, 'worktrees', name);
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitdir ?? path.join(mainRepo, '.git', 'worktrees', name)}\n`);
  return worktree;
}

function agent(cwd: string | undefined): Observation {
  return { id: 'a', provider: 'claude', name: 'n', activity: 'implementing', internal: { cwd }, display: {} };
}

test('resolve finds the git root a few directories up and reports it qualified by its parent directory', () => {
  const repo = makeRepo('widget-service');
  const nested = path.join(repo, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(new FloorResolver().resolve(nested), 'repos/widget-service');
});

test('resolve maps a worktree to its main repository, not the worktree folder name', () => {
  const repo = makeRepo('agents-office');
  const worktree = makeWorktree(repo, '118-floors-step1');

  assert.equal(new FloorResolver().resolve(worktree), 'repos/agents-office');
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

  assert.equal(observations[0].display.floor, 'repos/kiosk-app');
  assert.equal(observations[1].display.floor, 'repos/kiosk-app', 'a subagent shares its parent cwd, so the same floor');
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

// --- Review fixes ---

test('two repos that share a leaf folder name under different parent directories resolve to two different floors', () => {
  const repoA = makeRepo('project-management', 'grp-beklever-com');
  const repoB = makeRepo('project-management', 'gabriel-amyot');

  const resolver = new FloorResolver();
  const floorA = resolver.resolve(repoA);
  const floorB = resolver.resolve(repoB);

  assert.notEqual(floorA, floorB);
  assert.equal(floorA, 'grp-beklever-com/project-management');
  assert.equal(floorB, 'gabriel-amyot/project-management');
});

test('a relative cwd resolves to the general floor, never against the server\'s own working directory', () => {
  assert.equal(new FloorResolver().resolve('relative/path'), GENERAL_FLOOR);
  assert.equal(new FloorResolver().resolve('./relative'), GENERAL_FLOOR);
});

test('a worktree .git file with no gitdir line (malformed) resolves to the general floor, never the worktree\'s own directory name', () => {
  const worktree = path.join(root, 'worktrees', 'malformed');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), 'not a gitdir line at all\n');

  assert.equal(new FloorResolver().resolve(worktree), GENERAL_FLOOR);
});

test('a worktree .git file naming a directory that does not exist on disk still resolves (a pure string parse, not a second stat)', () => {
  const worktree = path.join(root, 'worktrees', 'dangling');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(root, 'nowhere', '.git', 'worktrees', 'dangling')}\n`);

  // The parsed main directory never needs to exist for the regex to resolve it (worktreeMainDir
  // is a pure string parse); this still names a floor from the parsed path, since the worktree
  // pointer itself is well-formed. Covered here to document that distinction from the malformed
  // case above (no gitdir line at all), which has nothing to parse and must fall to general.
  assert.equal(new FloorResolver().resolve(worktree), `${path.basename(root)}/nowhere`);
});

test('a worktree .git file with a relative gitdir pointer resolves the real main repository, not the general floor', () => {
  const mainRepo = makeRepo('relative-pointer-repo', 'orgs');
  const worktree = path.join(root, 'worktrees', 'rel-pointer');
  fs.mkdirSync(worktree, { recursive: true });
  // Relative to the worktree directory itself, the way git actually writes a same-filesystem worktree pointer.
  const relativeGitdir = path.relative(worktree, path.join(mainRepo, '.git', 'worktrees', 'rel-pointer'));
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${relativeGitdir}\n`);

  assert.equal(new FloorResolver().resolve(worktree), 'orgs/relative-pointer-repo');
});

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

/** A repo whose `.git/config` names an `origin` remote (issue #191's revision: the floor name
 * prefers the remote's own owner/name over the parent-dir qualifier, since that is what Gabriel
 * actually expects to see, not a filesystem accident like `projects/`). */
function makeRepoWithRemote(name: string, remoteUrl: string, parent = 'repos'): string {
  const repo = makeRepo(name, parent);
  fs.writeFileSync(path.join(repo, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
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

test('floorEnricher also sets display.repos (issue #216) to the resolved floor repo, empty on the general floor', () => {
  const repo = makeRepo('kiosk-app');
  const observations = [agent(repo), agent(undefined)];

  floorEnricher(new FloorResolver()).enrich(observations);

  assert.deepEqual(observations[0].display.repos, ['repos/kiosk-app']);
  assert.deepEqual(observations[1].display.repos, [], 'no real repo on the general floor, never a path or placeholder');
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

test('the remote lookup caches per repo root, so two different working directories under the same repo read .git/config only once', () => {
  const repo = makeRepoWithRemote('remote-cache-check', 'https://github.com/gabriel-amyot/agents-office.git', 'projects');
  const nested = path.join(repo, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  const resolver = new FloorResolver();
  const readFileSync = fs.readFileSync;
  const ownConfig = path.join(repo, '.git', 'config');
  let configReads = 0;
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    // Exact match on this test's own repo, not a suffix: a suffix match also counts every other
    // concurrently-running test's own `.git/config` read (for example `tests/missions-plugin.test.ts`'s
    // own fixture repo), which made this assertion racy against unrelated test files.
    if (String(args[0]) === ownConfig) configReads++;
    return readFileSync(...args);
  }) as typeof fs.readFileSync;
  try {
    assert.equal(resolver.resolve(repo), 'gabriel-amyot/agents-office');
    const readsAfterFirst = configReads;
    assert.ok(readsAfterFirst > 0, 'the first resolve actually read the config');
    // A different cwd (nested, under the same repo root) misses the outer per-directory cache
    // but must still reuse the remote lookup's own per-repo-root cache, not re-read the file.
    assert.equal(resolver.resolve(nested), 'gabriel-amyot/agents-office');
    assert.equal(configReads, readsAfterFirst, 'the remote lookup for the same repo root was not repeated');
  } finally {
    fs.readFileSync = readFileSync;
  }
});

// --- Review fixes ---

// --- Issue #191 revision: the git remote's own owner/name wins over the parent-dir qualifier ---

test('a repo with a GitHub HTTPS origin resolves to its own owner/repo, not its parent directory name', () => {
  const repo = makeRepoWithRemote('https-origin-repo', 'https://github.com/gabriel-amyot/agents-office.git', 'projects');
  assert.equal(new FloorResolver().resolve(repo), 'gabriel-amyot/agents-office');
});

test('a repo with a GitHub SSH origin resolves the same owner/repo as the HTTPS form', () => {
  const repo = makeRepoWithRemote('ssh-origin-repo', 'git@github.com:gabriel-amyot/agents-office.git', 'projects');
  assert.equal(new FloorResolver().resolve(repo), 'gabriel-amyot/agents-office');
});

test('a GitLab origin with nested subgroups keeps only the last group segment and the repo name', () => {
  const repo = makeRepoWithRemote('gitlab-origin-repo', 'https://cicd.prod.datasophia.com/grp-dac/sub1/sub2/project-management.git', 'orgs');
  assert.equal(new FloorResolver().resolve(repo), 'sub2/project-management');
});

test('an origin URL with no .git suffix and a trailing slash still resolves cleanly', () => {
  const repo = makeRepoWithRemote('trailing-slash-repo', 'https://github.com/gabriel-amyot/agents-office/', 'projects');
  assert.equal(new FloorResolver().resolve(repo), 'gabriel-amyot/agents-office');
});

test('a repo with no remote at all falls back to the parent-dir qualifier, unchanged from before this revision', () => {
  const repo = makeRepo('no-remote-repo', 'projects');
  assert.equal(new FloorResolver().resolve(repo), 'projects/no-remote-repo');
});

test('a repo whose config has no origin remote, or an unparsable url, falls back to the parent-dir qualifier', () => {
  const noOrigin = makeRepo('no-origin', 'projects');
  fs.writeFileSync(path.join(noOrigin, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  assert.equal(new FloorResolver().resolve(noOrigin), 'projects/no-origin');

  const badUrl = makeRepo('bad-url', 'projects');
  fs.writeFileSync(path.join(badUrl, '.git', 'config'), '[remote "origin"]\n\turl = not a url at all\n');
  assert.equal(new FloorResolver().resolve(badUrl), 'projects/bad-url');
});

test('an oversized .git/config falls back to the parent-dir qualifier rather than being read in full (issue #191 review nit: a size cap, like the worktree-file reader\'s own bounded read)', () => {
  const repo = makeRepo('oversized-config', 'projects');
  // A real `[remote "origin"]` section is in here too, so a successful read-without-a-cap
  // would otherwise resolve a real owner/repo — the point is that it never gets the chance.
  const filler = '#'.repeat(200_000);
  fs.writeFileSync(path.join(repo, '.git', 'config'), `${filler}\n[remote "origin"]\n\turl = https://github.com/gabriel-amyot/agents-office.git\n`);
  assert.equal(new FloorResolver().resolve(repo), 'projects/oversized-config');
});

test('a worktree resolves its main repository\'s own remote owner/repo, not the worktree directory', () => {
  const mainRepo = makeRepoWithRemote('worktree-main-repo', 'https://github.com/gabriel-amyot/agents-office.git', 'projects');
  const worktree = makeWorktree(mainRepo, '191-floors-step2');
  assert.equal(new FloorResolver().resolve(worktree), 'gabriel-amyot/agents-office');
});

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

// --- remoteOwnerRepoOf (issue #249: the Repos column's transcript-derived entries) ---

test('remoteOwnerRepoOf resolves a repo with a real remote, the same owner/repo the floor itself would use', () => {
  const repo = makeRepoWithRemote('second-repo', 'https://github.com/gabriel-amyot/second-repo.git');
  assert.equal(new FloorResolver().remoteOwnerRepoOf(repo), 'gabriel-amyot/second-repo');
});

test('remoteOwnerRepoOf resolves from a nested directory inside the repo, the same walk-up the floor uses', () => {
  const repo = makeRepoWithRemote('nested-repo', 'https://github.com/gabriel-amyot/nested-repo.git');
  const nested = path.join(repo, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(new FloorResolver().remoteOwnerRepoOf(nested), 'gabriel-amyot/nested-repo');
});

test('remoteOwnerRepoOf is undefined for a repo with no remote, unlike the floor itself (no directory-name fallback)', () => {
  const repo = makeRepo('no-remote-repo', 'projects');
  const resolver = new FloorResolver();
  assert.equal(resolver.resolve(repo), 'projects/no-remote-repo', 'the floor itself still falls back to the parent-dir qualifier');
  assert.equal(resolver.remoteOwnerRepoOf(repo), undefined, 'remoteOwnerRepoOf never falls back — a bare directory name is not a trustworthy second-repo signal');
});

test('remoteOwnerRepoOf is undefined for a directory with no repository at all, and for a missing or relative path', () => {
  const resolver = new FloorResolver();
  assert.equal(resolver.remoteOwnerRepoOf(path.join(root, 'nowhere', 'at', 'all')), undefined);
  assert.equal(resolver.remoteOwnerRepoOf('relative/path'), undefined);
});

test('remoteOwnerRepoOf resolves a worktree to its main repository\'s own remote, not the worktree directory', () => {
  const mainRepo = makeRepoWithRemote('worktree-main-repo', 'https://github.com/gabriel-amyot/worktree-main-repo.git');
  const worktree = makeWorktree(mainRepo, 'wt-remote');
  assert.equal(new FloorResolver().remoteOwnerRepoOf(worktree), 'gabriel-amyot/worktree-main-repo');
});

test('remoteOwnerRepoOf caches its own directory walk (review #249 round 2): a repeated call for the same directory does not re-walk the filesystem', () => {
  const repo = makeRepoWithRemote('repeated-remote-check', 'https://github.com/gabriel-amyot/repeated-remote-check.git');
  const resolver = new FloorResolver();
  const lstatSync = fs.lstatSync;
  let calls = 0;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
    calls++;
    return lstatSync(...args);
  }) as typeof fs.lstatSync;
  try {
    resolver.remoteOwnerRepoOf(repo);
    const callsAfterFirst = calls;
    assert.ok(callsAfterFirst > 0, 'the first call actually walked the filesystem');
    for (let i = 0; i < 50; i++) resolver.remoteOwnerRepoOf(repo);
    assert.equal(calls, callsAfterFirst, 'fifty repeated calls for the same directory reused the walk cache, not one lstat per call');
  } finally {
    fs.lstatSync = lstatSync;
  }
});

test('remoteOwnerRepoOf also caches a miss (no repository at this directory), not just a hit', () => {
  const dir = path.join(root, 'nowhere', 'repeated');
  const resolver = new FloorResolver();
  const lstatSync = fs.lstatSync;
  let calls = 0;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
    calls++;
    return lstatSync(...args);
  }) as typeof fs.lstatSync;
  try {
    resolver.remoteOwnerRepoOf(dir);
    const callsAfterFirst = calls;
    resolver.remoteOwnerRepoOf(dir);
    assert.equal(calls, callsAfterFirst, 'a repeated miss also reused the cache rather than re-walking to confirm there is still nothing there');
  } finally {
    fs.lstatSync = lstatSync;
  }
});

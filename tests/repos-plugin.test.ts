import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Observation } from '../server/seam.js';
import { FloorResolver } from '../server/floor.js';
import { createReposEnricher } from '../plugins/repos/index.js';

/**
 * Server-side coverage for `plugins/repos/index.ts` (issue #249): the Repos column's
 * transcript-derived entries, on top of `server/floor.ts`'s own one-entry floor repo
 * (review-222: the shipped one-entry column was a narrower signal than the older, async peek
 * view's "every repo touched" listing). Only two signals count: an `Edit`/`Write`/
 * `NotebookEdit` tool call's own absolute file path, and a `cd <dir>` opening a `Bash` call —
 * both resolved through the same `FloorResolver` class the floor itself uses, real remotes
 * only.
 */

async function gitRepo(dir: string, ownerRepo: string): Promise<void> {
  await mkdir(path.join(dir, '.git'), { recursive: true });
  await writeFile(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/${ownerRepo}.git\n`);
}

function toolUseLine(blocks: Array<{ name: string; input?: Record<string, unknown> }>): string {
  return JSON.stringify({ message: { role: 'assistant', content: blocks.map((b) => ({ type: 'tool_use', name: b.name, input: b.input ?? {} })) } });
}

function observation(id: string, transcriptPath: string, cwd?: string, repos?: string[]): Observation {
  return { id, provider: 'claude', name: id, activity: 'implementing', internal: { transcriptPath, cwd }, display: repos ? { repos } : {} };
}

async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'repos-enricher-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('an Edit call with an absolute path in a second repo adds that repo, after the floor repo', async () => {
  await withWorkspace(async (dir) => {
    const floorRepo = path.join(dir, 'floor-repo');
    const otherRepo = path.join(dir, 'other-repo');
    await gitRepo(floorRepo, 'gabriel-amyot/floor-repo');
    await gitRepo(otherRepo, 'gabriel-amyot/other-repo');
    const transcriptPath = path.join(dir, 'session.jsonl');
    await writeFile(transcriptPath, `${toolUseLine([{ name: 'Edit', input: { file_path: path.join(otherRepo, 'src/x.ts') } }])}\n`);

    const enricher = createReposEnricher(new FloorResolver());
    const agents = [observation('a', transcriptPath, floorRepo, ['gabriel-amyot/floor-repo'])];
    await enricher.enrich(agents);
    assert.deepEqual(agents[0].display.repos, ['gabriel-amyot/floor-repo', 'gabriel-amyot/other-repo']);
  });
});

test('a cd <dir> opening a Bash call adds that directory\'s repo, resolved relative to the session\'s own cwd when not absolute', async () => {
  await withWorkspace(async (dir) => {
    const floorRepo = path.join(dir, 'floor-repo');
    const sibling = path.join(dir, 'sibling-repo');
    await gitRepo(floorRepo, 'gabriel-amyot/floor-repo');
    await gitRepo(sibling, 'gabriel-amyot/sibling-repo');
    const transcriptPath = path.join(dir, 'session.jsonl');
    await writeFile(transcriptPath, `${toolUseLine([{ name: 'Bash', input: { command: 'cd ../sibling-repo && git status' } }])}\n`);

    const enricher = createReposEnricher(new FloorResolver());
    const agents = [observation('a', transcriptPath, floorRepo, ['gabriel-amyot/floor-repo'])];
    await enricher.enrich(agents);
    assert.deepEqual(agents[0].display.repos, ['gabriel-amyot/floor-repo', 'gabriel-amyot/sibling-repo']);
  });
});

test('a cd ~/<dir> is expanded against the home directory, not resolved as a literal "~" path segment under cwd (review #249 round 2)', async () => {
  await withWorkspace(async (dir) => {
    const floorRepo = path.join(dir, 'floor-repo');
    const home = await mkdtemp(path.join(os.tmpdir(), 'repos-enricher-home-'));
    const homeRepo = path.join(home, 'other-repo');
    await gitRepo(floorRepo, 'gabriel-amyot/floor-repo');
    await gitRepo(homeRepo, 'gabriel-amyot/home-repo');
    const transcriptPath = path.join(dir, 'session.jsonl');
    await writeFile(transcriptPath, `${toolUseLine([{ name: 'Bash', input: { command: 'cd ~/other-repo && git status' } }])}\n`);

    const homedir = os.homedir;
    (os as unknown as { homedir: typeof os.homedir }).homedir = () => home;
    try {
      const enricher = createReposEnricher(new FloorResolver());
      const agents = [observation('a', transcriptPath, floorRepo, ['gabriel-amyot/floor-repo'])];
      await enricher.enrich(agents);
      assert.deepEqual(agents[0].display.repos, ['gabriel-amyot/floor-repo', 'gabriel-amyot/home-repo']);
    } finally {
      os.homedir = homedir;
      await rm(home, { recursive: true, force: true });
    }
  });
});

test('a directory with no git remote is never added, even though it is a real repo', async () => {
  await withWorkspace(async (dir) => {
    const floorRepo = path.join(dir, 'floor-repo');
    const noRemote = path.join(dir, 'no-remote-repo');
    await gitRepo(floorRepo, 'gabriel-amyot/floor-repo');
    await mkdir(path.join(noRemote, '.git'), { recursive: true }); // a real repo, but no config at all
    const transcriptPath = path.join(dir, 'session.jsonl');
    await writeFile(transcriptPath, `${toolUseLine([{ name: 'Edit', input: { file_path: path.join(noRemote, 'x.ts') } }])}\n`);

    const enricher = createReposEnricher(new FloorResolver());
    const agents = [observation('a', transcriptPath, floorRepo, ['gabriel-amyot/floor-repo'])];
    await enricher.enrich(agents);
    assert.deepEqual(agents[0].display.repos, ['gabriel-amyot/floor-repo'], 'real remotes only — a bare directory name is not a trustworthy second-repo signal');
  });
});

test('reading a file in the same repo as the floor adds nothing new (deduped)', async () => {
  await withWorkspace(async (dir) => {
    const floorRepo = path.join(dir, 'floor-repo');
    await gitRepo(floorRepo, 'gabriel-amyot/floor-repo');
    const transcriptPath = path.join(dir, 'session.jsonl');
    await writeFile(transcriptPath, `${toolUseLine([{ name: 'Edit', input: { file_path: path.join(floorRepo, 'src/x.ts') } }])}\n`);

    const enricher = createReposEnricher(new FloorResolver());
    const agents = [observation('a', transcriptPath, floorRepo, ['gabriel-amyot/floor-repo'])];
    await enricher.enrich(agents);
    assert.deepEqual(agents[0].display.repos, ['gabriel-amyot/floor-repo']);
  });
});

test('a Read call never counts, only Edit/Write/NotebookEdit and a Bash cd', async () => {
  await withWorkspace(async (dir) => {
    const floorRepo = path.join(dir, 'floor-repo');
    const otherRepo = path.join(dir, 'other-repo');
    await gitRepo(floorRepo, 'gabriel-amyot/floor-repo');
    await gitRepo(otherRepo, 'gabriel-amyot/other-repo');
    const transcriptPath = path.join(dir, 'session.jsonl');
    await writeFile(transcriptPath, `${toolUseLine([{ name: 'Read', input: { file_path: path.join(otherRepo, 'x.ts') } }])}\n`);

    const enricher = createReposEnricher(new FloorResolver());
    const agents = [observation('a', transcriptPath, floorRepo, ['gabriel-amyot/floor-repo'])];
    await enricher.enrich(agents);
    assert.deepEqual(agents[0].display.repos, ['gabriel-amyot/floor-repo']);
  });
});

test('the floor repo always stays first and is never evicted by the cap, however many transcript repos pile up', async () => {
  await withWorkspace(async (dir) => {
    const floorRepo = path.join(dir, 'floor-repo');
    await gitRepo(floorRepo, 'gabriel-amyot/floor-repo');
    const repoDirs: string[] = [];
    for (let i = 0; i < 10; i++) {
      const repoDir = path.join(dir, `repo-${i}`);
      await gitRepo(repoDir, `gabriel-amyot/repo-${i}`);
      repoDirs.push(repoDir);
    }
    const transcriptPath = path.join(dir, 'session.jsonl');
    const lines = repoDirs.map((repoDir) => toolUseLine([{ name: 'Edit', input: { file_path: path.join(repoDir, 'x.ts') } }]));
    await writeFile(transcriptPath, `${lines.join('\n')}\n`);

    const enricher = createReposEnricher(new FloorResolver());
    const agents = [observation('a', transcriptPath, floorRepo, ['gabriel-amyot/floor-repo'])];
    await enricher.enrich(agents);
    const repos = agents[0].display.repos!;
    assert.equal(repos.length, 8, 'capped like skills (MAX_REPOS)');
    assert.equal(repos[0], 'gabriel-amyot/floor-repo', 'the floor repo is always first, never evicted');
    assert.deepEqual(repos.slice(1), ['gabriel-amyot/repo-3', 'gabriel-amyot/repo-4', 'gabriel-amyot/repo-5', 'gabriel-amyot/repo-6', 'gabriel-amyot/repo-7', 'gabriel-amyot/repo-8', 'gabriel-amyot/repo-9'], 'the 7 most recent transcript repos fill the rest, newest last');
  });
});

test('a later poll only reads the bytes added since the last one, and keeps accumulating across polls', async () => {
  await withWorkspace(async (dir) => {
    const floorRepo = path.join(dir, 'floor-repo');
    const otherRepo = path.join(dir, 'other-repo');
    await gitRepo(floorRepo, 'gabriel-amyot/floor-repo');
    await gitRepo(otherRepo, 'gabriel-amyot/other-repo');
    const transcriptPath = path.join(dir, 'session.jsonl');
    const resolver = new FloorResolver();
    const enricher = createReposEnricher(resolver);

    await writeFile(transcriptPath, `${toolUseLine([{ name: 'Edit', input: { file_path: path.join(floorRepo, 'a.ts') } }])}\n`);
    const first = [observation('a', transcriptPath, floorRepo, ['gabriel-amyot/floor-repo'])];
    await enricher.enrich(first);
    assert.deepEqual(first[0].display.repos, ['gabriel-amyot/floor-repo']);

    await writeFile(
      transcriptPath,
      `${toolUseLine([{ name: 'Edit', input: { file_path: path.join(floorRepo, 'a.ts') } }])}\n${toolUseLine([{ name: 'Edit', input: { file_path: path.join(otherRepo, 'b.ts') } }])}\n`,
      { flag: 'w' },
    );
    const second = [observation('a', transcriptPath, floorRepo, ['gabriel-amyot/floor-repo'])];
    await enricher.enrich(second);
    assert.deepEqual(second[0].display.repos, ['gabriel-amyot/floor-repo', 'gabriel-amyot/other-repo']);
  });
});

test('a non-.jsonl or missing transcript path is a silent no-op (graceful degradation)', async () => {
  const enricher = createReposEnricher(new FloorResolver());
  const agents: Observation[] = [
    { id: 'a', provider: 'claude', name: 'a', activity: 'implementing', internal: {}, display: { repos: ['gabriel-amyot/floor-repo'] } },
    { id: 'b', provider: 'claude', name: 'b', activity: 'implementing', internal: { transcriptPath: '/no/such/file.txt' }, display: { repos: ['gabriel-amyot/floor-repo'] } },
  ];
  assert.doesNotThrow(() => enricher.enrich(agents));
  assert.deepEqual(agents[0].display.repos, ['gabriel-amyot/floor-repo']);
  assert.deepEqual(agents[1].display.repos, ['gabriel-amyot/floor-repo']);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { projectAgents, projectWorld, type Observation } from '../server/seam.js';

// Transcripts live under a synthetic home, never the real ~/.claude.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-github-test-'));
const projectDir = path.join(fixture, '.claude', 'projects', '-work-repo');
const homeMock = mock.method(os, 'homedir', () => fixture);
const { createGithubPlugin } = await import('../plugins/github/index.js');
const { parseRepos, boardColumns, parseIssueList } = await import('../plugins/github/gh.js');
const { issueRefsFromCommand } = await import('../plugins/github/transcript.js');

after(() => {
  homeMock.mock.restore();
  fs.rmSync(fixture, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(fixture, '.claude'), { recursive: true, force: true });
  fs.mkdirSync(projectDir, { recursive: true });
});

const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY = 86_400_000;

function ghIssue(number: number, overrides: Record<string, unknown> = {}) {
  return { number, title: `Issue ${number}`, state: 'OPEN', labels: [], assignees: [],
    updatedAt: new Date(NOW - number * 60_000).toISOString(), ...overrides };
}

const SAMPLE = [
  ghIssue(1),
  ghIssue(2, { assignees: [{ login: 'gab' }] }),
  ghIssue(3, { labels: [{ name: 'In Progress' }] }),
  ghIssue(4, { labels: [{ name: 'doing' }] }),
  ghIssue(5, { state: 'CLOSED', updatedAt: new Date(NOW - DAY).toISOString() }),
  ghIssue(6, { state: 'CLOSED', updatedAt: new Date(NOW - 10 * DAY).toISOString() }),
  ghIssue(38, { title: 'GitHub plugin: kanban board and issue cards', assignees: [{ login: 'gab' }] }),
];

interface Call { file: string; args: string[]; options: Record<string, unknown> }

function fakeRun(output: () => string) {
  const calls: Call[] = [];
  const run = async (file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    return output();
  };
  return { run, calls };
}

function plugin(repos: string | undefined, output: () => string = () => JSON.stringify(SAMPLE), now = () => NOW) {
  const fake = fakeRun(output);
  return { plugin: createGithubPlugin({ repos, run: fake.run, now }), calls: fake.calls };
}

function observation(transcriptPath?: string): Observation {
  return { id: 'session-1', provider: 'claude', name: 'repo', activity: 'implementing',
    internal: { pid: 1, cwd: '/work/repo', ...(transcriptPath ? { transcriptPath } : {}) }, display: {} };
}

function bash(command: string): string {
  return JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
}

function userSays(text: string): string {
  return JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text }] } });
}

function writeTranscript(lines: string[], name = 'session-1.jsonl'): string {
  const file = path.join(projectDir, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

async function enrich(p: ReturnType<typeof plugin>['plugin'], observations: Observation[]) {
  for (const enricher of p.enrichers ?? []) await enricher.enrich(observations);
}

async function world(p: ReturnType<typeof plugin>['plugin']) {
  const parts = await Promise.all((p.world ?? []).map((provider) => provider.world([])));
  return parts;
}

test('repository names are validated strictly', () => {
  assert.deepEqual(parseRepos('gabriel-amyot/agents-office, a.b/c_d , bad, x/y/z, ../etc, a/b;rm, -R/x, a/b'),
    ['gabriel-amyot/agents-office', 'a.b/c_d', 'a/b']);
  assert.deepEqual(parseRepos(undefined), []);
  assert.deepEqual(parseRepos(''), []);
});

test('without the repository variable the plugin adds nothing and runs nothing', async () => {
  const { plugin: p, calls } = plugin(undefined);
  const file = writeTranscript([bash('gh issue view 38')]);
  const observations = [observation(file)];

  await enrich(p, observations);
  const parts = await world(p);

  assert.equal(p.name, 'github');
  assert.deepEqual(observations[0].display, {});
  assert.deepEqual(projectWorld(parts, [p.name], (raw) => raw).boards, []);
  assert.equal(calls.length, 0);
});

test('gh runs with fixed arguments, a timeout and no shell', async () => {
  const { plugin: p, calls } = plugin('gabriel-amyot/agents-office');
  await world(p);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'gh');
  assert.deepEqual(calls[0].args, ['issue', 'list', '-R', 'gabriel-amyot/agents-office', '--state', 'all',
    '--limit', '60', '--json', 'number,title,state,labels,assignees,updatedAt']);
  assert.ok(Number(calls[0].options.timeout) > 0 && Number(calls[0].options.timeout) <= 5000);
  assert.notEqual(calls[0].options.shell, true);
});

test('the board has To do, In progress and Done columns derived from state, assignees and labels', async () => {
  const { plugin: p } = plugin('gabriel-amyot/agents-office');
  const { boards } = projectWorld(await world(p), ['github'], (raw) => `h(${raw})`);

  assert.equal(boards.length, 1);
  assert.equal(boards[0].id, 'h(board:github:gabriel-amyot/agents-office)');
  assert.equal(boards[0].title, 'gabriel-amyot/agents-office');
  const columns = Object.fromEntries(boards[0].columns.map((column) => [column.name, column.cards.map((card) => card.number)]));
  assert.deepEqual(columns, { 'To do': [1], 'In progress': [2, 3, 4, 38], Done: [5] });
});

// --- Issue #191: a board scopes to its own repo, for the focused floor to filter by ---

test('a board carries its own full owner/repo, for an exact match against an org-qualified floor', async () => {
  const { plugin: p } = plugin('gabriel-amyot/agents-office');
  const { boards } = projectWorld(await world(p), ['github'], (raw) => `h(${raw})`);

  assert.equal(boards[0].repo, 'gabriel-amyot/agents-office');
});

test('Done keeps closed issues of the last 7 days, newest first, at most 8', () => {
  const closed = Array.from({ length: 12 }, (_, i) => ({ number: i + 1, title: `c${i + 1}`, open: false,
    inProgressLabel: false, assigned: false, updatedAt: NOW - (i + 1) * 3_600_000 }));
  const old = { number: 99, title: 'old', open: false, inProgressLabel: false, assigned: false, updatedAt: NOW - 8 * DAY };
  const done = boardColumns([...closed, old], NOW).find((column) => column.name === 'Done')!;

  assert.deepEqual(done.cards.map((card) => card.number), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('the gh output is shape-checked and capped', () => {
  assert.equal(parseIssueList('not json'), undefined);
  assert.equal(parseIssueList('{"number":1}'), undefined);
  const parsed = parseIssueList(JSON.stringify([
    ghIssue(1, { title: 'x'.repeat(500) }), { number: -1, title: 't' }, { number: 2 }, ghIssue(3, { state: 'MERGED' }),
    ...Array.from({ length: 80 }, (_, i) => ghIssue(100 + i)),
  ]))!;
  assert.equal(parsed[0].title.length <= 200, true);
  assert.equal(parsed.some((issue) => issue.number === -1 || issue.number === 2), false);
  assert.ok(parsed.length <= 60);
});

test('when gh fails the board is absent, and later failures keep the last good data', async () => {
  let fail = true;
  let now = NOW;
  const { plugin: p, calls } = plugin('gabriel-amyot/agents-office', () => {
    if (fail) throw new Error('gh: command not found');
    return JSON.stringify(SAMPLE);
  }, () => now);

  assert.deepEqual(projectWorld(await world(p), ['github'], (raw) => raw).boards, []);

  fail = false;
  now += 61_000;
  assert.equal(projectWorld(await world(p), ['github'], (raw) => raw).boards.length, 1);

  fail = true;
  now += 61_000;
  assert.equal(projectWorld(await world(p), ['github'], (raw) => raw).boards.length, 1);
  assert.equal(calls.length, 3);
});

test('gh results are cached for 60 seconds per repository', async () => {
  let now = NOW;
  const { plugin: p, calls } = plugin('a/one,b/two', () => JSON.stringify(SAMPLE), () => now);
  await world(p);
  await world(p);
  now += 30_000;
  await world(p);
  assert.equal(calls.length, 2);
  now += 31_000;
  await world(p);
  assert.equal(calls.length, 4);
});

test('issue numbers come from gh issue commands, branch names and commit messages', () => {
  const numbers = (command: string) => issueRefsFromCommand(command).map((ref) => ref.number);

  assert.deepEqual(numbers('gh issue view 38 -R gabriel-amyot/agents-office'), [38]);
  assert.deepEqual(numbers('gh issue comment 12 --body "see #99"'), [12]);
  assert.deepEqual(numbers('gh issue edit https://github.com/o/r/issues/7 --add-label x'), [7]);
  assert.deepEqual(numbers('git switch -c 41-board'), [41]);
  assert.deepEqual(numbers('git -C /w/repo worktree add /w/tree -b 38-github-kanban origin/main'), [38]);
  assert.deepEqual(numbers('git checkout -b 9-fix && npm test'), [9]);
  assert.deepEqual(numbers('git commit -m "Add the board\n\nRefs gabriel-amyot/agents-office#38"'), [38]);
  assert.deepEqual(numbers('git commit -m "Fix label (#17)"'), [17]);
  assert.deepEqual(numbers('git log --oneline | grep 12-'), []);
  assert.deepEqual(numbers('gh issue list'), []);
  assert.deepEqual(numbers('echo "#5" && git -C 12-dir status'), []);
  assert.deepEqual(issueRefsFromCommand('git commit -m "x" -m "Refs a/b#3"')[0], { number: 3, repo: 'a/b' });
});

test('the enricher sets issues from tool calls, most recent first, and ignores prompt text', async () => {
  const { plugin: p } = plugin('gabriel-amyot/agents-office');
  await world(p);
  const file = writeTranscript([
    userSays('please look at gh issue view 77 and #78'),
    bash('gh issue view 1'),
    bash('git worktree add /w/t -b 38-github-kanban origin/main'),
    bash('gh issue view 404 -R other/repo'),
    bash('gh issue view 1'),
  ]);
  const observations = [observation(file), observation()];

  await enrich(p, observations);

  assert.deepEqual(observations[0].display.issues, [
    { number: 1, title: 'Issue 1', column: 'To do', repo: 'agents-office' },
    { number: 404, title: '' },
    { number: 38, title: 'GitHub plugin: kanban board and issue cards', column: 'In progress', repo: 'agents-office' },
  ]);
  assert.equal(observations[1].display.issues, undefined);
});

test('a card names its repository only when the issue belongs to a configured one', async () => {
  const p = createGithubPlugin({ repos: 'o/alpha,o/beta', now: () => NOW,
    run: async (_file, args) => JSON.stringify(args.includes('o/alpha') ? [ghIssue(1)] : [ghIssue(2)]) });
  await world(p);
  const file = writeTranscript([
    bash('gh issue view 2'),
    bash('gh issue view 9'),
    bash('gh issue view 4 -R o/beta'),
    bash('gh issue view 5 -R x/gamma'),
  ]);
  const observations = [observation(file)];
  await enrich(p, observations);

  const single = createGithubPlugin({ repos: 'o/alpha', now: () => NOW, run: async () => JSON.stringify([ghIssue(1)]) });
  const bare = [observation(writeTranscript([bash('gh issue view 783')], 'bare.jsonl'))];
  await enrich(single, bare);
  assert.deepEqual(bare[0].display.issues, [{ number: 783, title: '' }], 'a bare unknown number names no repository');

  assert.deepEqual(observations[0].display.issues, [
    { number: 5, title: '' },
    { number: 4, title: '', repo: 'beta' },
    { number: 9, title: '' },
    { number: 2, title: 'Issue 2', column: 'To do', repo: 'beta' },
  ]);
});

test('a bare branch number present on two configured boards is not guessed to either one', async () => {
  const p = createGithubPlugin({ repos: 'o/alpha,o/beta', now: () => NOW,
    run: async () => JSON.stringify([ghIssue(31)]) });
  await world(p);
  const file = writeTranscript([bash('git switch -c 31-x')]);
  const observations = [observation(file)];

  await enrich(p, observations);

  assert.deepEqual(observations[0].display.issues, [{ number: 31, title: '' }],
    'both o/alpha and o/beta have issue 31: no evidence names either, so no repo and no link');
});

test('the enricher keeps the 5 most recent issues and the projection never sends more than 5', async () => {
  const { plugin: p } = plugin('gabriel-amyot/agents-office');
  const file = writeTranscript(Array.from({ length: 9 }, (_, i) => bash(`gh issue view ${i + 1}`)));
  const observations = [observation(file)];

  await enrich(p, observations);
  assert.deepEqual(observations[0].display.issues!.map((issue) => issue.number), [9, 8, 7, 6, 5]);

  observations[0].display.issues = Array.from({ length: 9 }, (_, i) => ({ number: i + 1, title: 't' }));
  assert.equal(projectAgents(observations, (raw) => raw)[0].issues!.length, 5);
});

test('the enricher reads only transcripts under ~/.claude/projects and caches by size and time', async () => {
  const { plugin: p } = plugin('gabriel-amyot/agents-office');
  const outside = path.join(fixture, 'elsewhere.jsonl');
  fs.writeFileSync(outside, `${bash('gh issue view 5')}\n`);
  const outsideObservation = [observation(outside)];
  await enrich(p, outsideObservation);
  assert.equal(outsideObservation[0].display.issues, undefined);

  const file = writeTranscript([bash('gh issue view 5')]);
  const readSpy = mock.method(fs, 'openSync');
  await enrich(p, [observation(file)]);
  await enrich(p, [observation(file)]);
  assert.equal(readSpy.mock.callCount(), 1);

  fs.appendFileSync(file, `${bash('gh issue view 6')}\n`);
  const observations = [observation(file)];
  await enrich(p, observations);
  readSpy.mock.restore();
  assert.equal(observations[0].display.issues![0].number, 6);
});

test('a card border takes the wayfinder label color, else the first label color, else none', async () => {
  const labeled = [
    ghIssue(1, { labels: [{ name: 'bug', color: 'D73A4A' }, { name: 'wayfinder:research', color: '0e8a16' }] }),
    ghIssue(2, { labels: [{ name: 'enhancement', color: 'a2eeef' }, { name: 'doing', color: 'fbca04' }] }),
    ghIssue(3),
    ghIssue(4, { labels: [{ name: 'odd', color: 'not-a-color' }] }),
  ];
  const { plugin: p } = plugin('gabriel-amyot/agents-office', () => JSON.stringify(labeled));
  await world(p);
  const file = writeTranscript([4, 3, 2, 1].map((number) => bash(`gh issue view ${number}`)));
  const observations = [observation(file)];
  await enrich(p, observations);

  const colors = observations[0].display.issues!.map((issue) => [issue.number, issue.color]);
  assert.deepEqual(colors, [[1, '0e8a16'], [2, 'a2eeef'], [3, undefined], [4, undefined]]);
  const text = JSON.stringify(projectAgents(observations, (raw) => raw)[0].issues);
  assert.equal(text.includes('wayfinder') || text.includes('enhancement'), false, 'no label text leaves the server');
});

test('the agents call gets titles and colors without a world call first', async () => {
  const labeled = [ghIssue(5, { labels: [{ name: 'wayfinder:implementation', color: '1D76DB' }] })];
  const { plugin: p, calls } = plugin('gabriel-amyot/agents-office', () => JSON.stringify(labeled));
  const observations = [observation(writeTranscript([bash('gh issue view 5')]))];

  await enrich(p, observations);

  assert.deepEqual(observations[0].display.issues, [{ number: 5, title: 'Issue 5', column: 'To do', repo: 'agents-office', color: '1d76db' }]);
  assert.equal(calls.length, 1);
  await world(p);
  assert.equal(calls.length, 1, 'the world call reuses the cache');
});

test('a slow gh does not hold the agents call: the cards come without titles', async () => {
  let release: () => void = () => undefined;
  const p = createGithubPlugin({ repos: 'o/alpha', now: () => NOW,
    run: () => new Promise((resolve) => { release = () => resolve(JSON.stringify([ghIssue(7)])); }) });
  const observations = [observation(writeTranscript([bash('gh issue view 7')]))];
  const started = Date.now();
  await enrich(p, observations);
  assert.ok(Date.now() - started < 1900, 'stays under the 2 s step limit');
  assert.deepEqual(observations[0].display.issues, [{ number: 7, title: '' }]);
  release();
});

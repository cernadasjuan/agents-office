import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  EMPTY_GITHUB_CONFIG,
  extractDoneList,
  extractPersonas,
  findStoryFile,
  parseGithubConfig,
  parseIntentTree,
  readSessionStory,
  resetSessionStoryCache,
  resolveIssueRef,
  type GithubConfig,
} from '../plugins/missions/sessionStoryReader.js';

/**
 * Issue #160: the tombstone story reader resolves a session slug to its archived
 * `intent-tree.md` and reads only display fields. Fixtures are synthetic, written
 * under a tmp dir — never a real `~/.claude` or project-management checkout.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-story-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function writeRecord(slug: string, body: string, sub = ''): string {
  const dir = path.join(root, 'sessions', 'archive', sub, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'intent-tree.md');
  fs.writeFileSync(file, body);
  return file;
}

const RECORD = `---
session_slug: tidy-otter
intent: "Fix the git situation safely"
org: personal
created: 2026-11-12T14:57:57Z
closed: 2026-11-17T20:56:15Z
verdict: CLOSE
node_counts: {done: 2, open: 0, abandoned: 0, handoff: 1, ticket: 0}
handoffs_generated: [2026-11-17-handoff.md]
tickets_referenced: [agents-office#160, agents-office#159]
---

## Intent Tree

\`\`\`
◉ Root: "Fix the git situation safely"
├── ◉ Amelia cleared the stale revert sequencer
└── ◉ Merged origin/main (no conflicts)
\`\`\`
`;

// Review round 2: a real archived record (`sessions/archive/*/intent-tree.md`) names its issue
// refs in `tickets_referenced`, as a bare `repo#N` with no owner at all — `gh_issues_referenced`
// exists per the schema comment but is rarely populated. `RECORD` above copies that real shape.

test('AC: parses intent, personas, counts, done list and handoffs from a real-shaped record', () => {
  const story = parseIntentTree(RECORD);
  assert.equal(story?.intent, 'Fix the git situation safely');
  assert.deepEqual(story?.personas, ['Amelia']);
  assert.deepEqual(story?.counts, { done: 2, open: 0, abandoned: 0 });
  assert.deepEqual(story?.doneList, ['Root: "Fix the git situation safely"', 'Amelia cleared the stale revert sequencer', 'Merged origin/main (no conflicts)']);
  assert.deepEqual(story?.handoffs, ['2026-11-17-handoff.md']);
});

test('AC: a bare repo#N ref from tickets_referenced still shows, without a link, when no owner is configured', () => {
  const story = parseIntentTree(RECORD);
  assert.deepEqual(story?.issues, [{ label: 'agents-office#160' }, { label: 'agents-office#159' }]);
});

test('AC: the same bare ref resolves to a link once the repo\'s owner is configured', () => {
  const config: GithubConfig = { repos: [{ owner: 'gabriel-amyot', repo: 'agents-office' }], owners: [] };
  const story = parseIntentTree(RECORD, config);
  assert.deepEqual(story?.issues, [
    { label: 'agents-office#160', url: 'https://github.com/gabriel-amyot/agents-office/issues/160' },
    { label: 'agents-office#159', url: 'https://github.com/gabriel-amyot/agents-office/issues/159' },
  ]);
});

test('AC: a full owner/repo#N ref (gh_issues_referenced) resolves without any config at all', () => {
  const story = parseIntentTree(RECORD.replace('tickets_referenced: [agents-office#160, agents-office#159]',
    'gh_issues_referenced: [gabriel-amyot/agents-office#160]'));
  assert.deepEqual(story?.issues, [{ label: 'gabriel-amyot/agents-office#160', url: 'https://github.com/gabriel-amyot/agents-office/issues/160' }]);
});

test('AC: a Jira-style key in tickets_referenced shows as plain text, never a GitHub link', () => {
  const story = parseIntentTree(RECORD.replace('tickets_referenced: [agents-office#160, agents-office#159]', 'tickets_referenced: [KTP-951]'));
  assert.deepEqual(story?.issues, [{ label: 'KTP-951' }]);
});

// --- resolveIssueRef and parseGithubConfig, directly ---

test('resolveIssueRef: a full owner/repo#N ref always resolves to a link, config or not', () => {
  assert.deepEqual(resolveIssueRef('gabriel-amyot/agents-office#46', EMPTY_GITHUB_CONFIG),
    { label: 'gabriel-amyot/agents-office#46', url: 'https://github.com/gabriel-amyot/agents-office/issues/46' });
});

test('resolveIssueRef: a "." or ".." owner or repo segment is rejected, and issue 0 is rejected', () => {
  assert.equal(resolveIssueRef('../repo#5', EMPTY_GITHUB_CONFIG), undefined);
  assert.equal(resolveIssueRef('owner/..#5', EMPTY_GITHUB_CONFIG), undefined);
  assert.equal(resolveIssueRef('owner/repo#0', EMPTY_GITHUB_CONFIG), undefined);
  assert.equal(resolveIssueRef('..#5', EMPTY_GITHUB_CONFIG), undefined);
  assert.deepEqual(resolveIssueRef('owner/repo#5', EMPTY_GITHUB_CONFIG),
    { label: 'owner/repo#5', url: 'https://github.com/owner/repo/issues/5' });
});

test('resolveIssueRef: a bare repo#N resolves only when exactly one configured repo has that name', () => {
  const ambiguous: GithubConfig = { repos: [{ owner: 'a', repo: 'x' }, { owner: 'b', repo: 'x' }], owners: [] };
  assert.deepEqual(resolveIssueRef('x#5', ambiguous), { label: 'x#5' });
  const unique: GithubConfig = { repos: [{ owner: 'a', repo: 'x' }], owners: [] };
  assert.deepEqual(resolveIssueRef('x#5', unique), { label: 'x#5', url: 'https://github.com/a/x/issues/5' });
});

test('resolveIssueRef: a bare repo#N falls back to the single configured default owner', () => {
  const config: GithubConfig = { repos: [], owners: ['gabriel-amyot'] };
  assert.deepEqual(resolveIssueRef('agents-office#5', config), { label: 'agents-office#5', url: 'https://github.com/gabriel-amyot/agents-office/issues/5' });
});

test('resolveIssueRef: more than one default owner is ambiguous, same as more than one matching repo', () => {
  const config: GithubConfig = { repos: [], owners: ['a', 'b'] };
  assert.deepEqual(resolveIssueRef('x#5', config), { label: 'x#5' });
});

test('resolveIssueRef: a Jira-style key shows as plain text; junk resolves to nothing', () => {
  assert.deepEqual(resolveIssueRef('KTP-951', EMPTY_GITHUB_CONFIG), { label: 'KTP-951' });
  assert.equal(resolveIssueRef('not a ref at all', EMPTY_GITHUB_CONFIG), undefined);
});

test('parseGithubConfig: parses owner/repo pairs and owners, dropping malformed entries', () => {
  assert.deepEqual(parseGithubConfig('gabriel-amyot/agents-office, bad-entry, a/b', 'gabriel-amyot, bad owner!'),
    { repos: [{ owner: 'gabriel-amyot', repo: 'agents-office' }, { owner: 'a', repo: 'b' }], owners: ['gabriel-amyot'] });
  assert.deepEqual(parseGithubConfig(undefined, undefined), EMPTY_GITHUB_CONFIG);
});

test('a record missing the required intent field is not a valid story', () => {
  assert.equal(parseIntentTree('---\nsession_slug: x\n---\nbody'), null);
});

test('text with no frontmatter block is not a valid story', () => {
  assert.equal(parseIntentTree('just some text'), null);
});

test('AC: extractDoneList ignores non-done tree markers (handoff and ticket glyphs)', () => {
  const body = '◉ Done item\n⤴🎫 Handoff marker\n🎫 Ticket marker\n└── ◉ Nested done item';
  assert.deepEqual(extractDoneList(body), ['Done item', 'Nested done item']);
});

test('AC: extractPersonas only ever returns names from the closed BMAD roster', () => {
  assert.deepEqual(extractPersonas('Amelia built it, Winston reviewed it, Gabriel approved it'), ['Winston', 'Amelia']);
  assert.deepEqual(extractPersonas('no persona mentioned here'), []);
});

test('review round 1: a roster name with regex metacharacters (period) does not crash or over-match', () => {
  // "Dr. Quinn" is in plugins/bmad/roster.ts (the shared roster, review round 1's fix): an
  // unescaped "." in the pattern would match any character, so "DrX Quinn" would also match.
  assert.deepEqual(extractPersonas('Dr. Quinn investigated the bug'), ['Quinn', 'Dr. Quinn']);
  assert.deepEqual(extractPersonas('DrX Quinn is not the real name'), ['Quinn']);
});

test('AC: findStoryFile checks the direct archive folder, then done/, then abandoned/', () => {
  writeRecord('plain-slug', RECORD);
  assert.ok(findStoryFile([root], 'plain-slug')?.endsWith(path.join('plain-slug', 'intent-tree.md')));
  writeRecord('done-slug', RECORD, 'done');
  assert.ok(findStoryFile([root], 'done-slug')?.includes(path.join('archive', 'done', 'done-slug')));
  writeRecord('abandoned-slug', RECORD, 'abandoned');
  assert.ok(findStoryFile([root], 'abandoned-slug')?.includes(path.join('archive', 'abandoned', 'abandoned-slug')));
});

test('AC: a missing archived record reads as no story, not an error', () => {
  resetSessionStoryCache();
  assert.equal(readSessionStory([root], 'never-existed'), null);
});

test('a slug outside the slug shape is rejected before touching the filesystem', () => {
  resetSessionStoryCache();
  assert.equal(findStoryFile([root], '../../etc/passwd'), undefined);
  assert.equal(readSessionStory([root], '../../etc/passwd'), null);
});

test('an oversized record is skipped (S6: validate and cap the size of what a reader reads)', () => {
  const dir = path.join(root, 'sessions', 'archive', 'huge-slug');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'intent-tree.md'), 'x'.repeat(200_001));
  assert.equal(findStoryFile([root], 'huge-slug'), undefined);
});

// --- Review round 1 (Codex): a symlinked session directory must not escape the archive root ---

test('AC: a session directory symlinked outside the archive root is rejected, not followed', () => {
  resetSessionStoryCache();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-outside-'));
  fs.writeFileSync(path.join(outside, 'intent-tree.md'), RECORD);
  const archiveDir = path.join(root, 'sessions', 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const linkPath = path.join(archiveDir, 'escape-slug');
  fs.rmSync(linkPath, { force: true });
  fs.symlinkSync(outside, linkPath, 'dir');
  assert.equal(findStoryFile([root], 'escape-slug'), undefined);
  assert.equal(readSessionStory([root], 'escape-slug'), null);
});

test('a symlinked session directory that stays inside the archive root still resolves', () => {
  resetSessionStoryCache();
  writeRecord('real-slug', RECORD);
  const archiveDir = path.join(root, 'sessions', 'archive');
  const linkPath = path.join(archiveDir, 'linked-slug');
  fs.rmSync(linkPath, { force: true });
  fs.symlinkSync(path.join(archiveDir, 'real-slug'), linkPath, 'dir');
  const found = findStoryFile([root], 'linked-slug');
  assert.ok(found, 'a symlink that stays inside the archive root still resolves');
  assert.equal(readSessionStory([root], 'linked-slug')?.intent, 'Fix the git situation safely');
});

test('readSessionStory caches a read: a file removed within the cache window still answers the old story', () => {
  const slug = 'cache-slug';
  writeRecord(slug, RECORD);
  let now = 1_000_000;
  resetSessionStoryCache();
  const first = readSessionStory([root], slug, () => now);
  assert.ok(first);
  fs.rmSync(path.join(root, 'sessions', 'archive', slug), { recursive: true, force: true });
  now += 1_000; // well within the 30s cache window
  assert.ok(readSessionStory([root], slug, () => now));
  now += 40_000; // past the cache window: the removal is now visible
  assert.equal(readSessionStory([root], slug, () => now), null);
});

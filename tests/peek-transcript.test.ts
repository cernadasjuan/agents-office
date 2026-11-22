import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Observation } from '../server/seam.js';
import { DEFAULT_JIRA_SITES, parseJiraSites, PeekReader, PEEK_LINE_MAX, PEEK_MAX_LINES, PEEK_TAIL_LINES } from '../plugins/peek/transcript.js';

// Synthetic transcripts in a temp folder. No test reads the user's ~/.claude.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-peek-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const FAKE_GHP = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const FAKE_AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';

let counter = 0;
function transcript(lines: unknown[]): string {
  const file = path.join(root, `t${counter++}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

const text = (value: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: value }] } });
const tool = (name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] } });
const user = (value: string) => ({ type: 'user', message: { role: 'user', content: value } });

function agent(transcriptPath: string | undefined, extra: Partial<Observation> = {}): Observation {
  return {
    id: 'raw-session', provider: 'claude', name: 'n', activity: 'implementing',
    internal: { cwd: root, ...(transcriptPath ? { transcriptPath } : {}) }, display: {}, ...extra,
  };
}

test('Recent: the last 10 lines, newest last, each 200 characters or less', () => {
  const lines = Array.from({ length: 15 }, (_, i) => text(`line ${i} ${'word '.repeat(60)}`));
  const peek = new PeekReader().read(agent(transcript(lines)));
  assert.equal(peek.lines.length, PEEK_MAX_LINES);
  assert.match(peek.lines[0].text, /^line 5 /);
  assert.match(peek.lines[9].text, /^line 14 /);
  for (const line of peek.lines) assert.ok(line.text.length <= PEEK_LINE_MAX);
});

test('Recent: a token, an API key and an email are masked, also near the cut', () => {
  const file = transcript([
    text(`token ${FAKE_GHP} and key ${FAKE_AWS} for jane.doe@example.com`),
    text(`${'x'.repeat(185)} ${FAKE_GHP}`),
  ]);
  const peek = new PeekReader().read(agent(file));
  const all = JSON.stringify(peek);
  for (const secret of [FAKE_GHP, FAKE_AWS, 'jane.doe@example.com', 'ghp_']) assert.equal(all.includes(secret), false, secret);
  assert.match(peek.lines[0].text, /\[secret\].*\[secret\].*\[email\]/);
});

test('Recent: tool calls show the tool name and a short safe summary, never the raw input', () => {
  const file = transcript([
    tool('Bash', { command: 'curl -H "X-Api: hidden-value-123" https://internal.example/x' }),
    tool('Bash', { command: 'FOO=1 git commit -m "secret plan"' }),
    tool('Edit', { file_path: '/private/customer/repo/src/app.ts', old_string: 'a', new_string: 'b' }),
    tool('Skill', { skill: 'crit:crit', args: 'private args' }),
    tool('Agent', { subagent_type: 'Explore', prompt: 'look for the private thing' }),
    tool('WebFetch', { url: 'https://docs.example.com/a?q=private' }),
    tool('Grep', { pattern: 'private-pattern' }),
  ]);
  const peek = new PeekReader().read(agent(file));
  assert.deepEqual(peek.lines.map((line) => [line.kind, line.text]), [
    ['tool', 'Bash · curl'],
    ['tool', 'Bash · git commit'],
    ['tool', 'Edit · app.ts'],
    ['tool', 'Skill · crit:crit'],
    ['tool', 'Agent · Explore'],
    ['tool', 'WebFetch · docs.example.com'],
    ['tool', 'Grep'],
  ]);
  const all = JSON.stringify(peek);
  for (const raw of ['hidden-value', 'secret plan', '/private/customer', 'private args', 'private thing', 'q=private', 'private-pattern']) {
    assert.equal(all.includes(raw), false, raw);
  }
});

test('Recent: user prompts and tool results never show', () => {
  const file = transcript([user('my private prompt'), { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'private output' }] } }, text('hello')]);
  const peek = new PeekReader().read(agent(file));
  assert.deepEqual(peek.lines.map((line) => line.text), ['hello']);
});

test('the last open question is pinned when the agent waits and its newest line is assistant text', () => {
  const file = transcript([tool('Read', { file_path: '/x/a.ts' }), text('Should I merge the branch now?')]);
  const reader = new PeekReader();
  assert.equal(reader.read(agent(file, { display: { attention: 'your-turn' } })).question, 'Should I merge the branch now?');
  assert.equal(reader.read(agent(file)).question, undefined, 'no attention, no pin');
  const busy = transcript([text('Should I?'), tool('Read', { file_path: '/x/a.ts' })]);
  assert.equal(reader.read(agent(busy, { display: { attention: 'waiting' } })).question, undefined, 'a tool call came after the text');
});

test('Assets: GitHub issues and PRs, GitLab MRs and Jira keys from tool calls, newest first, at most 10', () => {
  const file = transcript([
    tool('Bash', { command: 'gh issue view 80 -R gabriel-amyot/agents-office --comments' }),
    tool('Bash', { command: 'gh pr create -R gabriel-amyot/agents-office --base main' }),
    tool('Bash', { command: 'gh pr view 103 -R gabriel-amyot/agents-office' }),
    tool('WebFetch', { url: 'https://gitlab.example.com/grp/app/-/merge_requests/42' }),
    tool('mcp__atlassian__getJiraIssue', { issueIdOrKey: 'KTP-1453' }),
    tool('Bash', { command: 'echo SPV-69 ABC-12 UTF-8 SHA-256' }),
    tool('Bash', { command: 'gh issue view 80 -R gabriel-amyot/agents-office' }),
  ]);
  const peek = new PeekReader({ jiraSites: DEFAULT_JIRA_SITES }).read(agent(file));
  assert.deepEqual(peek.assets.map((asset) => [asset.kind, asset.label, asset.url]), [
    ['issue', 'agents-office#80', 'https://github.com/gabriel-amyot/agents-office/issues/80'],
    ['jira', 'SPV-69', 'https://origin8cares.atlassian.net/browse/SPV-69'],
    ['jira', 'KTP-1453', 'https://beklever.atlassian.net/browse/KTP-1453'],
    ['mr', 'app!42', 'https://gitlab.example.com/grp/app/-/merge_requests/42'],
    ['pr', 'agents-office#103', 'https://github.com/gabriel-amyot/agents-office/pull/103'],
  ]);

  const many = transcript(Array.from({ length: 14 }, (_, i) => tool('Bash', { command: `gh issue view ${i + 1} -R o/r` })));
  const capped = new PeekReader().read(agent(many));
  assert.equal(capped.assets.length, 10);
  assert.equal(capped.assets[0].label, 'r#14');
});

test('Jira sites come from the config by key prefix; text outside tool calls never counts', () => {
  assert.deepEqual(parseJiraSites('ABC=https://abc.example/browse/, bad=http://x/, XY=notaurl'), { ABC: 'https://abc.example/browse/' });
  assert.deepEqual(parseJiraSites(undefined), DEFAULT_JIRA_SITES);
  const file = transcript([text('see KTP-1 and ABC-2'), tool('Bash', { command: 'echo ABC-2 KTP-3' })]);
  const peek = new PeekReader({ jiraSites: { ABC: 'https://abc.example/browse/' } }).read(agent(file));
  assert.deepEqual(peek.assets.map((asset) => asset.url), ['https://abc.example/browse/ABC-2']);
});

test('Equipment: skills used (newest first) and modified repos as short names, never paths', () => {
  const repo = path.join(root, 'repos', 'alpha');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const worktree = path.join(root, 'worktrees', '80-peek-plugin');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(root, 'repos', 'beta', '.git', 'worktrees', '80-peek-plugin')}\n`);
  const file = transcript([
    tool('Skill', { skill: 'tdd' }),
    tool('Edit', { file_path: path.join(repo, 'src', 'a.ts') }),
    tool('Skill', { skill: 'crit:crit' }),
    tool('Bash', { command: `git -C ${worktree} commit -m "x"` }),
    tool('Read', { file_path: path.join(root, 'repos', 'gamma', 'b.ts') }),
    tool('Skill', { skill: 'tdd' }),
  ]);
  const peek = new PeekReader().read(agent(file));
  assert.deepEqual(peek.skills, ['tdd', 'crit:crit']);
  assert.deepEqual(peek.repos, ['beta', 'alpha']);
  assert.equal(JSON.stringify(peek).includes(root), false);
});

test('the reader reads only new bytes on the next request and starts at the tail of a large file', () => {
  const file = transcript([text('first')]);
  const reader = new PeekReader();
  assert.deepEqual(reader.read(agent(file)).lines.map((line) => line.text), ['first']);
  fs.appendFileSync(file, JSON.stringify(text('second')) + '\n');
  assert.deepEqual(reader.read(agent(file)).lines.map((line) => line.text), ['first', 'second']);

  const big = path.join(root, 'big.jsonl');
  const filler = JSON.stringify(text('old ' + 'z'.repeat(1000))) + '\n';
  fs.writeFileSync(big, filler.repeat(3000) + JSON.stringify(text('newest')) + '\n');
  const peek = new PeekReader({ tailBytes: 64 * 1024 }).read(agent(big));
  assert.equal(peek.lines[peek.lines.length - 1]?.text, 'newest');
});

test('no transcript, a missing file or a non-jsonl path gives an empty peek', () => {
  const reader = new PeekReader();
  for (const transcriptPath of [undefined, path.join(root, 'missing.jsonl'), path.join(root, 'x.txt')]) {
    assert.deepEqual(reader.read(agent(transcriptPath)), { lines: [], assets: [], skills: [], repos: [] });
  }
});

test('Recent: white space before a token does not push part of it past the raw cut, and placeholders stay whole', () => {
  const file = transcript([text(`${'\n'.repeat(3980)}${FAKE_GHP} tail`), text(`${'x'.repeat(195)} ${FAKE_GHP}`)]);
  const peek = new PeekReader().read(agent(file));
  assert.equal(JSON.stringify(peek).includes('ghp_'), false);
  assert.equal(peek.lines[0].text, '[secret] tail');
  assert.doesNotMatch(peek.lines[1].text, /\[[a-z]*$/);
});

test('the tail: read(agent, 100) answers up to PEEK_TAIL_LINES, the cache keeps that many', () => {
  const lines = Array.from({ length: 120 }, (_, i) => text(`line ${i}`));
  const file = transcript(lines);
  const reader = new PeekReader();
  const tail = reader.read(agent(file), PEEK_TAIL_LINES);
  assert.equal(tail.lines.length, PEEK_TAIL_LINES);
  assert.equal(tail.lines[0].text, 'line 20');
  assert.equal(tail.lines[PEEK_TAIL_LINES - 1].text, 'line 119');
  // The default (no argument) still answers the short "Recent" window, from the same cache.
  assert.equal(reader.read(agent(file)).lines.length, PEEK_MAX_LINES);
});

// Bubble tests moved to tests/bubble-tail-reader.test.ts (issue #81 review): bubbles now
// read through their own BubbleTailReader, not PeekReader.

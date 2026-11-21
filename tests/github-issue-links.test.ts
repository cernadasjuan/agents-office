import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { World } from '../src/extensions.js';
import { githubIssueUrl } from '../plugins/github/links.js';

function world(boards: Array<{ title: string; numbers: number[] }>, plugins = ['github']): World {
  return {
    plugins,
    rooms: [],
    boards: boards.map((board, i) => ({ id: `b${i}`, title: board.title, columns: [{ name: 'To do', cards: board.numbers.map((number) => ({ number, title: `t${number}` })) }] })),
    jiraTickets: [],
    libraries: [],
  };
}

test('an issue whose repository the server named links to the one board with that short name', () => {
  const w = world([{ title: 'gabriel-amyot/agents-office', numbers: [] }, { title: 'o/other', numbers: [] }]);
  assert.equal(githubIssueUrl({ number: 5, title: '', repo: 'other' }, w), 'https://github.com/o/other/issues/5');
  assert.equal(githubIssueUrl({ number: 78, title: 'Agent card', repo: 'agents-office' }, w), 'https://github.com/gabriel-amyot/agents-office/issues/78');
});

test('case A: an issue of an unconfigured repository never links to a board card with the same number', () => {
  // `gh issue view 12 -R someone/other`: the server sends no repo and no title.
  const w = world([{ title: 'gabriel-amyot/agents-office', numbers: [12] }]);
  assert.equal(githubIssueUrl({ number: 12, title: '' }, w), null);
});

test('case B: with two repositories, a title from repo A never links to the same number on repo B', () => {
  const w = world([{ title: 'a/one', numbers: [] }, { title: 'b/two', numbers: [7] }]);
  assert.equal(githubIssueUrl({ number: 7, title: 'Title from A' }, w), null);
  assert.equal(githubIssueUrl({ number: 7, title: 'Title from A', repo: 'one' }, w), 'https://github.com/a/one/issues/7');
});

test('no link when the short name matches no board or two boards, or the github plugin is off', () => {
  const twins = world([{ title: 'a/same', numbers: [] }, { title: 'b/same', numbers: [] }]);
  assert.equal(githubIssueUrl({ number: 7, title: 't', repo: 'same' }, twins), null);
  assert.equal(githubIssueUrl({ number: 7, title: 't', repo: 'missing' }, twins), null);
  assert.equal(githubIssueUrl({ number: 7, title: 't', repo: 'one' }, world([{ title: 'a/one', numbers: [] }], [])), null);
});

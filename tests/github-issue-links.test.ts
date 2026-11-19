import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { World } from '../src/extensions.js';
import { githubIssueUrl } from '../plugins/github/links.js';

function world(boards: Array<{ title: string; numbers: number[] }>, plugins = ['github']): World {
  return {
    plugins,
    rooms: [],
    boards: boards.map((board, i) => ({ id: `b${i}`, title: board.title, columns: [{ name: 'To do', cards: board.numbers.map((number) => ({ number, title: `t${number}` })) }] })),
  };
}

test('an issue on exactly one configured board links to that repository', () => {
  const w = world([{ title: 'gabriel-amyot/agents-office', numbers: [78, 75] }, { title: 'o/other', numbers: [12] }]);
  assert.equal(githubIssueUrl({ number: 78, title: 'Agent card' }, w), 'https://github.com/gabriel-amyot/agents-office/issues/78');
  assert.equal(githubIssueUrl({ number: 12, title: 'x' }, w), 'https://github.com/o/other/issues/12');
});

test('a repository name on the issue picks the board with that short name', () => {
  const w = world([{ title: 'gabriel-amyot/agents-office', numbers: [] }, { title: 'o/other', numbers: [] }]);
  assert.equal(githubIssueUrl({ number: 5, title: '', repo: 'other' } as never, w), 'https://github.com/o/other/issues/5');
});

test('one configured repository links an issue whose title the plugin found there', () => {
  const w = world([{ title: 'gabriel-amyot/agents-office', numbers: [] }]);
  assert.equal(githubIssueUrl({ number: 40, title: 'Closed long ago' }, w), 'https://github.com/gabriel-amyot/agents-office/issues/40');
  assert.equal(githubIssueUrl({ number: 40, title: '' }, w), null, 'a bare number may belong to another repository');
});

test('no link when the issue is ambiguous, unknown, or the github plugin is off', () => {
  const both = world([{ title: 'a/one', numbers: [7] }, { title: 'b/two', numbers: [7] }]);
  assert.equal(githubIssueUrl({ number: 7, title: 't7' }, both), null);
  assert.equal(githubIssueUrl({ number: 9, title: 't9' }, both), null);
  assert.equal(githubIssueUrl({ number: 7, title: 't7' }, world([{ title: 'a/one', numbers: [7] }], [])), null);
  assert.equal(githubIssueUrl({ number: 7, title: 't7' }, world([{ title: 'not a repo', numbers: [7] }])), null);
});

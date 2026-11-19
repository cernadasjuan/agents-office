import { currentWorld, type World } from '../../src/extensions.js';
import { registerIssueLinker, type CardIssue } from '../../src/ui/AgentCard.js';

/**
 * Issue links for the agent card. The browser knows only the board titles
 * (`owner/name`, from `/api/world`), so an issue links to a repository only
 * when exactly one configured board matches it. Otherwise it stays plain text.
 */

const REPO_TITLE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function githubIssueUrl(issue: CardIssue & { repo?: string }, world: World): string | null {
  if (!world.plugins.includes('github')) return null;
  const repos = world.boards.filter((board) => REPO_TITLE.test(board.title));
  const holds = (board: World['boards'][number]) => board.columns.some((column) => column.cards.some((card) => card.number === issue.number));
  let matches: typeof repos;
  if (typeof issue.repo === 'string' && issue.repo) matches = repos.filter((board) => board.title.split('/')[1] === issue.repo);
  else {
    matches = repos.filter(holds);
    // The plugin sets a title only for an issue it found in a configured repository.
    if (matches.length === 0 && repos.length === 1 && issue.title) matches = repos;
  }
  return matches.length === 1 ? `https://github.com/${matches[0].title}/issues/${issue.number}` : null;
}

registerIssueLinker((issue) => githubIssueUrl(issue, currentWorld()));

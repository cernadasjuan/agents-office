import { currentWorld, type World } from '../../src/extensions.js';
import { registerIssueLinker, type CardIssue } from '../../src/ui/AgentCard.js';

/**
 * Issue links for the agent card. The browser knows only the board titles
 * (`owner/name`, from `/api/world`). An issue links only when the server named
 * its repository (`issues[].repo`, the short name) and exactly one configured
 * board has that short name. A number alone never links: it may belong to
 * another repository.
 */

const REPO_TITLE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function githubIssueUrl(issue: CardIssue, world: World): string | null {
  if (!world.plugins.includes('github') || typeof issue.repo !== 'string' || !issue.repo) return null;
  const matches = world.boards.filter((board) => REPO_TITLE.test(board.title) && board.title.split('/')[1] === issue.repo);
  return matches.length === 1 ? `https://github.com/${matches[0].title}/issues/${issue.number}` : null;
}

registerIssueLinker((issue) => githubIssueUrl(issue, currentWorld()));

import type { BoardInput, DisplayExtras, OfficePlugin } from '../../server/seam.js';
import { boardColumns, columnOf, IssueCache, parseRepos, runFile, type RunFile } from './gh.js';
import { TranscriptIssues, type IssueRef } from './transcript.js';

/**
 * GitHub plugin. Opt-in twice: AGENTS_OFFICE_PLUGINS=github loads it, and
 * AGENTS_OFFICE_GITHUB_REPOS=owner/name[,owner/name] gives it repositories.
 * Without repositories it adds nothing and runs nothing.
 *
 * - World: one kanban board per repository (To do, In progress, Done).
 * - Enricher: the issues each agent works on, from its own tool calls.
 */

export interface GithubPluginOptions {
  repos?: string;
  run?: RunFile;
  now?: () => number;
}

type IssueCard = NonNullable<DisplayExtras['issues']>[number];

export function createGithubPlugin(options: GithubPluginOptions = {}): OfficePlugin {
  const repos = parseRepos(options.repos);
  if (repos.length === 0) return { name: 'github' };
  const now = options.now ?? Date.now;
  const cache = new IssueCache(options.run ?? runFile, now);
  const transcripts = new TranscriptIssues();

  function card(ref: IssueRef): IssueCard {
    const candidates = ref.repo ? [ref.repo].filter((repo) => repos.includes(repo)) : repos;
    for (const repo of candidates) {
      const issue = cache.issues(repo)?.find((item) => item.number === ref.number);
      if (!issue) continue;
      const column = columnOf(issue, now());
      return { number: issue.number, title: issue.title, ...(column ? { column } : {}) };
    }
    return { number: ref.number, title: '' };
  }

  return {
    name: 'github',
    world: [{
      id: 'github-boards',
      async world() {
        await Promise.all(repos.map((repo) => cache.refresh(repo)));
        const boards: BoardInput[] = [];
        for (const repo of repos) {
          const issues = cache.issues(repo);
          if (issues) boards.push({ key: `github:${repo}`, title: repo, columns: boardColumns(issues, now()) });
        }
        return boards.length > 0 ? { boards } : {};
      },
    }],
    enrichers: [{
      id: 'github-issue-cards',
      enrich(observations) {
        for (const observation of observations) {
          const transcriptPath = observation.internal.transcriptPath;
          if (typeof transcriptPath !== 'string' || observation.display.issues) continue;
          const refs = transcripts.refs(transcriptPath);
          if (refs.length > 0) observation.display.issues = refs.map(card);
        }
      },
    }],
  };
}

export default createGithubPlugin({ repos: process.env.AGENTS_OFFICE_GITHUB_REPOS });

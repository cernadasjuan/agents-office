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

/** Under the 2 s seam step limit: a slow gh gives cards without titles and colors, not no cards. */
const ENRICH_WAIT_MS = 1500;

async function withinMs(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}

const shortName = (repo: string): string => repo.slice(repo.indexOf('/') + 1);

export function createGithubPlugin(options: GithubPluginOptions = {}): OfficePlugin {
  const repos = parseRepos(options.repos);
  if (repos.length === 0) return { name: 'github' };
  const now = options.now ?? Date.now;
  const cache = new IssueCache(options.run ?? runFile, now);
  const transcripts = new TranscriptIssues();

  /**
   * The card names a repository only when the call named it (`-R`, URL) and it is
   * a configured one, or when exactly one configured repository has that issue
   * number. A bare number that matches no board, or matches more than one, is a
   * guess either way: the card then reads `#N` with no repository and no link.
   * The border color comes from the issue's labels on the board data (see
   * `cardColor` in gh.ts).
   */
  function card(ref: IssueRef): IssueCard {
    const candidates = ref.repo ? [ref.repo].filter((repo) => repos.includes(repo)) : repos;
    const matches = candidates.filter((repo) => cache.issues(repo)?.some((item) => item.number === ref.number));
    if (matches.length === 1) {
      const [repo] = matches;
      const issue = cache.issues(repo)!.find((item) => item.number === ref.number)!;
      const column = columnOf(issue, now());
      return { number: issue.number, title: issue.title, ...(column ? { column } : {}), repo: shortName(repo),
        ...(issue.labelColor ? { color: issue.labelColor } : {}) };
    }
    const named = ref.repo && candidates.length === 1 ? candidates[0] : undefined;
    return { number: ref.number, title: '', ...(named ? { repo: shortName(named) } : {}) };
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
          // The board's own repo tag (issue #191 revision) keeps the full `owner/repo` the
          // configuration already names, unlike the issue card's own `repo` (`shortName`,
          // below): `matchesFloor` needs the owner half to tell apart two repos that share a
          // leaf name under different owners, the same way a floor's own remote-derived name does.
          if (issues) boards.push({ key: `github:${repo}`, title: repo, columns: boardColumns(issues, now()), repo });
        }
        return boards.length > 0 ? { boards } : {};
      },
    }],
    enrichers: [{
      id: 'github-issue-cards',
      async enrich(observations) {
        const found: Array<{ observation: (typeof observations)[number]; refs: IssueRef[] }> = [];
        for (const observation of observations) {
          const transcriptPath = observation.internal.transcriptPath;
          if (typeof transcriptPath !== 'string' || observation.display.issues) continue;
          const refs = transcripts.refs(transcriptPath);
          if (refs.length > 0) found.push({ observation, refs });
        }
        if (found.length === 0) return;
        // Titles and colors come from the board data: fill a cold cache, but never wait past the seam step limit
        await withinMs(Promise.all(repos.map((repo) => cache.refresh(repo))), ENRICH_WAIT_MS);
        for (const { observation, refs } of found) observation.display.issues = refs.map(card);
      },
    }],
  };
}

export default createGithubPlugin({ repos: process.env.AGENTS_OFFICE_GITHUB_REPOS });

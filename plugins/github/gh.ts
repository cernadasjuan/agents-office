import { execFile } from 'node:child_process';
import type { BoardInput } from '../../server/seam.js';

/**
 * Issue data through the `gh` CLI. gh handles the login, so this code never
 * reads a token. No shell: one fixed command with a timeout and an output cap.
 */

export type RunFile = (file: string, args: string[], options: { timeout: number; maxBuffer: number; shell: false; windowsHide: true }) => Promise<string>;

export const runFile: RunFile = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GH_TIMEOUT_MS = 5000;
const MAX_OUTPUT = 1_000_000;
const ISSUE_LIMIT = 60;
const CACHE_MS = 60_000;
const DONE_WINDOW_MS = 7 * 86_400_000;
const DONE_MAX = 8;
const IN_PROGRESS_LABELS = new Set(['in-progress', 'doing']);

/** Repositories from a comma list. Anything but `owner/name` is dropped. */
export function parseRepos(value: string | undefined): string[] {
  const names = (value ?? '').split(',').map((name) => name.trim())
    .filter((name) => REPO.test(name) && !name.split('/').some((part) => part === '.' || part === '..' || part.startsWith('-')));
  return Array.from(new Set(names));
}

export function isRepoName(value: string): boolean {
  return parseRepos(value).length === 1;
}

export interface Issue {
  number: number;
  title: string;
  open: boolean;
  inProgressLabel: boolean;
  assigned: boolean;
  updatedAt: number;
}

function labelKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** Shape-check the `gh issue list --json` output. Undefined when it is not a list. */
export function parseIssueList(stdout: string): Issue[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const issues: Issue[] = [];
  for (const item of data.slice(0, ISSUE_LIMIT)) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.number !== 'number' || !Number.isInteger(raw.number) || raw.number <= 0) continue;
    if (typeof raw.title !== 'string' || (raw.state !== 'OPEN' && raw.state !== 'CLOSED')) continue;
    const labels = Array.isArray(raw.labels) ? raw.labels.slice(0, 30) : [];
    const updatedAt = typeof raw.updatedAt === 'string' ? Date.parse(raw.updatedAt) : NaN;
    issues.push({
      number: raw.number,
      title: raw.title.slice(0, 200),
      open: raw.state === 'OPEN',
      inProgressLabel: labels.some((label) => typeof label?.name === 'string' && IN_PROGRESS_LABELS.has(labelKey(label.name))),
      assigned: Array.isArray(raw.assignees) && raw.assignees.length > 0,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    });
  }
  return issues;
}

export type ColumnName = 'To do' | 'In progress' | 'Done';

/**
 * Columns, newest first:
 * - "To do": open, unassigned, no in-progress label.
 * - "In progress": open and assigned, or labeled in-progress or doing.
 * - "Done": closed and updated in the last 7 days, at most 8.
 */
export function columnOf(issue: Issue, now: number): ColumnName | undefined {
  if (issue.open) return issue.assigned || issue.inProgressLabel ? 'In progress' : 'To do';
  return now - issue.updatedAt <= DONE_WINDOW_MS ? 'Done' : undefined;
}

export function boardColumns(issues: Issue[], now: number): BoardInput['columns'] {
  const sorted = [...issues].sort((a, b) => b.updatedAt - a.updatedAt);
  const cards = (name: ColumnName) => sorted.filter((issue) => columnOf(issue, now) === name)
    .map((issue) => ({ number: issue.number, title: issue.title }));
  return [
    { name: 'To do', cards: cards('To do') },
    { name: 'In progress', cards: cards('In progress') },
    { name: 'Done', cards: cards('Done').slice(0, DONE_MAX) },
  ];
}

interface Entry { issues?: Issue[]; fetchedAt: number; inFlight?: Promise<void> }

/** Issue lists per repository, refreshed at most once a minute. A failure keeps the last good list. */
export class IssueCache {
  private entries = new Map<string, Entry>();

  constructor(private run: RunFile, private now: () => number) {}

  issues(repo: string): Issue[] | undefined {
    return this.entries.get(repo)?.issues;
  }

  refresh(repo: string): Promise<void> {
    if (!isRepoName(repo)) return Promise.resolve();
    const entry = this.entries.get(repo) ?? { fetchedAt: -Infinity };
    this.entries.set(repo, entry);
    if (entry.inFlight) return entry.inFlight;
    if (this.now() - entry.fetchedAt < CACHE_MS) return Promise.resolve();
    entry.fetchedAt = this.now();
    entry.inFlight = this.run('gh', ['issue', 'list', '-R', repo, '--state', 'all', '--limit', String(ISSUE_LIMIT),
      '--json', 'number,title,state,labels,assignees,updatedAt'],
    { timeout: GH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, shell: false, windowsHide: true })
      .then((stdout) => {
        const issues = parseIssueList(stdout);
        if (issues) entry.issues = issues;
      })
      .catch(() => undefined)
      .finally(() => { entry.inFlight = undefined; });
    return entry.inFlight;
  }
}

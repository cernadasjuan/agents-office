import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { SESSION_PERSONAS, type SessionStoryInput } from '../../server/seam.js';

/**
 * Tombstone story reader (issue #160). Resolves a mission journey entry's session slug to its
 * archived `sessions/archive[/done|/abandoned]/<slug>/intent-tree.md` (written once at session
 * close, per `sessions/schema.yaml`'s `intent_tree_format`) under the same roots
 * `AGENTS_OFFICE_MISSION_ROOTS` already names for mission records. Never reads the live ledger,
 * a transcript, a prompt or a tool call: only this one static file, and only the display fields
 * `server/seam.ts`'s `projectStory` goes on to whitelist and cap. A missing or oversized record
 * reads as no story (S6); the card then says so plainly rather than guessing.
 */

/** A session slug's own shape: the same pattern the engraved name (issue #159) must also pass. */
export const SESSION_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_RECORD_BYTES = 200_000;
const STORY_CACHE_MS = 30_000;
const MAX_DONE_ITEMS = 12;
const MAX_HANDOFFS = 10;
const MAX_ISSUES = 15;
const ARCHIVE_SUBDIRS = ['', 'done', 'abandoned'];

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

/**
 * Which GitHub repos and owners this office is configured to know about (review round 2):
 * a real archived record's `tickets_referenced` is often a bare `repo#N`, with no owner at
 * all, and the reader is the one place with enough context (this config) to resolve it.
 */
export interface GithubConfig {
  /** `AGENTS_OFFICE_GITHUB_REPOS`: `owner/repo` pairs, comma-separated. */
  repos: Array<{ owner: string; repo: string }>;
  /** `AGENTS_OFFICE_GITHUB_OWNERS`: default owners, comma-separated. Used only when exactly one is configured. */
  owners: string[];
}

export const EMPTY_GITHUB_CONFIG: GithubConfig = { repos: [], owners: [] };

const OWNER_REPO_PAIR = /^([A-Za-z0-9_.-]{1,64})\/([A-Za-z0-9_.-]{1,100})$/;
const OWNER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** A bare `.` or `..` owner or repo segment: valid against the patterns above, never a real one. */
const DOT_SEGMENT = new Set(['.', '..']);

/**
 * Parses `AGENTS_OFFICE_GITHUB_REPOS` and `AGENTS_OFFICE_GITHUB_OWNERS`. Malformed entries are
 * dropped, including a `.` or `..` owner or repo segment: the owner/repo patterns above allow
 * dots, same as `resolveIssueRef`'s own refs and the `repoShortName`/`repos` patterns in
 * `server/seam.ts`, so this config needs the same explicit rejection they already have.
 */
export function parseGithubConfig(repos: string | undefined, owners: string | undefined): GithubConfig {
  const repoList = (repos ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
    .flatMap((entry) => {
      const match = OWNER_REPO_PAIR.exec(entry);
      if (!match) return [];
      const [, owner, repo] = match;
      return DOT_SEGMENT.has(owner) || DOT_SEGMENT.has(repo) ? [] : [{ owner, repo }];
    });
  const ownerList = (owners ?? '').split(',').map((entry) => entry.trim())
    .filter((entry) => OWNER_NAME.test(entry) && !DOT_SEGMENT.has(entry));
  return { repos: repoList, owners: ownerList };
}

function resolveOwner(repo: string, config: GithubConfig): string | undefined {
  const matches = [...new Set(config.repos.filter((entry) => entry.repo === repo).map((entry) => entry.owner))];
  if (matches.length === 1) return matches[0];
  return config.owners.length === 1 ? config.owners[0] : undefined;
}

const FULL_ISSUE_REF = /^([A-Za-z0-9_.-]{1,64})\/([A-Za-z0-9_.-]{1,100})#(\d{1,7})$/;
const BARE_ISSUE_REF = /^([A-Za-z0-9_.-]{1,100})#(\d{1,7})$/;
/** A Jira-style key (`PREFIX-123`): never a GitHub issue, shown as plain text, same shape the Jira plugin already links. */
const JIRA_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

export interface ResolvedIssueRef {
  label: string;
  url?: string;
}

/**
 * One issue reference, in any of three shapes a real archived record uses: a full
 * `owner/repo#N` (`gh_issues_referenced`'s own convention), a bare `repo#N`
 * (`tickets_referenced`'s real shape — review round 2: no owner at all), or a Jira-style key.
 * A bare ref resolves to a link only when `config` names exactly one owner for that repo, or
 * exactly one default owner overall; otherwise it still shows, as plain text, never dropped.
 */
export function resolveIssueRef(ref: string, config: GithubConfig): ResolvedIssueRef | undefined {
  const value = ref.trim();
  const full = FULL_ISSUE_REF.exec(value);
  if (full) {
    const [, owner, repo, numberText] = full;
    if (DOT_SEGMENT.has(owner) || DOT_SEGMENT.has(repo)) return undefined;
    const number = Number(numberText);
    if (number < 1) return undefined;
    return { label: `${owner}/${repo}#${number}`, url: `https://github.com/${owner}/${repo}/issues/${number}` };
  }
  const bare = BARE_ISSUE_REF.exec(value);
  if (bare) {
    const [, repo, numberText] = bare;
    if (DOT_SEGMENT.has(repo)) return undefined;
    const number = Number(numberText);
    if (number < 1) return undefined;
    const owner = resolveOwner(repo, config);
    const label = `${repo}#${number}`;
    return owner ? { label, url: `https://github.com/${owner}/${repo}/issues/${number}` } : { label };
  }
  return JIRA_KEY.test(value) ? { label: value } : undefined;
}

// A box-drawing run (the tree's connectors) or plain whitespace, stripped from a line's start
// so `◉`-marked lines are found regardless of their nesting depth in the Intent Tree.
const LEADING_TREE_CHARS = /^[\s│├└┌┐┘─╰╭]+/;

/** One line of display text per `◉`-marked tree node (done or branch-complete), nesting dropped. */
export function extractDoneList(body: string): string[] {
  const items: string[] = [];
  for (const raw of body.split('\n')) {
    const stripped = raw.replace(LEADING_TREE_CHARS, '');
    if (!stripped.startsWith('◉')) continue;
    const item = stripped.slice('◉'.length).trim();
    if (item) items.push(item);
  }
  return items.slice(0, MAX_DONE_ITEMS);
}

/** Escapes a string for use inside a `RegExp` (the roster has names like "Dr. Quinn"). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every known BMAD persona name (`SESSION_PERSONAS`, the closed set) mentioned anywhere in the body. */
export function extractPersonas(body: string): string[] {
  return SESSION_PERSONAS.filter((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(body));
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Parse one `intent-tree.md` file's contents. `null` when it is not a valid record (S6). */
export function parseIntentTree(raw: string, config: GithubConfig = EMPTY_GITHUB_CONFIG): SessionStoryInput | null {
  const match = FRONTMATTER.exec(raw);
  if (!match) return null;
  let front: unknown;
  try {
    front = parse(match[1]);
  } catch {
    return null;
  }
  if (typeof front !== 'object' || front === null) return null;
  const record = front as Record<string, unknown>;
  const intent = text(record.intent);
  if (!intent) return null;
  const body = match[2] ?? '';
  const rawCounts = record.node_counts;
  const counts = rawCounts && typeof rawCounts === 'object'
    ? {
        done: Number((rawCounts as Record<string, unknown>).done) || 0,
        open: Number((rawCounts as Record<string, unknown>).open) || 0,
        abandoned: Number((rawCounts as Record<string, unknown>).abandoned) || 0,
      }
    : undefined;
  // Review round 2: a real archived record's own issue refs live in `tickets_referenced`
  // (bare `repo#N`, or a Jira key), not `gh_issues_referenced` (that field exists per the
  // session plugin's own schema comment, but is rarely populated in practice). Read both,
  // de-duplicated by the raw ref text, `gh_issues_referenced` first since it is already fully
  // qualified.
  const refs = [...new Set([...stringList(record.gh_issues_referenced), ...stringList(record.tickets_referenced)])].slice(0, MAX_ISSUES * 2);
  const issues = refs.map((ref) => resolveIssueRef(ref, config))
    .filter((issue): issue is ResolvedIssueRef => issue !== undefined).slice(0, MAX_ISSUES);
  return {
    intent,
    personas: extractPersonas(body),
    ...(counts ? { counts } : {}),
    doneList: extractDoneList(body),
    handoffs: stringList(record.handoffs_generated).slice(0, MAX_HANDOFFS),
    issues,
  };
}

/** True when `real` is `root` itself or genuinely inside it (never a `..`-escaped sibling). */
function withinRoot(real: string, root: string): boolean {
  const relative = path.relative(root, real);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The archived record's real path for a slug, or undefined: not a slug, not found, too large,
 * or outside the archive root once symlinks resolve. `fs.realpathSync` follows every symlink in
 * the path (a symlinked session directory, or the file itself); review round 1 (Codex): without
 * this, a symlink planted inside an archive directory could point the read anywhere on disk.
 */
export function findStoryFile(roots: string[], slug: string): string | undefined {
  if (!SESSION_SLUG.test(slug)) return undefined;
  for (const root of roots) {
    let archiveRoot: string;
    try {
      archiveRoot = fs.realpathSync(path.join(root, 'sessions', 'archive'));
    } catch {
      continue;
    }
    for (const sub of ARCHIVE_SUBDIRS) {
      const file = path.join(root, 'sessions', 'archive', sub, slug, 'intent-tree.md');
      try {
        const real = fs.realpathSync(file);
        if (!withinRoot(real, archiveRoot)) continue;
        const stat = fs.statSync(real);
        if (stat.isFile() && stat.size <= MAX_RECORD_BYTES) return real;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

const cache = new Map<string, { at: number; story: SessionStoryInput | null }>();

/** Tests only: forget every cached read. */
export function resetSessionStoryCache(): void {
  cache.clear();
}

/** A session's story, or null when no archived record exists or it does not parse. Cached per slug. */
export function readSessionStory(
  roots: string[],
  slug: string,
  now: () => number = Date.now,
  config: GithubConfig = EMPTY_GITHUB_CONFIG,
): SessionStoryInput | null {
  const key = `${roots.join('|')}::${slug}`;
  const cached = cache.get(key);
  if (cached && now() - cached.at < STORY_CACHE_MS) return cached.story;
  const file = findStoryFile(roots, slug);
  let story: SessionStoryInput | null = null;
  if (file) {
    try {
      story = parseIntentTree(fs.readFileSync(file, 'utf-8'), config);
    } catch {
      story = null;
    }
  }
  cache.set(key, { at: now(), story });
  return story;
}

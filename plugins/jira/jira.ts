import fs from 'node:fs';
import path from 'node:path';
import type { JiraTicketInput } from '../../server/seam.js';

/**
 * Jira credentials and the search call (issue #145). Read-only: one GET, Basic
 * auth, a timeout, a cache. No token is ever put in a ticket, logged, or sent
 * anywhere but the Authorization header of this one request.
 */

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  token: string;
}

/** `path` reads a file and returns its text, or throws when it is missing or unreadable. */
export type ReadFile = (filePath: string) => string;

/** `path` stats a file, or throws when it is missing or unreadable. Checked before any read. */
export type StatFile = (filePath: string) => { isFile(): boolean; size: number };

const MAX_CREDENTIALS_FILE = 4096;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The Jira site root (no path, query or fragment). `https://` always; `http://`
 * only to loopback, the same carve-out S1 already gives this office's own
 * server (loopback only) — a local mock Jira for development and tests, never
 * a real site over plain HTTP.
 */
function siteUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.origin;
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function plainText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Shape-check a credentials object (from the environment or the local file). All three fields are required. */
function credentialsFrom(baseUrl: unknown, email: unknown, token: unknown): JiraCredentials | undefined {
  const url = siteUrl(baseUrl);
  const mail = plainText(email);
  // The token is a secret: trimmed only to drop a trailing newline from a file, never logged.
  const key = typeof token === 'string' ? token.trim() : '';
  return url && mail && key ? { baseUrl: url, email: mail, token: key } : undefined;
}

/**
 * Credentials from `AGENTS_OFFICE_JIRA_BASE_URL`/`_EMAIL`/`_TOKEN`, else a local JSON file
 * (`{"baseUrl", "email", "token"}`) at `AGENTS_OFFICE_JIRA_CREDENTIALS_FILE`, else
 * `~/.config/agents-office/jira.json`. Undefined when neither gives all three fields,
 * the file is too large, or it does not parse: the plugin then adds no board (issue #145 AC3).
 *
 * The file is stat-checked before it is read (issue #145 review): not a regular file, or
 * larger than the cap, and the read never happens at all.
 */
export function resolveJiraCredentials(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
  readFile: ReadFile,
  statFile: StatFile = defaultStatFile,
): JiraCredentials | undefined {
  const fromEnv = credentialsFrom(env.AGENTS_OFFICE_JIRA_BASE_URL, env.AGENTS_OFFICE_JIRA_EMAIL, env.AGENTS_OFFICE_JIRA_TOKEN);
  if (fromEnv) return fromEnv;

  const filePath = plainText(env.AGENTS_OFFICE_JIRA_CREDENTIALS_FILE) || path.join(homedir(), '.config', 'agents-office', 'jira.json');
  let stat: { isFile(): boolean; size: number };
  try {
    stat = statFile(filePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > MAX_CREDENTIALS_FILE) return undefined;

  let raw: string;
  try {
    raw = readFile(filePath);
  } catch {
    return undefined;
  }
  if (raw.length > MAX_CREDENTIALS_FILE) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  return credentialsFrom(record.baseUrl, record.email, record.token);
}

export const defaultReadFile: ReadFile = (filePath) => fs.readFileSync(filePath, 'utf8');
export const defaultStatFile: StatFile = (filePath) => fs.statSync(filePath);

/** The open sprint, tickets assigned to the authenticated user (issue #145 default scope). */
export const JIRA_JQL = 'sprint in openSprints() AND assignee = currentUser() ORDER BY updated DESC';
const MAX_RESULTS = 50;
const FETCH_TIMEOUT_MS = 8000;
export const CACHE_MS = 120_000;

function fieldString(fields: Record<string, unknown>, key: string): string {
  return typeof fields[key] === 'string' ? fields[key] as string : '';
}

function fieldName(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).name === 'string'
    ? (value as Record<string, unknown>).name as string
    : '';
}

export interface JiraSearchPage {
  tickets: JiraTicketInput[];
  isLast: boolean;
  nextPageToken?: string;
}

/**
 * Shape-check one page of the `/rest/api/3/search/jql` response. Undefined when `issues` is
 * not an array. `isLast` comes from the response field when present; without a
 * `nextPageToken` there is nothing to follow regardless, so that counts as the last page too
 * (the endpoint has shipped without `isLast` in some responses).
 */
export function parseJiraSearchPage(data: unknown, baseUrl: string): JiraSearchPage | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const issues = record.issues;
  if (!Array.isArray(issues)) return undefined;
  const tickets: JiraTicketInput[] = [];
  for (const item of issues) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.key !== 'string') continue;
    const fields = typeof raw.fields === 'object' && raw.fields !== null ? raw.fields as Record<string, unknown> : {};
    const status = fieldName(fields, 'status');
    if (!status) continue;
    const summary = fieldString(fields, 'summary');
    const priority = fieldName(fields, 'priority');
    const assignee = typeof fields.assignee === 'object' && fields.assignee !== null
      ? fieldString(fields.assignee as Record<string, unknown>, 'displayName')
      : '';
    tickets.push({
      key: raw.key,
      summary,
      status,
      ...(assignee ? { assignee } : {}),
      ...(priority ? { priority } : {}),
      url: `${baseUrl}/browse/${raw.key}`,
    });
  }
  const nextPageToken = typeof record.nextPageToken === 'string' && record.nextPageToken ? record.nextPageToken : undefined;
  return { tickets, isLast: record.isLast === true || nextPageToken === undefined, nextPageToken };
}

const PAGE_SIZE = 50;
/** A hard stop regardless of `isLast`/`nextPageToken`, so a misbehaving response can never loop forever. */
const MAX_PAGES = 3;

/** One debug-level line, never a credential, an email, or a raw response body. */
function debugNote(message: string): void {
  console.debug(`[agents-office] jira: ${message}`);
}

/**
 * The search call, following pagination, Basic auth, a timeout per page. Never throws: any
 * failure (a non-OK response, including the 410 Jira Cloud now answers on the old
 * `/rest/api/3/search` path, an unexpected shape, or a network error) is undefined, with one
 * debug-level note. `GET /rest/api/3/search/jql` is the current endpoint (issue #145 review);
 * Atlassian removed `/rest/api/3/search`.
 */
export async function fetchJiraTickets(
  doFetch: typeof fetch,
  credentials: JiraCredentials,
): Promise<JiraTicketInput[] | undefined> {
  const auth = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
  const tickets: JiraTicketInput[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('/rest/api/3/search/jql', credentials.baseUrl);
    url.searchParams.set('jql', JIRA_JQL);
    url.searchParams.set('fields', 'summary,status,priority,assignee');
    url.searchParams.set('maxResults', String(PAGE_SIZE));
    if (pageToken) url.searchParams.set('nextPageToken', pageToken);
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      debugNote('the search request failed');
      return undefined;
    }
    if (!response.ok) {
      debugNote(`the search request answered ${response.status}`);
      return undefined;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      debugNote('the search response body could not be read');
      return undefined;
    }
    const parsed = parseJiraSearchPage(body, credentials.baseUrl);
    if (!parsed) {
      debugNote('the search response had an unexpected shape');
      return undefined;
    }
    tickets.push(...parsed.tickets);
    if (parsed.isLast || !parsed.nextPageToken || tickets.length >= MAX_RESULTS) break;
    pageToken = parsed.nextPageToken;
  }
  return tickets.slice(0, MAX_RESULTS);
}

interface CacheEntry {
  tickets?: JiraTicketInput[];
  fetchedAt: number;
  inFlight?: Promise<void>;
}

/** The ticket list, refreshed at most once every `CACHE_MS` (2 minutes). A failure keeps the last good list. */
export class JiraCache {
  private entry: CacheEntry = { fetchedAt: -Infinity };

  constructor(private doFetch: typeof fetch, private credentials: JiraCredentials, private now: () => number) {}

  tickets(): JiraTicketInput[] | undefined {
    return this.entry.tickets;
  }

  refresh(): Promise<void> {
    if (this.entry.inFlight) return this.entry.inFlight;
    if (this.now() - this.entry.fetchedAt < CACHE_MS) return Promise.resolve();
    this.entry.fetchedAt = this.now();
    this.entry.inFlight = fetchJiraTickets(this.doFetch, this.credentials)
      .then((tickets) => { if (tickets) this.entry.tickets = tickets; })
      // `fetchJiraTickets` itself never throws: every failure resolves to `undefined` with
      // one debug note. This `.catch` is defense in depth, so a future or unforeseen rejection
      // still falls back to the last good list instead of surfacing past this cache.
      .catch(() => undefined)
      .finally(() => { this.entry.inFlight = undefined; });
    return this.entry.inFlight;
  }
}

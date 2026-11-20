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

const MAX_CREDENTIALS_FILE = 4096;

/** An `https://` URL with no path, query or fragment (the Jira site root), or undefined. */
function siteUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : undefined;
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
 */
export function resolveJiraCredentials(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
  readFile: ReadFile,
): JiraCredentials | undefined {
  const fromEnv = credentialsFrom(env.AGENTS_OFFICE_JIRA_BASE_URL, env.AGENTS_OFFICE_JIRA_EMAIL, env.AGENTS_OFFICE_JIRA_TOKEN);
  if (fromEnv) return fromEnv;

  const filePath = plainText(env.AGENTS_OFFICE_JIRA_CREDENTIALS_FILE) || path.join(homedir(), '.config', 'agents-office', 'jira.json');
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

/** Shape-check the `/rest/api/3/search` response. Undefined when it is not the expected shape. */
export function parseJiraSearch(data: unknown, baseUrl: string): JiraTicketInput[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const issues = (data as Record<string, unknown>).issues;
  if (!Array.isArray(issues)) return undefined;
  const tickets: JiraTicketInput[] = [];
  for (const item of issues.slice(0, MAX_RESULTS)) {
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
  return tickets;
}

/** One GET to the search endpoint, Basic auth, a timeout. Never throws: a failure is undefined. */
export async function fetchJiraTickets(
  doFetch: typeof fetch,
  credentials: JiraCredentials,
): Promise<JiraTicketInput[] | undefined> {
  const auth = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
  const url = new URL('/rest/api/3/search', credentials.baseUrl);
  url.searchParams.set('jql', JIRA_JQL);
  url.searchParams.set('fields', 'summary,status,priority,assignee');
  url.searchParams.set('maxResults', String(MAX_RESULTS));
  try {
    const response = await doFetch(url.toString(), {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return parseJiraSearch(await response.json(), credentials.baseUrl);
  } catch {
    return undefined;
  }
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
      .finally(() => { this.entry.inFlight = undefined; });
    return this.entry.inFlight;
  }
}

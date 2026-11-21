import { maskedLine } from './secrets.js';
import { PERSONAS } from '../plugins/bmad/roster.js';

/**
 * Extension seam. Sources find agents, enrichers add display data, world
 * providers describe rooms and boards. Everything they produce stays on the
 * server until `projectAgents` and `projectWorld` copy the whitelisted fields
 * into the API response. Those two functions are the only exit, plus
 * `projectPeek` for the opt-in per-agent peek view (`/api/views/peek`).
 */

export type Attention = 'waiting' | 'your-turn';
export type Provider = 'claude' | 'codex';

/** The closed set of write actions. A plugin can offer only these, and only behind its own opt-in. */
export const ACTION_NAMES = ['focus'] as const;
export type ActionName = typeof ACTION_NAMES[number];

/** Data an enricher may set for display. Raw keys are hashed before they leave. */
export interface DisplayExtras {
  attention?: Attention;
  /** Only with `attention: 'your-turn'` (issue #168): finished its own turn, but a subagent of
   * its own is still running. The raised-hand/beacon signal and the figure's posture read this,
   * never the plain your-turn case, so an orchestrator does not look like it is blocked on you. */
  orchestrating?: boolean;
  waitMinutes?: number;
  groupKey?: string;
  groupLabel?: string;
  badges?: string[];
  /** Skills used at least once this session, newest-introduced last (issue #166). Plain tokens only, the same as `badges`. */
  skills?: string[];
  /** A fixed allow-list of built-in tool calls (issue #167 round 2), newest-introduced last, the same convention as `skills`. */
  tools?: string[];
  /** Which of `skills` or `tools` had the more recently introduced entry (issue #167 round 2): the
   * equipment catalog's hand item needs one true "newest" across both lists. */
  lastEquipSource?: 'skill' | 'tool';
  /**
   * `repo` is the short repository name (after the slash). The projection keeps it only as a plain token.
   * `color` is the card border color, a 6-hex label color. The projection keeps it only as `rrggbb`.
   */
  issues?: Array<{ number: number; title: string; column?: string; repo?: string; color?: string }>;
  roomKey?: string;
  /** Write actions this agent supports. Projected only when the server enabled the action. */
  actions?: ActionName[];
  /** One role token, for example 'librarian'. */
  role?: string;
  /** Busy with no transcript write for STUCK_AFTER_MINUTES (src/ui/attention.ts). */
  stuck?: boolean;
  /** The whitelisted floor name the session's working directory resolved to: a repo name, or
   * that repo name qualified by its parent directory (`org/repo`, review: two repos that
   * share a leaf folder name under different organizations must resolve to two different
   * floors), or the shared `'general'` floor (issue #118, `server/floor.ts`'s built-in
   * enricher). The projection re-validates it through its own whitelist (`floorName`, below),
   * never trusting the enricher's own output blindly. */
  floor?: string;
}

/** One agent as the server sees it. `internal` never leaves the server. */
export interface Observation {
  id: string;
  parentId?: string;
  provider: Provider;
  name: string;
  activity: string;
  status?: string;
  statusSince?: number;
  internal: { pid?: number; cwd?: string; sessionId?: string; transcriptPath?: string; agentType?: string; [key: string]: unknown };
  display: DisplayExtras;
}

export interface AgentSource {
  id: string;
  scan(): Observation[] | Promise<Observation[]>;
}

export interface Enricher {
  id: string;
  enrich(observations: Observation[]): void | Promise<void>;
}

/**
 * A session's story (issue #160), read from the archived `intent-tree.md` the
 * session plugin writes at close (never the live ledger). `personas` is checked
 * again below against `SESSION_PERSONAS`, a closed set: a reader free-texting
 * something else never leaves the server. `issues` arrives already resolved
 * (review round 2: a real archived record's `tickets_referenced` is often a bare
 * `repo#N`, with no owner; `plugins/missions/sessionStoryReader.ts` is the one
 * place that knows the configured repo/owner list needed to resolve that, so it
 * hands over a display label and an optional link, never a raw ref string for
 * this module to interpret) — `label` always shows, `url` only when resolved.
 */
export interface SessionStoryInput {
  intent?: string;
  personas?: string[];
  counts?: { done?: number; open?: number; abandoned?: number };
  doneList?: string[];
  handoffs?: string[];
  issues?: Array<{ label?: string; url?: string }>;
}

/**
 * The closed set of persona names a story may name: every name in `plugins/bmad/roster.ts`,
 * the same roster the BMAD enricher itself uses (review round 1: this used to be its own
 * hand-typed, shorter list — a second source of truth that could drift from the real one).
 */
export const SESSION_PERSONAS: readonly string[] = PERSONAS.map((persona) => persona.name);

export interface RoomInput {
  key: string;
  kind: 'mission' | 'workspace';
  title: string;
  state: 'open' | 'locked';
  /** One entry per ended session, its own id and the day it ended (a tombstone). `name` is the
   * session's own slug (issue #159): not a secret, already how Gabriel names sessions elsewhere,
   * engraved on the stone in place of the old hover sign. `story` is issue #160's card data. */
  sleepers?: Array<{ id: string; endedAt?: string; name?: string; story?: SessionStoryInput }>;
  /** For the missions board (issue #144): when a mission started, and when a closed one stopped. */
  createdAt?: string;
  closedAt?: string;
  /** The repo this room scopes to, for the focused floor to filter by (issue #191). A bare
   * repo short name (never `owner/repo`, `server/seam.ts`'s own `repoShortName`), matched on
   * the client against a floor's own trailing segment (`src/floors/FloorRegistry.ts`'s
   * `matchesFloor`) rather than compared for exact equality, since a floor may be
   * org-qualified while this tag never is. Absent only when no repo could be resolved at all;
   * such a room shows on `ALL_FLOORS` only, never guessed onto one specific floor. */
  repo?: string;
  walls?: {
    statement?: string;
    docs?: string[];
    /** `repo` is a full `owner/name`, unlike an agent card issue's short name: a mission can span repos. */
    issues?: Array<{ number: number; repo?: string; title: string; state: 'open' | 'closed' }>;
    kanban?: Array<{ column: string; cards: Array<{ number: number; title: string }> }>;
  };
}

export interface BoardInput {
  key: string;
  title: string;
  columns: Array<{ name: string; cards: Array<{ number: number; title: string }> }>;
  /** The repo this board scopes to (issue #191), the same whitelist and client matching rule as `RoomInput.repo`. */
  repo?: string;
}

/** One ticket of a personal Jira board (issue #145). `url` is the browse link built from the key. */
export interface JiraTicketInput {
  key: string;
  summary: string;
  status: string;
  assignee?: string;
  priority?: string;
  url?: string;
}

/** One entry on a library shelf (issue #191/#119). `archived` is Prospero's rule: a superseded
 * or archived entry still shows, with a visible mark, never silently dropped. `repoPath` is the
 * link target's own path relative to the repo root (`plugins/floor-library/bibliotheque.ts`'s
 * `resolveEntryTarget`), used here only to build `githubUrl` below — it never reaches the
 * browser itself (issue #221 AC3). */
export interface LibraryEntryInput {
  title: string;
  archived?: boolean;
  summary?: string;
  lastChanged?: string;
  repoPath?: string;
}

/** One section's own shelf, built from that section's own `INDEX.md` (issue #119 review:
 * "build rooms from each section's own INDEX.md, not a raw folder walk"), never a deeper walk. */
export interface LibrarySectionInput {
  name: string;
  entries: LibraryEntryInput[];
  /** More entries exist in the section's own INDEX.md than the capped list carries. */
  truncated?: boolean;
}

/** A floor's own library (issue #191 AC1, #119): read from `<repo>/documentation/bibliotheque/`
 * when that structure exists there, else this floor gets none (graceful degradation, never a
 * folder-structure guess). `repo` is the same whitelist and client matching rule as
 * `RoomInput.repo`/`BoardInput.repo` — it also carries the directory-name fallback `server/
 * floor.ts`'s own `qualifiedFloorName` falls back to when a repo has no git remote, which
 * reads exactly like a real `owner/repo` pair. `remoteRepo` (issue #221 review) is the one
 * this layer actually builds a GitHub link from: `FloorResolver.resolveRemoteOwnerRepo`'s own
 * output, absent whenever there is no real git remote, never the directory fallback. */
export interface LibraryInput {
  key: string;
  sections: LibrarySectionInput[];
  repo?: string;
  remoteRepo?: string;
}

export interface WorldInput {
  rooms?: RoomInput[];
  boards?: BoardInput[];
  jiraTickets?: JiraTicketInput[];
  libraries?: LibraryInput[];
}

export interface WorldProvider {
  id: string;
  world(observations: Observation[]): WorldInput | Promise<WorldInput>;
}

/** What a write action reports. `gone`: the re-check found the target changed or missing. */
export type ActionOutcome = 'done' | 'gone' | 'failed';

/**
 * An opt-in write action. The server mounts `POST /api/actions/<name>` only when
 * a loaded plugin offers it, and calls `run` only for an agent that advertises
 * the action. `run` must re-check its target before it acts.
 */
export interface OfficeAction {
  name: ActionName;
  run(agent: Observation): Promise<ActionOutcome>;
}

/** The closed set of per-agent read views. A plugin can offer only these, behind its own opt-in. */
export const VIEW_NAMES = ['peek'] as const;
export type ViewName = typeof VIEW_NAMES[number];

/**
 * What the peek view may return for one agent. `projectPeek` caps and masks it
 * again before it leaves. Never in `/api/agents` or `/api/world`.
 */
export interface PeekInput {
  lines: Array<{ kind: 'text' | 'tool'; text: string }>;
  question?: string;
  assets: Array<{ kind: 'issue' | 'pr' | 'mr' | 'jira'; label: string; url: string }>;
  skills: string[];
  repos: string[];
}

/**
 * An opt-in read view for one selected agent. The server mounts
 * `GET /api/views/<name>?agent=<public id>` only when a loaded plugin offers it.
 */
export interface OfficeView {
  name: ViewName;
  read(agent: Observation): PeekInput | Promise<PeekInput>;
}

export interface OfficePlugin {
  name: string;
  sources?: AgentSource[];
  enrichers?: Enricher[];
  world?: WorldProvider[];
  actions?: OfficeAction[];
  views?: OfficeView[];
}

const STEP_TIMEOUT_MS = 2000;

async function withinTimeLimit<T>(work: () => T | Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), STEP_TIMEOUT_MS); }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the core source, then the plugin sources, then every enricher in order.
 * A core source failure is an error. A failing or slow plugin step drops only its own output.
 */
export async function observe(core: AgentSource, sources: AgentSource[], enrichers: Enricher[]): Promise<Observation[]> {
  const coreObservations = await core.scan();
  const found = await Promise.all(sources.map((source) => withinTimeLimit(() => source.scan())));
  const observations = [...coreObservations, ...found.flatMap((list) => list ?? [])];
  for (const enricher of enrichers) {
    await withinTimeLimit(() => enricher.enrich(observations));
  }
  return observations;
}

export async function describeWorld(providers: WorldProvider[], observations: Observation[]): Promise<WorldInput[]> {
  const parts = await Promise.all(providers.map((provider) => withinTimeLimit(() => provider.world(observations))));
  return parts.filter((part): part is WorldInput => part !== undefined);
}

// --- Projection: the only exit ---

const ACTIVITIES = new Set(['idle', 'planning', 'implementing', 'researching', 'testing', 'debugging',
  'reviewing', 'writing_docs', 'deploying', 'meeting']);
const BADGE = /^[a-z0-9-]{1,32}$/;
/** A skill name (issue #166): same token shape `plugins/peek` already validates skill names against, a plugin's own namespace prefix (`crit:crit-cli`) included. */
const SKILL = /^[A-Za-z0-9:_.-]{1,64}$/;
/** The same fixed allow-list `plugins/skills/index.ts` tracks (issue #167 round 2): a raw
 * built-in tool name reaches the client only if it is exactly one of these, whatever an
 * enricher's own output claims. */
const TOOL_ALLOWLIST = new Set(['Bash', 'Grep', 'Glob', 'Read', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Task']);

export function displayText(value: unknown, maxLength: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function wholeNumber(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;
}

/** A plain `YYYY-MM-DD` date, the date part of an ISO timestamp kept and the rest dropped. */
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})/;

function isoDate(value: unknown): string | undefined {
  return typeof value === 'string' ? ISO_DATE.exec(value)?.[1] : undefined;
}

/** A full ISO-8601 timestamp, parseable by `Date`: for the missions board's elapsed-time clock (issue #144). */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isoTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) ? value : undefined;
}

const REPO_SHORT = /^[A-Za-z0-9_.-]{1,40}$/;

/** The repository name after the last slash, or undefined when it is not a plain short token
 * (issue #191: shared with `RoomInput`/`BoardInput`'s own `repo` tag, below, since a mission or a
 * GitHub kanban board whitelists its repo through the exact same shape as an agent's issue card). */
export function repoShortName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const short = value.slice(value.lastIndexOf('/') + 1);
  return REPO_SHORT.test(short) && short !== '.' && short !== '..' ? short : undefined;
}

/**
 * A floor name (issue #118): one segment (`GENERAL_FLOOR`, a bare repo name, or the `'all'`
 * sentinel the client never sends but a well-shaped value all the same), or two segments
 * joined by a slash — the repo's own parent directory name, then the repo name
 * (`server/floor.ts`'s own org-qualifying rule, review: two repos that share a leaf folder
 * name under different organizations must resolve to two different floors). Unlike
 * `repoShortName`, this never keeps only the text after the last slash: a malformed value
 * with more than one slash, a `.` or `..` segment, or an over-length segment is dropped
 * whole, not silently shortened to its tail.
 */
const FLOOR_SEGMENT = '[A-Za-z0-9_.-]{1,40}';
const FLOOR_NAME = new RegExp(`^${FLOOR_SEGMENT}(?:/${FLOOR_SEGMENT})?$`);

function floorName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !FLOOR_NAME.test(value)) return undefined;
  return value.split('/').some((segment) => segment === '.' || segment === '..') ? undefined : value;
}

/**
 * Path-like text redacted before it reaches a free-text story field (issue #160's own AC:
 * "No path ... appears anywhere on the card", review round 1 — `displayText` alone only strips
 * control characters and truncates). Catches a `file://` URL, a `~/...` home path, a POSIX
 * path of two or more segments, a single-segment absolute path (review round 2: `/tmp`, `/etc`
 * alone, with nothing after, were not caught by the two-or-more-segment rule), a relative path
 * (`./x`, `../x`) and a Windows drive path. The lookbehind keeps a bare `/` or `.` mid-sentence
 * (a fraction, an ellipsis) from being mistaken for the start of a path, while still catching a
 * single-segment or relative path introduced by a quote, backtick, paren, `=` or `:` (review
 * round 2 follow-up: `Read "/tmp"`, `` `/etc` `` and `TMPDIR=/private` all read unchanged
 * without this — ordinary quoting should not defeat the privacy boundary).
 */
const PATH_START = "^|[\\s\"'`(=:,[]";
const PATH_LIKE = new RegExp(
  `file://\\S+|~/\\S+|(?<=${PATH_START})\\.{1,2}/\\S+|/(?:[\\w.-]+/)+[\\w.-]+|(?<=${PATH_START})/[\\w.-]+|[A-Za-z]:[\\\\/]\\S*`,
  'g',
);

function redactPaths(value: unknown): string {
  return typeof value === 'string' ? value.replace(PATH_LIKE, '[path]') : '';
}

/** A session slug's own shape. Duplicated from `plugins/missions/sessionStoryReader.ts`'s
 * `SESSION_SLUG` (not imported: that module already imports from this one, and a plugin
 * importing back from the server it is read by would be circular). Keep the two in sync. */
const SESSION_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const STORY_MAX_PERSONAS = 6;
const STORY_MAX_DONE_ITEMS = 8;
const STORY_MAX_HANDOFFS = 6;
const STORY_MAX_ISSUES = 8;

/**
 * The tombstone story card's whitelist (issue #160, S4): a short intent, persona names from
 * the closed `SESSION_PERSONAS` set, done/open/abandoned counts, a capped done list, handoff
 * file names (never a path) and resolved issue links. `issues` is always present (even empty)
 * once a story exists, so the card can tell "no issue yet" apart from "no record at all".
 */
function projectStory(input: SessionStoryInput | undefined) {
  if (!input || typeof input !== 'object') return undefined;
  // Redacted before the length cap, not after: truncating first could cut a path in half and
  // leave an unredacted fragment of it behind (review round 1).
  const intent = displayText(redactPaths(input.intent), 160);
  const personas = Array.isArray(input.personas)
    ? [...new Set(input.personas.filter((name): name is string => SESSION_PERSONAS.includes(name)))].slice(0, STORY_MAX_PERSONAS)
    : [];
  const rawCounts = input.counts;
  const counts = rawCounts && typeof rawCounts === 'object'
    ? { done: wholeNumber(rawCounts.done, 999) ?? 0, open: wholeNumber(rawCounts.open, 999) ?? 0, abandoned: wholeNumber(rawCounts.abandoned, 999) ?? 0 }
    : undefined;
  const doneList = Array.isArray(input.doneList)
    ? input.doneList.map((item) => displayText(redactPaths(item), 100)).filter(Boolean).slice(0, STORY_MAX_DONE_ITEMS)
    : [];
  // A handoff is a file name, never a path (issue #160's privacy rule): the last path
  // segment only, whichever separator a reader's own OS happened to use.
  const handoffs = Array.isArray(input.handoffs)
    ? input.handoffs.map((file) => displayText(file, 80).split(/[/\\]/).pop() ?? '').filter(Boolean).slice(0, STORY_MAX_HANDOFFS)
    : [];
  // A resolved issue carries a link; an unresolved one (review round 2: a bare `repo#N` whose
  // owner could not be resolved, or a Jira-style key) is still a real reference and still
  // shows, just as plain text — never dropped into "no issue yet" when a ref actually exists.
  const issues = (Array.isArray(input.issues) ? input.issues : [])
    .map((issue) => {
      const label = displayText(issue?.label, 40);
      if (!label) return undefined;
      const url = httpsUrl(issue?.url);
      return { label, ...(url ? { url } : {}) };
    })
    .filter((issue): issue is { label: string; url?: string } => issue !== undefined)
    .slice(0, STORY_MAX_ISSUES);
  if (!intent && personas.length === 0 && !counts && doneList.length === 0 && handoffs.length === 0 && issues.length === 0) return undefined;
  return {
    ...(intent ? { intent } : {}),
    ...(personas.length > 0 ? { personas } : {}),
    ...(counts ? { counts } : {}),
    ...(doneList.length > 0 ? { doneList } : {}),
    ...(handoffs.length > 0 ? { handoffs } : {}),
    issues,
  };
}

const OWNER_REPO = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/;

/** A full `owner/name` pair, or undefined when the value does not match that shape. Neither
 * segment may be `.` or `..` (review, issue #191: the shape alone, both sides drawn from the
 * same character class the floor-name whitelist uses, admits a relative segment like `../x` or
 * `owner/..` — the same rule `floorName` already applies segment-wise, not just to the one
 * literal `'./.'` string this used to special-case). */
function ownerRepo(value: unknown): string | undefined {
  if (typeof value !== 'string' || !OWNER_REPO.test(value)) return undefined;
  return value.split('/').some((segment) => segment === '.' || segment === '..') ? undefined : value;
}

/**
 * A `RoomInput`/`BoardInput` repo tag (issue #191 revision): a full `owner/repo` pair kept
 * whole when the value already has that shape, else the bare short name. A value with a slash
 * must pass the stricter `ownerRepo` whitelist outright, or is dropped whole — review, blocking:
 * falling through to `repoShortName` for a value that merely *contains* a slash would keep only
 * the text after its *last* one, silently admitting the tail of a rejected value like
 * `../private` (owner `..`, repo `private`) as a seemingly clean bare name. `repoShortName`
 * only ever runs on a value with no slash at all, the bare-name case it is actually for.
 */
function repoTag(value: unknown): string | undefined {
  return typeof value === 'string' && value.includes('/') ? ownerRepo(value) : repoShortName(value);
}

/** Review: a real document name is not ASCII-only (an accent, a space) — the original
 * `[A-Za-z0-9_.-]` whitelist rejected those and silently dropped `githubUrl` for an otherwise
 * valid file (issue #221 AC3 explicitly asks for "nested paths and spaces"). This instead
 * forbids only what actually matters for a repo-relative path: no control character, no
 * backslash, no leading slash, no empty/`.`/`..` segment — the same shape `resolveEntryTarget`
 * already only ever hands back (defense in depth: this whitelist runs again at the boundary
 * regardless of what the plugin layer sent). Everything else a real filename can hold (spaces,
 * accents, parentheses) survives, and `githubBlobUrl` below percent-encodes each segment before
 * it reaches a URL. */
const FORBIDDEN_PATH_CHARS = /[\x00-\x1f\\]/;

function repoPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return undefined;
  if (value.startsWith('/') || FORBIDDEN_PATH_CHARS.test(value)) return undefined;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined;
  return value;
}

/**
 * A document's own "Open on GitHub" link (issue #221 AC3): `https://github.com/<owner>/<repo>
 * /blob/main/<path>`, built here from an already-whitelisted owner/repo and repo-relative path,
 * never a URL a plugin hands over whole — the same reasoning `redactPaths` already applies to
 * free text: nothing resembling a local filesystem path crosses this boundary, only a URL and
 * display strings built from parts this function itself validated. Each path segment is
 * percent-encoded on its own (review: `repoPath` now allows a space or an accent through, which
 * is not valid raw inside a URL) so the slash that separates segments survives untouched.
 */
function githubBlobUrl(owner: string, repo: string, path: string): string | undefined {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://github.com/${owner}/${repo}/blob/main/${encodedPath}`;
  return httpsUrl(url);
}

const HEX_COLOR = /^#?([0-9A-Fa-f]{6})$/;

/** A 6-hex color as lowercase `rrggbb`, or undefined. */
function hexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return HEX_COLOR.exec(value)?.[1].toLowerCase();
}

function issueList(issues: DisplayExtras['issues'], max: number) {
  if (!Array.isArray(issues)) return undefined;
  const list = issues
    .map((issue) => {
      const repo = repoShortName(issue?.repo);
      const color = hexColor(issue?.color);
      return { number: wholeNumber(issue?.number, 10_000_000), title: displayText(issue?.title, 80),
        ...(issue?.column ? { column: displayText(issue.column, 24) } : {}), ...(repo ? { repo } : {}), ...(color ? { color } : {}) };
    })
    .filter((issue) => issue.number !== undefined)
    .slice(0, max);
  return list.length > 0 ? list : undefined;
}

/** `PREFIX-123`, the same key shape the peek plugin already links (`plugins/peek/transcript.ts`). */
const JIRA_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

/** One Jira ticket (issue #145): the key, a capped summary and status, and optional priority, assignee and link. */
function jiraTicket(ticket: JiraTicketInput) {
  if (typeof ticket?.key !== 'string' || !JIRA_KEY.test(ticket.key)) return undefined;
  const status = displayText(ticket.status, 32);
  if (!status) return undefined;
  const summary = displayText(ticket.summary, 80);
  const assignee = typeof ticket.assignee === 'string' ? displayText(ticket.assignee, 40) : '';
  const priority = typeof ticket.priority === 'string' ? displayText(ticket.priority, 16) : '';
  const url = httpsUrl(ticket.url);
  return {
    key: ticket.key,
    summary,
    status,
    ...(assignee ? { assignee } : {}),
    ...(priority ? { priority } : {}),
    ...(url ? { url } : {}),
  };
}

export type PublicId = (raw: string) => string;

const NO_ACTIONS: ReadonlySet<string> = new Set();

function actionList(actions: unknown, enabled: ReadonlySet<string>): ActionName[] | undefined {
  if (!Array.isArray(actions)) return undefined;
  const list = ACTION_NAMES.filter((name) => enabled.has(name) && actions.includes(name));
  return list.length > 0 ? list : undefined;
}

export function projectAgents(observations: Observation[], publicId: PublicId, enabledActions: ReadonlySet<string> = NO_ACTIONS) {
  return observations.map((agent) => {
    const extras = agent.display ?? {};
    const badges = Array.isArray(extras.badges) ? extras.badges.filter((b) => BADGE.test(b)).slice(0, 6) : [];
    // Capped from the end, not the start (review, issue #167 round 2): `skills`/`tools` are
    // newest-last (the equipment catalog's hand item reads the last entry as "newest"). The
    // enricher (`plugins/skills/index.ts`) already caps to the same size, so this is normally
    // a no-op; it only matters as defense in depth against a future enricher that forgets to.
    const skills = Array.isArray(extras.skills)
      ? extras.skills.filter((s): s is string => typeof s === 'string' && SKILL.test(s)).slice(-8)
      : [];
    const tools = Array.isArray(extras.tools)
      ? extras.tools.filter((t): t is string => typeof t === 'string' && TOOL_ALLOWLIST.has(t)).slice(-TOOL_ALLOWLIST.size)
      : [];
    const lastEquipSource = extras.lastEquipSource === 'skill' || extras.lastEquipSource === 'tool' ? extras.lastEquipSource : undefined;
    const issues = issueList(extras.issues, 5);
    const waitMinutes = wholeNumber(extras.waitMinutes, 100_000);
    const actions = actionList(extras.actions, enabledActions);
    const floor = floorName(extras.floor);
    return {
      id: publicId(agent.id),
      name: displayText(agent.name, 60),
      activity: ACTIVITIES.has(agent.activity) ? agent.activity : 'implementing',
      ...(agent.parentId ? { parentId: publicId(agent.parentId) } : {}),
      ...(agent.provider === 'codex' ? { provider: 'codex' as const } : {}),
      ...(extras.attention === 'waiting' || extras.attention === 'your-turn' ? { attention: extras.attention } : {}),
      ...(extras.attention === 'your-turn' && extras.orchestrating === true ? { orchestrating: true as const } : {}),
      ...(waitMinutes !== undefined ? { waitMinutes } : {}),
      ...(extras.groupKey ? { group: { id: publicId(`group:${extras.groupKey}`), label: displayText(extras.groupLabel, 40) } } : {}),
      ...(badges.length > 0 ? { badges } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(lastEquipSource ? { lastEquipSource } : {}),
      ...(issues ? { issues } : {}),
      ...(extras.roomKey ? { room: publicId(`room:${extras.roomKey}`) } : {}),
      ...(actions ? { actions } : {}),
      ...(typeof extras.role === 'string' && BADGE.test(extras.role) ? { role: extras.role } : {}),
      ...(extras.stuck === true ? { stuck: true as const } : {}),
      ...(floor ? { floor } : {}),
    };
  });
}

const PEEK_LINES = 10;
const PEEK_LINE_LENGTH = 200;
const PEEK_LIST = 10;
const PEEK_TOKEN = /^[A-Za-z0-9:_.-]{1,64}$/;
const ASSET_KINDS = new Set(['issue', 'pr', 'mr', 'jira']);

function peekText(value: unknown): string {
  return maskedLine(value, PEEK_LINE_LENGTH);
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The peek view for one agent: capped lines (masked again), https links, plain tokens. */
export function projectPeek(input: PeekInput) {
  const lines = (Array.isArray(input?.lines) ? input.lines : []).slice(-PEEK_LINES)
    .map((line) => ({ kind: line?.kind === 'text' ? 'text' as const : 'tool' as const, text: peekText(line?.text) }))
    .filter((line) => line.text.length > 0);
  const question = input?.question ? peekText(input.question) : '';
  const assets = (Array.isArray(input?.assets) ? input.assets : []).flatMap((asset) => {
    const url = httpsUrl(asset?.url);
    return url && ASSET_KINDS.has(asset.kind) ? [{ kind: asset.kind, label: displayText(asset.label, 80), url }] : [];
  }).slice(0, PEEK_LIST);
  const tokens = (list: unknown, pattern: RegExp) => (Array.isArray(list) ? list : [])
    .filter((item): item is string => typeof item === 'string' && pattern.test(item)).slice(0, PEEK_LIST);
  return {
    lines,
    ...(question ? { question } : {}),
    assets,
    skills: tokens(input?.skills, PEEK_TOKEN),
    repos: tokens(input?.repos, REPO_SHORT).filter((repo) => repo !== '.' && repo !== '..'),
  };
}

export function projectWorld(parts: WorldInput[], pluginNames: string[], publicId: PublicId) {
  const rooms = parts.flatMap((part) => part.rooms ?? []).slice(0, 100).map((room) => {
    const walls = room.walls ?? {};
    const sleepers = (Array.isArray(room.sleepers) ? room.sleepers : []).slice(0, 48)
      .flatMap((entry) => {
        const rawId = displayText(entry?.id, 64);
        if (!rawId) return [];
        const endedAt = isoDate(entry?.endedAt);
        // Same shape as `plugins/missions/sessionStoryReader.ts`'s `SESSION_SLUG` (review round
        // 1, defense in depth): the plugin already checks this before it ever sets `name`, but
        // the server never trusts a plugin's own output without checking it again here too,
        // the same way personas and issue references are rechecked below.
        const name = SESSION_SLUG.test(String(entry?.name ?? '')) ? displayText(entry?.name, 64) : undefined;
        const story = projectStory(entry?.story);
        return [{ id: publicId(`sleeper:${room.key}:${rawId}`), ...(endedAt ? { endedAt } : {}), ...(name ? { name } : {}), ...(story ? { story } : {}) }];
      });
    const repo = repoTag(room.repo);
    return {
      id: publicId(`room:${room.key}`),
      kind: room.kind === 'workspace' ? 'workspace' : 'mission',
      title: displayText(room.title, 60),
      state: room.state === 'locked' ? 'locked' : 'open',
      ...(sleepers.length > 0 ? { sleepers } : {}),
      ...(isoTimestamp(room.createdAt) ? { createdAt: isoTimestamp(room.createdAt) } : {}),
      ...(isoTimestamp(room.closedAt) ? { closedAt: isoTimestamp(room.closedAt) } : {}),
      ...(repo ? { repo } : {}),
      walls: {
        ...(walls.statement ? { statement: displayText(walls.statement, 240) } : {}),
        ...(Array.isArray(walls.docs) ? { docs: walls.docs.slice(0, 8).map((doc) => displayText(doc, 60)) } : {}),
        ...(Array.isArray(walls.issues) ? { issues: walls.issues.slice(0, 12)
          .map((issue) => {
            const repo = ownerRepo(issue?.repo);
            return { number: wholeNumber(issue.number, 10_000_000), title: displayText(issue.title, 80),
              state: issue.state === 'closed' ? 'closed' : 'open', ...(repo ? { repo } : {}) };
          })
          .filter((issue) => issue.number !== undefined) } : {}),
        ...(Array.isArray(walls.kanban) ? { kanban: walls.kanban.slice(0, 6).map((column) => ({
          column: displayText(column.column, 24),
          cards: (column.cards ?? []).slice(0, 10)
            .map((card) => ({ number: wholeNumber(card.number, 10_000_000), title: displayText(card.title, 60) }))
            .filter((card) => card.number !== undefined),
        })) } : {}),
      },
    };
  });
  const boards = parts.flatMap((part) => part.boards ?? []).slice(0, 4).map((board) => ({
    id: publicId(`board:${board.key}`),
    title: displayText(board.title, 60),
    columns: (board.columns ?? []).slice(0, 6).map((column) => ({
      name: displayText(column.name, 24),
      cards: (column.cards ?? []).slice(0, 12)
        .map((card) => ({ number: wholeNumber(card.number, 10_000_000), title: displayText(card.title, 60) }))
        .filter((card) => card.number !== undefined),
    })),
    ...(repoTag(board.repo) ? { repo: repoTag(board.repo) } : {}),
  }));
  const jiraTickets = parts.flatMap((part) => part.jiraTickets ?? []).slice(0, 50)
    .map(jiraTicket).filter((ticket): ticket is NonNullable<ReturnType<typeof jiraTicket>> => ticket !== undefined);
  const libraries = parts.flatMap((part) => part.libraries ?? []).slice(0, 4).map((library) => {
    // Resolved once per library (issue #221 AC3, review): a GitHub blob link only ever builds
    // against `remoteRepo` — `FloorResolver.resolveRemoteOwnerRepo`'s own output, present only
    // when the floor's root actually has a git `origin` remote. `library.repo` (used below for
    // the client's own floor-matching, unchanged) is the wrong field for this: its own
    // fallback, a bare `parent-dir/repo-dir` pair when there is no remote at all, has the exact
    // same `owner/repo` shape as a real one and would otherwise build a link to an unrelated
    // GitHub repo that merely shares that directory name. No remote at all: every entry's
    // `githubUrl` is simply absent — graceful degradation, the same shape every other optional
    // field here already follows.
    const repo = repoTag(library.repo);
    const remoteRepo = repoTag(library.remoteRepo);
    const ownerName = remoteRepo && OWNER_REPO.test(remoteRepo) ? remoteRepo.split('/') : undefined;
    return {
      id: publicId(`library:${library.key}`),
      // Section names and entry titles come straight from a repo's own committed markdown
      // (issue #119/#191): a title whose own visible link text happens to read as a filesystem
      // path (a careless `[/Users/alice/notes.md](link)`, the display text rather than the link
      // itself, which never reaches here) still must not cross this boundary raw (S4) — redacted
      // the same way free text already is for a tombstone's own story (`redactPaths`, above),
      // before the display cap, so truncation cannot cut a path in half and leave a fragment.
      // 100x100 (issue #221 AC1, Gabriel's own cap, round 7 part 3): the data layer's own cap,
      // not the room's physical display limit — `plugins/floor-library/client.ts` shows far
      // fewer at once and signs the rest, same as `section.truncated` already does below.
      sections: (library.sections ?? []).slice(0, 100).map((section) => ({
        name: displayText(redactPaths(section.name), 32),
        entries: (section.entries ?? []).slice(0, 100)
          .map((entry) => {
            const title = displayText(redactPaths(entry.title), 80);
            const summary = entry.summary ? displayText(redactPaths(entry.summary), 160) : undefined;
            const lastChanged = isoDate(entry.lastChanged);
            const path = repoPath(entry.repoPath);
            const githubUrl = ownerName && path ? githubBlobUrl(ownerName[0], ownerName[1], path) : undefined;
            return {
              title,
              ...(entry.archived === true ? { archived: true as const } : {}),
              ...(summary ? { summary } : {}),
              ...(lastChanged ? { lastChanged } : {}),
              ...(githubUrl ? { githubUrl } : {}),
            };
          })
          .filter((entry) => entry.title.length > 0),
        ...(section.truncated === true ? { truncated: true as const } : {}),
      })).filter((section) => section.name.length > 0 && section.entries.length > 0),
      ...(repo ? { repo } : {}),
    };
  }).filter((library) => library.sections.length > 0);
  return { plugins: pluginNames.filter((name) => /^[a-z0-9-]{1,32}$/.test(name)), rooms, boards, jiraTickets, libraries };
}

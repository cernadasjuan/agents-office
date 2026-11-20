import { maskedLine } from './secrets.js';

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
  waitMinutes?: number;
  groupKey?: string;
  groupLabel?: string;
  badges?: string[];
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

export interface RoomInput {
  key: string;
  kind: 'mission' | 'workspace';
  title: string;
  state: 'open' | 'locked';
  /** One entry per ended session, its own id and the day it ended (a tombstone). */
  sleepers?: Array<{ id: string; endedAt?: string }>;
  walls?: {
    statement?: string;
    docs?: string[];
    issues?: Array<{ number: number; title: string; state: 'open' | 'closed' }>;
    kanban?: Array<{ column: string; cards: Array<{ number: number; title: string }> }>;
  };
}

export interface BoardInput {
  key: string;
  title: string;
  columns: Array<{ name: string; cards: Array<{ number: number; title: string }> }>;
}

export interface WorldInput {
  rooms?: RoomInput[];
  boards?: BoardInput[];
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

const REPO_SHORT = /^[A-Za-z0-9_.-]{1,40}$/;

/** The repository name after the last slash, or undefined when it is not a plain short token. */
function repoShortName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const short = value.slice(value.lastIndexOf('/') + 1);
  return REPO_SHORT.test(short) && short !== '.' && short !== '..' ? short : undefined;
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
    const issues = issueList(extras.issues, 5);
    const waitMinutes = wholeNumber(extras.waitMinutes, 100_000);
    const actions = actionList(extras.actions, enabledActions);
    return {
      id: publicId(agent.id),
      name: displayText(agent.name, 60),
      activity: ACTIVITIES.has(agent.activity) ? agent.activity : 'implementing',
      ...(agent.parentId ? { parentId: publicId(agent.parentId) } : {}),
      ...(agent.provider === 'codex' ? { provider: 'codex' as const } : {}),
      ...(extras.attention === 'waiting' || extras.attention === 'your-turn' ? { attention: extras.attention } : {}),
      ...(waitMinutes !== undefined ? { waitMinutes } : {}),
      ...(extras.groupKey ? { group: { id: publicId(`group:${extras.groupKey}`), label: displayText(extras.groupLabel, 40) } } : {}),
      ...(badges.length > 0 ? { badges } : {}),
      ...(issues ? { issues } : {}),
      ...(extras.roomKey ? { room: publicId(`room:${extras.roomKey}`) } : {}),
      ...(actions ? { actions } : {}),
      ...(typeof extras.role === 'string' && BADGE.test(extras.role) ? { role: extras.role } : {}),
      ...(extras.stuck === true ? { stuck: true as const } : {}),
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
        return [{ id: publicId(`sleeper:${room.key}:${rawId}`), ...(endedAt ? { endedAt } : {}) }];
      });
    return {
      id: publicId(`room:${room.key}`),
      kind: room.kind === 'workspace' ? 'workspace' : 'mission',
      title: displayText(room.title, 60),
      state: room.state === 'locked' ? 'locked' : 'open',
      ...(sleepers.length > 0 ? { sleepers } : {}),
      walls: {
        ...(walls.statement ? { statement: displayText(walls.statement, 240) } : {}),
        ...(Array.isArray(walls.docs) ? { docs: walls.docs.slice(0, 8).map((doc) => displayText(doc, 60)) } : {}),
        ...(Array.isArray(walls.issues) ? { issues: walls.issues.slice(0, 12)
          .map((issue) => ({ number: wholeNumber(issue.number, 10_000_000), title: displayText(issue.title, 80),
            state: issue.state === 'closed' ? 'closed' : 'open' }))
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
  }));
  return { plugins: pluginNames.filter((name) => /^[a-z0-9-]{1,32}$/.test(name)), rooms, boards };
}

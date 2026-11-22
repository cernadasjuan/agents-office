import { Activity } from './ActivityAnimations.js';

/** Optional display data that plugins add on the server. All fields are whitelisted there. */
export interface AgentExtras {
  parentId?: string;
  provider?: 'codex';
  attention?: 'waiting' | 'your-turn';
  /** Only with `attention: 'your-turn'` (issue #168): finished its own turn, but a subagent of
   * its own is still running. It stands with hands on hips, not the raised hand, and shows no
   * beacon — it is not asking for you. */
  orchestrating?: boolean;
  waitMinutes?: number;
  group?: { id: string; label: string };
  badges?: string[];
  /** Skills used at least once this session, newest-loaded last (issue #166, the `skills` plugin). Without it the card falls back to personas only. */
  skills?: string[];
  /** A fixed allow-list of built-in tool calls used at least once this session, newest-loaded
   * last (issue #167 round 2, same `skills` plugin): `Bash`, `Grep`, `Glob`, `Read`, `Edit`,
   * `Write`, `WebSearch`, `WebFetch`, `Task`. The equipment catalog's search/bash/edit items
   * (`plugins/skills/items.ts`) key on this, never on `skills` alone — a `Skill` tool call is
   * a structurally different kind of event and can never carry a raw tool name. */
  tools?: string[];
  /** Which of `skills` or `tools` had the more recently introduced entry (issue #167 round 2):
   * one true "newest" across both lists, for the equipment catalog's hand item. Absent only
   * when neither list has ever gained an entry. */
  lastEquipSource?: 'skill' | 'tool';
  /** `color` is the card border color as `rrggbb` (the issue's label color). */
  issues?: Array<{ number: number; title: string; column?: string; repo?: string; color?: string }>;
  room?: string;
  /** Opt-in write actions the server offers for this agent (today only `focus`, from the herdr plugin). */
  actions?: Array<'focus'>;
  role?: string;
  /** Busy with no transcript write for STUCK_AFTER_MINUTES (src/ui/attention.ts). */
  stuck?: boolean;
  /** The whitelisted floor a session's working directory resolved to: a repo name, that repo
   * name qualified by its parent directory (`org/repo`, so two repos sharing a leaf folder
   * name under different organizations resolve to two different floors), or the shared
   * `'general'` floor (issue #118). Always present once the server's floor enricher has run;
   * a session without it (an old server, or a source that skips enrichment) is treated as
   * `'general'` by every floor-aware reader, never as a crash. */
  floor?: string;
  /** Repositories this agent's work touches, as plain display tokens (a bare repo name or an
   * `owner/repo` pair, the same shape `floor` uses) — never a filesystem path (issue #216,
   * the agent card's Repos column). Present alongside `badges`/`skills` at the same instant,
   * set by the server's floor enricher; absent (not a loading state) when no repo resolved. */
  repos?: string[];
}

export interface AgentInfo {
  id: string;
  name: string;
  activity: Activity;
  extras?: AgentExtras;
}

/** The first 8 hex characters of the public id (issue #171): short, and stable for this
 * server run. The card and the floating label both call this, so they always agree. */
export function shortAgentId(id: string): string {
  return id.slice(0, 8);
}

export const ACTIVITIES: Activity[] = [
  'idle',
  'planning',
  'implementing',
  'researching',
  'testing',
  'debugging',
  'reviewing',
  'writing_docs',
  'deploying',
  'meeting',
];

export const ACTIVITY_LABELS: Record<Activity, string> = {
  idle: 'Taking a break',
  planning: 'Planning',
  implementing: 'Implementing',
  researching: 'Researching',
  testing: 'Running tests',
  debugging: 'Debugging',
  reviewing: 'Reviewing',
  writing_docs: 'Writing docs',
  deploying: 'Deploying',
  // Not "Waiting for you" (issue #169): that wording is the attention system's own, for a
  // different reason (a true block on Gabriel). The `meeting` activity is a pose about what the
  // agent is doing right now (for example mid-`AskUserQuestion`) and can show even when nothing
  // calls for Gabriel; `attentionLine` still overrides this text when attention is actually set.
  meeting: 'In a meeting',
};

/** A subagent at rest gave its final answer: it has finished, it is not on a break. */
export const DONE_LABEL = 'Done';

/** A busy session that has not written its transcript for a long while (src/ui/attention.ts). */
export const STUCK_LABEL = 'Stuck?';

export function activityLabelFor(activity: Activity, isSubagent: boolean): string {
  if (isSubagent && activity === 'idle') return DONE_LABEL;
  return ACTIVITY_LABELS[activity] ?? activity;
}

/** The activity text of an agent: "Stuck?" when it has gone quiet, "Done" for a finished subagent, else the activity label. */
export function activityLabel(agent: Pick<AgentInfo, 'activity' | 'extras'>): string {
  if (agent.extras?.stuck) return STUCK_LABEL;
  return activityLabelFor(agent.activity, agent.extras?.parentId !== undefined);
}

const AGENT_NAMES = [
  'Agent Alpha',
  'Agent Beta',
  'Agent Gamma',
  'Agent Delta',
  'Agent Epsilon',
];

const INITIAL_ACTIVITIES: Activity[] = [
  'implementing',
  'planning',
  'testing',
  'idle',
  'debugging',
];

export function getMockAgents(): AgentInfo[] {
  return AGENT_NAMES.map((name, i) => ({
    id: `agent_${i}`,
    name,
    activity: INITIAL_ACTIVITIES[i],
  }));
}

// Map activities to station types
export const ACTIVITY_STATION_MAP: Record<Activity, string> = {
  idle: 'idle',
  planning: 'planning',
  implementing: 'implementing',
  researching: 'researching',
  testing: 'testing',
  debugging: 'implementing', // uses desks too
  reviewing: 'reviewing',
  writing_docs: 'reviewing',
  deploying: 'implementing',
  meeting: 'meeting',
};

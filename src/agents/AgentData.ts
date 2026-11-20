import { Activity } from './ActivityAnimations.js';

/** Optional display data that plugins add on the server. All fields are whitelisted there. */
export interface AgentExtras {
  parentId?: string;
  provider?: 'codex';
  attention?: 'waiting' | 'your-turn';
  waitMinutes?: number;
  group?: { id: string; label: string };
  badges?: string[];
  /** `color` is the card border color as `rrggbb` (the issue's label color). */
  issues?: Array<{ number: number; title: string; column?: string; repo?: string; color?: string }>;
  room?: string;
  /** Opt-in write actions the server offers for this agent (today only `focus`, from the herdr plugin). */
  actions?: Array<'focus'>;
  role?: string;
  /** Busy with no transcript write for STUCK_AFTER_MINUTES (src/ui/attention.ts). */
  stuck?: boolean;
}

export interface AgentInfo {
  id: string;
  name: string;
  activity: Activity;
  extras?: AgentExtras;
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
  meeting: 'Waiting for you',
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

import { Activity } from './ActivityAnimations.js';

export interface AgentInfo {
  id: string;
  name: string;
  activity: Activity;
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
  meeting: 'In a meeting',
};

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

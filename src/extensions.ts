import type { ManagedAgent } from './agents/AgentManager.js';
import type { PickTarget } from './scene/Selection.js';
import type * as THREE from 'three';

export interface WorldRoom {
  id: string;
  kind: 'mission' | 'workspace';
  title: string;
  state: 'open' | 'locked';
  /** One entry per ended session (a tombstone): its own public id and the day it ended. */
  sleepers?: Array<{ id: string; endedAt?: string }>;
  /** For the missions board (issue #144): when a mission started, and when a closed one stopped. */
  createdAt?: string;
  closedAt?: string;
  walls: {
    statement?: string;
    docs?: string[];
    /** `repo` is a full `owner/name`: one mission can hold issues from more than one repository. */
    issues?: Array<{ number: number; repo?: string; title: string; state: 'open' | 'closed' }>;
    kanban?: Array<{ column: string; cards: Array<{ number: number; title: string }> }>;
  };
}

export interface WorldBoard {
  id: string;
  title: string;
  columns: Array<{ name: string; cards: Array<{ number: number; title: string }> }>;
}

/** One ticket of the personal Jira board (issue #145). `url` is the browse link built from the key. */
export interface WorldJiraTicket {
  key: string;
  summary: string;
  status: string;
  assignee?: string;
  priority?: string;
  url?: string;
}

/** What `/api/world` returns: active plugin names, rooms, boards and Jira tickets. */
export interface World {
  plugins: string[];
  rooms: WorldRoom[];
  boards: WorldBoard[];
  jiraTickets: WorldJiraTicket[];
}

export const EMPTY_WORLD: World = { plugins: [], rooms: [], boards: [], jiraTickets: [] };

/**
 * A client-side extension: a fork add-on or the browser part of a server plugin.
 * An extension with `plugin` set runs only while that server plugin is active.
 */
export interface OfficeExtension {
  id: string;
  plugin?: string;
  start?(scene: THREE.Scene): void;
  agentsChanged?(agents: ManagedAgent[]): void;
  worldChanged?(world: World): void;
  update?(elapsed: number, delta: number): void;
  /** Extra things a click or hover can pick, besides an agent (for example a tombstone). */
  pickTargets?(): PickTarget[];
}

const registered: OfficeExtension[] = [];
const started = new Set<string>();
let latestWorld: World = EMPTY_WORLD;

export function registerExtension(extension: OfficeExtension): void {
  registered.push(extension);
}

function isActive(extension: OfficeExtension): boolean {
  return !extension.plugin || latestWorld.plugins.includes(extension.plugin);
}

/** Active extensions. Each one gets `start` once, the first time it becomes active. */
export function activeExtensions(scene: THREE.Scene): OfficeExtension[] {
  const active = registered.filter(isActive);
  for (const extension of active) {
    if (started.has(extension.id)) continue;
    started.add(extension.id);
    extension.start?.(scene);
  }
  return active;
}

export function setWorld(world: World): void {
  latestWorld = world;
}

export function currentWorld(): World {
  return latestWorld;
}

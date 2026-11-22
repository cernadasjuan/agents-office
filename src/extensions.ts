import type { ManagedAgent } from './agents/AgentManager.js';
import type { PickTarget } from './scene/Selection.js';
import type * as THREE from 'three';

/** A session's story (issue #160): the tombstone card's data, read from the session's own
 * archived record. Absent entirely means no record was found for this tombstone; an empty
 * `issues` list on an otherwise-present story means the session named none yet. An issue
 * entry with no `url` (review round 2: a real archived record's bare `repo#N` ref, or a
 * Jira-style key) still shows on the card, as plain text instead of a link. */
export interface WorldSessionStory {
  intent?: string;
  personas?: string[];
  counts?: { done: number; open: number; abandoned: number };
  doneList?: string[];
  handoffs?: string[];
  issues?: Array<{ label: string; url?: string }>;
}

export interface WorldRoom {
  id: string;
  kind: 'mission' | 'workspace';
  title: string;
  state: 'open' | 'locked';
  /** One entry per ended session (a tombstone): its own public id, the day it ended, its
   * engraved name (issue #159, the session's own slug) and its story card (issue #160). */
  sleepers?: Array<{ id: string; endedAt?: string; name?: string; story?: WorldSessionStory }>;
  /** For the missions board (issue #144): when a mission started, and when a closed one stopped. */
  createdAt?: string;
  closedAt?: string;
  /** The repo this room scopes to (issue #191): a bare repo short name, matched against the
   * focused floor's own trailing segment (`src/floors/FloorRegistry.ts`'s `matchesFloor`), not
   * exact floor-name equality. Absent only when no repo could be resolved; such a room shows
   * on `ALL_FLOORS` only. */
  repo?: string;
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
  /** The repo this board scopes to (issue #191), the same tag and client matching rule as `WorldRoom.repo`. */
  repo?: string;
}

/** One entry on a library shelf (issue #191 AC1, #119). `archived` is Prospero's rule: a
 * superseded or archived entry still shows, with a visible mark, never silently dropped.
 * `githubUrl` (issue #221 AC2/AC3) is the only way this card ever points at the real file: a
 * fully-built `server/seam.ts` link, never a local path. */
export interface WorldLibraryEntry {
  title: string;
  archived?: boolean;
  summary?: string;
  lastChanged?: string;
  githubUrl?: string;
}

/** One section's own shelf, built from that section's own `INDEX.md`, never a raw folder walk. */
export interface WorldLibrarySection {
  name: string;
  entries: WorldLibraryEntry[];
  /** More entries exist than this capped list carries. */
  truncated?: boolean;
}

/** A floor's own library: only the floors whose repo root holds a `documentation/bibliotheque/`
 * tree get one (graceful degradation — no folder-structure guessing for any other floor). */
export interface WorldLibrary {
  id: string;
  sections: WorldLibrarySection[];
  /** The repo this library scopes to, the same tag and client matching rule as `WorldRoom.repo`. */
  repo?: string;
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
  libraries: WorldLibrary[];
}

export const EMPTY_WORLD: World = { plugins: [], rooms: [], boards: [], jiraTickets: [], libraries: [] };

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

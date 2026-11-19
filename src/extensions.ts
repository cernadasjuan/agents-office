import type { ManagedAgent } from './agents/AgentManager.js';
import type * as THREE from 'three';

export interface WorldRoom {
  id: string;
  kind: 'mission' | 'workspace';
  title: string;
  state: 'open' | 'locked';
  sleepers?: number;
  walls: {
    statement?: string;
    docs?: string[];
    issues?: Array<{ number: number; title: string; state: 'open' | 'closed' }>;
    kanban?: Array<{ column: string; cards: Array<{ number: number; title: string }> }>;
  };
}

export interface WorldBoard {
  id: string;
  title: string;
  columns: Array<{ name: string; cards: Array<{ number: number; title: string }> }>;
}

/** What `/api/world` returns: active plugin names, rooms and boards. */
export interface World {
  plugins: string[];
  rooms: WorldRoom[];
  boards: WorldBoard[];
}

export const EMPTY_WORLD: World = { plugins: [], rooms: [], boards: [] };

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

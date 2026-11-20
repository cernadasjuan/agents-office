import * as THREE from 'three';
import { FIGURE_PART_LAYER } from '../characters/FigureBatch.js';

export type SelectionListener = (agentId: string | null) => void;

/** Which agent is selected. Listeners hear each change once. */
export class SelectionState {
  private current: string | null = null;
  private listeners = new Set<SelectionListener>();

  get selected(): string | null {
    return this.current;
  }

  select(agentId: string | null): void {
    if (agentId === this.current) return;
    this.current = agentId;
    this.notify();
  }

  /** Tell listeners about the current selection again, even though it has not changed. A marker or the top-count chip wants this: the camera still flies there, where a plain `select` of the same id would do nothing. */
  reselect(): void {
    this.notify();
  }

  clear(): void {
    this.select(null);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.current);
      } catch (error) {
        console.debug('selection listener failed', error);
      }
    }
  }

  /** Drop the selection when the selected agent is no longer present. */
  keepOnly(presentIds: Iterable<string>): void {
    if (this.current === null) return;
    for (const id of presentIds) if (id === this.current) return;
    this.clear();
  }

  onChange(listener: SelectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const shared = new SelectionState();

/** The selection the office uses. Extensions (for example a triage list) share it. */
export function officeSelection(): SelectionState {
  return shared;
}

export function selectAgent(agentId: string | null): void {
  shared.select(agentId);
}

/**
 * Select the agent, or if it is already selected, tell listeners again (so
 * the camera still flies there). Used by the off-screen marker and the
 * top-count chip: both expect a click to recenter on the agent even when it
 * is the one already selected. Other callers (a row in the triage list, a
 * figure click) keep the plain `selectAgent` same-id no-op.
 */
export function selectOrFly(agentId: string): void {
  if (shared.selected === agentId) shared.reselect();
  else shared.select(agentId);
}

export function clearSelection(): void {
  shared.clear();
}

export function selectedAgentId(): string | null {
  return shared.selected;
}

export function onSelectionChange(listener: SelectionListener): () => void {
  return shared.onChange(listener);
}

export interface PickTarget {
  id: string;
  object: THREE.Object3D;
}

/** The agent whose figure the ray hits first, or null. */
export function pickAgent(raycaster: THREE.Raycaster, targets: PickTarget[]): string | null {
  if (targets.length === 0) return null;
  // Figure parts draw through the figure batch from their own layer; the ray still hits them
  const mask = raycaster.layers.mask;
  raycaster.layers.enable(FIGURE_PART_LAYER);
  const owners = new Map<THREE.Object3D, string>(targets.map((target) => [target.object, target.id]));
  let hits: THREE.Intersection[];
  try {
    hits = raycaster.intersectObjects(targets.map((target) => target.object), true);
  } finally {
    raycaster.layers.mask = mask;
  }
  for (const hit of hits) {
    for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
      const id = owners.get(node);
      if (id !== undefined) return id;
    }
  }
  return null;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

const CLICK_TOLERANCE_PX = 5;

/** True when the pointer moved so little between press and release that it was a click. */
export function isClick(down: ScreenPoint | null, up: ScreenPoint): boolean {
  if (!down) return true;
  return Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_TOLERANCE_PX;
}

export type ViewMode = 'first-person' | 'overview' | 'isometric';

/** A view name from a URL or the browser storage: `overview`, `first-person`, `iso` or `isometric`; else null. */
export function viewModeFromName(value: string | null | undefined): ViewMode | null {
  if (value === 'overview' || value === 'first-person' || value === 'isometric') return value;
  return value === 'iso' ? 'isometric' : null;
}

/** The overview and the isometric view look down on the building: cutaway walls, no ceiling, zoom-based labels. */
export function isViewFromAbove(mode: ViewMode): boolean {
  return mode !== 'first-person';
}

export interface ViewHash {
  view: ViewMode;
  focus: string | null;
}

const PUBLIC_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `#view=overview` starts in the overview, `#view=iso` in the isometric view. `#focus=<agent id>` selects that agent once it appears. */
export function parseViewHash(hash: string): ViewHash {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const focus = params.get('focus');
  return {
    view: viewModeFromName(params.get('view')) ?? 'first-person',
    focus: focus && PUBLIC_ID.test(focus) ? focus : null,
  };
}

import * as THREE from 'three';
import { FIGURE_PART_LAYER } from '../characters/FigureBatch.js';
import { STATIC_SOURCE_LAYER } from './StaticMerge.js';

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
  /**
   * Issue #223: a board with several clickable rows (the war room's live-sessions board)
   * resolves which row from the ray's own hit, instead of needing one extra mesh per row
   * (the draw-call budget's own growth-rate guard, `tests/mission-corridor-render-budget.test.ts`,
   * polices exactly that: a new un-merged piece per room). `null` means the hit landed on the
   * object but not on a clickable row (for example its title area): no selection, the same as
   * the ray missing every target outright, not a fall-through to the next target behind it.
   */
  resolve?: (hit: THREE.Intersection) => string | null;
}

/**
 * The target (an agent's figure, or another pickable such as a tombstone) whose
 * object the ray hits first, or null.
 */
export function pickAgent(raycaster: THREE.Raycaster, targets: PickTarget[]): string | null {
  if (targets.length === 0) return null;
  // Figure parts draw through the figure batch, and static furniture (like a tombstone) through
  // StaticMerge, each from its own layer; the ray still hits the original, still-positioned source
  const mask = raycaster.layers.mask;
  raycaster.layers.enable(FIGURE_PART_LAYER);
  raycaster.layers.enable(STATIC_SOURCE_LAYER);
  const owners = new Map<THREE.Object3D, PickTarget>(targets.map((target) => [target.object, target]));
  let hits: THREE.Intersection[];
  try {
    hits = raycaster.intersectObjects(targets.map((target) => target.object), true);
  } finally {
    raycaster.layers.mask = mask;
  }
  for (const hit of hits) {
    for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
      const target = owners.get(node);
      if (target === undefined) continue;
      return target.resolve ? target.resolve(hit) : target.id;
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

export type ViewMode = 'first-person' | 'isometric' | 'desk';

/** A view name from a URL or the browser storage: `first-person`, `iso`/`isometric` or `desk`; else null. */
export function viewModeFromName(value: string | null | undefined): ViewMode | null {
  if (value === 'first-person' || value === 'isometric' || value === 'desk') return value;
  return value === 'iso' ? 'isometric' : null;
}

/** The isometric view looks down on the building: cutaway walls, no ceiling, zoom-based labels. Desk mode is an eye-level view, like first person. */
export function isViewFromAbove(mode: ViewMode): boolean {
  return mode === 'isometric';
}

export interface ViewHash {
  view: ViewMode;
  focus: string | null;
  /** The overview-equivalent camera distance to start at (`zoomDistance` units), or null for the view's own default framing. */
  zoom: number | null;
  /** A room name or mission id to frame on load (`office`, `library`, a mission slug), lowercased, or null. */
  room: string | null;
}

const PUBLIC_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A finite, positive `#zoom=` value, or null for anything else (missing, zero, negative, not a number). */
function parseZoom(value: string | null): number | null {
  if (value === null) return null;
  const zoom = Number(value);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : null;
}

/**
 * `#view=iso` (or `isometric`) starts in the isometric view; an unknown or retired view name
 * (`overview`, for example) is `null` here, first person's own value in `ViewHash.view`. The
 * live app never stops at this fallback alone: `main.ts` picks the start view through
 * `chooseViewMode` (`ViewMemory.ts`), which tries this hash value first, then the last saved
 * view, then the active layout's own default — isometric for the building layout, so
 * `#view=overview` with nothing else saved actually lands in isometric, the closest view from
 * above, not first person (#173 review). `#select=<agent id>` (or `#focus=`, its
 * older name, still read) selects that agent once it appears. `#zoom=<distance>` starts at that
 * camera distance instead of the view's own default framing (issue #89): the isometric view
 * converts it to the equivalent `halfHeight`, the same way `ViewController.zoomDistance` already
 * reports it in one unit. `#room=office`, `#room=library` or `#room=<mission id>` frames that
 * room instead, in the current view (fly to its bounds in the isometric view, stand inside it
 * facing its main wall in first person); unknown names are ignored, read-only, no effect on
 * the scene (issue #89, added so a reviewer can screenshot a room's boards from one URL).
 */
export function parseViewHash(hash: string): ViewHash {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const focus = params.get('select') ?? params.get('focus');
  const room = params.get('room');
  return {
    view: viewModeFromName(params.get('view')) ?? 'first-person',
    focus: focus && PUBLIC_ID.test(focus) ? focus : null,
    zoom: parseZoom(params.get('zoom')),
    room: room && PUBLIC_ID.test(room) ? room.toLowerCase() : null,
  };
}

import * as THREE from 'three';
import type { ViewMode } from '../scene/Selection.js';
import { attentionBand } from './attention.js';

/** `smart` shows full labels only where they matter; `all` is the original behavior. */
export type LabelMode = 'smart' | 'all';
export type LabelLevel = 'full' | 'compact';

/** First person: agents within this many units of the camera get a full label. */
export const FIRST_PERSON_FULL_LABEL_DISTANCE = 8;
/** Overview: at this camera distance or closer, every label is full. Above the 12-unit fly-to focus distance. */
export const OVERVIEW_FULL_LABEL_ZOOM = 14;
/** How often the labels are recomputed. */
export const LABEL_DETAIL_INTERVAL_MS = 150;

const COMPACT_CLASS = 'compact';
const MODE_TEXT: Record<LabelMode, string> = { smart: 'Labels: smart (V)', all: 'Labels: all (V)' };

export interface LabelFacts {
  attention: string | undefined;
  /** Minutes the agent has waited for the user, when known. A cold block gets no full label. */
  waitMinutes?: number;
  selected: boolean;
  hovered: boolean;
  /** Distance from the camera to the figure, in world units. */
  distance: number;
}

export interface LabelView {
  mode: LabelMode;
  viewMode: ViewMode;
  /** Overview camera distance; ignored in first person. */
  zoomDistance: number;
}

/** Full or compact label for one agent. Pure: no DOM, no scene. */
export function labelDetail(facts: LabelFacts, view: LabelView): LabelLevel {
  if (view.mode === 'all') return 'full';
  const blockedRecently = facts.attention === 'waiting' && attentionBand({ attention: facts.attention, waitMinutes: facts.waitMinutes }) !== 'cold';
  if (blockedRecently || facts.selected || facts.hovered) return 'full';
  if (view.viewMode === 'overview') return view.zoomDistance <= OVERVIEW_FULL_LABEL_ZOOM ? 'full' : 'compact';
  return facts.distance <= FIRST_PERSON_FULL_LABEL_DISTANCE ? 'full' : 'compact';
}

/** `#labels=all` restores every full label. Anything else is the smart default. */
export function parseLabelMode(hash: string): LabelMode {
  return new URLSearchParams(hash.replace(/^#/, '')).get('labels') === 'all' ? 'all' : 'smart';
}

export function nextLabelMode(mode: LabelMode): LabelMode {
  return mode === 'smart' ? 'all' : 'smart';
}

/** Toggle the compact class. Returns true only when the DOM changed. */
export function applyLabelDetail(element: HTMLElement, level: LabelLevel): boolean {
  const compact = level === 'compact';
  if (element.classList.contains(COMPACT_CLASS) === compact) return false;
  element.classList.toggle(COMPACT_CLASS, compact);
  return true;
}

/** The part of a managed agent this module reads. */
export interface LabelAgent {
  info: { id: string; extras?: { attention?: string; waitMinutes?: number } };
  figure: { group: THREE.Object3D; label: { element: HTMLElement } };
}

export interface LabelDetailOptions {
  agents: () => LabelAgent[];
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  /** Where key presses arrive (the window). */
  keys: Pick<Window, 'addEventListener'>;
  viewMode: () => ViewMode;
  zoomDistance: () => number;
  /** The agent under a screen point, or null (the selection raycast). */
  pick: (clientX: number, clientY: number) => string | null;
  selected: () => string | null;
  hash?: string;
  /** Shows the current mode, for example in the side panel header. */
  indicator?: HTMLElement | null;
}

function isFormField(target: EventTarget | null): boolean {
  const tag = (target as Element | null)?.tagName;
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
}

/**
 * Decides on a throttle which labels are full and which are compact, and only
 * toggles a class on each label element. Key V cycles smart and all.
 */
export class LabelDetailController {
  private currentMode: LabelMode;
  private lastRun = Number.NEGATIVE_INFINITY;
  private pointer: { x: number; y: number } | null = null;
  private figurePosition = new THREE.Vector3();
  private cameraPosition = new THREE.Vector3();

  constructor(private options: LabelDetailOptions) {
    this.currentMode = parseLabelMode(options.hash ?? '');
    this.listen();
    this.showMode();
  }

  get mode(): LabelMode {
    return this.currentMode;
  }

  cycleMode(): void {
    this.currentMode = nextLabelMode(this.currentMode);
    this.showMode();
    this.refresh();
  }

  /** Call each frame; recomputes at most once per `LABEL_DETAIL_INTERVAL_MS`. */
  update(nowMs: number): void {
    if (nowMs - this.lastRun < LABEL_DETAIL_INTERVAL_MS) return;
    this.lastRun = nowMs;
    this.refresh();
  }

  /** Recompute now, for example after a selection change. */
  refresh(): void {
    const { camera } = this.options;
    const view: LabelView = { mode: this.currentMode, viewMode: this.options.viewMode(), zoomDistance: this.options.zoomDistance() };
    const selected = this.options.selected();
    const hovered = view.mode === 'smart' ? this.hoveredAgent() : null;
    camera.getWorldPosition(this.cameraPosition);
    for (const agent of this.options.agents()) {
      agent.figure.group.getWorldPosition(this.figurePosition);
      const level = labelDetail({
        attention: agent.info.extras?.attention,
        waitMinutes: agent.info.extras?.waitMinutes,
        selected: agent.info.id === selected,
        hovered: agent.info.id === hovered,
        distance: this.figurePosition.distanceTo(this.cameraPosition),
      }, view);
      applyLabelDetail(agent.figure.label.element, level);
    }
  }

  /** Under the pointer, or under the screen center while the pointer is locked (first person). */
  private hoveredAgent(): string | null {
    const { canvas, pick } = this.options;
    if (canvas.ownerDocument.pointerLockElement === canvas) {
      const rect = canvas.getBoundingClientRect();
      return pick(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    return this.pointer ? pick(this.pointer.x, this.pointer.y) : null;
  }

  private listen(): void {
    const { canvas, keys } = this.options;
    keys.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.code !== 'KeyV' || isFormField(event.target)) return;
      this.cycleMode();
    });
    canvas.addEventListener('pointermove', (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointer = null;
    });
  }

  private showMode(): void {
    if (this.options.indicator) this.options.indicator.textContent = MODE_TEXT[this.currentMode];
  }
}

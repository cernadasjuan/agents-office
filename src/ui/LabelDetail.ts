import * as THREE from 'three';
import { isViewFromAbove, type ViewMode } from '../scene/Selection.js';
import { attentionBand } from './attention.js';

/** `smart` shows full labels only where they matter; `all` is the original behavior. */
export type LabelMode = 'smart' | 'all';
export type LabelLevel = 'full' | 'compact';

/** First person: agents within this many units of the camera get a full label. */
export const FIRST_PERSON_FULL_LABEL_DISTANCE = 8;
/** Overview: at this camera distance or closer, every label is full. Above the 12-unit fly-to focus distance. */
export const OVERVIEW_FULL_LABEL_ZOOM = 14;
/** Overview: at this camera distance or closer, war room signs show. */
export const OVERVIEW_SIGN_ZOOM = 24;
/** First person: war room signs within this many units of the camera show. */
export const FIRST_PERSON_SIGN_DISTANCE = 12;
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
  /** Busy with no transcript write for a long while: like a fresh wait, always full. */
  stuck?: boolean;
}

export interface LabelView {
  mode: LabelMode;
  viewMode: ViewMode;
  /**
   * Overview camera distance; ignored in first person. The isometric view
   * reports the overview distance with the same screen size, so one set of
   * zoom thresholds serves both views.
   */
  zoomDistance: number;
}

/** Full or compact label for one agent. Pure: no DOM, no scene. */
export function labelDetail(facts: LabelFacts, view: LabelView): LabelLevel {
  if (view.mode === 'all') return 'full';
  const blockedRecently = facts.attention === 'waiting' && attentionBand({ attention: facts.attention, waitMinutes: facts.waitMinutes }) !== 'cold';
  if (blockedRecently || facts.stuck || facts.selected || facts.hovered) return 'full';
  if (isViewFromAbove(view.viewMode)) return view.zoomDistance <= OVERVIEW_FULL_LABEL_ZOOM ? 'full' : 'compact';
  return facts.distance <= FIRST_PERSON_FULL_LABEL_DISTANCE ? 'full' : 'compact';
}

export interface RoomLabelFacts {
  viewMode: LabelView['viewMode'];
  /** The camera stands inside the label's room. */
  cameraInside: boolean;
}

/**
 * Whether a room label (an in-scene sprite above the room center) shows. In first
 * person it hides while you stand in its room, so it does not block the view.
 * Elsewhere it shows; walls hide it in first person by depth.
 */
/**
 * What a room label hears each refresh through `userData.applyView` (a layout
 * hook, for example the building add-on). `detail`: zoomed in, pointed at or
 * labels: all.
 */
export interface RoomLabelHookView {
  viewMode: ViewMode;
  zoomDistance: number;
  detail: boolean;
}

export function roomLabelVisible(facts: RoomLabelFacts): boolean {
  return isViewFromAbove(facts.viewMode) || !facts.cameraInside;
}

export interface SignFacts {
  /** The pointer is over the sign's room. */
  hovered: boolean;
  /** Distance from the camera to the sign, in world units. */
  distance: number;
  /** A sign that shows only on hover (or with labels: all), never from zoom alone. */
  hoverOnly: boolean;
}

/**
 * Whether a detail sign (a war room sign, marked `userData.detailSign`) shows.
 * Same rule as agent labels: zoom in or hover in the overview, near the camera in first person.
 */
export function signVisible(facts: SignFacts, view: LabelView): boolean {
  if (view.mode === 'all' || facts.hovered) return true;
  if (facts.hoverOnly) return false;
  if (isViewFromAbove(view.viewMode)) return view.zoomDistance <= OVERVIEW_SIGN_ZOOM;
  return facts.distance <= FIRST_PERSON_SIGN_DISTANCE;
}

/** Show or hide a sign with `visibility`, which CSS2DRenderer leaves alone. Returns true only when the DOM changed. */
export function applySignVisibility(element: HTMLElement, visible: boolean): boolean {
  const value = visible ? '' : 'hidden';
  if (element.style.visibility === value) return false;
  element.style.visibility = value;
  return true;
}

/** The rect a detail sign belongs to, on the floor plane. */
interface DetailSign {
  rect: { minX: number; maxX: number; minZ: number; maxZ: number };
  hoverOnly?: boolean;
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
  info: { id: string; extras?: { attention?: string; waitMinutes?: number; stuck?: boolean } };
  figure: { group: THREE.Object3D; label: { element: HTMLElement } };
}

export interface LabelDetailOptions {
  agents: () => LabelAgent[];
  camera: THREE.Camera;
  /** The camera that draws now (the isometric view uses an orthographic camera). Default: `camera`. */
  activeCamera?: () => THREE.Camera;
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
  /** Where detail signs (`userData.detailSign`) live. Without it, only agent labels change. */
  scene?: THREE.Object3D;
  /** A room label changed (pose, face or visibility): the scene needs a new frame. */
  changed?: () => void;
}

function isFormField(target: EventTarget | null): boolean {
  const tag = (target as Element | null)?.tagName;
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
}

/**
 * Decides on a throttle which labels are full and which are compact, and only
 * toggles a class on each label element. With a scene, it also shows or hides
 * detail signs (war room signs). Key V cycles smart and all.
 */
export class LabelDetailController {
  private currentMode: LabelMode;
  private lastRun = Number.NEGATIVE_INFINITY;
  private pointer: { x: number; y: number } | null = null;
  private figurePosition = new THREE.Vector3();
  private cameraPosition = new THREE.Vector3();
  private signPosition = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private signs: THREE.Object3D[] | null = null;

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
    const camera = this.camera();
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
        stuck: agent.info.extras?.stuck,
      }, view);
      applyLabelDetail(agent.figure.label.element, level);
    }
    this.refreshSigns(view);
  }

  /** Call when rooms or signs were added or removed; the next refresh collects them again. */
  sceneChanged(): void {
    this.signs = null;
  }

  /** Room labels and detail signs, collected once and again after `sceneChanged`, not on every refresh. */
  private collectSigns(scene: THREE.Object3D): THREE.Object3D[] {
    const found: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (object.userData.roomRect || object.userData.detailSign) found.push(object);
    });
    return found;
  }

  private refreshSigns(view: LabelView): void {
    const { scene } = this.options;
    if (!scene) return;
    this.signs ??= this.collectSigns(scene);
    const pointed = view.mode === 'smart' ? this.pointedFloor() : null;
    const inRect = (point: THREE.Vector3 | null, rect: DetailSign['rect']) =>
      point !== null && point.x >= rect.minX && point.x <= rect.maxX && point.z >= rect.minZ && point.z <= rect.maxZ;
    let changed = false;
    for (const object of this.signs) {
      if (!object.parent) continue;
      const roomRect = object.userData.roomRect as DetailSign['rect'] | undefined;
      if (roomRect) {
        const visible = roomLabelVisible({ viewMode: view.viewMode, cameraInside: inRect(this.cameraPosition, roomRect) });
        const fromAbove = isViewFromAbove(view.viewMode);
        const detail = view.mode === 'all' || inRect(pointed, roomRect) || (fromAbove && view.zoomDistance <= OVERVIEW_SIGN_ZOOM);
        const key = `${visible}|${view.viewMode}|${detail}|${fromAbove ? view.zoomDistance.toFixed(2) : ''}`;
        if (object.userData.labelViewKey === key) continue;
        object.userData.labelViewKey = key;
        object.visible = visible;
        const applyView = object.userData.applyView as ((next: RoomLabelHookView) => void) | undefined;
        applyView?.({ viewMode: view.viewMode, zoomDistance: view.zoomDistance, detail });
        changed = true;
        continue;
      }
      const detail = object.userData.detailSign as DetailSign | undefined;
      const element = (object as THREE.Object3D & { element?: HTMLElement }).element;
      if (!detail || !element) continue;
      object.getWorldPosition(this.signPosition);
      const facts: SignFacts = { hovered: inRect(pointed, detail.rect), distance: this.signPosition.distanceTo(this.cameraPosition), hoverOnly: detail.hoverOnly === true };
      applySignVisibility(element, signVisible(facts, view));
    }
    if (changed) this.options.changed?.();
  }

  /** The floor point under the pointer (or the screen center while the pointer is locked), or null. */
  private pointedFloor(): THREE.Vector3 | null {
    const { canvas } = this.options;
    const camera = this.camera();
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const locked = canvas.ownerDocument.pointerLockElement === canvas;
    if (!locked && !this.pointer) return null;
    const x = locked ? rect.left + rect.width / 2 : this.pointer!.x;
    const y = locked ? rect.top + rect.height / 2 : this.pointer!.y;
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, camera);
    return this.raycaster.ray.intersectPlane(this.floor, new THREE.Vector3());
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

  private camera(): THREE.Camera {
    return this.options.activeCamera?.() ?? this.options.camera;
  }

  private showMode(): void {
    if (this.options.indicator) this.options.indicator.textContent = MODE_TEXT[this.currentMode];
  }
}

import * as THREE from 'three';
import { isViewFromAbove, type ViewMode } from '../scene/Selection.js';
import { projectToClip } from '../scene/OffscreenMarker.js';
import { attentionBand, BEACON_HINT, callsForYou, type Wait } from './attention.js';
import { boundingRect, declutterLabels, labelPriority, labelRect, obscuredByAny, type DeclutterCandidate, type Rect } from './LabelDeclutter.js';

/** `smart` shows full labels only where they matter; `all` is the original behavior. */
export type LabelMode = 'smart' | 'all';
export type LabelLevel = 'full' | 'compact';

/** First person: agents within this many units of the camera get a full label. */
export const FIRST_PERSON_FULL_LABEL_DISTANCE = 8;
/** Isometric: at this camera distance or closer, every label is full. Above the 12-unit fly-to focus distance. */
export const ISOMETRIC_FULL_LABEL_ZOOM = 14;
/** Isometric: at this camera distance or closer, war room signs show. */
export const ISOMETRIC_SIGN_ZOOM = 24;
/** First person: war room signs within this many units of the camera show. */
export const FIRST_PERSON_SIGN_DISTANCE = 12;
/** How often the labels are recomputed. */
export const LABEL_DETAIL_INTERVAL_MS = 150;

const COMPACT_CLASS = 'compact';
const MODE_TEXT: Record<LabelMode, string> = { smart: 'Labels: smart (V)', all: 'Labels: all (V)' };

/**
 * A world point's screen position, in CSS pixels from the canvas top-left, or
 * null when the point is behind the camera, past the far plane, or outside
 * the frustum: it would never draw there, so it must never win or lose a
 * declutter decision against a label that is actually on screen. Otherwise
 * the same NDC-to-pixel conversion CSS2DRenderer itself uses.
 */
function projectToScreen(position: THREE.Vector3, camera: THREE.Camera, width: number, height: number): { x: number; y: number } | null {
  const projection = projectToClip(position, camera);
  if (projection.behind || projection.pastFar || projection.tooClose) return null;
  const { x, y } = projection.ndc;
  if (x < -1 || x > 1 || y < -1 || y > 1) return null;
  return { x: (x + 1) / 2 * width, y: (1 - y) / 2 * height };
}

export interface LabelFacts {
  attention: string | undefined;
  /** Minutes the agent has waited for the user, when known. Only a fresh block forces a full label; an aging or cold block does not. */
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
  /** Isometric camera distance; ignored in first person. */
  zoomDistance: number;
}

/** Full or compact label for one agent. Pure: no DOM, no scene. */
export function labelDetail(facts: LabelFacts, view: LabelView): LabelLevel {
  if (view.mode === 'all') return 'full';
  const band = attentionBand({ attention: facts.attention, waitMinutes: facts.waitMinutes } as Wait);
  const fromAbove = isViewFromAbove(view.viewMode);
  // Isometric: only a fresh wait (or an unknown wait time, the old behavior)
  // forces a full label; an aging wait follows the normal zoom rule instead,
  // so a real queue (14+ agents, almost all aging) does not force every label
  // full and overlap the others (#132). First person keeps the original rule
  // (any wait that is not cold forces full): the issue that prompted this
  // relief described the above-view camera's own crowding only, and first
  // person's queue spacing (1.7 m) can already overlap on screen, so an aging
  // wait nearby must not lose its activity line and go compact there.
  const blockedRecently = facts.attention === 'waiting' && (fromAbove ? band === undefined || band === 'fresh' : band !== 'cold');
  if (blockedRecently || facts.stuck || facts.selected || facts.hovered) return 'full';
  if (fromAbove) return view.zoomDistance <= ISOMETRIC_FULL_LABEL_ZOOM ? 'full' : 'compact';
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
  /** Overrides `FIRST_PERSON_SIGN_DISTANCE` for a sign meant to read from anywhere in its own
   * room (round 7, #214: the library's shelf labels), not just up close like a war room sign. */
  maxDistance?: number;
}

/**
 * Whether a detail sign (a war room sign, marked `userData.detailSign`) shows.
 * Same rule as agent labels: zoom in or hover in the isometric view, near the camera in first person.
 */
export function signVisible(facts: SignFacts, view: LabelView): boolean {
  if (view.mode === 'all' || facts.hovered) return true;
  if (facts.hoverOnly) return false;
  if (isViewFromAbove(view.viewMode)) return view.zoomDistance <= ISOMETRIC_SIGN_ZOOM;
  return facts.distance <= (facts.maxDistance ?? FIRST_PERSON_SIGN_DISTANCE);
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
  /** See `SignFacts.maxDistance`. */
  maxDistance?: number;
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

/** Show or hide a label with `visibility`, which CSS2DRenderer leaves alone (same pattern as a sign). */
export function applyLabelVisibility(element: HTMLElement, visible: boolean): boolean {
  const value = visible ? '' : 'hidden';
  if (element.style.visibility === value) return false;
  element.style.visibility = value;
  return true;
}

/** The part of a managed agent this module reads. */
export interface LabelAgent {
  info: { id: string; activity?: string; extras?: { attention?: string; waitMinutes?: number; stuck?: boolean; orchestrating?: boolean } };
  figure: { group: THREE.Object3D; label: { element: HTMLElement; getWorldPosition: (target: THREE.Vector3) => THREE.Vector3 } };
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
  /** World corners of each desk monitor's face, left then right (issue #161 review, defect 4): used only in desk mode, to keep a queued agent's label from covering one. Without it, desk mode declutters normally but protects no monitor. */
  deskMonitorCorners?: () => THREE.Vector3[][];
  /** A room label changed (pose, face or visibility): the scene needs a new frame. */
  changed?: () => void;
  /**
   * Called each refresh with the beacon's meaning and the cursor position, or both null, for
   * the hovered agent (issue #170 review): labels have `pointer-events: none`, so a title
   * attribute there never shows. The caller owns rendering a small DOM tooltip near the point;
   * this module only decides when one applies, reusing the hover detection it already runs for
   * label declutter.
   */
  onHoverHint?: (hint: string | null, point: { x: number; y: number } | null) => void;
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
  private labelPosition = new THREE.Vector3();
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
    // Hover detection runs in every label mode now (review fix): the beacon hint must still
    // reach the cursor in `#labels=all`, even though declutter (`canDeclutter` below) stays
    // smart-only, and `labelDetail` itself ignores `hovered` in `all` mode regardless.
    const hovered = this.hoveredAgent();
    camera.getWorldPosition(this.cameraPosition);
    const canvasRect = this.options.canvas.getBoundingClientRect();
    // Declutter in the isometric view and in desk mode (issue #161 review, defect 4: the desk
    // view's own queue can overlap the waiting-list monitor): never in first person, where the
    // queue spacing can already overlap on screen and a waiting agent you stand near must never
    // disappear there (review fix: PR #152).
    const canDeclutter = view.mode === 'smart' && (isViewFromAbove(view.viewMode) || view.viewMode === 'desk') && canvasRect.width > 0 && canvasRect.height > 0;
    const agents = this.options.agents();
    // Pass 1, writes only: every label's class (full/compact) is set here, and nothing in this
    // loop reads layout (getBoundingClientRect, offsetWidth and the like). Pass 2 below reads
    // layout for the agents that need it. Interleaving a write and a read per agent (the old
    // shape) forces the browser to flush layout once per agent; splitting them into two passes
    // lets it batch every write first and run the layout pass once for the whole refresh
    // (review fix: PR #152).
    interface Candidate { agent: LabelAgent; level: LabelLevel; isSelected: boolean; isHovered: boolean }
    const prepared: Candidate[] = [];
    for (const agent of agents) {
      agent.figure.group.getWorldPosition(this.figurePosition);
      const isSelected = agent.info.id === selected;
      const isHovered = agent.info.id === hovered;
      const level = labelDetail({
        attention: agent.info.extras?.attention,
        waitMinutes: agent.info.extras?.waitMinutes,
        selected: isSelected,
        hovered: isHovered,
        distance: this.figurePosition.distanceTo(this.cameraPosition),
        stuck: agent.info.extras?.stuck,
      }, view);
      applyLabelDetail(agent.figure.label.element, level);
      prepared.push({ agent, level, isSelected, isHovered });
    }
    // The hovered agent's beacon hint (issue #170 review), reusing the hover detection above.
    // Pointer-locked (first person): `listen()`'s `pointerlockchange` handler clears
    // `this.pointer` the moment the lock engages and ignores every pointermove while it holds,
    // so this never fires there — the card line is the fallback in that view.
    const hoveredAgent = prepared.find((candidate) => candidate.isHovered)?.agent;
    const hoveredCallsForYou = hoveredAgent !== undefined && this.pointer !== null && callsForYou({
      attention: hoveredAgent.info.extras?.attention as NonNullable<Wait>['attention'],
      waitMinutes: hoveredAgent.info.extras?.waitMinutes,
      orchestrating: hoveredAgent.info.extras?.orchestrating,
    });
    this.options.onHoverHint?.(hoveredCallsForYou ? BEACON_HINT : null, hoveredCallsForYou ? this.pointer : null);
    // Pass 2, reads only (when declutter runs at all).
    const candidates: DeclutterCandidate[] = [];
    if (canDeclutter) {
      for (const { agent, level, isSelected, isHovered } of prepared) {
        agent.figure.label.getWorldPosition(this.labelPosition);
        const point = projectToScreen(this.labelPosition, camera, canvasRect.width, canvasRect.height);
        if (!point) continue; // behind the camera, outside the frustum, or closer than the near plane: never a candidate
        // The label's own rendered size (set by applyLabelDetail above, pass 1), measured once
        // here and used only for this candidate: a long name does not silently escape the
        // fixed-size estimate. Falls back to that estimate when no real layout exists (a test, or
        // a label not yet in a laid-out document).
        const box = agent.figure.label.element.getBoundingClientRect();
        candidates.push({
          id: agent.info.id,
          rect: labelRect(point.x, point.y, level, box.width, box.height),
          priority: labelPriority({
            selected: isSelected,
            hovered: isHovered,
            stuck: agent.info.extras?.stuck === true,
            attention: agent.info.extras?.attention,
            waitMinutes: agent.info.extras?.waitMinutes,
            idle: agent.info.activity === 'idle',
          }),
          waitMinutes: agent.info.extras?.waitMinutes ?? -1,
        });
      }
    }
    if (canDeclutter) {
      const visible = declutterLabels(candidates);
      // Issue #161 review, defect 4: in desk mode, a visible label that still covers a
      // monitor's own screen rect hides anyway, unless it is the selection or the hover (the
      // same exception `labelPriority` already gives them against a plain label-on-label
      // overlap). The monitor itself never appears as a declutter candidate — it is not a
      // label — so this runs as a second pass over what `declutterLabels` already kept.
      const obstructions = view.viewMode === 'desk' ? this.monitorObstructionRects(camera, canvasRect) : [];
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      for (const agent of agents) {
        const id = agent.info.id;
        let show = visible.has(id);
        if (show && obstructions.length > 0 && id !== selected && id !== hovered) {
          const candidate = candidateById.get(id);
          if (candidate && obscuredByAny(candidate.rect, obstructions)) show = false;
        }
        applyLabelVisibility(agent.figure.label.element, show);
      }
    } else {
      // `all` mode or a zero-size canvas: show every label, nothing hides.
      for (const agent of agents) applyLabelVisibility(agent.figure.label.element, true);
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
        const detail = view.mode === 'all' || inRect(pointed, roomRect) || (fromAbove && view.zoomDistance <= ISOMETRIC_SIGN_ZOOM);
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
      const facts: SignFacts = {
        hovered: inRect(pointed, detail.rect),
        distance: this.signPosition.distanceTo(this.cameraPosition),
        hoverOnly: detail.hoverOnly === true,
        maxDistance: detail.maxDistance,
      };
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
      // A locked pointer keeps firing `pointermove`, with `clientX`/`clientY` frozen at the
      // pre-lock position (the look deltas travel in `movementX`/`movementY` instead): ignored
      // here, so a locked move can never resurrect a stale cursor position (review fix).
      if (canvas.ownerDocument.pointerLockElement === canvas) return;
      this.pointer = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointer = null;
    });
    // The lock can engage between two pointermove events (a click straight into first person),
    // so this.pointer may still hold a pre-lock position when it does. Clearing it here, and
    // telling the caller to hide the tooltip at once, closes that gap instead of waiting for
    // the next throttled refresh (review fix: a beacon hint must never show a stale screen spot
    // while the user looks around locked).
    canvas.ownerDocument.addEventListener('pointerlockchange', () => {
      if (canvas.ownerDocument.pointerLockElement !== canvas) return;
      this.pointer = null;
      this.options.onHoverHint?.(null, null);
    });
  }

  private camera(): THREE.Camera {
    return this.options.activeCamera?.() ?? this.options.camera;
  }

  /**
   * Each desk monitor's own screen rect (issue #161 review, defect 4), or none without the
   * option, without a layout that supports it, or while a monitor's own corner falls off the
   * frustum (its screen rect would not be the true one, so it protects nothing rather than a
   * wrong one).
   */
  private monitorObstructionRects(camera: THREE.Camera, canvasRect: { width: number; height: number }): Rect[] {
    const quads = this.options.deskMonitorCorners?.() ?? [];
    const rects: Rect[] = [];
    for (const quad of quads) {
      const points = quad.map((corner) => projectToScreen(corner, camera, canvasRect.width, canvasRect.height));
      if (points.some((point) => point === null)) continue;
      const rect = boundingRect(points as Array<{ x: number; y: number }>);
      if (rect) rects.push(rect);
    }
    return rects;
  }

  private showMode(): void {
    if (this.options.indicator) this.options.indicator.textContent = MODE_TEXT[this.currentMode];
  }
}

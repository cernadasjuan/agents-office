import * as THREE from 'three';
import type { ManagedAgent } from '../agents/AgentManager.js';
import { focusPosition, freeCameraLook, setFreeCameraLook, setPointerLockFilter, updateFreeCamera } from './FreeCamera.js';
import { IsometricController, IsometricTween, type IsometricState } from './IsometricCamera.js';
import { OverviewController, PoseTween, floorUnder, overviewBounds, type CameraPose } from './OverviewCamera.js';
import { SelectionMarker } from './SelectionMarker.js';
import { isClick, isViewFromAbove, officeSelection, parseViewHash, pickAgent, type PickTarget, type ScreenPoint, type SelectionState, type ViewMode } from './Selection.js';

const FLIGHT_SECONDS = 0.6;
const FIRST_PERSON_FOCUS_DISTANCE = 4;
const FIRST_PERSON_FOCUS_HEIGHT = 1.2;
const FIGURE_CHEST = 1.1;
const PAN_SPEED_PER_DISTANCE = 0.9;
const FAST_MULTIPLIER = 2.5;

export const VIEW_HINTS: Record<ViewMode, string> = {
  'first-person': 'Click to look around — WASD to move — Space/Q up/down — Shift = fast — ESC to release — Click a figure to select — O = overview — I = isometric — Shift+L = layout — N = next — F = focus — / = filter',
  overview: 'Overview — Drag to pan — Wheel to zoom — WASD to pan — Click a figure to select — Esc clears — O = first person — I = isometric — Shift+L = layout — N = next — F = focus — / = filter',
  isometric: 'Isometric — Drag to pan — Wheel to zoom — WASD to pan — Click a figure to select — Esc clears — I = back — O = overview — Shift+L = layout — N = next — F = focus — / = filter',
};

export interface ViewControllerOptions {
  camera: THREE.PerspectiveCamera;
  /** The camera of the isometric view. Without it the controller makes one. */
  isometricCamera?: THREE.OrthographicCamera;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  agents: () => ManagedAgent[];
  /** Other pickable things besides an agent's figure (for example a tombstone). */
  tombstones?: () => PickTarget[];
  /** Where key presses arrive (the window). */
  keys: Pick<Window, 'addEventListener'>;
  hint?: HTMLElement | null;
  /** The URL hash: `#view=overview`, `#view=iso`, `#focus=<agent id>`. */
  hash?: string;
  selection?: SelectionState;
  /** The start view. Without it the hash decides (`#view=overview`), else first person. */
  view?: ViewMode;
  /** Called with the start mode and after each mode change (the header, the saved view). */
  modeChanged?: (mode: ViewMode) => void;
  /** Pixels to show a selected figure left of the canvas center (the agent card covers the right). */
  figureShiftPx?: () => number;
}

function isFormField(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || element?.isContentEditable === true;
}

/**
 * Owns the camera mode (first person, overview or isometric), click to select,
 * the selection ring and the camera flights. First person stays the default.
 * The isometric view draws through its own orthographic camera (`activeCamera`).
 */
export class ViewController {
  private currentMode: ViewMode = 'first-person';
  private overview = new OverviewController();
  private isometric = new IsometricController();
  private isometricCamera: THREE.OrthographicCamera;
  private flight: { tween: PoseTween; end: CameraPose } | null = null;
  private isometricFlight: IsometricTween | null = null;
  private savedFirstPerson: CameraPose | null = null;
  private beforeIsometric: ViewMode = 'overview';
  private hiddenInOverview: THREE.Object3D[] = [];
  private panKeys = new Set<string>();
  private pressPoint: ScreenPoint | null = null;
  private dragPoint: ScreenPoint | null = null;
  /** True once the current gesture has panned, even if it ends back near the press point (issue #133). */
  private dragged = false;
  private pendingFocus: string | null;
  private marker: SelectionMarker;
  private selection: SelectionState;
  private raycaster = new THREE.Raycaster();

  constructor(private options: ViewControllerOptions) {
    this.selection = options.selection ?? officeSelection();
    this.isometricCamera = options.isometricCamera ?? new THREE.OrthographicCamera();
    this.marker = new SelectionMarker(options.scene);
    const start = parseViewHash(options.hash ?? '');
    this.pendingFocus = start.focus;

    setPointerLockFilter((event) => this.currentMode === 'first-person' && this.pickAt(event.clientX, event.clientY) === null);
    this.listen();
    this.selection.onChange((agentId) => this.selectionChanged(agentId));
    this.setHint();
    const startView = options.view ?? start.view;
    if (startView !== 'first-person') this.setMode(startView, false);
    else options.modeChanged?.(this.currentMode);
  }

  get mode(): ViewMode {
    return this.currentMode;
  }

  /** The camera that draws now: the orthographic camera in the isometric view, else the perspective camera. */
  get activeCamera(): THREE.Camera {
    return this.currentMode === 'isometric' ? this.isometricCamera : this.options.camera;
  }

  /**
   * The zoom as an overview camera distance. Label detail reads it. The
   * isometric view reports the overview distance with the same screen size.
   */
  get zoomDistance(): number {
    return this.currentMode === 'isometric' ? this.isometric.equivalentDistance(this.options.camera.fov) : this.overview.distance;
  }

  /** Key O: first person and the overview. From the isometric view it goes to the overview. */
  toggleMode(): void {
    this.setMode(this.currentMode === 'overview' ? 'first-person' : 'overview', true);
  }

  /** Key I: into the isometric view, and back to the view before it. */
  toggleIsometric(): void {
    this.setMode(this.currentMode === 'isometric' ? this.beforeIsometric : 'isometric', true);
  }

  setMode(mode: ViewMode, animate: boolean): void {
    if (mode === this.currentMode) return;
    const previous = this.currentMode;
    const from = this.currentPose();
    if (previous === 'first-person') this.savedFirstPerson = from;
    if (mode === 'isometric') this.beforeIsometric = previous;
    this.currentMode = mode;
    this.isometricFlight = null;
    // The camera changes kind when the isometric view starts or ends: cut, do not fly
    const fly = animate && previous !== 'isometric' && mode !== 'isometric';
    if (isViewFromAbove(mode)) {
      const document = this.options.canvas.ownerDocument;
      if (document.pointerLockElement) document.exitPointerLock?.();
      if (!isViewFromAbove(previous)) this.hideNearWalls();
    } else {
      this.showNearWalls();
    }
    this.setHint();
    if (mode === 'isometric') {
      this.flight = null;
      this.frameIsometric();
      this.applyIsometric();
    } else if (mode === 'overview') {
      this.frameOverview();
      this.flyTo(from, this.overview.pose(), fly);
    } else {
      this.flyTo(from, this.savedFirstPerson ?? from, fly);
    }
    this.options.modeChanged?.(mode);
  }

  /**
   * Call after each poll: applies `#focus` once and drops a selection whose agent left.
   * A tombstone is not an agent and never appears in `agents`, so its id is kept too: an open
   * tombstone card must survive the routine 3 s agent poll, not just the next `worldChanged`.
   */
  agentsChanged(agents: ManagedAgent[]): void {
    const ids = agents.map((agent) => agent.info.id);
    const tombstoneIds = (this.options.tombstones?.() ?? []).map((target) => target.id);
    this.selection.keepOnly([...ids, ...tombstoneIds]);
    if (this.pendingFocus && ids.includes(this.pendingFocus)) {
      const focus = this.pendingFocus;
      this.pendingFocus = null;
      this.selection.select(focus);
    }
  }

  update(elapsed: number, delta: number): void {
    const camera = this.options.camera;
    if (this.currentMode === 'isometric') {
      if (this.isometricFlight) {
        this.isometric.setState(this.isometricFlight.advance(delta));
        if (this.isometricFlight.done) this.isometricFlight = null;
      } else {
        this.panWithKeys(delta);
      }
      this.applyIsometric();
    } else if (this.flight) {
      const pose = this.flight.tween.advance(delta);
      this.applyPose(pose);
      if (this.flight.tween.done) {
        if (this.currentMode === 'first-person') setFreeCameraLook(camera, this.flight.end.position, this.flight.end.lookAt);
        this.flight = null;
      }
    } else if (this.currentMode === 'overview') {
      this.panWithKeys(delta);
      this.applyPose(this.overview.pose());
    } else {
      updateFreeCamera(camera, delta);
    }

    const selected = this.selectedAgent();
    if (selected) this.marker.follow(selected.figure.group.position, elapsed);
  }

  /** The agent figure, or other pickable (a tombstone), under a screen point, or null. */
  pickAt(clientX: number, clientY: number): string | null {
    const rect = this.options.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const camera = this.activeCamera;
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, camera);
    const targets = [
      ...this.options.agents().map((agent) => ({ id: agent.info.id, object: agent.figure.group })),
      ...(this.options.tombstones?.() ?? []),
    ];
    return pickAgent(this.raycaster, targets);
  }

  private listen(): void {
    const { canvas, keys } = this.options;
    const document = canvas.ownerDocument;

    keys.addEventListener('keydown', (event: KeyboardEvent) => {
      if (isFormField(event.target)) return;
      if (event.code === 'KeyO') this.toggleMode();
      else if (event.code === 'KeyI') this.toggleIsometric();
      else if (event.code === 'Escape') this.selection.clear();
      else this.panKeys.add(event.code);
    });
    keys.addEventListener('keyup', (event: KeyboardEvent) => this.panKeys.delete(event.code));

    canvas.addEventListener('pointerdown', (event) => {
      this.pressPoint = { x: event.clientX, y: event.clientY };
      this.dragPoint = isViewFromAbove(this.currentMode) && event.button === 0 ? { ...this.pressPoint } : null;
      this.dragged = false;
    });
    document.addEventListener('pointermove', (event) => {
      if (!this.dragPoint || !isViewFromAbove(this.currentMode)) return;
      const point = { x: event.clientX, y: event.clientY };
      if (isClick(this.pressPoint, point)) return;
      this.dragged = true;
      this.flight = null;
      this.isometricFlight = null;
      const dx = point.x - this.dragPoint.x;
      const dy = point.y - this.dragPoint.y;
      if (this.currentMode === 'isometric') this.isometric.drag(dx, dy, canvas.clientHeight || 1);
      else this.overview.drag(dx, dy, canvas.clientHeight || 1, this.options.camera.fov);
      this.dragPoint = point;
    });
    document.addEventListener('pointerup', () => {
      this.dragPoint = null;
    });
    canvas.addEventListener('click', (event) => {
      // Pointer lock turns a click into "look around" (issue #133); let it through unselected.
      if (document.pointerLockElement) return;
      // A gesture that panned and returned near the press point is still a drag, not a click
      // (issue #133): `isClick` alone only compares endpoints, so it would misread this as a miss.
      if (this.dragged || !isClick(this.pressPoint, { x: event.clientX, y: event.clientY })) return;
      const agentId = this.pickAt(event.clientX, event.clientY);
      if (agentId) this.selection.select(agentId);
      else this.selection.clear();
    });
    canvas.addEventListener('wheel', (event) => {
      if (!isViewFromAbove(this.currentMode)) return;
      event.preventDefault();
      this.flight = null;
      this.isometricFlight = null;
      if (this.currentMode === 'isometric') this.isometric.zoom(event.deltaY);
      else this.overview.zoom(event.deltaY);
    }, { passive: false });
  }

  private selectionChanged(agentId: string | null): void {
    const agent = agentId ? this.selectedAgent() : undefined;
    if (!agent) {
      this.marker.hide();
      return;
    }
    this.marker.show(agent.figure.accentColor);
    this.flyToAgent(agent.figure.group.position);
  }

  /**
   * Key F (issue #85 fix): fly to, or recenter on, an agent even when it is
   * already selected (a plain reselect is a no-op in `SelectionState`, so no
   * selection-change listener fires). Does nothing for an agent not in the scene.
   */
  refocus(agentId: string): void {
    const agent = this.options.agents().find((candidate) => candidate.info.id === agentId);
    if (!agent) return;
    this.marker.show(agent.figure.accentColor);
    this.flyToAgent(agent.figure.group.position);
  }

  private selectedAgent(): ManagedAgent | undefined {
    const id = this.selection.selected;
    return id === null ? undefined : this.options.agents().find((agent) => agent.info.id === id);
  }

  private flyToAgent(point: THREE.Vector3): void {
    if (this.currentMode === 'isometric') {
      const from: IsometricState = this.isometric.state();
      this.isometric.focusOn(point);
      this.isometric.pan(this.cardShiftPx() * this.isometric.unitsPerPixel(this.options.canvas.clientHeight), 0);
      this.isometricFlight = new IsometricTween(from, this.isometric.state(), FLIGHT_SECONDS);
      this.isometric.setState(from);
      return;
    }
    const from = this.currentPose();
    if (this.currentMode === 'overview') {
      this.overview.focusOn(point);
      this.overview.pan(this.shiftOnScreen(this.overview.distance), 0);
      this.flyTo(from, this.overview.pose(), true);
      return;
    }
    const lookAt = new THREE.Vector3(point.x, point.y + FIGURE_CHEST, point.z);
    const away = new THREE.Vector3().subVectors(from.position, lookAt);
    away.y = 0;
    if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
    away.normalize();
    // Inside the figure's room: the camera stays on the figure's side of every wall
    const position = focusPosition(lookAt, away, floorUnder(this.options.scene, point), FIRST_PERSON_FOCUS_DISTANCE, FIRST_PERSON_FOCUS_HEIGHT);
    away.set(position.x - lookAt.x, 0, position.z - lookAt.z).normalize();
    // Turn only the aim to the screen right, so the figure shows left of the card.
    // The camera stays where the plain flight puts it: a sideways move could end inside a wall.
    const right = new THREE.Vector3(away.z, 0, -away.x);
    lookAt.addScaledVector(right, this.shiftOnScreen(position.distanceTo(lookAt)));
    this.flyTo(from, { position, lookAt }, true);
  }

  /** Pixels to show a selected figure left of the canvas center, or 0. */
  private cardShiftPx(): number {
    const pixels = this.options.figureShiftPx?.() ?? 0;
    return pixels > 0 && this.options.canvas.clientHeight > 0 ? pixels : 0;
  }

  /** World units at `distance` from the camera for the figure shift in pixels. */
  private shiftOnScreen(distance: number): number {
    const pixels = this.cardShiftPx();
    const height = this.options.canvas.clientHeight;
    if (pixels === 0) return 0;
    const visibleHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.options.camera.fov) / 2);
    return (pixels * visibleHeight) / height;
  }

  private flyTo(from: CameraPose, to: CameraPose, animate: boolean): void {
    if (animate) {
      this.flight = { tween: new PoseTween(from, to, FLIGHT_SECONDS), end: to };
      return;
    }
    this.flight = null;
    this.applyPose(to);
    if (this.currentMode === 'first-person') setFreeCameraLook(this.options.camera, to.position, to.lookAt);
  }

  private currentPose(): CameraPose {
    if (this.currentMode === 'first-person' && !this.flight) return freeCameraLook(this.options.camera);
    const camera = this.options.camera;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const reach = this.currentMode === 'overview' ? this.overview.distance : 5;
    return { position: camera.position.clone(), lookAt: camera.position.clone().addScaledVector(forward, reach) };
  }

  private applyPose(pose: CameraPose): void {
    this.options.camera.position.copy(pose.position);
    this.options.camera.lookAt(pose.lookAt);
  }

  private frameIsometric(): void {
    this.isometric.frame(overviewBounds(this.options.scene), this.aspect());
  }

  /** Put the orthographic camera on the isometric state; it follows the canvas size. */
  private applyIsometric(): void {
    this.isometric.applyTo(this.isometricCamera, this.aspect(), this.options.camera.fov);
  }

  private aspect(): number {
    const { canvas, camera } = this.options;
    return canvas.clientWidth > 0 && canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : camera.aspect;
  }

  private frameOverview(): void {
    const { camera, scene } = this.options;
    const bounds = overviewBounds(scene);
    this.overview.frame(bounds, camera.fov, camera.aspect);
    const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    const far = Math.max(100, this.overview.maxDistance + radius * 2);
    if (far !== camera.far) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  }

  private panWithKeys(delta: number): void {
    let right = 0;
    let forward = 0;
    if (this.panKeys.has('KeyW') || this.panKeys.has('ArrowUp')) forward += 1;
    if (this.panKeys.has('KeyS') || this.panKeys.has('ArrowDown')) forward -= 1;
    if (this.panKeys.has('KeyD') || this.panKeys.has('ArrowRight')) right += 1;
    if (this.panKeys.has('KeyA') || this.panKeys.has('ArrowLeft')) right -= 1;
    if (right === 0 && forward === 0) return;
    const fast = this.panKeys.has('ShiftLeft') || this.panKeys.has('ShiftRight') ? FAST_MULTIPLIER : 1;
    const step = this.zoomDistance * PAN_SPEED_PER_DISTANCE * fast * delta;
    if (this.currentMode === 'isometric') this.isometric.pan(right * step, forward * step);
    else this.overview.pan(right * step, forward * step);
  }

  /** Walls and lamps marked `userData.overviewHidden` would block the overview; hide them there. */
  private hideNearWalls(): void {
    this.hiddenInOverview = [];
    this.options.scene.traverse((object) => {
      if (object.userData.overviewHidden && object.visible) this.hiddenInOverview.push(object);
    });
    for (const object of this.hiddenInOverview) object.visible = false;
  }

  private showNearWalls(): void {
    for (const object of this.hiddenInOverview) object.visible = true;
    this.hiddenInOverview = [];
  }

  private setHint(): void {
    const hint = this.options.hint;
    if (!hint) return;
    hint.textContent = VIEW_HINTS[this.currentMode];
    if (isViewFromAbove(this.currentMode)) hint.style.display = 'block';
  }
}

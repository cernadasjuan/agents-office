import * as THREE from 'three';
import type { ManagedAgent } from '../agents/AgentManager.js';
import { clampToOffice, freeCameraLook, setFreeCameraLook, setPointerLockFilter, updateFreeCamera } from './FreeCamera.js';
import { OverviewController, PoseTween, overviewBounds, type CameraPose } from './OverviewCamera.js';
import { SelectionMarker } from './SelectionMarker.js';
import { isClick, officeSelection, parseViewHash, pickAgent, type ScreenPoint, type SelectionState, type ViewMode } from './Selection.js';

const FLIGHT_SECONDS = 0.6;
const FIRST_PERSON_FOCUS_DISTANCE = 4;
const FIRST_PERSON_FOCUS_HEIGHT = 1.2;
const FIGURE_CHEST = 1.1;
const PAN_SPEED_PER_DISTANCE = 0.9;
const FAST_MULTIPLIER = 2.5;

export const VIEW_HINTS: Record<ViewMode, string> = {
  'first-person': 'Click to look around — WASD to move — Space/Q up/down — Shift = fast — ESC to release — Click a figure to select — O = overview',
  overview: 'Overview — Drag to pan — Wheel to zoom — WASD to pan — Click a figure to select — Esc clears — O = first person',
};

export interface ViewControllerOptions {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  agents: () => ManagedAgent[];
  /** Where key presses arrive (the window). */
  keys: Pick<Window, 'addEventListener'>;
  hint?: HTMLElement | null;
  /** The URL hash: `#view=overview`, `#focus=<agent id>`. */
  hash?: string;
  selection?: SelectionState;
  /** Pixels to show a selected figure left of the canvas center (the agent card covers the right). */
  figureShiftPx?: () => number;
}

function isFormField(target: EventTarget | null): boolean {
  const tag = (target as Element | null)?.tagName;
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
}

/**
 * Owns the camera mode (first person or overview), click to select, the
 * selection ring and the camera flights. First person stays the default.
 */
export class ViewController {
  private currentMode: ViewMode = 'first-person';
  private overview = new OverviewController();
  private flight: { tween: PoseTween; end: CameraPose } | null = null;
  private savedFirstPerson: CameraPose | null = null;
  private hiddenInOverview: THREE.Object3D[] = [];
  private panKeys = new Set<string>();
  private pressPoint: ScreenPoint | null = null;
  private dragPoint: ScreenPoint | null = null;
  private pendingFocus: string | null;
  private marker: SelectionMarker;
  private selection: SelectionState;
  private raycaster = new THREE.Raycaster();

  constructor(private options: ViewControllerOptions) {
    this.selection = options.selection ?? officeSelection();
    this.marker = new SelectionMarker(options.scene);
    const start = parseViewHash(options.hash ?? '');
    this.pendingFocus = start.focus;

    setPointerLockFilter((event) => this.currentMode === 'first-person' && this.pickAt(event.clientX, event.clientY) === null);
    this.listen();
    this.selection.onChange((agentId) => this.selectionChanged(agentId));
    this.setHint();
    if (start.view === 'overview') this.setMode('overview', false);
  }

  get mode(): ViewMode {
    return this.currentMode;
  }

  /** Overview camera distance (the zoom). Label detail reads it. */
  get zoomDistance(): number {
    return this.overview.distance;
  }

  toggleMode(): void {
    this.setMode(this.currentMode === 'overview' ? 'first-person' : 'overview', true);
  }

  setMode(mode: ViewMode, animate: boolean): void {
    if (mode === this.currentMode) return;
    const from = this.currentPose();
    this.currentMode = mode;
    let to: CameraPose;
    if (mode === 'overview') {
      this.savedFirstPerson = from;
      const document = this.options.canvas.ownerDocument;
      if (document.pointerLockElement) document.exitPointerLock?.();
      this.frameOverview();
      this.hideNearWalls();
      to = this.overview.pose();
    } else {
      this.showNearWalls();
      to = this.savedFirstPerson ?? from;
    }
    this.setHint();
    this.flyTo(from, to, animate);
  }

  /** Call after each poll: applies `#focus` once and drops a selection whose agent left. */
  agentsChanged(agents: ManagedAgent[]): void {
    const ids = agents.map((agent) => agent.info.id);
    this.selection.keepOnly(ids);
    if (this.pendingFocus && ids.includes(this.pendingFocus)) {
      const focus = this.pendingFocus;
      this.pendingFocus = null;
      this.selection.select(focus);
    }
  }

  update(elapsed: number, delta: number): void {
    const camera = this.options.camera;
    if (this.flight) {
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

  /** The agent whose figure is under a screen point, or null. */
  pickAt(clientX: number, clientY: number): string | null {
    const rect = this.options.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.options.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.options.camera);
    return pickAgent(this.raycaster, this.options.agents().map((agent) => ({ id: agent.info.id, object: agent.figure.group })));
  }

  private listen(): void {
    const { canvas, keys } = this.options;
    const document = canvas.ownerDocument;

    keys.addEventListener('keydown', (event: KeyboardEvent) => {
      if (isFormField(event.target)) return;
      if (event.code === 'KeyO') this.toggleMode();
      else if (event.code === 'Escape') this.selection.clear();
      else this.panKeys.add(event.code);
    });
    keys.addEventListener('keyup', (event: KeyboardEvent) => this.panKeys.delete(event.code));

    canvas.addEventListener('pointerdown', (event) => {
      this.pressPoint = { x: event.clientX, y: event.clientY };
      this.dragPoint = this.currentMode === 'overview' && event.button === 0 ? { ...this.pressPoint } : null;
    });
    document.addEventListener('pointermove', (event) => {
      if (!this.dragPoint || this.currentMode !== 'overview') return;
      const point = { x: event.clientX, y: event.clientY };
      if (isClick(this.pressPoint, point)) return;
      this.flight = null;
      this.overview.drag(point.x - this.dragPoint.x, point.y - this.dragPoint.y, canvas.clientHeight || 1, this.options.camera.fov);
      this.dragPoint = point;
    });
    document.addEventListener('pointerup', () => {
      this.dragPoint = null;
    });
    canvas.addEventListener('click', (event) => {
      if (document.pointerLockElement) return;
      if (!isClick(this.pressPoint, { x: event.clientX, y: event.clientY })) return;
      const agentId = this.pickAt(event.clientX, event.clientY);
      if (agentId) this.selection.select(agentId);
    });
    canvas.addEventListener('wheel', (event) => {
      if (this.currentMode !== 'overview') return;
      event.preventDefault();
      this.flight = null;
      this.overview.zoom(event.deltaY);
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

  private selectedAgent(): ManagedAgent | undefined {
    const id = this.selection.selected;
    return id === null ? undefined : this.options.agents().find((agent) => agent.info.id === id);
  }

  private flyToAgent(point: THREE.Vector3): void {
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
    const position = lookAt.clone().addScaledVector(away, FIRST_PERSON_FOCUS_DISTANCE);
    position.y += FIRST_PERSON_FOCUS_HEIGHT;
    // Move the camera and its aim to the screen right, so the figure shows left of the card.
    const right = new THREE.Vector3(away.z, 0, -away.x);
    const shift = this.shiftOnScreen(position.distanceTo(lookAt));
    position.addScaledVector(right, shift);
    lookAt.addScaledVector(right, shift);
    clampToOffice(position);
    this.flyTo(from, { position, lookAt }, true);
  }

  /** World units at `distance` from the camera for the figure shift in pixels. */
  private shiftOnScreen(distance: number): number {
    const pixels = this.options.figureShiftPx?.() ?? 0;
    const height = this.options.canvas.clientHeight;
    if (pixels <= 0 || height <= 0) return 0;
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
    const step = this.overview.distance * PAN_SPEED_PER_DISTANCE * fast * delta;
    this.overview.pan(right * step, forward * step);
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
    if (this.currentMode === 'overview') hint.style.display = 'block';
  }
}

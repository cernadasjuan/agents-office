import * as THREE from 'three';
import type { ManagedAgent } from '../agents/AgentManager.js';
import { focusPosition, freeCameraLook, setFreeCameraLook, setPointerLockFilter, updateFreeCamera } from './FreeCamera.js';
import { IsometricController, IsometricTween, framedHalfHeight, zoomTowardCursor as zoomIsometricTowardCursor, type IsometricState } from './IsometricCamera.js';
import { PoseTween, floorUnder, overviewBounds, type CameraPose } from './OverviewCamera.js';
import type { RoomView } from '../layout/LayoutStrategy.js';
import { SelectionMarker } from './SelectionMarker.js';
import { isClick, isViewFromAbove, officeSelection, parseViewHash, pickAgent, type PickTarget, type ScreenPoint, type SelectionState, type ViewMode } from './Selection.js';

const FLIGHT_SECONDS = 0.6;
const FIRST_PERSON_FOCUS_DISTANCE = 4;
const FIRST_PERSON_FOCUS_HEIGHT = 1.2;
const FIGURE_CHEST = 1.1;
const PAN_SPEED_PER_DISTANCE = 0.9;
const FAST_MULTIPLIER = 2.5;

export const VIEW_HINTS: Record<ViewMode, string> = {
  'first-person': 'Click to look around — WASD to move — Space/Q up/down — Shift = fast — ESC to release — Click a figure to select — I = isometric — Shift+L = layout — N = next — F = focus — / = filter',
  isometric: 'Isometric — Drag to pan — Wheel to zoom — WASD to pan — Click a figure to select — Esc clears — I = back — Shift+L = layout — N = next — F = focus — / = filter',
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
  /** The URL hash: `#view=iso`, `#focus=<agent id>`. */
  hash?: string;
  selection?: SelectionState;
  /** The start view. Without it the hash decides (`#view=iso`), else first person. */
  view?: ViewMode;
  /** Called with the start mode and after each mode change (the header, the saved view). */
  modeChanged?: (mode: ViewMode) => void;
  /** Pixels to show a selected figure left of the canvas center (the agent card covers the right). */
  figureShiftPx?: () => number;
  /** `#room=<name>` (issue #89): where the camera should go to show that room, from the active layout. Without it, or for a layout with no rooms, `#room=` does nothing. */
  roomView?: (name: string) => RoomView | null;
}

function isFormField(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || element?.isContentEditable === true;
}

/**
 * Owns the camera mode (first person or isometric), click to select, the
 * selection ring and the camera flights. First person stays the default.
 * The isometric view draws through its own orthographic camera (`activeCamera`).
 */
export class ViewController {
  private currentMode: ViewMode = 'first-person';
  private isometric = new IsometricController();
  private isometricCamera: THREE.OrthographicCamera;
  private flight: { tween: PoseTween; end: CameraPose } | null = null;
  private isometricFlight: IsometricTween | null = null;
  private savedFirstPerson: CameraPose | null = null;
  private hiddenFromAbove: THREE.Object3D[] = [];
  private panKeys = new Set<string>();
  private pressPoint: ScreenPoint | null = null;
  private dragPoint: ScreenPoint | null = null;
  /** True once the current gesture has panned, even if it ends back near the press point (issue #133). */
  private dragged = false;
  private pendingFocus: string | null;
  /**
   * `#zoom=` paired with `#select=`/`#focus=` (issue #89 review, fix round 2): only ever set
   * when the URL also names an agent to select, and only applies to that exact agent's own
   * first flight, never a bare `#zoom=` (that only sets the view's own initial framing,
   * `applyStartZoom` below) and never a different agent `selectionChanged` sees first. A
   * decoy selected before the named agent ever appears gets its own normal framing, not the
   * requested zoom; once any other selection or a click happens, the request is dropped for
   * good, matching `pendingZoomTarget` going stale.
   */
  private pendingStartZoom: number | null;
  /** The one agent id `pendingStartZoom` is reserved for, or null once it no longer applies. */
  private pendingZoomTarget: string | null;
  private marker: SelectionMarker;
  private selection: SelectionState;
  private raycaster = new THREE.Raycaster();

  constructor(private options: ViewControllerOptions) {
    this.selection = options.selection ?? officeSelection();
    this.isometricCamera = options.isometricCamera ?? new THREE.OrthographicCamera();
    this.marker = new SelectionMarker(options.scene);
    const start = parseViewHash(options.hash ?? '');
    this.pendingFocus = start.focus;
    this.pendingZoomTarget = start.focus;
    this.pendingStartZoom = start.focus !== null ? start.zoom : null;

    setPointerLockFilter((event) => this.currentMode === 'first-person' && this.pickAt(event.clientX, event.clientY) === null);
    this.listen();
    this.selection.onChange((agentId) => this.selectionChanged(agentId));
    this.setHint();
    const startView = options.view ?? start.view;
    if (startView !== 'first-person') this.setMode(startView, false);
    else options.modeChanged?.(this.currentMode);
    const room = start.room !== null ? (this.options.roomView?.(start.room) ?? null) : null;
    if (room) this.applyStartRoom(room);
    else if (start.zoom !== null) this.applyStartZoom(start.zoom);
  }

  /** `#zoom=<distance>` (issue #89): starts the view at that camera distance instead of its own default framing. A no-op in first person, which has no zoom. */
  private applyStartZoom(zoomDistance: number): void {
    if (this.currentMode === 'isometric') {
      this.isometric.halfHeight = THREE.MathUtils.clamp(
        zoomDistance * Math.tan(THREE.MathUtils.degToRad(this.options.camera.fov) / 2),
        this.isometric.minHalfHeight,
        this.isometric.maxHalfHeight,
      );
      this.applyIsometric();
    }
  }

  /**
   * `#room=<name>` (issue #89): frames that room instead of the view's own default framing
   * or `#zoom=`, in whichever view is active. The isometric view flies to the room's bounds,
   * using the same pure framing math a selection flight target would (never narrowing the
   * view's own pan/zoom limits, unlike `frame`); first person stands inside the room, facing
   * its main wall. Read-only: it never changes the scene, only the camera.
   */
  private applyStartRoom(room: RoomView): void {
    if (this.currentMode === 'isometric') {
      this.isometric.target.copy(room.bounds.getCenter(new THREE.Vector3()));
      this.isometric.halfHeight = THREE.MathUtils.clamp(
        framedHalfHeight(room.bounds, this.aspect()),
        this.isometric.minHalfHeight,
        this.isometric.maxHalfHeight,
      );
      this.applyIsometric();
    } else {
      this.applyPose(room.standing);
      setFreeCameraLook(this.options.camera, room.standing.position, room.standing.lookAt);
    }
  }

  get mode(): ViewMode {
    return this.currentMode;
  }

  /** The camera that draws now: the orthographic camera in the isometric view, else the perspective camera. */
  get activeCamera(): THREE.Camera {
    return this.currentMode === 'isometric' ? this.isometricCamera : this.options.camera;
  }

  /**
   * The zoom as an overview-equivalent camera distance. Label detail reads
   * it. Meaningless outside the isometric view (nothing reads it then).
   */
  get zoomDistance(): number {
    return this.isometric.equivalentDistance(this.options.camera.fov);
  }

  /** Key I: into the isometric view, and back to first person. */
  toggleIsometric(): void {
    this.setMode(this.currentMode === 'isometric' ? 'first-person' : 'isometric', true);
  }

  setMode(mode: ViewMode, animate: boolean): void {
    if (mode === this.currentMode) return;
    const previous = this.currentMode;
    const from = this.currentPose();
    if (previous === 'first-person') this.savedFirstPerson = from;
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
      if (event.code === 'KeyI') this.toggleIsometric();
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
      this.isometric.drag(dx, dy, canvas.clientHeight || 1);
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
      // Zoom toward the cursor (issue #87, AC1), not toward the room center: the point
      // under the pointer stays under it. Falls back to a plain zoom while the canvas has
      // no on-screen size yet (e.g. a test or a hidden tab), when NDC is undefined.
      const rect = canvas.getBoundingClientRect();
      const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
      if (rect.width === 0 || rect.height === 0) {
        this.isometric.zoom(event.deltaY);
        return;
      }
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      zoomIsometricTowardCursor(this.isometric, ndcX, ndcY, event.deltaY, aspect);
    }, { passive: false });
  }

  private selectionChanged(agentId: string | null): void {
    // Any selection other than the one #select= named drops the pending #zoom= for good
    // (issue #89 review, fix round 2): a decoy selected first must never steal it, and the
    // named agent, once it finally appears, must get its own normal framing instead, not a
    // stale request meant for someone else.
    if (agentId !== this.pendingZoomTarget) {
      this.pendingStartZoom = null;
      this.pendingZoomTarget = null;
    }
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
    // #zoom= paired with #select=/#focus= (issue #89 review): consumed once, so this flight
    // (and only this one) honors the requested zoom instead of focusOn's own fixed distance.
    const startZoom = this.pendingStartZoom;
    this.pendingStartZoom = null;
    this.pendingZoomTarget = null;
    if (this.currentMode === 'isometric') {
      const from: IsometricState = this.isometric.state();
      this.isometric.focusOn(point);
      if (startZoom !== null) {
        this.isometric.halfHeight = THREE.MathUtils.clamp(
          startZoom * Math.tan(THREE.MathUtils.degToRad(this.options.camera.fov) / 2),
          this.isometric.minHalfHeight,
          this.isometric.maxHalfHeight,
        );
      }
      this.isometric.pan(this.cardShiftPx() * this.isometric.unitsPerPixel(this.options.canvas.clientHeight), 0);
      this.isometricFlight = new IsometricTween(from, this.isometric.state(), FLIGHT_SECONDS);
      this.isometric.setState(from);
      return;
    }
    const from = this.currentPose();
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
    return { position: camera.position.clone(), lookAt: camera.position.clone().addScaledVector(forward, 5) };
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
    this.isometric.pan(right * step, forward * step);
  }

  /** Walls and lamps marked `userData.hiddenFromAbove` would block the isometric view; hide them there. */
  private hideNearWalls(): void {
    this.hiddenFromAbove = [];
    this.options.scene.traverse((object) => {
      if (object.userData.hiddenFromAbove && object.visible) this.hiddenFromAbove.push(object);
    });
    for (const object of this.hiddenFromAbove) object.visible = false;
  }

  private showNearWalls(): void {
    for (const object of this.hiddenFromAbove) object.visible = true;
    this.hiddenFromAbove = [];
  }

  private setHint(): void {
    const hint = this.options.hint;
    if (!hint) return;
    hint.textContent = VIEW_HINTS[this.currentMode];
    if (isViewFromAbove(this.currentMode)) hint.style.display = 'block';
  }
}

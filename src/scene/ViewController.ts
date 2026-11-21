import * as THREE from 'three';
import type { ManagedAgent } from '../agents/AgentManager.js';
import { currentEyeHeight, focusPosition, freeCameraLook, setFreeCameraLook, setMovementEnabled, setPointerLockFilter, setWallColliders, updateFreeCamera } from './FreeCamera.js';
import { DIRECT_FOLLOW_RATES, FLIGHT_FOLLOW_RATES, IsometricController, applyIsometricState, followIsometric, framedHalfHeight, zoomTowardCursor as zoomIsometricTowardCursor, type IsometricFollowRates, type IsometricState } from './IsometricCamera.js';
import { PoseTween, floorUnder, overviewBounds, type CameraPose } from './OverviewCamera.js';
import type { RoomView, WallRect } from '../layout/LayoutStrategy.js';
import { SelectionMarker } from './SelectionMarker.js';
import { isClick, isViewFromAbove, officeSelection, parseViewHash, pickAgent, type PickTarget, type ScreenPoint, type SelectionState, type ViewMode } from './Selection.js';

const FLIGHT_SECONDS = 0.6;
const FIRST_PERSON_FOCUS_DISTANCE = 4;
const FIGURE_CHEST = 1.1;
const PAN_SPEED_PER_DISTANCE = 0.9;
const FAST_MULTIPLIER = 2.5;
/** Issue #161: the office settles into the desk view after this long with no camera input. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 120;
/** Issue #252: `checkPendingRoom` gives up quietly past this many `sceneChanged()` checks (one per world poll, `main.ts`'s own `pollWorld`, plus one per agent poll — both call it) — a typo'd or never-opened mission name must not keep paying this check for the rest of the session. */
const PENDING_ROOM_MAX_ATTEMPTS = 50;
/** A ground plane for the isometric double-click room pick (issue #175): where the ray meets `y=0`. */
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
/** Review (defect 2): held, these send no further discrete event, so the idle clock needs its own per-frame check, not just the keydown that started the hold. */
const MOVEMENT_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

export const VIEW_HINTS: Record<ViewMode, string> = {
  'first-person': 'Click to look around — WASD to walk — double-tap W to run — Shift to crouch — Space to jump — ESC to release — Click a figure to select, or the dot once locked — I = isometric — H = desk — Shift+L = layout — N = next — F = focus — / = filter',
  isometric: 'Isometric — Drag to pan — Wheel to zoom — WASD to pan — Click a figure to select — Double-click a room to enter it — Esc clears — I = back — H = desk — Shift+L = layout — N = next — F = focus — / = filter',
  desk: 'Desk — fixed camera, no WASD or mouse-look — Click a figure to select, click elsewhere to clear — H or I to leave — N = next — F = focus — / = filter',
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
  /**
   * Issue #205: the center-screen dot shown only in first person while the pointer is locked.
   * Without it (graceful degradation), nothing is drawn, the same as before the dot existed.
   */
  crosshair?: HTMLElement | null;
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
  /**
   * Issue #161: where the fixed desk-view camera sits, from the active layout. Without it (or
   * a null return), key `H` and the idle timeout do nothing — graceful degradation, there is
   * no desk to show. `fov` (issue #199) is optional: the shared camera's own FOV while desk
   * mode is omitted — a layout, or a test fixture, that leaves it out keeps the old behavior.
   */
  deskView?: () => { position: THREE.Vector3; lookAt: THREE.Vector3; fov?: number } | null;
  /** Issue #175: the room (if any) whose floor contains this world point, for a double-click in the isometric view. Without it, double-click does nothing. */
  roomAt?: (x: number, z: number) => RoomView | null;
  /** Issue #161: seconds of no camera input before the office settles into the desk view. Default 120; tests pass a short one. */
  idleTimeoutSeconds?: number;
  /** Issue #194: every wall in the active layout, as a flat 2D collision list, so first-person ground-walk stops at a wall instead of walking through it. Without it, walls stay unobstructed — the old behavior. */
  wallColliders?: () => WallRect[];
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
  /** The isometric view's goal pose (issue #113 redesign): every input — wheel, drag, cursor zoom, a selection, a bounds retrack — edits this and only this. */
  private isometric = new IsometricController();
  /** The isometric view's live pose: what the camera actually shows. `update()` eases it toward `isometric`'s goal every frame; nothing else ever writes it. */
  private liveIsometric: IsometricState = this.isometric.state();
  /**
   * PR #200 review round: the one knob a goal edit sets, not a tween. Direct manipulation
   * (the wheel, a drag, WASD) sets `DIRECT_FOLLOW_RATES` right before it edits the goal, so the
   * live pose keeps feeling like it is under the pointer. A flight-type change (a selection,
   * `refocus`/F, an off-screen marker click, the `#zoom=`/`#room=` start framing) sets
   * `FLIGHT_FOLLOW_RATES` instead, so it still reads as a flight. Read fresh by `update()` every
   * frame — nothing here is "remembered" past the next input that changes it.
   */
  private isometricFollowRates: IsometricFollowRates = DIRECT_FOLLOW_RATES;
  /** Issue #113: a room added/removed or a window resize invalidates the isometric pan/zoom limits; re-derived lazily in `update()`, not on every tick. */
  private isometricBoundsDirty = true;
  private isometricCamera: THREE.OrthographicCamera;
  private flight: { tween: PoseTween; end: CameraPose } | null = null;
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
  /** Seconds since the last camera input (issue #161); the desk view's idle default. */
  private idleSeconds = 0;
  private idleTimeoutSeconds: number;
  /** Issue #199: the shared camera's own FOV from just before desk mode widened it, restored on the way out. Null outside desk mode, and while a `deskView` never sets `fov` at all (graceful degradation, no lens change). */
  private deskRestoreFov: number | null = null;
  /** Issue #252: a `#room=` target that did not resolve at construction (a mission room, not yet created by the first world poll) — re-checked by `checkPendingRoom` on every `sceneChanged()`, until it resolves or `pendingRoomAttempts` reaches `PENDING_ROOM_MAX_ATTEMPTS`. Null once resolved, given up on, or never requested. */
  private pendingRoomName: string | null = null;
  private pendingRoomAttempts = 0;

  constructor(private options: ViewControllerOptions) {
    this.selection = options.selection ?? officeSelection();
    this.isometricCamera = options.isometricCamera ?? new THREE.OrthographicCamera();
    this.marker = new SelectionMarker(options.scene);
    this.idleTimeoutSeconds = options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
    const start = parseViewHash(options.hash ?? '');
    this.pendingFocus = start.focus;
    this.pendingZoomTarget = start.focus;
    this.pendingStartZoom = start.focus !== null ? start.zoom : null;

    setPointerLockFilter((event) => this.currentMode === 'first-person' && this.pickAt(event.clientX, event.clientY) === null);
    // Issue #113: a resize can change the aspect ratio the isometric pan/zoom limits were framed
    // for; `sceneChanged()` covers a room added or removed, this covers the window shape.
    options.keys.addEventListener('resize', () => this.sceneChanged());
    this.listen();
    this.selection.onChange((agentId) => this.selectionChanged(agentId));
    this.setHint();
    this.updateCrosshair();
    const startView = options.view ?? start.view;
    if (startView !== 'first-person') this.setMode(startView, false);
    // `setMode` no-ops for `desk` without a pose to show (graceful degradation): report the
    // mode actually landed on (first person), which never ran its own `modeChanged` above.
    if (this.currentMode === 'first-person') options.modeChanged?.(this.currentMode);
    if (start.room !== null) {
      const room = this.options.roomView?.(start.room) ?? null;
      if (room) {
        this.applyStartRoom(room, true);
      } else {
        // Issue #252: a mission room never exists this early — `BuildingLayout` builds
        // `office`/`library` synchronously right here at construction, but a mission only
        // appears once the first `/api/world` poll creates it, well after this constructor
        // returns. Keep the name and keep checking (`sceneChanged`, fired after every world
        // poll) instead of treating "not found yet" the same as "not a real room". `#zoom=`
        // still applies meanwhile, same as a genuinely unknown name would get today.
        this.pendingRoomName = start.room;
        if (start.zoom !== null) this.applyStartZoom(start.zoom);
      }
    } else if (start.zoom !== null) {
      this.applyStartZoom(start.zoom);
    }
  }

  /**
   * Issue #252: re-checks a `#room=` target that did not resolve at construction, once per
   * `sceneChanged()` (so, once per world poll — `main.ts`'s own `pollWorld`). Applies a cut,
   * never a flight, once it finally appears: a flight is a transition *from* the view's own
   * default framing (the PR #200 review comment on `applyStartRoom` below), and this one never
   * got a chance to show that framing even for a moment, so there is nothing to fly from.
   * Gives up quietly past `PENDING_ROOM_MAX_ATTEMPTS` checks — a typo'd or never-opened mission
   * name must not keep paying this check for the rest of the session.
   */
  private checkPendingRoom(): void {
    const name = this.pendingRoomName;
    if (name === null) return;
    const room = this.options.roomView?.(name) ?? null;
    if (room) {
      this.pendingRoomName = null;
      this.applyStartRoom(room, false);
      // `sceneChanged()` (which led here) already set `isometricBoundsDirty`, for its own,
      // unrelated reason (any floor content change re-derives the pan/zoom limits). Clear it
      // again: the framing just above IS the freshly computed goal for this room, the same
      // thing `setMode('isometric', ...)` already protects its own fresh framing from — left
      // dirty, the very next `update()` would retrack against the overall scene bounds and
      // immediately clamp this target back, the one tick it is applied.
      this.isometricBoundsDirty = false;
      return;
    }
    this.pendingRoomAttempts++;
    if (this.pendingRoomAttempts >= PENDING_ROOM_MAX_ATTEMPTS) this.pendingRoomName = null;
  }

  /** `#zoom=<distance>` (issue #89): starts the view at that camera distance instead of its own default framing. A no-op in first person, which has no zoom. */
  private applyStartZoom(zoomDistance: number): void {
    if (this.currentMode === 'isometric') {
      this.isometric.halfHeight = THREE.MathUtils.clamp(
        zoomDistance * Math.tan(THREE.MathUtils.degToRad(this.options.camera.fov) / 2),
        this.isometric.minHalfHeight,
        this.isometric.maxHalfHeight,
      );
      // PR #200 review round: a start parameter is a flight from the view's own default
      // framing, not a cut — only the camera-kind change itself (the fresh framing `setMode`
      // just did) is a cut. `update()` reads the rate fresh next frame, so this is enough.
      this.isometricFollowRates = FLIGHT_FOLLOW_RATES;
      this.applyIsometric();
    }
  }

  /**
   * `#room=<name>` (issue #89): frames that room instead of the view's own default framing
   * or `#zoom=`, in whichever view is active. The isometric view flies to the room's bounds,
   * using the same pure framing math a selection flight target would (never narrowing the
   * view's own pan/zoom limits, unlike `frame`); first person stands inside the room, facing
   * its main wall. Read-only: it never changes the scene, only the camera.
   *
   * @param flight True for the cold-start case (the constructor resolved the room right away):
   * a transition from the view's own default framing, same as `applyStartZoom`. False for a
   * `#room=` target resolved later, after waiting on a mission room to appear
   * (`checkPendingRoom`, issue #252): a cut, the same `DIRECT_FOLLOW_RATES` + cancelled flight
   * idiom a drag or a wheel zoom already uses for "respond right now, no easing" — there is no
   * default framing to transition from this time, since none was ever shown.
   */
  private applyStartRoom(room: RoomView, flight: boolean): void {
    if (this.currentMode === 'isometric') {
      this.isometric.target.copy(room.bounds.getCenter(new THREE.Vector3()));
      this.isometric.halfHeight = THREE.MathUtils.clamp(
        framedHalfHeight(room.bounds, this.aspect()),
        this.isometric.minHalfHeight,
        this.isometric.maxHalfHeight,
      );
      if (flight) {
        // PR #200 review round: a start parameter is a flight from the view's own default
        // framing, not a cut — only the camera-kind change itself (the fresh framing `setMode`
        // just did) is a cut. `update()` reads the rate fresh next frame, so this is enough.
        this.isometricFollowRates = FLIGHT_FOLLOW_RATES;
      } else {
        this.flight = null;
        this.isometricFollowRates = DIRECT_FOLLOW_RATES;
      }
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

  /** Key H (issue #161): into the fixed desk view, and back to first person. A no-op without a desk to show (graceful degradation). */
  toggleDesk(): void {
    this.setMode(this.currentMode === 'desk' ? 'first-person' : 'desk', true);
  }

  /**
   * @param explicitPose Issue #175: the exact first-person pose to land at (a double-clicked
   * room's standing pose), instead of the generic "restore the saved first-person pose" a plain
   * mode toggle uses. Ignored for any mode but `first-person`.
   */
  setMode(mode: ViewMode, animate: boolean, explicitPose?: CameraPose): void {
    if (mode === this.currentMode) return;
    // Desk mode needs a pose to go to; without one (no desk yet, or no layout support) this is a no-op (rule 3).
    const deskPose = mode === 'desk' ? this.options.deskView?.() ?? null : null;
    if (mode === 'desk' && !deskPose) return;
    const previous = this.currentMode;
    const from = this.currentPose();
    if (previous === 'first-person') this.savedFirstPerson = from;
    this.currentMode = mode;
    this.idleSeconds = 0;
    // The camera changes kind when the isometric view starts or ends: cut, do not fly. Desk
    // is the one exception (review, defect 3): it is a fresh destination, never a "resume",
    // so it always flies on entry even from isometric — the perspective camera itself never
    // changed kind, only the isometric camera stopped drawing.
    const fly = animate && mode !== 'isometric' && (mode === 'desk' || previous !== 'isometric');
    // Desk mode never engages pointer lock (issue #161 AC): exit it even though desk itself is not "from above".
    if (isViewFromAbove(mode) || mode === 'desk') {
      const document = this.options.canvas.ownerDocument;
      if (document.pointerLockElement) document.exitPointerLock?.();
    }
    if (isViewFromAbove(mode)) {
      if (!isViewFromAbove(previous)) this.hideNearWalls();
    } else {
      this.showNearWalls();
    }
    // Ground-walk (FreeCamera) stays off for the whole time the camera is locked at the desk.
    if (mode === 'desk') setMovementEnabled(false);
    else if (previous === 'desk') setMovementEnabled(true);
    // Issue #199: desk mode widens the shared camera's own FOV, when the active layout supplies
    // one, so the nearest queue row's outer pair clears the frustum; restored on the way out so
    // first person and isometric keep the normal lens (graceful degradation without a `fov`).
    if (mode === 'desk' && deskPose!.fov !== undefined) {
      this.deskRestoreFov = this.options.camera.fov;
      this.options.camera.fov = deskPose!.fov;
      this.options.camera.updateProjectionMatrix();
    } else if (previous === 'desk' && this.deskRestoreFov !== null) {
      this.options.camera.fov = this.deskRestoreFov;
      this.options.camera.updateProjectionMatrix();
      this.deskRestoreFov = null;
    }
    this.setHint();
    this.updateCrosshair();
    if (mode === 'isometric') {
      this.flight = null;
      this.frameIsometric();
      // Entering the isometric view cuts, it never flies (the camera changes kind): the live
      // pose starts exactly on the freshly framed goal, with nothing left for the follower to
      // close on the next tick.
      this.liveIsometric = this.isometric.state();
      this.isometricBoundsDirty = false;
      this.applyIsometric();
    } else if (mode === 'desk') {
      this.flyTo(from, deskPose!, fly);
    } else {
      this.flyTo(from, explicitPose ?? this.savedFirstPerson ?? from, fly);
    }
    this.options.modeChanged?.(mode);
  }

  /**
   * Issue #113: call after the scene's floor content changes (a room added or removed, a
   * floor switch) so the isometric pan/zoom limits catch up. Cheap and idempotent: it only
   * flags the limits dirty, the actual bounds box recomputes once, lazily, in `update()` —
   * not on every poll, and never on a frame where nothing changed.
   */
  sceneChanged(): void {
    this.isometricBoundsDirty = true;
    if (this.pendingRoomName !== null) this.checkPendingRoom();
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
      // Issue #113: bounds retrack only clamps the goal (never the live pose below), so a room
      // change or a resize mid-drag never jumps the camera — the follower just has a new goal
      // to close the gap toward, like any other goal edit.
      if (this.isometricBoundsDirty) {
        this.isometricBoundsDirty = false;
        this.isometric.retrack(overviewBounds(this.options.scene), this.aspect());
      }
      this.panWithKeys(delta);
      this.liveIsometric = followIsometric(this.liveIsometric, this.isometric.state(), delta, this.isometricFollowRates);
      this.applyIsometric();
    } else if (this.flight) {
      const pose = this.flight.tween.advance(delta);
      this.applyPose(pose);
      if (this.flight.tween.done) {
        if (this.currentMode === 'first-person') {
          // Re-read the live eye height on arrival (re-review, round 2), not the one baked in
          // when the flight was built: crouching or standing up during the 0.6 s flight would
          // otherwise leave the landing height stale, popping to the live one a frame later,
          // the same class of bug this round's own fix already closed for the common case.
          this.flight.end.position.y = currentEyeHeight();
          setFreeCameraLook(camera, this.flight.end.position, this.flight.end.lookAt);
        }
        this.flight = null;
      }
    } else if (this.currentMode === 'desk') {
      // Desk mode holds its pose every frame (issue #161): no WASD, and never the module-level
      // mouse-look `updateFreeCamera` always applies even with movement off, so this bypasses
      // it entirely instead of calling it with movement disabled.
      const pose = this.options.deskView?.();
      if (pose) this.applyPose(pose);
    } else {
      // Issue #194: the live wall list, every frame — a room grows (a new rented room, a new
      // war room) over the life of the session, so a list captured once at construction would
      // miss any wall added after it. Cheap: a flat array the layout already keeps, not a
      // scene walk.
      setWallColliders(this.options.wallColliders?.() ?? []);
      updateFreeCamera(camera, delta);
    }

    // Idle default (issue #161): any camera input resets this in `listen()`; without one for
    // long enough, settle into the desk view. Review (defect 2): a held movement key or an
    // active pointer lock sends no further discrete event once it starts, so both count as
    // ongoing activity every frame here too, not just on the event that started them — the
    // clock only starts running again once the key is released or the lock exits (checked
    // fresh each frame, so "on release" needs no separate listener). A no-op while already in
    // desk mode, and a no-op without a desk to show (`setMode` itself degrades gracefully).
    if (this.isContinuouslyActive()) this.idleSeconds = 0;
    else this.idleSeconds += delta;
    if (this.idleSeconds >= this.idleTimeoutSeconds && this.currentMode !== 'desk') this.setMode('desk', true);

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

  /**
   * Issue #205: the same pick `pickAt` does, from the canvas's own center instead of a
   * screen point — what the crosshair dot sits over. A locked click reads this, never the
   * cursor position (hidden by the lock, and meaningless as "look around" moves it every
   * frame). Null with no on-screen canvas size yet (a test, a hidden tab), same as `pickAt`.
   */
  private pickAtCenter(): string | null {
    const rect = this.options.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return this.pickAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /** Any camera input resets the desk view's idle timer (issue #161). */
  private markActive(): void {
    this.idleSeconds = 0;
  }

  /** Review (defect 2): a held movement key or an engaged pointer lock, checked fresh every frame. */
  private isContinuouslyActive(): boolean {
    const { canvas } = this.options;
    if (canvas.ownerDocument.pointerLockElement === canvas) return true;
    return MOVEMENT_KEYS.some((code) => this.panKeys.has(code));
  }

  private listen(): void {
    const { canvas, keys } = this.options;
    const document = canvas.ownerDocument;

    keys.addEventListener('keydown', (event: KeyboardEvent) => {
      // Review (defect 1): typing in the triage filter is still camera input for the idle
      // clock, even though the filter keeps the key itself from reaching I/H/Esc/panKeys below.
      this.markActive();
      if (isFormField(event.target)) return;
      if (event.code === 'KeyI') this.toggleIsometric();
      else if (event.code === 'KeyH') this.toggleDesk();
      else if (event.code === 'Escape') this.selection.clear();
      else this.panKeys.add(event.code);
    });
    keys.addEventListener('keyup', (event: KeyboardEvent) => this.panKeys.delete(event.code));

    // Issue #205: the lock itself (engaged or released by `FreeCamera`'s own click listener,
    // or force-exited by `setMode` entering isometric/desk) is the other half of whether the
    // dot shows — `setMode` above covers a mode change with the lock state unchanged.
    document.addEventListener('pointerlockchange', () => this.updateCrosshair());

    canvas.addEventListener('pointerdown', (event) => {
      this.markActive();
      this.pressPoint = { x: event.clientX, y: event.clientY };
      this.dragPoint = isViewFromAbove(this.currentMode) && event.button === 0 ? { ...this.pressPoint } : null;
      this.dragged = false;
    });
    document.addEventListener('pointermove', (event) => {
      if (document.pointerLockElement === canvas) this.markActive(); // first-person look
      if (!this.dragPoint || !isViewFromAbove(this.currentMode)) return;
      this.markActive();
      const point = { x: event.clientX, y: event.clientY };
      if (isClick(this.pressPoint, point)) return;
      this.dragged = true;
      this.flight = null;
      // PR #200 review round: a drag is direct manipulation, not a flight — responsive even
      // mid-correction, even right after a flight-type change (a selection, a start parameter).
      this.isometricFollowRates = DIRECT_FOLLOW_RATES;
      const dx = point.x - this.dragPoint.x;
      const dy = point.y - this.dragPoint.y;
      this.isometric.drag(dx, dy, canvas.clientHeight || 1);
      this.dragPoint = point;
    });
    document.addEventListener('pointerup', () => {
      this.dragPoint = null;
    });
    canvas.addEventListener('click', (event) => {
      // A locked click is "look around" (issue #133) turned into a second job (issue #205):
      // select whatever is under the center dot, since the cursor itself is hidden and pinned
      // to the canvas center anyway. Never leaves the lock and never presses Esc for the
      // caller. A miss keeps the pre-#205 behavior exactly: it only looks around, no deselect
      // (deselecting on every miss would fight the common case of looking past the agent you
      // already have selected to aim a run, not to drop its card).
      if (document.pointerLockElement) {
        if (this.currentMode !== 'first-person') return;
        const agentId = this.pickAtCenter();
        if (agentId) this.selection.select(agentId);
        return;
      }
      // A gesture that panned and returned near the press point is still a drag, not a click
      // (issue #133): `isClick` alone only compares endpoints, so it would misread this as a miss.
      if (this.dragged || !isClick(this.pressPoint, { x: event.clientX, y: event.clientY })) return;
      // Desk mode (issue #161, Finding J): a ground click (a miss below) only clears the
      // selection, exactly like first person already does — it never engages pointer lock
      // (the filter above already guards that) and never switches view.
      const agentId = this.pickAt(event.clientX, event.clientY);
      if (agentId) this.selection.select(agentId);
      else this.selection.clear();
    });
    canvas.addEventListener('dblclick', (event) => {
      // Issue #175: double-click a room in the isometric view to enter it in first person,
      // at the standing pose `#room=` already uses. No-op in any other view, over no room, or
      // without a layout that supports `roomAt` (graceful degradation).
      if (this.currentMode !== 'isometric') return;
      const room = this.roomUnderPoint(event.clientX, event.clientY);
      if (!room) return;
      this.markActive();
      this.setMode('first-person', false, room.standing);
    });
    canvas.addEventListener('wheel', (event) => {
      if (!isViewFromAbove(this.currentMode)) return;
      this.markActive();
      event.preventDefault();
      this.flight = null;
      // PR #200 review round: the wheel is direct manipulation, not a flight.
      this.isometricFollowRates = DIRECT_FOLLOW_RATES;
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

  /** Issue #175: the room (if any) under a screen point in the isometric view, via a ground-plane raycast. */
  private roomUnderPoint(clientX: number, clientY: number): RoomView | null {
    const rect = this.options.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const camera = this.activeCamera;
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, camera);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(GROUND_PLANE, point)) return null;
    return this.options.roomAt?.(point.x, point.z) ?? null;
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
    // Desk mode locks the camera in place (issue #161): the ring and the card still follow
    // the selection, the camera itself never flies there.
    if (this.currentMode !== 'desk') this.flyToAgent(agent.figure.group.position);
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
    if (this.currentMode !== 'desk') this.flyToAgent(agent.figure.group.position);
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
      // Issue #113 redesign: a selection just edits the goal, the same as a wheel tick or a
      // drag. The follower in `update()` eases the live pose there; there is no flight object
      // to build, so a second selection before the first one arrives simply moves the goal
      // again, with nothing stale left over from the first. PR #200 review round: a selection
      // (also reached from `refocus`/F and an off-screen marker click) is a flight-type
      // change, not direct manipulation — the slower rate, so it still reads as a flight.
      this.isometricFollowRates = FLIGHT_FOLLOW_RATES;
      this.isometric.focusOn(point);
      if (startZoom !== null) {
        this.isometric.halfHeight = THREE.MathUtils.clamp(
          startZoom * Math.tan(THREE.MathUtils.degToRad(this.options.camera.fov) / 2),
          this.isometric.minHalfHeight,
          this.isometric.maxHalfHeight,
        );
      }
      this.isometric.pan(this.cardShiftPx() * this.isometric.unitsPerPixel(this.options.canvas.clientHeight), 0);
      return;
    }
    const from = this.currentPose();
    const lookAt = new THREE.Vector3(point.x, point.y + FIGURE_CHEST, point.z);
    const away = new THREE.Vector3().subVectors(from.position, lookAt);
    away.y = 0;
    if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
    away.normalize();
    // Inside the figure's room: the camera stays on the figure's side of every wall. The
    // height lands exactly at ground-walk's own eye height (issue #174/#185 review): a fixed
    // offset above the figure's chest used to pop down to the standing height one frame after
    // the flight landed, since ground-walk forces that height on every later frame regardless.
    const position = focusPosition(lookAt, away, floorUnder(this.options.scene, point), FIRST_PERSON_FOCUS_DISTANCE, currentEyeHeight() - lookAt.y);
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

  /**
   * Put the orthographic camera on the isometric view's live pose; it follows the canvas size.
   * The far plane follows the max of the live and the goal distance (issue #113 redesign,
   * review defect 4): whichever is farther decides, so a camera mid-chase toward a closer goal
   * never clips the building it is still passing, and a goal that just moved farther away
   * never clips it either before the live pose catches up.
   */
  private applyIsometric(): void {
    const goalDistance = this.isometric.equivalentDistance(this.options.camera.fov);
    applyIsometricState(this.liveIsometric, this.isometric.reach, this.isometricCamera, this.aspect(), this.options.camera.fov, goalDistance);
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
    // PR #200 review round: WASD is direct manipulation, not a flight.
    this.isometricFollowRates = DIRECT_FOLLOW_RATES;
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
    // Isometric and desk never engage pointer lock, so the lock's own show/hide never runs for
    // them (`FreeCamera`'s `pointerlockchange` listener); show the hint outright instead.
    if (this.currentMode !== 'first-person') hint.style.display = 'block';
  }

  /**
   * Issue #205: shown only while first person is both the active mode and the pointer is
   * locked — hidden the rest of the time (isometric, desk, or first person with the mouse
   * cursor free), without its own option at all (graceful degradation, no dot drawn).
   */
  private updateCrosshair(): void {
    const dot = this.options.crosshair;
    if (!dot) return;
    const canvas = this.options.canvas;
    const locked = canvas.ownerDocument.pointerLockElement === canvas;
    dot.style.display = this.currentMode === 'first-person' && locked ? 'block' : 'none';
  }
}

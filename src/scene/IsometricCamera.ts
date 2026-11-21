import * as THREE from 'three';

/** The classic isometric angle: about 35.26 degrees above the floor. */
export const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);
/** At 45 degrees to both wall axes, from the front-left like the overview. */
export const ISO_AZIMUTH = THREE.MathUtils.degToRad(-45);
const FRAME_MARGIN = 1.04;
/** A box of zero height still gets a usable frame: issue #89's room framing passes a floor-to-wall box this tall at minimum. */
export const MIN_FRAME_HEIGHT = 2;
const MAX_ZOOM_OUT = 1.5;
/** Half the visible height when zoomed on a selected figure (the overview's 12-unit focus at 60 degrees). */
export const ISO_FOCUS_HALF_HEIGHT = 7;
const MIN_HALF_HEIGHT = 1.5;
const WHEEL_ZOOM_RATE = 0.0015;

/**
 * The follower's own step speed (issue #113 redesign): `pan` in world units per second per
 * unit of `halfHeight` (the zoom) at the moment of the step, `zoom` as a fraction of
 * `halfHeight` closed per second. Panning at a wide zoom covers more visible ground than the
 * same speed at a tight one, the same scaling `panWithKeys` already used for its own speed, so
 * the catch-up always reads at the same relative pace.
 */
export interface IsometricFollowRates {
  pan: number;
  zoom: number;
}

/** Direct manipulation (the wheel, a drag, WASD): the live pose should feel like it is under the pointer, not chasing it. */
export const DIRECT_FOLLOW_RATES: IsometricFollowRates = { pan: 7, zoom: 4.5 };
/**
 * A flight-type goal change (a selection, `refocus`/F, an off-screen marker click, the
 * `#room=`/`#zoom=` start framing): PR #200 review round — the direct rates above settled a
 * selection flight in about 0.12 s, which read like a jump; earlier rounds required visible
 * easing. Slower, so a flight still reads as a flight (about 0.5-0.7 s at a typical office
 * distance), while the rates above keep the wheel, a drag and WASD exactly as responsive.
 */
export const FLIGHT_FOLLOW_RATES: IsometricFollowRates = { pan: 1.1, zoom: 0.85 };
/** The floor under the pan/zoom speed's own `halfHeight` reference, so a tight focus zoom never stalls the follower to a crawl. */
const MIN_FOLLOW_REFERENCE = 5;

/** Unit vector from the looked-at point toward the isometric camera. */
export function isometricDirection(): THREE.Vector3 {
  return new THREE.Vector3(
    Math.cos(ISO_ELEVATION) * Math.sin(ISO_AZIMUTH),
    Math.sin(ISO_ELEVATION),
    Math.cos(ISO_ELEVATION) * Math.cos(ISO_AZIMUTH),
  );
}

/** Screen right and screen up of the isometric view, in world space. */
function screenAxes(): { back: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 } {
  const back = isometricDirection();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), back).normalize();
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  return { back, right, up };
}

/**
 * The half height that keeps every corner of `box` on screen, centered on `box`. Pure,
 * exported so a caller can frame a box without moving the live controller's own pan/zoom
 * limits (issue #89, `#room=`: a room's own bounds use this directly, instead of `frame`,
 * which would also narrow the whole view's limits to just that room).
 */
export function framedHalfHeight(box: THREE.Box3, aspect: number): number {
  const center = box.getCenter(new THREE.Vector3());
  const { right, up } = screenAxes();
  let halfWidth = 0;
  let halfHeight = 0;
  const offset = new THREE.Vector3();
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        offset.set(x, y, z).sub(center);
        halfWidth = Math.max(halfWidth, Math.abs(offset.dot(right)));
        halfHeight = Math.max(halfHeight, Math.abs(offset.dot(up)));
      }
    }
  }
  return Math.max(halfHeight, halfWidth / Math.max(aspect, 1e-6), MIN_HALF_HEIGHT) * FRAME_MARGIN;
}

/** What the isometric camera shows: a point on the floor and half the visible height (the zoom). */
export interface IsometricState {
  target: THREE.Vector3;
  halfHeight: number;
}

/**
 * Camera state of the isometric view: an orthographic camera at a fixed angle.
 * The zoom is the visible half height. Distance rules (labels, signs, animation
 * sleep) read `equivalentDistance`: the overview distance with the same screen size.
 */
export class IsometricController {
  target = new THREE.Vector3();
  halfHeight = 20;
  minHalfHeight = MIN_HALF_HEIGHT;
  maxHalfHeight = 30;
  /** How far the near/far planes reach past the framed bounds; read by `applyIsometricState` so the far plane always covers them. */
  reach = 40;
  private bounds = new THREE.Box3(new THREE.Vector3(-15, 0, -13), new THREE.Vector3(15, 0, 13));
  /**
   * Issue #242 review: a point an explicit room flight (`#room=`, a room double-click) just
   * framed, outside the default overview bounds (the hex structure, built deliberately clear
   * of the rect building so it never widens the overview's own default zoom — see
   * `HexRooms.ts`). `retrack()` (fired by any scene change: a room added, a resize) must not
   * snap the goal back past this point, or a flight to a room outside the default bounds would
   * work for exactly one frame and then silently revert. Cleared by the next direct pan or
   * zoom (`clearPin`): once the user is driving the camera themselves, the normal bounds clamp
   * applies again, same as before this existed.
   */
  private pinnedTarget: THREE.Vector3 | null = null;

  /** Center the box and zoom so that every corner is on screen: the one-shot framing a fresh entry into the view uses. */
  frame(bounds: THREE.Box3, aspect: number): void {
    const box = bounds.clone();
    box.max.y = Math.max(box.max.y, box.min.y + MIN_FRAME_HEIGHT);
    this.target.copy(box.getCenter(new THREE.Vector3()));
    this.halfHeight = framedHalfHeight(box, aspect);
    this.applyBounds(box, aspect);
  }

  /** Keeps `retrack()`'s clamp from snapping `target` back past this point (issue #242 review). */
  pinTarget(point: THREE.Vector3): void {
    this.pinnedTarget = point.clone();
  }

  /** Any direct pan or zoom un-pins: the normal bounds clamp resumes (issue #242 review). */
  clearPin(): void {
    this.pinnedTarget = null;
  }

  /**
   * Issue #113: re-derive the pan/zoom limits for new bounds or a new aspect (a room added or
   * removed, a window resize), without moving `target`/`halfHeight` unless the current goal now
   * falls outside the new limits. Only the goal is clamped here — the live camera the follower
   * is chasing is never touched directly, so a bounds change alone never jumps it; the follower
   * simply eases toward wherever the reclamped goal now sits.
   *
   * The default clamp box is untouched by a pin (issue #242 review): `maxHalfHeight` and
   * `reach` still derive from `bounds` alone, so the default zoom-out limit for ordinary
   * panning/zooming never changes. Only the position clamp widens, and only enough to keep
   * the pinned point inside — `expandByPoint`, not a union with some other room's whole box.
   */
  retrack(bounds: THREE.Box3, aspect: number): void {
    const box = bounds.clone();
    box.max.y = Math.max(box.max.y, box.min.y + MIN_FRAME_HEIGHT);
    this.applyBounds(box, aspect);
    this.halfHeight = THREE.MathUtils.clamp(this.halfHeight, this.minHalfHeight, this.maxHalfHeight);
    const clampBox = this.pinnedTarget ? this.bounds.clone().expandByPoint(this.pinnedTarget) : this.bounds;
    this.target.x = THREE.MathUtils.clamp(this.target.x, clampBox.min.x, clampBox.max.x);
    this.target.z = THREE.MathUtils.clamp(this.target.z, clampBox.min.z, clampBox.max.z);
  }

  private applyBounds(box: THREE.Box3, aspect: number): void {
    this.maxHalfHeight = framedHalfHeight(box, aspect) * MAX_ZOOM_OUT;
    this.bounds = box.clone();
    this.reach = box.getBoundingSphere(new THREE.Sphere()).radius * 2 + 10;
  }

  zoom(wheelDelta: number): void {
    this.halfHeight = THREE.MathUtils.clamp(this.halfHeight * Math.exp(wheelDelta * WHEEL_ZOOM_RATE), this.minHalfHeight, this.maxHalfHeight);
  }

  /** Move the floor with the pointer: the floor point under it follows a drag in pixels. */
  drag(dxPixels: number, dyPixels: number, viewportHeight: number): void {
    const unitsPerPixel = (2 * this.halfHeight) / Math.max(viewportHeight, 1);
    // A floor step forward shows sin(elevation) as long on screen
    this.pan(-dxPixels * unitsPerPixel, (dyPixels * unitsPerPixel) / Math.sin(ISO_ELEVATION));
  }

  /** Move the target on the floor, in units to the screen right and screen forward. */
  pan(right: number, forward: number): void {
    const back = isometricDirection();
    const forwardOnFloor = new THREE.Vector3(-back.x, 0, -back.z).normalize();
    const rightOnFloor = new THREE.Vector3(-forwardOnFloor.z, 0, forwardOnFloor.x);
    this.target.addScaledVector(rightOnFloor, right).addScaledVector(forwardOnFloor, forward);
    this.target.x = THREE.MathUtils.clamp(this.target.x, this.bounds.min.x, this.bounds.max.x);
    this.target.z = THREE.MathUtils.clamp(this.target.z, this.bounds.min.z, this.bounds.max.z);
  }

  /** Move the target by a world-space offset on the floor (x, z), clamped like `pan`. */
  shiftTarget(dx: number, dz: number): void {
    this.target.x = THREE.MathUtils.clamp(this.target.x + dx, this.bounds.min.x, this.bounds.max.x);
    this.target.z = THREE.MathUtils.clamp(this.target.z + dz, this.bounds.min.z, this.bounds.max.z);
  }

  focusOn(point: THREE.Vector3): void {
    this.target.set(point.x, 0, point.z);
    this.halfHeight = Math.min(this.halfHeight, ISO_FOCUS_HALF_HEIGHT);
  }

  /** World units per screen pixel at the current zoom. */
  unitsPerPixel(viewportHeight: number): number {
    return (2 * this.halfHeight) / Math.max(viewportHeight, 1);
  }

  /** The perspective camera distance (vertical field of view `fovDeg`) that shows things at the same screen size. */
  equivalentDistance(fovDeg: number): number {
    return distanceForHalfHeight(this.halfHeight, fovDeg);
  }

  state(): IsometricState {
    return { target: this.target.clone(), halfHeight: this.halfHeight };
  }

  /**
   * Put an orthographic camera on this state. It stands at the equivalent
   * distance, so distance rules read like the overview; its near plane lies
   * behind it, so nothing in the building is clipped at any zoom.
   */
  applyTo(camera: THREE.OrthographicCamera, aspect: number, fovDeg: number): void {
    applyIsometricState(this.state(), this.reach, camera, aspect, fovDeg);
  }
}

/**
 * Where the isometric camera's ray through a screen point (NDC, -1 to 1) meets
 * the floor (y = 0). Pure: built from the state alone, no camera object, no
 * scene. The rays are parallel (orthographic), so the origin is any point on
 * the ray — the point on the image plane through `target`.
 */
export function floorPointUnderCursor(target: THREE.Vector3, halfHeight: number, aspect: number, ndcX: number, ndcY: number): THREE.Vector3 {
  const { back, right, up } = screenAxes();
  const halfWidth = halfHeight * aspect;
  const origin = target.clone().addScaledVector(right, ndcX * halfWidth).addScaledVector(up, ndcY * halfHeight);
  const direction = back.clone().negate();
  if (Math.abs(direction.y) < 1e-9) return origin;
  const t = -origin.y / direction.y;
  return origin.addScaledVector(direction, t);
}

/**
 * Zooms the isometric view, then shifts the target so the floor point that
 * was under the cursor (NDC, -1 to 1) stays there (issue #87, AC1). Exact for
 * the same reason as the overview's `zoomTowardCursor`: the view axes are
 * fixed, so a target shift moves the floor intersection by the same amount.
 */
export function zoomTowardCursor(view: IsometricController, ndcX: number, ndcY: number, wheelDelta: number, aspect: number): void {
  const before = floorPointUnderCursor(view.target, view.halfHeight, aspect, ndcX, ndcY);
  view.zoom(wheelDelta);
  const after = floorPointUnderCursor(view.target, view.halfHeight, aspect, ndcX, ndcY);
  view.shiftTarget(before.x - after.x, before.z - after.z);
}

/**
 * Move a value toward `to` by at most `maxStep`, landing exactly on it once within reach
 * (issue #113 redesign). No elapsed time, no start pose: recomputed fresh from the current
 * live and goal values alone, so retargeting the goal mid-chase (another wheel tick, a second
 * bounds shrink) never leaves a stale tween to jump out of — there is no tween to go stale.
 */
function stepScalar(from: number, to: number, maxStep: number): number {
  const diff = to - from;
  return Math.abs(diff) <= maxStep ? to : from + Math.sign(diff) * maxStep;
}

function stepVector(from: THREE.Vector3, to: THREE.Vector3, maxStep: number): THREE.Vector3 {
  const offset = to.clone().sub(from);
  const distance = offset.length();
  return distance <= maxStep || distance < 1e-9 ? to.clone() : from.clone().addScaledVector(offset, maxStep / distance);
}

/**
 * The one damped follower (issue #113 redesign): moves `live` toward `goal` by a step capped
 * to a fixed world speed (pan) and a fixed fraction of the current zoom (halfHeight) per
 * second, frame-rate independent. Every input — the wheel, a cursor-anchored zoom, a drag, a
 * selection, a bounds clamp — edits only the goal (`IsometricController`'s own target and
 * halfHeight); this is the only place that ever moves the live pose, and it never restarts or
 * cancels: called again next frame, it just keeps closing whatever gap remains. `rates`
 * (review round, PR #200) is the one knob the caller sets per goal change, not a tween: direct
 * manipulation and a flight-type change just pick a different `IsometricFollowRates`, the step
 * math itself never changes shape.
 */
export function followIsometric(live: IsometricState, goal: IsometricState, delta: number, rates: IsometricFollowRates = DIRECT_FOLLOW_RATES): IsometricState {
  const reference = Math.max(live.halfHeight, goal.halfHeight, MIN_FOLLOW_REFERENCE);
  return {
    target: stepVector(live.target, goal.target, rates.pan * reference * delta),
    halfHeight: stepScalar(live.halfHeight, goal.halfHeight, rates.zoom * reference * delta),
  };
}

/** True once a follower step has closed the gap: the live pose equals the goal, nothing left to chase. */
export function isometricAtRest(live: IsometricState, goal: IsometricState): boolean {
  return live.target.equals(goal.target) && live.halfHeight === goal.halfHeight;
}

/**
 * Put an orthographic camera on a live pose. Distance rules (labels, signs, animation sleep)
 * read `IsometricController.equivalentDistance`, which is always the GOAL's own distance, not
 * the live one chasing it — those thresholds should react to what the camera is headed toward,
 * not lag a frame behind it. The far plane is the one thing both states share: it follows
 * `goalDistance` (issue #113 redesign review, defect 4) so a correction never clips the
 * building while the live camera is still mid-chase toward a goal that is itself closer.
 */
export function applyIsometricState(
  live: IsometricState,
  reach: number,
  camera: THREE.OrthographicCamera,
  aspect: number,
  fovDeg: number,
  goalDistance: number = Number.NEGATIVE_INFINITY,
): void {
  const standoff = distanceForHalfHeight(live.halfHeight, fovDeg);
  camera.position.copy(live.target).addScaledVector(isometricDirection(), standoff);
  camera.up.set(0, 1, 0);
  camera.lookAt(live.target);
  const halfWidth = live.halfHeight * aspect;
  const near = -reach;
  const far = Math.max(standoff, goalDistance) + reach;
  if (camera.top === live.halfHeight && camera.right === halfWidth && camera.near === near && camera.far === far && camera.zoom === 1) return;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = live.halfHeight;
  camera.bottom = -live.halfHeight;
  camera.near = near;
  camera.far = far;
  camera.zoom = 1;
  camera.updateProjectionMatrix();
}

/** The perspective camera distance (vertical field of view `fovDeg`) that shows a given half height at the same screen size. */
export function distanceForHalfHeight(halfHeight: number, fovDeg: number): number {
  return halfHeight / Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
}

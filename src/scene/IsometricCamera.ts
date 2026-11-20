import * as THREE from 'three';
import { easeInOutCubic } from './OverviewCamera.js';

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
  private bounds = new THREE.Box3(new THREE.Vector3(-15, 0, -13), new THREE.Vector3(15, 0, 13));
  private reach = 40;

  /** Center the box and zoom so that every corner is on screen. */
  frame(bounds: THREE.Box3, aspect: number): void {
    const box = bounds.clone();
    box.max.y = Math.max(box.max.y, box.min.y + MIN_FRAME_HEIGHT);
    this.target.copy(box.getCenter(new THREE.Vector3()));
    this.halfHeight = framedHalfHeight(box, aspect);
    this.maxHalfHeight = this.halfHeight * MAX_ZOOM_OUT;
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
    return this.halfHeight / Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  }

  state(): IsometricState {
    return { target: this.target.clone(), halfHeight: this.halfHeight };
  }

  setState(state: IsometricState): void {
    this.target.copy(state.target);
    this.halfHeight = state.halfHeight;
  }

  /**
   * Put an orthographic camera on this state. It stands at the equivalent
   * distance, so distance rules read like the overview; its near plane lies
   * behind it, so nothing in the building is clipped at any zoom.
   */
  applyTo(camera: THREE.OrthographicCamera, aspect: number, fovDeg: number): void {
    const standoff = this.equivalentDistance(fovDeg);
    camera.position.copy(this.target).addScaledVector(isometricDirection(), standoff);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.target);
    const halfWidth = this.halfHeight * aspect;
    const near = -this.reach;
    const far = standoff + this.reach;
    if (camera.top === this.halfHeight && camera.right === halfWidth && camera.near === near && camera.far === far && camera.zoom === 1) return;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = this.halfHeight;
    camera.bottom = -this.halfHeight;
    camera.near = near;
    camera.far = far;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
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

/** A flight of the isometric camera: target and zoom ease together. */
export class IsometricTween {
  private elapsed = 0;

  constructor(private from: IsometricState, private to: IsometricState, private duration = 0.6) {}

  get done(): boolean {
    return this.elapsed >= this.duration;
  }

  advance(delta: number): IsometricState {
    this.elapsed = Math.min(this.duration, this.elapsed + delta);
    const t = easeInOutCubic(this.duration > 0 ? this.elapsed / this.duration : 1);
    return {
      target: this.from.target.clone().lerp(this.to.target, t),
      halfHeight: THREE.MathUtils.lerp(this.from.halfHeight, this.to.halfHeight, t),
    };
  }
}

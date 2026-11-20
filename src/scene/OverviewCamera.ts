import * as THREE from 'three';
import { OFFICE } from '../utils/Constants.js';

/** Overview angle: 52 degrees above the floor, from the front-left corner like the start view. */
const ELEVATION = THREE.MathUtils.degToRad(52);
const AZIMUTH = THREE.MathUtils.degToRad(-35);
const FRAME_MARGIN = 1.04;
const MIN_FRAME_HEIGHT = 2; // keep standing figures inside the frame of a flat floor
const MAX_ZOOM_OUT = 1.5;
const FOCUS_DISTANCE = 12;
const WHEEL_ZOOM_RATE = 0.0015;

export interface CameraPose {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

export interface OverviewFrame {
  target: THREE.Vector3;
  distance: number;
}

/** Unit vector from the looked-at point toward the overview camera. */
export function overviewDirection(): THREE.Vector3 {
  return new THREE.Vector3(
    Math.cos(ELEVATION) * Math.sin(AZIMUTH),
    Math.sin(ELEVATION),
    Math.cos(ELEVATION) * Math.cos(AZIMUTH),
  );
}

/**
 * Target and distance so that every corner of the box is inside the view.
 * For each corner, the camera must be far enough that the corner fits both
 * the horizontal and the vertical half angle.
 */
export function frameForBounds(bounds: THREE.Box3, fovDeg: number, aspect: number): OverviewFrame {
  const box = bounds.clone();
  box.max.y = Math.max(box.max.y, box.min.y + MIN_FRAME_HEIGHT);
  const target = box.getCenter(new THREE.Vector3());

  const back = overviewDirection();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), back).normalize();
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const tanH = tanV * aspect;

  let distance = 1;
  const offset = new THREE.Vector3();
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        offset.set(x, y, z).sub(target);
        const toward = offset.dot(back);
        distance = Math.max(
          distance,
          toward + Math.abs(offset.dot(right)) / tanH,
          toward + Math.abs(offset.dot(up)) / tanV,
        );
      }
    }
  }
  return { target, distance: distance * FRAME_MARGIN };
}

/**
 * Where the overview camera's ray through a screen point (NDC, -1 to 1) meets the
 * floor (y = 0). Pure: built from the pose alone, no camera object, no scene.
 */
export function floorPointUnderCursor(target: THREE.Vector3, distance: number, fovDeg: number, aspect: number, ndcX: number, ndcY: number): THREE.Vector3 {
  const back = overviewDirection();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), back).normalize();
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  const position = target.clone().addScaledVector(back, distance);
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const tanH = tanV * aspect;
  const direction = back.clone().negate().addScaledVector(right, ndcX * tanH).addScaledVector(up, ndcY * tanV);
  if (Math.abs(direction.y) < 1e-9) return position;
  const t = -position.y / direction.y;
  return position.addScaledVector(direction, t);
}

/**
 * Zooms the overview, then shifts the target so the floor point that was under
 * the cursor (NDC, -1 to 1) stays there — the wheel zooms where you point
 * (issue #87, AC1), not toward the room center. Exact: the camera's forward and
 * up axes do not change with distance, so the floor intersection shifts by
 * exactly the target's own shift (see the derivation in the PR description).
 */
export function zoomTowardCursor(view: OverviewController, ndcX: number, ndcY: number, wheelDelta: number, fovDeg: number, aspect: number): void {
  const before = floorPointUnderCursor(view.target, view.distance, fovDeg, aspect, ndcX, ndcY);
  view.zoom(wheelDelta);
  const after = floorPointUnderCursor(view.target, view.distance, fovDeg, aspect, ndcX, ndcY);
  view.shiftTarget(before.x - after.x, before.z - after.z);
}

let explicitBounds: THREE.Box3 | null = null;

/** Let a layout say what the overview must show. Null goes back to the floor objects. */
export function setOverviewBounds(box: THREE.Box3 | null): void {
  explicitBounds = box ? box.clone() : null;
}

/** The union of all objects marked `userData.floor`, or null when there are none. */
export function floorBounds(scene: THREE.Object3D): THREE.Box3 | null {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  scene.traverse((object) => {
    if (object.userData.floor) box.expandByObject(object);
  });
  return box.isEmpty() ? null : box;
}

/** The box of the smallest floor object (`userData.floor`) whose area holds the point, or null. */
export function floorUnder(scene: THREE.Object3D, point: THREE.Vector3): THREE.Box3 | null {
  scene.updateMatrixWorld(true);
  let best: THREE.Box3 | null = null;
  let bestArea = Infinity;
  scene.traverse((object) => {
    if (!object.userData.floor) return;
    const box = new THREE.Box3().expandByObject(object);
    const holds = point.x >= box.min.x && point.x <= box.max.x && point.z >= box.min.z && point.z <= box.max.z;
    const area = (box.max.x - box.min.x) * (box.max.z - box.min.z);
    if (holds && area < bestArea) {
      best = box;
      bestArea = area;
    }
  });
  return best;
}

const ROOM_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-OFFICE.halfX, 0, -OFFICE.halfZ),
  new THREE.Vector3(OFFICE.halfX, 0, OFFICE.halfZ),
);

/** What the overview frames: explicit bounds, then the floor objects, then the fixed room. */
export function overviewBounds(scene: THREE.Object3D): THREE.Box3 {
  return (explicitBounds ?? floorBounds(scene) ?? ROOM_BOUNDS).clone();
}

/** Camera state of the overview: a point on the floor and a distance along the fixed angle. */
export class OverviewController {
  target = new THREE.Vector3();
  distance = 40;
  minDistance = 3;
  maxDistance = 60;
  private bounds = ROOM_BOUNDS.clone();

  frame(bounds: THREE.Box3, fovDeg: number, aspect: number): void {
    const fit = frameForBounds(bounds, fovDeg, aspect);
    this.bounds = bounds.clone();
    this.target.copy(fit.target);
    this.distance = fit.distance;
    this.maxDistance = fit.distance * MAX_ZOOM_OUT;
  }

  zoom(wheelDelta: number): void {
    this.distance = THREE.MathUtils.clamp(
      this.distance * Math.exp(wheelDelta * WHEEL_ZOOM_RATE),
      this.minDistance,
      this.maxDistance,
    );
  }

  /** Move the floor with the pointer: a drag in pixels at the current zoom. */
  drag(dxPixels: number, dyPixels: number, viewportHeight: number, fovDeg: number): void {
    const unitsPerPixel = (2 * this.distance * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2)) / Math.max(viewportHeight, 1);
    this.pan(-dxPixels * unitsPerPixel, dyPixels * unitsPerPixel);
  }

  /** Move the target on the floor, in units to the screen right and screen forward. */
  pan(right: number, forward: number): void {
    const back = overviewDirection();
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
    this.distance = Math.min(this.distance, FOCUS_DISTANCE);
  }

  pose(): CameraPose {
    return {
      position: this.target.clone().addScaledVector(overviewDirection(), this.distance),
      lookAt: this.target.clone(),
    };
  }
}

export function easeInOutCubic(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function interpolatePose(from: CameraPose, to: CameraPose, t: number): CameraPose {
  const eased = easeInOutCubic(t);
  return {
    position: from.position.clone().lerp(to.position, eased),
    lookAt: from.lookAt.clone().lerp(to.lookAt, eased),
  };
}

/** A camera flight from one pose to another over a fixed time. */
export class PoseTween {
  private elapsed = 0;

  constructor(private from: CameraPose, private to: CameraPose, private duration = 0.6) {}

  get done(): boolean {
    return this.elapsed >= this.duration;
  }

  advance(delta: number): CameraPose {
    this.elapsed = Math.min(this.duration, this.elapsed + delta);
    return interpolatePose(this.from, this.to, this.duration > 0 ? this.elapsed / this.duration : 1);
  }
}

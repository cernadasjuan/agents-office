import * as THREE from 'three';
import { OFFICE } from '../utils/Constants.js';

export interface CameraPose {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

let explicitBounds: THREE.Box3 | null = null;

/** Let a layout say what the isometric view must show. Null goes back to the floor objects. */
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

/** What the isometric view frames: explicit bounds, then the floor objects, then the fixed room. */
export function overviewBounds(scene: THREE.Object3D): THREE.Box3 {
  return (explicitBounds ?? floorBounds(scene) ?? ROOM_BOUNDS).clone();
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

import * as THREE from 'three';

const MOVE_SPEED = 6;
const FAST_MULTIPLIER = 2.5;
const MOUSE_SENSITIVITY = 0.002;
/** The only limit on first person: the eye stays above the floor. No box: rooms and the roof are open. */
export const MIN_EYE_HEIGHT = 0.5;
/** A focus position stays this far inside the floor of the figure's room, clear of its walls. */
const ROOM_WALL_CLEARANCE = 0.6;
/** A focus position closer than this to the figure tries the direction toward the room center. */
const MIN_FOCUS_DISTANCE = 2;

const keys = new Set<string>();
let yaw = 0;
let pitch = 0;
let locked = false;
let lockFilter: (event: MouseEvent) => boolean = () => true;

/** Decide per click whether it engages the camera (for example: not when it selects a figure). */
export function setPointerLockFilter(filter: (event: MouseEvent) => boolean): void {
  lockFilter = filter;
}

export function initFreeCamera(
  camera: THREE.PerspectiveCamera,
  canvas: HTMLCanvasElement,
  lookAtTarget: THREE.Vector3
): void {
  setFreeCameraLook(camera, camera.position, lookAtTarget);

  // Pointer lock
  canvas.addEventListener('click', (event) => {
    if (lockFilter(event)) canvas.requestPointerLock();
  });

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    const hint = document.getElementById('pointer-hint');
    if (hint) hint.style.display = locked ? 'none' : 'block';
  });

  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    yaw -= e.movementX * MOUSE_SENSITIVITY;
    pitch -= e.movementY * MOUSE_SENSITIVITY;
    pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  });

  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
  });
}

/** Place the camera and turn it toward a point. */
export function setFreeCameraLook(camera: THREE.Camera, position: THREE.Vector3, lookAt: THREE.Vector3): void {
  camera.position.copy(position);
  const dir = new THREE.Vector3().subVectors(lookAt, position).normalize();
  yaw = Math.atan2(-dir.x, -dir.z);
  pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)), -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
}

/** Where the first-person camera is and a point it looks at. */
export function freeCameraLook(camera: THREE.Camera): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')));
  return { position: camera.position.clone(), lookAt: camera.position.clone().addScaledVector(forward, 5) };
}

export function keepAboveFloor(pos: THREE.Vector3): void {
  pos.y = Math.max(pos.y, MIN_EYE_HEIGHT);
}

function clampInto(point: THREE.Vector3, room: THREE.Box3): THREE.Vector3 {
  const inset = (min: number, max: number) => (max - min > 2 * ROOM_WALL_CLEARANCE ? ROOM_WALL_CLEARANCE : (max - min) / 2);
  const ix = inset(room.min.x, room.max.x);
  const iz = inset(room.min.z, room.max.z);
  point.x = THREE.MathUtils.clamp(point.x, room.min.x + ix, room.max.x - ix);
  point.z = THREE.MathUtils.clamp(point.z, room.min.z + iz, room.max.z - iz);
  return point;
}

function flatDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Where the camera stands to look at a figure: `distance` back along `away`
 * (flat) and `height` up. With the floor box of the figure's room, the point
 * stays inside that room, so the camera never ends behind or inside a wall.
 * When that leaves the camera too close, it backs off toward the room center.
 */
export function focusPosition(lookAt: THREE.Vector3, away: THREE.Vector3, room: THREE.Box3 | null, distance: number, height: number): THREE.Vector3 {
  const at = (direction: THREE.Vector3) => {
    const flat = new THREE.Vector3(direction.x, 0, direction.z);
    if (flat.lengthSq() < 1e-9) flat.set(0, 0, 1);
    const point = lookAt.clone().addScaledVector(flat.normalize(), distance);
    point.y += height;
    return room ? clampInto(point, room) : point;
  };
  const position = at(away);
  if (!room || flatDistance(position, lookAt) >= MIN_FOCUS_DISTANCE) return position;
  const toCenter = at(room.getCenter(new THREE.Vector3()).sub(lookAt));
  return flatDistance(toCenter, lookAt) > flatDistance(position, lookAt) ? toCenter : position;
}

export function updateFreeCamera(camera: THREE.PerspectiveCamera, delta: number): void {
  // Apply look rotation
  const euler = new THREE.Euler(pitch, yaw, 0, 'YXZ');
  camera.quaternion.setFromEuler(euler);

  // Movement
  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight')
    ? MOVE_SPEED * FAST_MULTIPLIER
    : MOVE_SPEED;

  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);

  const move = new THREE.Vector3();

  if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(forward);
  if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(forward);
  if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right);
  if (keys.has('Space')) move.y += 1;
  if (keys.has('KeyQ') || keys.has('ControlLeft')) move.y -= 1;

  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(speed * delta);
    camera.position.add(move);
  }

  keepAboveFloor(camera.position);
}

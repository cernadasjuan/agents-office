import * as THREE from 'three';
import { OFFICE } from '../utils/Constants.js';

const MOVE_SPEED = 6;
const FAST_MULTIPLIER = 2.5;
const MOUSE_SENSITIVITY = 0.002;

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

export function clampToOffice(pos: THREE.Vector3): void {
  const m = OFFICE.margin;
  pos.x = THREE.MathUtils.clamp(pos.x, -OFFICE.halfX + m, OFFICE.halfX - m);
  pos.z = THREE.MathUtils.clamp(pos.z, -OFFICE.halfZ + m, OFFICE.halfZ - m);
  pos.y = THREE.MathUtils.clamp(pos.y, 0.5, OFFICE.height - m);
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

  clampToOffice(camera.position);
}

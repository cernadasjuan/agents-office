import * as THREE from 'three';
import { FIGURE_EYE_HEIGHT } from '../characters/StickFigureParts.js';

/** Issue #174: first person walks on the ground at a standing agent's own eye height, instead of flying. */
export const EYE_HEIGHT = FIGURE_EYE_HEIGHT;
/** Crouching (Shift) lowers the eye height, so looking down at a desk or under a table reads differently from standing. */
export const CROUCH_EYE_HEIGHT = EYE_HEIGHT * 0.6;
/** A little faster than the old flight-era base speed (6), issue #174's own acceptance criteria. */
const WALK_SPEED = 7;
/** Double-tap W (issue #174), not Shift (now crouch): running goes faster than walking. */
const RUN_MULTIPLIER = 1.8;
/** Shift crouches and moves slower, the reverse of the old "Shift = fast". */
const CROUCH_SPEED_MULTIPLIER = 0.5;
const MOUSE_SENSITIVITY = 0.002;
/** A forgiving double-tap window for the run toggle. */
const DOUBLE_TAP_RUN_MS = 350;
const GRAVITY = 20;
/** Tuned for a jump apex just under 1 m (`JUMP_SPEED^2 / (2 * GRAVITY)`), enough to clear nothing taller than a desk. */
const JUMP_SPEED = 6;

const keys = new Set<string>();
let yaw = 0;
let pitch = 0;
let locked = false;
let lockFilter: (event: MouseEvent) => boolean = () => true;
let listenersAttached = false;

// --- Ground-walk state (issue #174): module-level, like yaw/pitch/keys above, one free camera at a time. ---
/** Upward (positive) or downward (negative) speed while airborne; zero while grounded or crouch-adjusting in place. */
let verticalVelocity = 0;
/** False only between a jump's takeoff and its landing: Space is a no-op mid-air, so there is no double jump. */
let grounded = true;
/** True from a double-tap of W until it is released: the held-run state double-tapping sets. */
let running = false;
let lastWTapAt = 0;
/** Issue #174 (desk mode, #161, not built yet): a future locked-camera mode calls this so ground-walk itself never needs to know about it. */
let movementEnabled = true;

/** Issue #85 fix: the triage filter is the app's first text field, so a key that reaches it must not also move the camera. */
function isFormField(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || element?.isContentEditable === true;
}

/** Decide per click whether it engages the camera (for example: not when it selects a figure). */
export function setPointerLockFilter(filter: (event: MouseEvent) => boolean): void {
  lockFilter = filter;
}

/** Issue #174 (desk mode, #161): turns ground-walk off (no WASD, no gravity, no jump) without touching look or pointer lock. Movement is enabled by default. */
export function setMovementEnabled(enabled: boolean): void {
  movementEnabled = enabled;
}

export function initFreeCamera(
  camera: THREE.PerspectiveCamera,
  canvas: HTMLCanvasElement,
  lookAtTarget: THREE.Vector3
): void {
  setFreeCameraLook(camera, camera.position, lookAtTarget);

  // Pointer lock: canvas-specific, so every call wires its own canvas.
  canvas.addEventListener('click', (event) => {
    if (lockFilter(event)) canvas.requestPointerLock();
  });

  // The window/document listeners below are process-wide (yaw, pitch and keys already are);
  // a second initFreeCamera call (there is only ever one in the app, SceneSetup.ts) must not
  // double-attach them, or a single keydown would run the double-tap and jump logic twice.
  if (listenersAttached) return;
  listenersAttached = true;

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
    if (isFormField(e.target)) return;
    if (e.code === 'KeyW' && !e.repeat) {
      const now = performance.now();
      if (now - lastWTapAt < DOUBLE_TAP_RUN_MS) running = true;
      lastWTapAt = now;
    }
    if (e.code === 'Space' && !e.repeat && movementEnabled && grounded) {
      verticalVelocity = JUMP_SPEED;
      grounded = false;
    }
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyW') running = false;
    keys.delete(e.code);
  });
}

/** Place the camera and turn it toward a point. Also resets ground-walk state (issue #174): a fly-to or a mode switch is a fresh placement, never mid-jump or mid-run from before it. */
export function setFreeCameraLook(camera: THREE.Camera, position: THREE.Vector3, lookAt: THREE.Vector3): void {
  camera.position.copy(position);
  const dir = new THREE.Vector3().subVectors(lookAt, position).normalize();
  yaw = Math.atan2(-dir.x, -dir.z);
  pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)), -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  verticalVelocity = 0;
  grounded = true;
  running = false;
  lastWTapAt = -Infinity;
}

/** Where the first-person camera is and a point it looks at. */
export function freeCameraLook(camera: THREE.Camera): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')));
  return { position: camera.position.clone(), lookAt: camera.position.clone().addScaledVector(forward, 5) };
}

/** A focus position stays this far inside the floor of the figure's room, clear of its walls. */
const ROOM_WALL_CLEARANCE = 0.6;
/** A focus position closer than this to the figure tries the direction toward the room center. */
const MIN_FOCUS_DISTANCE = 2;

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
  // Apply look rotation: mouse-look always applies, even with movement off (issue #174, desk mode keeps its own rule).
  const euler = new THREE.Euler(pitch, yaw, 0, 'YXZ');
  camera.quaternion.setFromEuler(euler);

  if (!movementEnabled) return;

  const crouching = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const targetEyeHeight = crouching ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;

  // Horizontal movement projects onto the ground plane (issue #174): looking up or down no
  // longer tilts the walk, unlike the old flight that moved along the full look direction.
  const yawOnly = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(yawOnly);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(yawOnly);
  const move = new THREE.Vector3();

  if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(forward);
  if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(forward);
  if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right);

  if (move.lengthSq() > 0) {
    const speed = WALK_SPEED * (crouching ? CROUCH_SPEED_MULTIPLIER : running ? RUN_MULTIPLIER : 1);
    move.normalize().multiplyScalar(speed * delta);
    camera.position.x += move.x;
    camera.position.z += move.z;
  }

  // Vertical: gravity and the jump impulse (issue #174), replacing the old Space/Q fly up/down.
  // Grounded, standing or crouching tracks the target eye height directly (a pose change, not
  // a fall); only an actual jump (`grounded` false) rides gravity down to it, so the apex and
  // the landing both play out as real motion instead of a teleport.
  if (grounded) {
    camera.position.y = targetEyeHeight;
  } else {
    verticalVelocity -= GRAVITY * delta;
    camera.position.y += verticalVelocity * delta;
    if (camera.position.y <= targetEyeHeight) {
      camera.position.y = targetEyeHeight;
      verticalVelocity = 0;
      grounded = true;
    }
  }
}

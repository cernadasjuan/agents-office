/**
 * Pure trig for the library scene's own camera rig (issue #239): no pointer lock, no Three.js
 * here either — a plain mouse-drag look (yaw/pitch) and WASD ground movement, simple on
 * purpose (round 7 north star). Three.js only wraps this at the call site (`bootLibrary.ts`).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const PITCH_LIMIT = Math.PI / 2 - 0.05;

/** Pitch is clamped just short of straight up/down, same reasoning a first-person camera
 * anywhere else in this app already applies: past it, "forward" stops meaning anything. */
export function clampPitch(pitch: number): number {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
}

/** Yaw/pitch that makes `position` look at `lookAt` (the inverse of `forwardFromYawPitch`),
 * for `teleport`'s own use: landing at a room's standing pose must also face the way that pose
 * already faces, not snap back to whatever direction the rig last held. */
export function yawPitchFromLookAt(position: Vec3, lookAt: Vec3): { yaw: number; pitch: number } {
  const dx = lookAt.x - position.x;
  const dy = lookAt.y - position.y;
  const dz = lookAt.z - position.z;
  const horizontal = Math.hypot(dx, dz);
  return { yaw: Math.atan2(dx, dz), pitch: clampPitch(Math.atan2(dy, horizontal)) };
}

/** The look direction (unit vector) for a yaw/pitch pair, Three.js's own convention (yaw 0,
 * pitch 0 looks down +Z, matching `Math.atan2(dx, dz)` above). */
export function forwardFromYawPitch(yaw: number, pitch: number): Vec3 {
  return { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
}

/** A wall's 2D floor footprint (same shape `src/layout/LayoutStrategy.ts`'s own `WallRect` —
 * duplicated rather than imported so this module stays THREE-and-office-free, the same
 * reasoning `plugins/floor-library/client.ts`'s own `shelfPoint` duplicates `RoomFrame`). */
export interface WallRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Review (issue #245): the library scene's own ground-walk had no wall collision at all —
 * holding a movement key walked the camera straight through a section room's own walls and
 * off the map. The same stepped, axis-separated algorithm `src/scene/FreeCamera.ts` already
 * uses for the office (never ported as a shared export, since that module's own version is
 * tangled with its module-level pointer-lock state; this is the same algorithm, a fresh pure
 * copy, not the same singleton): a wall's blocked zone is padded by `WALL_MARGIN` on both
 * faces, and each axis advances in steps no bigger than that margin, so a slow frame's larger
 * `delta` can never jump clean across a thin wall in one move (tunneling).
 */
const WALL_MARGIN = 0.3;

function blockedAt(walls: WallRect[], x: number, z: number): boolean {
  for (const wall of walls) {
    if (x > wall.minX - WALL_MARGIN && x < wall.maxX + WALL_MARGIN && z > wall.minZ - WALL_MARGIN && z < wall.maxZ + WALL_MARGIN) return true;
  }
  return false;
}

function stepAxis(current: number, target: number, blocked: (value: number) => boolean): number {
  let position = current;
  while (position !== target) {
    const remaining = target - position;
    const step = Math.abs(remaining) <= WALL_MARGIN ? remaining : Math.sign(remaining) * WALL_MARGIN;
    const next = position + step;
    if (blocked(next)) return position;
    position = next;
  }
  return position;
}

/** `dx`/`dz` applied to `(x, z)` with wall collision, each axis independently (sliding along a
 * wall hit at an angle, instead of sticking) — `src/scene/FreeCamera.ts`'s own
 * `moveWithCollision`, as a pure function over a plain position instead of a mutated
 * `THREE.Vector3` and a module-level wall list. */
export function moveWithCollision(x: number, z: number, dx: number, dz: number, walls: WallRect[]): { x: number; z: number } {
  const nextX = dx !== 0 ? stepAxis(x, x + dx, (value) => blockedAt(walls, value, z)) : x;
  const nextZ = dz !== 0 ? stepAxis(z, z + dz, (value) => blockedAt(walls, nextX, value)) : z;
  return { x: nextX, z: nextZ };
}

/**
 * Ground movement ignores pitch (looking down does not tip you into the floor): `forward`
 * and `right` on the XZ plane only, for WASD.
 *
 * Review (issue #245): this used `(cos(yaw), -sin(yaw))` for `right` — the correct "turn the
 * compass bearing 90° clockwise" vector in isolation, but not what actually reads as
 * screen-right once `camera.lookAt` builds the camera's own orientation from this same
 * `forward` (`bootLibrary.ts`'s `applyLook`). Verified directly (a `THREE.PerspectiveCamera`
 * aimed with `forwardFromYawPitch`, then projecting a point offset along the old `right`
 * landed at a *negative* screen X — screen-left, confirming the reviewer's D-moves-left bug).
 * Negated here, the same vector now projects to positive screen X.
 */
export function groundAxes(yaw: number): { forward: Vec3; right: Vec3 } {
  return { forward: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }, right: { x: -Math.cos(yaw), y: 0, z: Math.sin(yaw) } };
}

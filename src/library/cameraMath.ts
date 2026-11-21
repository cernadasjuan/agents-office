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

/** Ground movement ignores pitch (looking down does not tip you into the floor): `forward`
 * and `right` on the XZ plane only, for WASD. */
export function groundAxes(yaw: number): { forward: Vec3; right: Vec3 } {
  return { forward: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }, right: { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) } };
}

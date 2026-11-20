import * as THREE from 'three';

/** A point on the screen edge (CSS pixels, from the canvas top-left) and the angle (radians, screen convention: 0 points right, positive turns clockwise) to rotate an arrow so it points at the off-screen target. */
export interface EdgeMarker {
  x: number;
  y: number;
  angle: number;
}

/** A rectangle to avoid, in the same pixel space as the canvas (left/top/right/bottom from the canvas top-left). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far the marker sits from the true edge, or from an avoided rect, so it never clips under it. */
export const EDGE_MARGIN_PX = 28;

/** A world point's clip-space position, and the two ways a point can need a marker despite its own x/y sitting inside the frame. */
export interface Projection {
  ndc: THREE.Vector3;
  /** True only for a perspective camera, and only when the point is behind the viewer, never for an orthographic camera (the isometric view) or a point past the far plane. */
  behind: boolean;
  /** True when the point is ahead of the camera but farther than `camera.far`: the renderer clips it, so it draws no figure there, but it still needs a marker. Not flipped, unlike `behind`. */
  pastFar: boolean;
}

const view = new THREE.Vector3();

/** The clip-space position of a world point for `offscreenMarker`, and the behind-camera and past-far-plane flags it needs. */
export function projectToClip(position: THREE.Vector3, camera: THREE.Camera): Projection {
  camera.updateMatrixWorld();
  const ndc = position.clone().project(camera);
  view.copy(position).applyMatrix4(camera.matrixWorldInverse);
  // The camera looks down its own -Z: ahead is view.z < 0, behind is view.z > 0.
  const ahead = view.z < 0;
  const behind = !ahead && (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
  const far = (camera as THREE.PerspectiveCamera | THREE.OrthographicCamera).far;
  const pastFar = ahead && -view.z > far;
  return { ndc, behind, pastFar };
}

/**
 * Null when the point draws on screen (in front of the camera, inside the
 * frame, and not past the far plane). Otherwise the point on the screen edge
 * closest to the target's direction, and the angle to point an arrow there.
 * NDC is converted to pixels on each axis separately (aspect-correct), so a
 * wide canvas does not pull the point toward the wrong edge. A point behind
 * the camera flips left/right first, as a plain NDC clamp would send the
 * arrow the wrong way; a point past the far plane does not flip, since it is
 * still ahead of the viewer. With `avoid` (for example the side panel), the
 * point clamps into the larger free area beside it instead of the full
 * frame, with the ray's own origin at that area's center — so it still
 * lands outside `avoid` even when `avoid` covers the canvas center.
 */
export function offscreenMarker(projection: Projection, width: number, height: number, margin = EDGE_MARGIN_PX, avoid: Rect | null = null): EdgeMarker | null {
  const { ndc, behind, pastFar } = projection;
  const ndcX = behind ? -ndc.x : ndc.x;
  const ndcY = behind ? -ndc.y : ndc.y;
  const onScreen = !behind && !pastFar && ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1;
  if (onScreen) return null;

  // NDC to pixels, against the true canvas half-extents: aspect-correct, and independent of `avoid`.
  let dirX = ndcX * (width / 2);
  let dirY = -ndcY * (height / 2);
  // Dead ahead (or dead on-axis behind the camera): no direction to flip. Pick a default edge (right) instead of dividing by zero.
  if (dirX === 0 && dirY === 0) dirX = 1;

  const area = freeArea(width, height, avoid);
  const originX = (area.left + area.right) / 2;
  const originY = (area.top + area.bottom) / 2;
  const halfW = Math.max((area.right - area.left) / 2 - margin, 1);
  const halfH = Math.max((area.bottom - area.top) / 2 - margin, 1);
  const scale = edgeScale(dirX, dirY, halfW, halfH);

  return {
    x: originX + dirX * scale,
    y: originY + dirY * scale,
    angle: Math.atan2(dirY, dirX),
  };
}

/** The scale that puts `(dirX, dirY)` on the edge of a `halfW`×`halfH` rectangle centered at the origin. */
function edgeScale(dirX: number, dirY: number, halfW: number, halfH: number): number {
  const scaleX = dirX !== 0 ? halfW / Math.abs(dirX) : Infinity;
  const scaleY = dirY !== 0 ? halfH / Math.abs(dirY) : Infinity;
  return Math.min(scaleX, scaleY);
}

/**
 * The canvas rect, minus `avoid`: the larger of the four strips left, right,
 * above or below it. Without `avoid`, the whole canvas. A marker clamps into
 * this rect, so it never lands under `avoid` even when `avoid` spans the
 * canvas center (a narrow window with a wide side panel).
 */
function freeArea(width: number, height: number, avoid: Rect | null): Rect {
  if (!avoid) return { left: 0, top: 0, right: width, bottom: height };
  const left = { left: 0, top: 0, right: clampRange(avoid.left, 0, width), bottom: height };
  const right = { left: clampRange(avoid.right, 0, width), top: 0, right: width, bottom: height };
  const top = { left: 0, top: 0, right: width, bottom: clampRange(avoid.top, 0, height) };
  const bottom = { left: 0, top: clampRange(avoid.bottom, 0, height), right: width, bottom: height };
  return [left, right, top, bottom].reduce((best, candidate) => (rectArea(candidate) > rectArea(best) ? candidate : best));
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rectArea(rect: Rect): number {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
}

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

/** A world point's clip-space position, and whether it sits behind the camera (not merely past the far plane). */
export interface Projection {
  ndc: THREE.Vector3;
  /** True only for a perspective camera, and only when the point is behind the viewer, never for an orthographic camera (the isometric view) or a point past the far plane. */
  behind: boolean;
}

const view = new THREE.Vector3();

/** The clip-space position of a world point for `offscreenMarker`, and the behind-camera flag it needs. */
export function projectToClip(position: THREE.Vector3, camera: THREE.Camera): Projection {
  camera.updateMatrixWorld();
  const ndc = position.clone().project(camera);
  view.copy(position).applyMatrix4(camera.matrixWorldInverse);
  // The camera looks down its own -Z; a perspective camera's far plane never flips this sign, only standing past the viewer does.
  const behind = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true && view.z > 0;
  return { ndc, behind };
}

/**
 * Null when the point draws on screen (in front of the camera, inside the
 * frame). Otherwise the point on the screen edge closest to the target's
 * direction, and the angle to point an arrow there. NDC is converted to
 * pixels on each axis separately (aspect-correct), so a wide canvas does not
 * pull the point toward the wrong edge. A point behind the camera flips
 * left/right first, as a plain NDC clamp would send the arrow the wrong way.
 * With `avoid`, the point also stops short of that rect (for example the
 * side panel), so the marker never sits under it.
 */
export function offscreenMarker(projection: Projection, width: number, height: number, margin = EDGE_MARGIN_PX, avoid: Rect | null = null): EdgeMarker | null {
  const { ndc, behind } = projection;
  const ndcX = behind ? -ndc.x : ndc.x;
  const ndcY = behind ? -ndc.y : ndc.y;
  if (!behind && ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1) return null;

  const cx = width / 2;
  const cy = height / 2;
  // NDC to pixels, each axis against its own half-extent: aspect-correct.
  let dirX = ndcX * cx;
  let dirY = -ndcY * cy;
  // On the camera's own center axis, behind it: direction is (0, 0). Pick a default edge (right) instead of dividing by zero.
  if (dirX === 0 && dirY === 0) dirX = 1;

  const halfW = Math.max(cx - margin, 1);
  const halfH = Math.max(cy - margin, 1);
  let scale = edgeScale(dirX, dirY, halfW, halfH);
  if (avoid) {
    const inset = insetRect(avoid, margin);
    const entry = rayRectEntry(cx, cy, dirX, dirY, inset);
    if (entry !== null && entry > 0 && entry < scale) scale = entry;
  }

  return {
    x: cx + dirX * scale,
    y: cy + dirY * scale,
    angle: Math.atan2(dirY, dirX),
  };
}

/** The scale that puts `(dirX, dirY)` on the edge of a `halfW`×`halfH` rectangle centered at the origin. */
function edgeScale(dirX: number, dirY: number, halfW: number, halfH: number): number {
  const scaleX = dirX !== 0 ? halfW / Math.abs(dirX) : Infinity;
  const scaleY = dirY !== 0 ? halfH / Math.abs(dirY) : Infinity;
  return Math.min(scaleX, scaleY);
}

/** `rect`, grown outward by `margin` on every side (so a marker stops a little short of it). */
function insetRect(rect: Rect, margin: number): Rect {
  return { left: rect.left - margin, top: rect.top - margin, right: rect.right + margin, bottom: rect.bottom + margin };
}

/**
 * The scale at which the ray from `(cx, cy)` in direction `(dirX, dirY)`
 * first enters `rect` (the standard ray-vs-AABB slab test), or null when the
 * ray never enters it. `(cx, cy)` is assumed outside `rect`.
 */
function rayRectEntry(cx: number, cy: number, dirX: number, dirY: number, rect: Rect): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  if (dirX !== 0) {
    const t1 = (rect.left - cx) / dirX;
    const t2 = (rect.right - cx) / dirX;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  } else if (cx < rect.left || cx > rect.right) {
    return null;
  }
  if (dirY !== 0) {
    const t1 = (rect.top - cy) / dirY;
    const t2 = (rect.bottom - cy) / dirY;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  } else if (cy < rect.top || cy > rect.bottom) {
    return null;
  }
  if (tMax < tMin || tMax < 0) return null;
  return tMin;
}

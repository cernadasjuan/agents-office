import * as THREE from 'three';

/** A point on the screen edge (CSS pixels, from the canvas top-left) and the angle (radians, screen convention: 0 points right, positive turns clockwise) to rotate an arrow so it points at the off-screen target. */
export interface EdgeMarker {
  x: number;
  y: number;
  angle: number;
}

/** How far the marker sits from the true edge, so it never clips under the canvas border. */
export const EDGE_MARGIN_PX = 28;

/** The clip-space position of a world point for `offscreenMarker`. A fresh `Vector3` per call; callers may reuse a scratch vector. */
export function projectToClip(position: THREE.Vector3, camera: THREE.Camera): THREE.Vector3 {
  camera.updateMatrixWorld();
  return position.clone().project(camera);
}

/**
 * Null when the point draws on screen (in front of the camera, inside the
 * frame). Otherwise the point on the screen edge closest to the target's
 * direction, and the angle to point an arrow there. A point behind the
 * camera (`clip.z > 1`) flips left/right, as a plain NDC clamp would send
 * the arrow the wrong way.
 */
export function offscreenMarker(clip: THREE.Vector3, width: number, height: number, margin = EDGE_MARGIN_PX): EdgeMarker | null {
  const behind = clip.z > 1;
  const ndcX = behind ? -clip.x : clip.x;
  const ndcY = behind ? -clip.y : clip.y;
  if (!behind && ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1) return null;

  // Direction from the screen center, in pixel space (y grows downward).
  const dirX = ndcX;
  const dirY = -ndcY;
  const halfW = Math.max(width / 2 - margin, 1);
  const halfH = Math.max(height / 2 - margin, 1);
  const scaleX = dirX !== 0 ? halfW / Math.abs(dirX) : Infinity;
  const scaleY = dirY !== 0 ? halfH / Math.abs(dirY) : Infinity;
  const scale = Math.min(scaleX, scaleY);

  return {
    x: width / 2 + dirX * scale,
    y: height / 2 + dirY * scale,
    angle: Math.atan2(dirY, dirX),
  };
}

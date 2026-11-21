import type * as THREE from 'three';

/** In the overview, cutaway zones drop to this height (a dollhouse cut-away), so the room floors show. */
export const OVERVIEW_WALL_HEIGHT = 0.5;

/**
 * Lower or restore the cutaway zones: merged static zones at the scene root
 * whose `userData.overviewLower` holds their full height (see `markStatic`).
 * A zone drops to `userData.overviewHeight` when set (door frames), else to
 * `OVERVIEW_WALL_HEIGHT`.
 * They stand on the floor (y = 0), so a scale on y lowers them in place.
 * Call it every frame after the static merge: zones built later follow the
 * mode at once. Returns true when a zone changed (render and redraw shadows).
 */
export function applyCutaway(scene: THREE.Object3D, fromAbove: boolean): boolean {
  let changed = false;
  for (const zone of scene.children) {
    const height = zone.userData.overviewLower;
    if (typeof height !== 'number' || !(height > 0)) continue;
    const target = typeof zone.userData.overviewHeight === 'number' ? zone.userData.overviewHeight : OVERVIEW_WALL_HEIGHT;
    const scaleY = fromAbove ? Math.min(1, target / height) : 1;
    if (zone.scale.y === scaleY) continue;
    zone.scale.y = scaleY;
    zone.updateMatrixWorld(true);
    changed = true;
  }
  return changed;
}

/** Ceiling meshes (`userData.ceiling`). They are marked dynamic, so a hide costs no static merge rebuild. */
export function findCeilings(root: THREE.Object3D): THREE.Object3D[] {
  const ceilings: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (object.userData.ceiling) ceilings.push(object);
  });
  return ceilings;
}

/**
 * Ceilings show in first person and hide only in the isometric view (issue #176): a flown-over
 * first person used to see over the top of them, but first person now walks on the ground
 * (#174), so that reason is gone. The isometric view still needs the open roof. True when one changed.
 */
export function applyCeilingCut(ceilings: THREE.Object3D[], fromAbove: boolean): boolean {
  const visible = !fromAbove;
  let changed = false;
  for (const ceiling of ceilings) {
    if (ceiling.visible === visible) continue;
    ceiling.visible = visible;
    changed = true;
  }
  return changed;
}

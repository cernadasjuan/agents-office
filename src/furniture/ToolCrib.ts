import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';

/**
 * The tool crib (issue #167 addendum, Gabriel, 2026-11-21: "a new object... very
 * small thing... just do it"): a small counter in the hall with a few recognizable
 * tool shapes on it, the physical home the skills equipment catalog's items (#167)
 * come from. A static hall piece like the water cooler or the printer: plain
 * meshes, no `figurePart` tag, no shadow (it is a small prop, the same rationale
 * `plugins/bmad/hats.ts` and the equipment catalog itself already use), merged by
 * `StaticBatch` with the rest of the hall's furniture.
 *
 * No trip mechanic this round: an agent's equipped item still appears the moment
 * its skill list changes, with no walk to this counter first. Wiring a visit here
 * (a new station type, a dwell before the item shows) touches the activity/trip
 * system, not just a plugin; deferred as a follow-up (see the PR).
 */
export function createToolCrib(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'tool-crib';

  const counterMaterial = getToonMaterial(0x8b7355);
  const counter = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.55, 0.4), counterMaterial);
  counter.position.y = 0.275;
  counter.castShadow = false;
  group.add(counter);

  // Same material as the countertop (not a second one, StaticMerge.ts merges one mesh
  // per material): a leg is a tiny sliver, the color difference was not worth a 4th
  // merged draw call for this small a piece.
  for (const x of [-0.45, 0.45]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.25, 0.06), counterMaterial);
    leg.position.set(x, 0.125, 0);
    leg.castShadow = false;
    group.add(leg);
  }

  // A few tool silhouettes standing on the counter: a wrench, a small toolbox, a
  // magnifier — the same families the equipment catalog hands out (items.ts), so
  // the crib visually reads as "where those items come from".
  const toolMaterial = getToonMaterial(0x8a7a5c);

  const wrench = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2, 0.025), toolMaterial);
  wrench.position.set(-0.3, 0.65, 0);
  wrench.rotation.z = 0.3;
  wrench.castShadow = false;
  group.add(wrench);

  const toolbox = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.12), toolMaterial);
  toolbox.position.set(0, 0.61, 0);
  toolbox.castShadow = false;
  group.add(toolbox);

  const magnifier = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 10), toolMaterial);
  magnifier.position.set(0.32, 0.65, 0);
  magnifier.castShadow = false;
  group.add(magnifier);

  return group;
}

import * as THREE from 'three';
import { Colors } from '../utils/Colors.js';
import { getToonMaterial } from '../utils/Materials.js';

/** A low wall divider: keeps a desk cluster and a lounge corner from touching in a large war
 * room. Reuses the desk legs' own color and shadow flags, so it shares a merge bucket. */
export function createLowDivider(length = 2.4): THREE.Group {
  const group = new THREE.Group();

  const panel = new THREE.Mesh(new THREE.BoxGeometry(length, 0.9, 0.08), getToonMaterial(Colors.deskLegs));
  panel.position.y = 0.45;
  panel.castShadow = true;
  group.add(panel);

  const cap = new THREE.Mesh(new THREE.BoxGeometry(length, 0.04, 0.12), getToonMaterial(Colors.deskLegs));
  cap.position.y = 0.92;
  cap.castShadow = true;
  group.add(cap);

  return group;
}

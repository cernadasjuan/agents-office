import * as THREE from 'three';
import { getToonMaterial, getEmissiveMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

/** A wall-mounted TV: a stand, a frame and an emissive screen face. Reuses the desk's
 * own monitor colors, so a room's TV shares its merge bucket instead of costing a new one. */
export function createTV(): THREE.Group {
  const group = new THREE.Group();

  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.12), getToonMaterial(Colors.monitor));
  stand.position.set(0, -0.02, 0.06);
  group.add(stand);

  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.65, 0.05), getToonMaterial(Colors.monitor));
  frame.castShadow = true;
  group.add(frame);

  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.56), getEmissiveMaterial(Colors.monitorScreen, Colors.monitorScreen, 0.8));
  face.position.z = 0.026;
  group.add(face);
  group.userData.screenFace = face;

  return group;
}

import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';

const SLAB_COLOR = 0x8a8a94;
const STONE_COLOR = 0x6e6e78;

/**
 * A small tombstone: a flat base slab and an upright, rounded-top stone. Marks
 * one ended mission session (`missionRooms.ts`), replacing the old bed. Two
 * boxes, one shared material each, so a room full of them still merges into a
 * couple of draw calls (`StaticMerge`).
 */
export function createTombstone(): THREE.Group {
  const group = new THREE.Group();

  const slab = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.35), getToonMaterial(SLAB_COLOR));
  slab.position.y = 0.025;
  slab.castShadow = true;
  slab.receiveShadow = true;
  group.add(slab);

  // The upright stone's top corners are beveled with a second, narrower box, reading as a rounded cap.
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, 0.08), getToonMaterial(STONE_COLOR));
  body.position.set(0, 0.25, 0);
  body.castShadow = true;
  group.add(body);

  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.1, 0.08), getToonMaterial(STONE_COLOR));
  cap.position.set(0, 0.47, 0);
  cap.rotation.z = Math.PI / 4;
  cap.castShadow = true;
  group.add(cap);

  return group;
}

import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

/** A standing floor lamp: a decor piece only, it adds no light (the light budget stays). */
export function createFloorLamp(): THREE.Group {
  const group = new THREE.Group();
  const metal = getToonMaterial(0x222222);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.04, 12), metal);
  base.position.y = 0.02;
  group.add(base);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.45, 6), metal);
  pole.position.y = 0.76;
  pole.castShadow = true;
  group.add(pole);
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.3, 12), getToonMaterial(Colors.cup));
  shade.position.y = 1.55;
  shade.castShadow = true;
  group.add(shade);
  return group;
}

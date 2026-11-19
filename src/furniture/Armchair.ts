import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';

/** A one-seat armchair. Its front looks along +z, like the sofa. */
export function createArmchair(color = 0xd35400): THREE.Group {
  const group = new THREE.Group();
  const cushion = getToonMaterial(color);
  const frame = getToonMaterial(0x3a3a4a);
  const box = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
  };
  box(0.8, 0.15, 0.75, frame, 0, 0.2, 0);
  box(0.62, 0.14, 0.62, cushion, 0, 0.35, 0.03);
  box(0.62, 0.5, 0.14, cushion, 0, 0.6, -0.3);
  for (const side of [-1, 1]) box(0.1, 0.32, 0.7, frame, side * 0.36, 0.42, 0);
  const foot = getToonMaterial(0x222222);
  for (const [x, z] of [[-0.32, -0.28], [-0.32, 0.28], [0.32, -0.28], [0.32, 0.28]]) box(0.07, 0.12, 0.07, foot, x, 0.06, z);
  return group;
}

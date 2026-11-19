import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

function box(group: THREE.Group, w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  group.add(mesh);
}

/** A low coffee table for a lounge corner, with a book and a cup on it. */
export function createLowTable(): THREE.Group {
  const group = new THREE.Group();
  box(group, 1.0, 0.06, 0.6, getToonMaterial(Colors.desk), 0, 0.4, 0);
  const legs = getToonMaterial(Colors.deskLegs);
  for (const [x, z] of [[-0.44, -0.24], [-0.44, 0.24], [0.44, -0.24], [0.44, 0.24]]) box(group, 0.06, 0.37, 0.06, legs, x, 0.185, z);
  box(group, 0.28, 0.05, 0.2, getToonMaterial(Colors.books[1]), -0.2, 0.455, 0.05);
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.035, 0.09, 8), getToonMaterial(Colors.cup));
  cup.position.set(0.25, 0.475, -0.05);
  group.add(cup);
  return group;
}

/** A long low cabinet for behind a desk: two doors, books and a vase on top. Its front looks along +z. */
export function createCredenza(): THREE.Group {
  const group = new THREE.Group();
  const body = getToonMaterial(Colors.deskLegs);
  box(group, 1.8, 0.7, 0.45, body, 0, 0.4, 0);
  box(group, 1.86, 0.05, 0.5, getToonMaterial(Colors.desk), 0, 0.775, 0);
  const handle = getToonMaterial(0x222222);
  // Two doors that meet in the middle: one handle on each side of the seam
  for (const x of [-0.09, 0.09]) box(group, 0.04, 0.16, 0.03, handle, x, 0.45, 0.235);
  for (const [x, z] of [[-0.82, -0.17], [-0.82, 0.17], [0.82, -0.17], [0.82, 0.17]]) box(group, 0.06, 0.05, 0.06, handle, x, 0.025, z);
  // A few books standing on the top, and a pot
  Colors.books.slice(2, 5).forEach((color, i) => box(group, 0.05, 0.24, 0.18, getToonMaterial(color), 0.45 + i * 0.07, 0.92, 0));
  const vase = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.22, 8), getToonMaterial(Colors.pot));
  vase.position.set(-0.55, 0.91, 0);
  group.add(vase);
  return group;
}

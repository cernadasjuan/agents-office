import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

/** An open display shelf: three levels with a few objects (books, a pot, a trophy), not a full bookcase. Its front looks along +z. */
export function createDisplayShelf(): THREE.Group {
  const group = new THREE.Group();
  const wood = getToonMaterial(Colors.bookshelf);
  const box = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
  };
  for (const side of [-1, 1]) box(0.04, 1.6, 0.36, wood, side * 0.68, 0.8, 0);
  for (let level = 0; level < 4; level++) box(1.4, 0.04, 0.36, wood, 0, 0.04 + level * 0.5, 0);
  // Bottom level: a row of books
  Colors.books.slice(0, 5).forEach((color, i) => box(0.06, 0.3, 0.24, getToonMaterial(color), -0.5 + i * 0.08, 0.21, 0));
  // Middle level: a pot and a trophy
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.08, 0.25, 8), getToonMaterial(Colors.pot));
  pot.position.set(-0.3, 0.68, 0);
  group.add(pot);
  const gold = getToonMaterial(Colors.books[3]);
  box(0.16, 0.05, 0.12, gold, 0.3, 0.58, 0);
  const cupMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.04, 0.16, 8), gold);
  cupMesh.position.set(0.3, 0.69, 0);
  group.add(cupMesh);
  // Top level: leaning books and a small box
  Colors.books.slice(5, 8).forEach((color, i) => box(0.06, 0.28, 0.22, getToonMaterial(color), 0.25 + i * 0.08, 1.18, 0));
  box(0.24, 0.14, 0.18, getToonMaterial(Colors.books[1]), -0.3, 1.11, 0);
  return group;
}

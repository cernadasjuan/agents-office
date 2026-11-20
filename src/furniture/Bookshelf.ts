import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

/**
 * `color` lets a room give its shelves a distinct finish (issue #128: the library-knowledge
 * shelves render white, so an agent never confuses them with an ordinary bookshelf).
 */
export function createBookshelf(color: number | THREE.Color = Colors.bookshelf) {
  const group = new THREE.Group();

  const shelfMat = getToonMaterial(color);

  // Back panel
  const backGeo = new THREE.BoxGeometry(1.6, 2.0, 0.04);
  const back = new THREE.Mesh(backGeo, shelfMat);
  back.position.set(0, 1.0, -0.18);
  back.castShadow = true;
  group.add(back);

  // Shelves (4 levels)
  const shelfGeo = new THREE.BoxGeometry(1.6, 0.04, 0.4);
  for (let i = 0; i < 4; i++) {
    const shelf = new THREE.Mesh(shelfGeo, shelfMat);
    shelf.position.set(0, 0.02 + i * 0.5, 0);
    shelf.castShadow = true;
    shelf.receiveShadow = true;
    group.add(shelf);
  }

  // Side panels
  const sideGeo = new THREE.BoxGeometry(0.04, 2.0, 0.4);
  const sideL = new THREE.Mesh(sideGeo, shelfMat);
  sideL.position.set(-0.8, 1.0, 0);
  sideL.castShadow = true;
  group.add(sideL);

  const sideR = new THREE.Mesh(sideGeo, shelfMat);
  sideR.position.set(0.8, 1.0, 0);
  sideR.castShadow = true;
  group.add(sideR);

  // Books on shelves
  for (let shelf = 0; shelf < 3; shelf++) {
    const y = 0.04 + shelf * 0.5;
    let x = -0.65;
    const bookCount = 5 + Math.floor(Math.random() * 4);
    for (let b = 0; b < bookCount && x < 0.6; b++) {
      const w = 0.06 + Math.random() * 0.06;
      const h = 0.3 + Math.random() * 0.14;
      const d = 0.2 + Math.random() * 0.1;
      const color = Colors.books[b % Colors.books.length];
      const bookGeo = new THREE.BoxGeometry(w, h, d);
      const book = new THREE.Mesh(bookGeo, getToonMaterial(color));
      book.position.set(x + w / 2, y + h / 2, 0);
      book.castShadow = true;
      group.add(book);
      x += w + 0.01;
    }
  }

  return group;
}

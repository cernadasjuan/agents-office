import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';

/** The main room's play zone (issue #122): a foosball ("babyfoot") table. */

const FELT_GREEN = 0x2f7a3a;
const FRAME_BROWN = 0x8b6914;
const ROD_GREY = 0x999999;

export function createFoosballTable(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'foosball-table';

  // The same brown and both shadow flags as the bookshelf's own shelf boards: no new batch.
  const tableGeo = new THREE.BoxGeometry(1.9, 0.75, 1.0);
  const table = new THREE.Mesh(tableGeo, getToonMaterial(FRAME_BROWN));
  table.position.y = 0.375;
  table.castShadow = true;
  table.receiveShadow = true;
  group.add(table);

  const feltGeo = new THREE.BoxGeometry(1.8, 0.04, 0.9);
  const felt = new THREE.Mesh(feltGeo, getToonMaterial(FELT_GREEN));
  felt.position.y = 0.77;
  felt.receiveShadow = true;
  group.add(felt);

  // Four player rods, crossing the table's short axis. The same grey and flags as the
  // water cooler's tray: no new batch.
  const rodGeo = new THREE.CylinderGeometry(0.015, 0.015, 1.1, 6);
  const rodMat = getToonMaterial(ROD_GREY);
  for (const x of [-0.675, -0.225, 0.225, 0.675]) {
    const rod = new THREE.Mesh(rodGeo, rodMat);
    rod.rotation.z = Math.PI / 2;
    rod.position.set(x, 0.85, 0);
    group.add(rod);
  }

  return group;
}

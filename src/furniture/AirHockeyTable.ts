import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';

/** The main room's play zone (issue #122): an air hockey table. */

const RINK_BLUE = 0x2a5a8c;
const RIM_GREY = 0x444444;

export function createAirHockeyTable(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'air-hockey-table';

  // Cast-only (the same 0x444444 as the coffee machine body): joins that existing batch.
  const rimGeo = new THREE.BoxGeometry(2.0, 0.78, 1.1);
  const rim = new THREE.Mesh(rimGeo, getToonMaterial(RIM_GREY));
  rim.position.y = 0.39;
  rim.castShadow = true;
  group.add(rim);

  const rinkGeo = new THREE.BoxGeometry(1.9, 0.04, 1.0);
  const rink = new THREE.Mesh(rinkGeo, getToonMaterial(RINK_BLUE));
  rink.position.y = 0.8;
  rink.receiveShadow = true;
  group.add(rink);

  // Two mallets, one per end. The same grey and flags as the rim: no new batch.
  const malletGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.04, 10);
  const malletMat = getToonMaterial(RIM_GREY);
  for (const x of [-0.75, 0.75]) {
    const mallet = new THREE.Mesh(malletGeo, malletMat);
    mallet.castShadow = true;
    mallet.position.set(x, 0.84, 0);
    group.add(mallet);
  }

  return group;
}

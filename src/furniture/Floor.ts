import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';
import { OFFICE } from '../utils/Constants.js';

export function createFloor(): THREE.Group {
  const group = new THREE.Group();
  group.userData.floor = true; // the overview camera frames every floor object

  // Main floor
  const floorGeo = new THREE.PlaneGeometry(OFFICE.halfX * 2, OFFICE.halfZ * 2);
  const floor = new THREE.Mesh(floorGeo, getToonMaterial(Colors.floor));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  // Carpet in the center
  const carpetGeo = new THREE.PlaneGeometry(10, 8);
  const carpet = new THREE.Mesh(carpetGeo, getToonMaterial(Colors.carpet));
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.set(0, 0.01, 0);
  carpet.receiveShadow = true;
  group.add(carpet);

  return group;
}

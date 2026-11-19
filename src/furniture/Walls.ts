import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';
import { OFFICE } from '../utils/Constants.js';

export function createWalls(): THREE.Group {
  const group = new THREE.Group();
  const wallMat = getToonMaterial(Colors.wall);

  const W = 0.15;
  const H = OFFICE.height;
  const Y = H / 2;
  const HX = OFFICE.halfX;
  const HZ = OFFICE.halfZ;
  const fullX = HX * 2 + W;
  const fullZ = HZ * 2 + W;

  // Back wall (z = -HZ)
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(fullX, H, W), wallMat);
  backWall.position.set(0, Y, -HZ);
  backWall.castShadow = true;
  backWall.receiveShadow = true;
  group.add(backWall);

  // Front wall (z = +HZ)
  const frontWall = new THREE.Mesh(new THREE.BoxGeometry(fullX, H, W), wallMat);
  frontWall.position.set(0, Y, HZ);
  frontWall.castShadow = true;
  frontWall.receiveShadow = true;
  frontWall.userData.overviewHidden = true; // faces the overview camera
  group.add(frontWall);

  // Left wall (x = -HX)
  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(W, H, fullZ), wallMat);
  leftWall.position.set(-HX, Y, 0);
  leftWall.castShadow = true;
  leftWall.receiveShadow = true;
  leftWall.userData.overviewHidden = true; // faces the overview camera
  group.add(leftWall);

  // Right wall (x = +HX)
  const rightWall = new THREE.Mesh(new THREE.BoxGeometry(W, H, fullZ), wallMat);
  rightWall.position.set(HX, Y, 0);
  rightWall.castShadow = true;
  rightWall.receiveShadow = true;
  group.add(rightWall);

  // Ceiling
  const ceilingMat = getToonMaterial(0xf2ede5);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2, HZ * 2), ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = H;
  ceiling.receiveShadow = true;
  group.add(ceiling);

  // Low divider walls between areas
  const dividerGeo = new THREE.BoxGeometry(0.1, 1.2, 4);
  const dividerMat = getToonMaterial(0xd0d0d0);

  const divider1 = new THREE.Mesh(dividerGeo, dividerMat);
  divider1.position.set(-4, 0.6, 1.5);
  divider1.castShadow = true;
  group.add(divider1);

  return group;
}

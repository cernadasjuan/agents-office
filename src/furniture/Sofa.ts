import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';

export function createSofa(color = 0x6a5acd): THREE.Group {
  const group = new THREE.Group();
  const cushionMat = getToonMaterial(color);
  const frameMat = getToonMaterial(0x3a3a4a);

  // Base frame
  const frameGeo = new THREE.BoxGeometry(2.0, 0.15, 0.8);
  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.position.y = 0.2;
  frame.castShadow = true;
  group.add(frame);

  // Seat cushion
  const seatGeo = new THREE.BoxGeometry(1.9, 0.15, 0.7);
  const seat = new THREE.Mesh(seatGeo, cushionMat);
  seat.position.set(0, 0.35, 0.02);
  seat.castShadow = true;
  group.add(seat);

  // Back cushion
  const backGeo = new THREE.BoxGeometry(1.9, 0.5, 0.15);
  const back = new THREE.Mesh(backGeo, cushionMat);
  back.position.set(0, 0.55, -0.33);
  back.castShadow = true;
  group.add(back);

  // Armrests
  const armGeo = new THREE.BoxGeometry(0.12, 0.3, 0.7);
  const armL = new THREE.Mesh(armGeo, frameMat);
  armL.position.set(-1.0, 0.42, 0);
  armL.castShadow = true;
  group.add(armL);

  const armR = new THREE.Mesh(armGeo, frameMat);
  armR.position.set(1.0, 0.42, 0);
  armR.castShadow = true;
  group.add(armR);

  // Feet
  const footGeo = new THREE.BoxGeometry(0.08, 0.12, 0.08);
  const footMat = getToonMaterial(0x222222);
  const footPositions: [number, number][] = [[-0.85, -0.3], [-0.85, 0.3], [0.85, -0.3], [0.85, 0.3]];
  for (const [x, z] of footPositions) {
    const foot = new THREE.Mesh(footGeo, footMat);
    foot.position.set(x, 0.06, z);
    group.add(foot);
  }

  return group;
}

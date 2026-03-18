import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

export function createWhiteboard() {
  const group = new THREE.Group();

  // Board
  const boardGeo = new THREE.BoxGeometry(2.0, 1.2, 0.05);
  const board = new THREE.Mesh(boardGeo, getToonMaterial(Colors.whiteboard));
  board.position.set(0, 1.5, 0);
  board.castShadow = true;
  group.add(board);

  // Frame (4 pieces)
  const frameMat = getToonMaterial(Colors.whiteboardFrame);
  const frameThickness = 0.06;

  // Top
  const topGeo = new THREE.BoxGeometry(2.1, frameThickness, 0.07);
  const top = new THREE.Mesh(topGeo, frameMat);
  top.position.set(0, 2.13, 0);
  top.castShadow = true;
  group.add(top);

  // Bottom
  const bottom = new THREE.Mesh(topGeo, frameMat);
  bottom.position.set(0, 0.87, 0);
  group.add(bottom);

  // Left
  const sideGeo = new THREE.BoxGeometry(frameThickness, 1.32, 0.07);
  const left = new THREE.Mesh(sideGeo, frameMat);
  left.position.set(-1.03, 1.5, 0);
  group.add(left);

  // Right
  const right = new THREE.Mesh(sideGeo, frameMat);
  right.position.set(1.03, 1.5, 0);
  group.add(right);

  // Legs
  const legGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.85, 6);
  const legMat = getToonMaterial(Colors.whiteboardFrame);
  const legL = new THREE.Mesh(legGeo, legMat);
  legL.position.set(-0.7, 0.42, 0.15);
  legL.rotation.x = 0.1;
  legL.castShadow = true;
  group.add(legL);

  const legR = new THREE.Mesh(legGeo, legMat);
  legR.position.set(0.7, 0.42, 0.15);
  legR.rotation.x = 0.1;
  legR.castShadow = true;
  group.add(legR);

  // Tray
  const trayGeo = new THREE.BoxGeometry(1.0, 0.03, 0.1);
  const tray = new THREE.Mesh(trayGeo, frameMat);
  tray.position.set(0, 0.9, 0.07);
  group.add(tray);

  // Marker on tray
  const markerGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.12, 6);
  const marker = new THREE.Mesh(markerGeo, getToonMaterial(0x2244aa));
  marker.position.set(0.2, 0.93, 0.07);
  marker.rotation.z = Math.PI / 2;
  group.add(marker);

  return group;
}

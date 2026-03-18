import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';

export function createPrinter(): THREE.Group {
  const group = new THREE.Group();

  // Stand/table
  const standGeo = new THREE.BoxGeometry(0.8, 0.6, 0.5);
  const stand = new THREE.Mesh(standGeo, getToonMaterial(0xbbbbbb));
  stand.position.y = 0.3;
  stand.castShadow = true;
  group.add(stand);

  // Printer body
  const bodyGeo = new THREE.BoxGeometry(0.7, 0.25, 0.45);
  const body = new THREE.Mesh(bodyGeo, getToonMaterial(0x444455));
  body.position.y = 0.73;
  body.castShadow = true;
  group.add(body);

  // Paper tray (output)
  const trayGeo = new THREE.BoxGeometry(0.4, 0.02, 0.2);
  const tray = new THREE.Mesh(trayGeo, getToonMaterial(0x555566));
  tray.position.set(0, 0.62, 0.3);
  tray.rotation.x = -0.15;
  group.add(tray);

  // Paper stack on top
  const paperGeo = new THREE.BoxGeometry(0.3, 0.04, 0.22);
  const paper = new THREE.Mesh(paperGeo, getToonMaterial(0xf5f5f0));
  paper.position.set(0, 0.88, -0.05);
  paper.castShadow = true;
  group.add(paper);

  // Status light
  const lightGeo = new THREE.SphereGeometry(0.015, 6, 6);
  const statusLight = new THREE.Mesh(lightGeo, getToonMaterial(0x44ff44));
  statusLight.position.set(0.25, 0.86, 0.22);
  group.add(statusLight);

  return group;
}

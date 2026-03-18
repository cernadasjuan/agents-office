import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';

export function createWaterCooler(): THREE.Group {
  const group = new THREE.Group();

  // Body
  const bodyGeo = new THREE.BoxGeometry(0.35, 0.9, 0.35);
  const body = new THREE.Mesh(bodyGeo, getToonMaterial(0xcccccc));
  body.position.y = 0.45;
  body.castShadow = true;
  group.add(body);

  // Water jug (inverted bottle)
  const jugGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.4, 8);
  const jug = new THREE.Mesh(jugGeo, getToonMaterial(0x88bbee));
  jug.position.y = 1.1;
  jug.castShadow = true;
  group.add(jug);

  // Jug cap
  const capGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.03, 8);
  const cap = new THREE.Mesh(capGeo, getToonMaterial(0x4488cc));
  cap.position.y = 0.9;
  group.add(cap);

  // Tap
  const tapGeo = new THREE.BoxGeometry(0.06, 0.04, 0.08);
  const tap = new THREE.Mesh(tapGeo, getToonMaterial(0x3366aa));
  tap.position.set(0, 0.75, 0.2);
  group.add(tap);

  // Drip tray
  const trayGeo = new THREE.BoxGeometry(0.2, 0.02, 0.12);
  const tray = new THREE.Mesh(trayGeo, getToonMaterial(0x999999));
  tray.position.set(0, 0.35, 0.22);
  group.add(tray);

  return group;
}

import * as THREE from 'three';
import { getToonMaterial, getEmissiveMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

/**
 * A debug station: the same skeleton as a work desk (`Desk.ts`), but with a
 * green screen instead of blue, and a small second "log" monitor beside it, so
 * a debugging agent reads differently from one at a plain desk.
 */
export function createDebugStation(): THREE.Group {
  const group = new THREE.Group();

  const top = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 0.9), getToonMaterial(Colors.desk));
  top.position.y = 0.75;
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);

  const legGeo = new THREE.BoxGeometry(0.06, 0.75, 0.06);
  const legMat = getToonMaterial(Colors.deskLegs);
  for (const [x, z] of [[-0.8, -0.35], [0.8, -0.35], [-0.8, 0.35], [0.8, 0.35]] as const) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(x, 0.375, z);
    leg.castShadow = true;
    group.add(leg);
  }

  // Main screen: green, debugging
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.15, 6), getToonMaterial(Colors.monitor));
  stand.position.set(-0.2, 0.87, -0.15);
  stand.castShadow = true;
  group.add(stand);
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.03), getToonMaterial(Colors.monitor));
  screen.position.set(-0.2, 1.15, -0.15);
  screen.castShadow = true;
  group.add(screen);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.33), getEmissiveMaterial(Colors.monitorScreenActive, Colors.monitorScreenActive, 0.7));
  face.position.set(-0.2, 1.15, -0.133);
  group.add(face);
  group.userData.screenFace = face;

  // Small second "log" monitor
  const logScreen = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.03), getToonMaterial(Colors.monitor));
  logScreen.position.set(0.45, 1.02, -0.15);
  logScreen.castShadow = true;
  group.add(logScreen);
  // Same intensity as the main screen, so the log monitor shares its merge bucket.
  const logFace = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.16), getEmissiveMaterial(Colors.monitorScreenActive, Colors.monitorScreenActive, 0.7));
  logFace.position.set(0.45, 1.02, -0.133);
  group.add(logFace);

  const kb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.12), getToonMaterial(Colors.monitor));
  kb.position.set(-0.1, 0.8, 0.15);
  kb.castShadow = true;
  group.add(kb);

  group.add(createChair());
  return group;
}

function createChair(): THREE.Group {
  const group = new THREE.Group();
  const matDark = getToonMaterial(0x333344);
  const matSeat = getToonMaterial(0x444466);

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.05, 0.45), matSeat);
  seat.position.set(0, 0.45, 0.7);
  seat.castShadow = true;
  group.add(seat);

  const back = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.4, 0.04), matSeat);
  back.position.set(0, 0.7, 0.9);
  back.castShadow = true;
  group.add(back);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 6), matDark);
  pole.position.set(0, 0.22, 0.7);
  group.add(pole);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 8), matDark);
  base.position.set(0, 0.02, 0.7);
  group.add(base);

  return group;
}

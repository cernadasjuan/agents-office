import * as THREE from 'three';
import { getToonMaterial, getEmissiveMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

export function createTestStation(): THREE.Group {
  const group = new THREE.Group();

  // Tall desk
  const deskGeo = new THREE.BoxGeometry(1.4, 0.08, 0.7);
  const desk = new THREE.Mesh(deskGeo, getToonMaterial(Colors.desk));
  desk.position.set(0, 1.0, 0);
  desk.castShadow = true;
  desk.receiveShadow = true;
  group.add(desk);

  // Legs
  const legGeo = new THREE.BoxGeometry(0.06, 1.0, 0.06);
  const legMat = getToonMaterial(Colors.deskLegs);
  const positions: [number, number, number][] = [
    [-0.6, 0.5, -0.25],
    [0.6, 0.5, -0.25],
    [-0.6, 0.5, 0.25],
    [0.6, 0.5, 0.25],
  ];
  for (const [x, y, z] of positions) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(x, y, z);
    leg.castShadow = true;
    group.add(leg);
  }

  // Large monitor
  const screenGeo = new THREE.BoxGeometry(0.9, 0.6, 0.04);
  const screen = new THREE.Mesh(screenGeo, getToonMaterial(Colors.monitor));
  screen.position.set(0, 1.44, -0.15);
  screen.castShadow = true;
  group.add(screen);

  // Monitor stand
  const standGeo = new THREE.CylinderGeometry(0.05, 0.07, 0.2, 6);
  const stand = new THREE.Mesh(standGeo, getToonMaterial(Colors.monitor));
  stand.position.set(0, 1.1, -0.15);
  stand.castShadow = true;
  group.add(stand);

  // Screen face - green for tests passing
  const faceGeo = new THREE.PlaneGeometry(0.8, 0.5);
  const face = new THREE.Mesh(faceGeo, getEmissiveMaterial(Colors.monitorScreenActive, Colors.monitorScreenActive, 0.6));
  face.position.set(0, 1.44, -0.128);
  group.add(face);
  group.userData.screenFace = face;

  // Progress bar on screen
  const barBgGeo = new THREE.PlaneGeometry(0.6, 0.04);
  const barBg = new THREE.Mesh(barBgGeo, getToonMaterial(0x1a1a2a));
  barBg.position.set(0, 1.35, -0.125);
  group.add(barBg);

  const barGeo = new THREE.PlaneGeometry(0.4, 0.03);
  const bar = new THREE.Mesh(barGeo, getEmissiveMaterial(0x44ff44, 0x44ff44, 1.0));
  bar.position.set(-0.1, 1.35, -0.122);
  group.add(bar);

  return group;
}

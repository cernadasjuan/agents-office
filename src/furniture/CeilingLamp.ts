import * as THREE from 'three';
import { getToonMaterial, getEmissiveMaterial } from '../utils/Materials.js';
import { OFFICE } from '../utils/Constants.js';

export function createCeilingLamp(): THREE.Group {
  const group = new THREE.Group();

  const metalMat = getToonMaterial(0x555555);
  const panelColor = 0xeeeeff;

  // Housing — rectangular box (the lamp body)
  const housingGeo = new THREE.BoxGeometry(2.4, 0.08, 0.6);
  const housing = new THREE.Mesh(housingGeo, metalMat);
  housing.position.y = 0;
  housing.castShadow = true;
  group.add(housing);

  // Side rails (thin metal edges)
  const railGeo = new THREE.BoxGeometry(2.4, 0.12, 0.03);
  const railFront = new THREE.Mesh(railGeo, metalMat);
  railFront.position.set(0, -0.02, 0.3);
  group.add(railFront);

  const railBack = new THREE.Mesh(railGeo, metalMat);
  railBack.position.set(0, -0.02, -0.3);
  group.add(railBack);

  const railSideGeo = new THREE.BoxGeometry(0.03, 0.12, 0.6);
  const railLeft = new THREE.Mesh(railSideGeo, metalMat);
  railLeft.position.set(-1.2, -0.02, 0);
  group.add(railLeft);

  const railRight = new THREE.Mesh(railSideGeo, metalMat);
  railRight.position.set(1.2, -0.02, 0);
  group.add(railRight);

  // Light panel (the glowing underside)
  const panelGeo = new THREE.PlaneGeometry(2.3, 0.55);
  const panelMat = getEmissiveMaterial(panelColor, panelColor, 1.5);
  const panel = new THREE.Mesh(panelGeo, panelMat);
  panel.rotation.x = Math.PI / 2;
  panel.position.y = -0.05;
  group.add(panel);

  // Suspension cables (2 thin cylinders from lamp to ceiling)
  const cableHeight = OFFICE.height - 5.2; // lamp hangs at y=5.2, ceiling at OFFICE.height
  const cableGeo = new THREE.CylinderGeometry(0.01, 0.01, cableHeight, 4);
  const cableMat = getToonMaterial(0x444444);

  const cable1 = new THREE.Mesh(cableGeo, cableMat);
  cable1.position.set(-0.8, cableHeight / 2, 0);
  group.add(cable1);

  const cable2 = new THREE.Mesh(cableGeo, cableMat);
  cable2.position.set(0.8, cableHeight / 2, 0);
  group.add(cable2);

  // Ceiling mount plates
  const mountGeo = new THREE.BoxGeometry(0.15, 0.02, 0.08);
  const mount1 = new THREE.Mesh(mountGeo, metalMat);
  mount1.position.set(-0.8, cableHeight, 0);
  group.add(mount1);

  const mount2 = new THREE.Mesh(mountGeo, metalMat);
  mount2.position.set(0.8, cableHeight, 0);
  group.add(mount2);

  return group;
}

export function createCeilingLampWithLight(x: number, z: number): {
  lampGroup: THREE.Group;
  light: THREE.SpotLight;
} {
  const lampGroup = createCeilingLamp();
  const lampY = 5.2;
  lampGroup.position.set(x, lampY, z);

  // SpotLight pointing down from the lamp
  const light = new THREE.SpotLight(0xfff5e6, 3, 20, Math.PI / 3, 0.5, 1);
  light.position.set(x, lampY - 0.1, z);
  light.target.position.set(x, 0, z);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.camera.near = 0.5;
  light.shadow.camera.far = 15;
  light.shadow.bias = -0.002;

  return { lampGroup, light };
}

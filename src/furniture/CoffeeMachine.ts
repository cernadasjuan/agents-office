import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

export function createCoffeeMachine(): THREE.Group {
  const group = new THREE.Group();

  // Counter
  const counterGeo = new THREE.BoxGeometry(1.2, 0.9, 0.6);
  const counter = new THREE.Mesh(counterGeo, getToonMaterial(Colors.coffeeCounter));
  counter.position.set(0, 0.45, 0);
  counter.castShadow = true;
  counter.receiveShadow = true;
  group.add(counter);

  // Machine body
  const machineGeo = new THREE.BoxGeometry(0.4, 0.5, 0.35);
  const machine = new THREE.Mesh(machineGeo, getToonMaterial(Colors.coffeeMachine));
  machine.position.set(-0.2, 1.15, 0);
  machine.castShadow = true;
  group.add(machine);

  // Machine top
  const topGeo = new THREE.BoxGeometry(0.44, 0.04, 0.38);
  const top = new THREE.Mesh(topGeo, getToonMaterial(0x555555));
  top.position.set(-0.2, 1.42, 0);
  top.castShadow = true;
  group.add(top);

  // Cup
  const cupGeo = new THREE.CylinderGeometry(0.04, 0.035, 0.1, 8);
  const cup = new THREE.Mesh(cupGeo, getToonMaterial(Colors.cup));
  cup.position.set(0.25, 0.95, 0);
  cup.castShadow = true;
  group.add(cup);

  // Steam particles (small spheres for visual effect)
  const steamMat = getToonMaterial(0xdddddd);
  for (let i = 0; i < 3; i++) {
    const steamGeo = new THREE.SphereGeometry(0.02, 4, 4);
    const steam = new THREE.Mesh(steamGeo, steamMat);
    steam.position.set(0.25 + (i - 1) * 0.02, 1.02 + i * 0.04, 0);
    steam.userData.steamIndex = i;
    group.add(steam);
  }

  return group;
}

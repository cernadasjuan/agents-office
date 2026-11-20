import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

/**
 * The main room's break-space furniture (issue #122): a counter, a fridge and
 * bar stools. Reuses the existing counter and metal colors (`Colors.coffeeCounter`,
 * the printer's grey) so the hall's static batch gains no new material.
 */

export function createKitchenCounter(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'kitchen-counter';

  const baseGeo = new THREE.BoxGeometry(2.4, 0.9, 0.6);
  const base = new THREE.Mesh(baseGeo, getToonMaterial(Colors.coffeeCounter));
  base.position.y = 0.45;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const topGeo = new THREE.BoxGeometry(2.5, 0.06, 0.65);
  const top = new THREE.Mesh(topGeo, getToonMaterial(0xbbbbbb));
  top.position.y = 0.93;
  top.castShadow = true;
  group.add(top);

  // A hob: two small dark rings on the counter top. Cast-only, like the coffee machine
  // body (the same 0x444444), so the batch this joins already exists — no new draw call.
  const hobGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.02, 10);
  const hobMat = getToonMaterial(0x444444);
  for (const x of [-0.5, 0.5]) {
    const hob = new THREE.Mesh(hobGeo, hobMat);
    hob.castShadow = true;
    hob.position.set(x, 0.97, 0);
    group.add(hob);
  }

  return group;
}

export function createFridge(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'kitchen-fridge';

  // Cast-only (like the printer stand, the same 0xbbbbbb): joins that existing batch.
  const bodyGeo = new THREE.BoxGeometry(0.8, 1.7, 0.7);
  const body = new THREE.Mesh(bodyGeo, getToonMaterial(0xbbbbbb));
  body.position.y = 0.85;
  body.castShadow = true;
  group.add(body);

  const handleGeo = new THREE.BoxGeometry(0.03, 0.5, 0.05);
  const handle = new THREE.Mesh(handleGeo, getToonMaterial(0x444444));
  handle.castShadow = true;
  handle.position.set(0.37, 1.0, 0.3);
  group.add(handle);

  return group;
}

export function createBarStool(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'kitchen-stool';

  const seatGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.06, 10);
  const seat = new THREE.Mesh(seatGeo, getToonMaterial(Colors.deskLegs));
  seat.position.y = 0.75;
  seat.castShadow = true;
  group.add(seat);

  const legGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.75, 6);
  const leg = new THREE.Mesh(legGeo, getToonMaterial(0x444444));
  leg.position.y = 0.375;
  leg.castShadow = true;
  group.add(leg);

  return group;
}

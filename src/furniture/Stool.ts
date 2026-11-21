import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';

/**
 * A small backless stool, no back, no arms: a pod subagent's own seat next to
 * its parent's desk (issue #164). Reuses the desk chair's own seat and dark
 * colors (`Desk.ts`'s `createChair`), so it shares a cached `MeshToonMaterial`
 * and costs the hall's static batch no new material, only more vertices.
 */
export function createStool(): THREE.Group {
  const group = new THREE.Group();
  const matSeat = getToonMaterial(0x444466);
  const matDark = getToonMaterial(0x333344);

  const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 8), matSeat);
  seat.position.y = 0.42;
  seat.castShadow = true;
  group.add(seat);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.38, 6), matDark);
  pole.position.y = 0.21;
  pole.castShadow = true;
  group.add(pole);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.03, 8), matDark);
  base.position.y = 0.02;
  base.castShadow = true;
  group.add(base);

  return group;
}

import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

const RADIAL_SEGMENTS = 6;

// Every figure shares one geometry per part shape, so the figure batch draws all
// figures' parts of one shape and color in one call (src/characters/FigureBatch.ts).
const sharedGeometries = new Map<string, THREE.BufferGeometry>();

function shared(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let geometry = sharedGeometries.get(key);
  if (!geometry) {
    geometry = build();
    sharedGeometries.set(key, geometry);
  }
  return geometry;
}

/** A body part of a stick figure. The figure batch draws these meshes instanced. */
function part(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.userData.figurePart = true;
  return mesh;
}

export function createHead(): THREE.Mesh {
  return part(shared('head', () => new THREE.SphereGeometry(0.15, 8, 8)), getToonMaterial(Colors.skin));
}

export function createTorso(accentColor: THREE.Color): THREE.Mesh {
  return part(shared('torso', () => new THREE.CylinderGeometry(0.12, 0.15, 0.6, RADIAL_SEGMENTS)), getToonMaterial(accentColor));
}

export function createLimb(length: number, radius = 0.035): THREE.Mesh {
  const geometry = shared(`limb:${length}:${radius}`, () => {
    const geo = new THREE.CylinderGeometry(radius, radius, length, RADIAL_SEGMENTS);
    geo.translate(0, -length / 2, 0);
    return geo;
  });
  return part(geometry, getToonMaterial(Colors.limb));
}

export function createHand(): THREE.Mesh {
  return part(shared('hand', () => new THREE.BoxGeometry(0.06, 0.06, 0.06)), getToonMaterial(Colors.skin));
}

export function createFoot(): THREE.Mesh {
  return part(shared('foot', () => new THREE.BoxGeometry(0.08, 0.05, 0.12)), getToonMaterial(Colors.shoe));
}

export interface Joints {
  root: THREE.Group;
  body: THREE.Group;
  hips: THREE.Group;
  shoulders: THREE.Group;
  neck: THREE.Group;
  head: THREE.Mesh;
  torso: THREE.Mesh;
  leftUpperArm: THREE.Group;
  leftForearm: THREE.Group;
  leftHand: THREE.Mesh;
  rightUpperArm: THREE.Group;
  rightForearm: THREE.Group;
  rightHand: THREE.Mesh;
  leftUpperLeg: THREE.Group;
  leftLowerLeg: THREE.Group;
  leftFoot: THREE.Mesh;
  rightUpperLeg: THREE.Group;
  rightLowerLeg: THREE.Group;
  rightFoot: THREE.Mesh;
}

export function buildSkeleton(accentColor: THREE.Color): Joints {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Hips
  const hips = new THREE.Group();
  hips.position.y = 0.9;
  body.add(hips);

  // Torso
  const torso = createTorso(accentColor);
  torso.position.y = 0.3;
  hips.add(torso);

  // --- Legs ---
  const leftUpperLeg = new THREE.Group();
  leftUpperLeg.position.set(-0.1, 0, 0);
  hips.add(leftUpperLeg);
  const leftUpperLegMesh = createLimb(0.4);
  leftUpperLeg.add(leftUpperLegMesh);

  const leftLowerLeg = new THREE.Group();
  leftLowerLeg.position.set(0, -0.4, 0);
  leftUpperLeg.add(leftLowerLeg);
  const leftLowerLegMesh = createLimb(0.4);
  leftLowerLeg.add(leftLowerLegMesh);

  const leftFoot = createFoot();
  leftFoot.position.set(0, -0.4, 0.03);
  leftLowerLeg.add(leftFoot);

  const rightUpperLeg = new THREE.Group();
  rightUpperLeg.position.set(0.1, 0, 0);
  hips.add(rightUpperLeg);
  const rightUpperLegMesh = createLimb(0.4);
  rightUpperLeg.add(rightUpperLegMesh);

  const rightLowerLeg = new THREE.Group();
  rightLowerLeg.position.set(0, -0.4, 0);
  rightUpperLeg.add(rightLowerLeg);
  const rightLowerLegMesh = createLimb(0.4);
  rightLowerLeg.add(rightLowerLegMesh);

  const rightFoot = createFoot();
  rightFoot.position.set(0, -0.4, 0.03);
  rightLowerLeg.add(rightFoot);

  // Shoulders
  const shoulders = new THREE.Group();
  shoulders.position.y = 1.5;
  body.add(shoulders);

  // --- Arms ---
  const leftUpperArm = new THREE.Group();
  leftUpperArm.position.set(-0.2, 0, 0);
  shoulders.add(leftUpperArm);
  const leftUpperArmMesh = createLimb(0.3);
  leftUpperArm.add(leftUpperArmMesh);

  const leftForearm = new THREE.Group();
  leftForearm.position.set(0, -0.3, 0);
  leftUpperArm.add(leftForearm);
  const leftForearmMesh = createLimb(0.3);
  leftForearm.add(leftForearmMesh);

  const leftHand = createHand();
  leftHand.position.set(0, -0.3, 0);
  leftForearm.add(leftHand);

  const rightUpperArm = new THREE.Group();
  rightUpperArm.position.set(0.2, 0, 0);
  shoulders.add(rightUpperArm);
  const rightUpperArmMesh = createLimb(0.3);
  rightUpperArm.add(rightUpperArmMesh);

  const rightForearm = new THREE.Group();
  rightForearm.position.set(0, -0.3, 0);
  rightUpperArm.add(rightForearm);
  const rightForearmMesh = createLimb(0.3);
  rightForearm.add(rightForearmMesh);

  const rightHand = createHand();
  rightHand.position.set(0, -0.3, 0);
  rightForearm.add(rightHand);

  // Neck + Head
  const neck = new THREE.Group();
  neck.position.y = 1.6;
  body.add(neck);

  const head = createHead();
  head.position.y = 0.15;
  neck.add(head);

  return {
    root, body, hips, shoulders, neck, head, torso,
    leftUpperArm, leftForearm, leftHand,
    rightUpperArm, rightForearm, rightHand,
    leftUpperLeg, leftLowerLeg, leftFoot,
    rightUpperLeg, rightLowerLeg, rightFoot,
  };
}

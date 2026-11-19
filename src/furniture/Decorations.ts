import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

export function createPlant(scale = 1): THREE.Group {
  const group = new THREE.Group();

  const potGeo = new THREE.CylinderGeometry(0.12 * scale, 0.09 * scale, 0.2 * scale, 8);
  const pot = new THREE.Mesh(potGeo, getToonMaterial(Colors.pot));
  pot.position.y = 0.1 * scale;
  pot.castShadow = true;
  group.add(pot);

  const dirtGeo = new THREE.CylinderGeometry(0.11 * scale, 0.11 * scale, 0.02 * scale, 8);
  const dirt = new THREE.Mesh(dirtGeo, getToonMaterial(0x5a3a1a));
  dirt.position.y = 0.21 * scale;
  group.add(dirt);

  const leafMat = getToonMaterial(Colors.plant);
  const leafMatLight = getToonMaterial(Colors.plantLight);

  const leaf1 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15 * scale, 0), leafMat);
  leaf1.position.set(0, 0.45 * scale, 0);
  leaf1.castShadow = true;
  group.add(leaf1);

  const leaf2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12 * scale, 0), leafMatLight);
  leaf2.position.set(0.08 * scale, 0.55 * scale, 0.05 * scale);
  leaf2.castShadow = true;
  group.add(leaf2);

  const leaf3 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1 * scale, 0), leafMat);
  leaf3.position.set(-0.06 * scale, 0.5 * scale, -0.04 * scale);
  leaf3.castShadow = true;
  group.add(leaf3);

  return group;
}

export function createTallPlant(): THREE.Group {
  const group = new THREE.Group();

  // Tall pot
  const potGeo = new THREE.CylinderGeometry(0.18, 0.14, 0.4, 8);
  const pot = new THREE.Mesh(potGeo, getToonMaterial(Colors.pot));
  pot.position.y = 0.2;
  pot.castShadow = true;
  group.add(pot);

  const dirtGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.03, 8);
  const dirt = new THREE.Mesh(dirtGeo, getToonMaterial(0x5a3a1a));
  dirt.position.y = 0.41;
  group.add(dirt);

  // Trunk
  const trunkGeo = new THREE.CylinderGeometry(0.03, 0.04, 0.8, 6);
  const trunk = new THREE.Mesh(trunkGeo, getToonMaterial(0x8b6914));
  trunk.position.y = 0.8;
  trunk.castShadow = true;
  group.add(trunk);

  // Foliage clusters
  const leafMat = getToonMaterial(Colors.plant);
  const leafMatLight = getToonMaterial(Colors.plantLight);
  const foliagePositions: [number, number, number, number][] = [
    [0, 1.3, 0, 0.22],
    [0.1, 1.2, 0.08, 0.16],
    [-0.08, 1.25, -0.06, 0.14],
    [0.05, 1.4, -0.05, 0.12],
  ];
  foliagePositions.forEach(([x, y, z, r], i) => {
    const geo = new THREE.IcosahedronGeometry(r, 0);
    const mesh = new THREE.Mesh(geo, i % 2 === 0 ? leafMat : leafMatLight);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
  });

  return group;
}

export function createWallArt(width: number, height: number, color: number, frameColor = 0x333333): THREE.Group {
  const group = new THREE.Group();

  // Frame
  const frameMat = getToonMaterial(frameColor);
  const frameW = 0.04;

  const top = new THREE.Mesh(new THREE.BoxGeometry(width + frameW * 2, frameW, 0.03), frameMat);
  top.position.y = height / 2 + frameW / 2;
  group.add(top);

  const bottom = new THREE.Mesh(new THREE.BoxGeometry(width + frameW * 2, frameW, 0.03), frameMat);
  bottom.position.y = -(height / 2 + frameW / 2);
  group.add(bottom);

  const left = new THREE.Mesh(new THREE.BoxGeometry(frameW, height, 0.03), frameMat);
  left.position.x = -(width / 2 + frameW / 2);
  group.add(left);

  const right = new THREE.Mesh(new THREE.BoxGeometry(frameW, height, 0.03), frameMat);
  right.position.x = width / 2 + frameW / 2;
  group.add(right);

  // Canvas
  const canvasGeo = new THREE.PlaneGeometry(width, height);
  const canvas = new THREE.Mesh(canvasGeo, getToonMaterial(color));
  canvas.position.z = 0.005;
  group.add(canvas);

  return group;
}

export function createClock(): THREE.Group {
  const group = new THREE.Group();

  const faceGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.04, 16);
  const face = new THREE.Mesh(faceGeo, getToonMaterial(0xf5f5f0));
  face.rotation.x = Math.PI / 2;
  face.castShadow = true;
  group.add(face);

  const rimGeo = new THREE.TorusGeometry(0.25, 0.02, 8, 24);
  const rim = new THREE.Mesh(rimGeo, getToonMaterial(0x333333));
  rim.castShadow = true;
  group.add(rim);

  const hourGeo = new THREE.BoxGeometry(0.02, 0.14, 0.01);
  const hour = new THREE.Mesh(hourGeo, getToonMaterial(0x222222));
  hour.position.set(0, 0.07, 0.03);
  group.add(hour);

  const minGeo = new THREE.BoxGeometry(0.015, 0.2, 0.01);
  const min = new THREE.Mesh(minGeo, getToonMaterial(0x222222));
  min.position.set(0, 0.1, 0.035);
  group.add(min);

  return group;
}

export function createRug(width: number, depth: number, color: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(width, depth);
  const rug = new THREE.Mesh(geo, getToonMaterial(color));
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.01;
  rug.receiveShadow = true;
  return rug;
}

export function createDecorations(): THREE.Group {
  const group = new THREE.Group();

  // Corner plants (small)
  const smallPlantPositions: [number, number, number][] = [
    [-13.5, 0, -11.5],
    [13.5, 0, -11.5],
    [-13.5, 0, 11.5],
    [13.5, 0, 11.5],
    [-6, 0, 1.5],
  ];
  for (const [x, y, z] of smallPlantPositions) {
    const plant = createPlant();
    plant.position.set(x, y, z);
    group.add(plant);
  }

  // Tall plants for atmosphere
  const tallPlantPositions: [number, number, number][] = [
    [-13, 0, -5],
    [13, 0, -5],
    [-13, 0, 5],
    [13, 0, 5],
    [-8, 0, 8],
    [4, 0, 8],
  ];
  for (const [x, y, z] of tallPlantPositions) {
    const plant = createTallPlant();
    plant.position.set(x, y, z);
    group.add(plant);
  }

  // Clock on back wall
  const clock = createClock();
  clock.position.set(0, 4.5, -12.9);
  group.add(clock);

  // Wall art on back wall
  const art1 = createWallArt(0.8, 0.5, 0x4477aa);
  art1.position.set(-9, 3.0, -12.9);
  group.add(art1);

  const art2 = createWallArt(0.6, 0.8, 0xaa5544);
  art2.position.set(9, 3.2, -12.9);
  group.add(art2);

  // Wall art on left wall
  const art3 = createWallArt(0.7, 0.5, 0x55aa77);
  art3.position.set(-14.9, 3.0, -7);
  art3.rotation.y = Math.PI / 2;
  group.add(art3);

  const art4 = createWallArt(0.9, 0.6, 0xcc9944);
  art4.position.set(-14.9, 3.0, 7);
  art4.rotation.y = Math.PI / 2;
  group.add(art4);

  // Wall art on right wall
  const art5 = createWallArt(0.8, 0.6, 0x7755aa);
  art5.position.set(14.9, 3.0, -3);
  art5.rotation.y = -Math.PI / 2;
  group.add(art5);

  // Meeting area rug
  const meetingRug = createRug(5, 5, 0x7a6a5a);
  meetingRug.position.set(9, 0.01, 9);
  group.add(meetingRug);

  return group;
}

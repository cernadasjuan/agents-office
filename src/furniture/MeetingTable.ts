import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

export function createMeetingTable(): THREE.Group {
  const group = new THREE.Group();

  // Round table top
  const topGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.06, 16);
  const top = new THREE.Mesh(topGeo, getToonMaterial(Colors.desk));
  top.position.y = 0.75;
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);

  // Central leg
  const legGeo = new THREE.CylinderGeometry(0.08, 0.12, 0.72, 8);
  const leg = new THREE.Mesh(legGeo, getToonMaterial(Colors.deskLegs));
  leg.position.y = 0.36;
  leg.castShadow = true;
  group.add(leg);

  // Base plate
  const baseGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.03, 12);
  const base = new THREE.Mesh(baseGeo, getToonMaterial(Colors.deskLegs));
  base.position.y = 0.015;
  base.castShadow = true;
  group.add(base);

  // 4 chairs around the table
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const chair = createSimpleChair();
    chair.position.set(Math.sin(angle) * 1.7, 0, Math.cos(angle) * 1.7);
    chair.rotation.y = angle + Math.PI;
    group.add(chair);
  }

  return group;
}

function createSimpleChair(): THREE.Group {
  const group = new THREE.Group();
  const matSeat = getToonMaterial(0x5566aa);
  const matFrame = getToonMaterial(0x666666);

  // Seat
  const seatGeo = new THREE.BoxGeometry(0.4, 0.04, 0.4);
  const seat = new THREE.Mesh(seatGeo, matSeat);
  seat.position.y = 0.45;
  seat.castShadow = true;
  group.add(seat);

  // Back
  const backGeo = new THREE.BoxGeometry(0.4, 0.35, 0.04);
  const back = new THREE.Mesh(backGeo, matSeat);
  back.position.set(0, 0.67, -0.18);
  back.castShadow = true;
  group.add(back);

  // Legs (4)
  const legGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.45, 6);
  const positions: [number, number][] = [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]];
  for (const [x, z] of positions) {
    const leg = new THREE.Mesh(legGeo, matFrame);
    leg.position.set(x, 0.225, z);
    group.add(leg);
  }

  return group;
}

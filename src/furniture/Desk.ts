import * as THREE from 'three';
import { getToonMaterial, getEmissiveMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

export function createDesk(hasMonitor = true) {
  const group = new THREE.Group();

  // Table top
  const topGeo = new THREE.BoxGeometry(1.8, 0.08, 0.9);
  const top = new THREE.Mesh(topGeo, getToonMaterial(Colors.desk));
  top.position.y = 0.75;
  top.castShadow = true;
  top.receiveShadow = true;
  group.add(top);

  // Legs
  const legGeo = new THREE.BoxGeometry(0.06, 0.75, 0.06);
  const legMat = getToonMaterial(Colors.deskLegs);
  const positions = [
    [-0.8, 0.375, -0.35],
    [0.8, 0.375, -0.35],
    [-0.8, 0.375, 0.35],
    [0.8, 0.375, 0.35],
  ];
  for (const [x, y, z] of positions) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(x, y, z);
    leg.castShadow = true;
    group.add(leg);
  }

  if (hasMonitor) {
    // Monitor stand
    const standGeo = new THREE.CylinderGeometry(0.04, 0.06, 0.15, 6);
    const stand = new THREE.Mesh(standGeo, getToonMaterial(Colors.monitor));
    stand.position.set(0, 0.87, -0.15);
    stand.castShadow = true;
    group.add(stand);

    // Monitor screen
    const screenGeo = new THREE.BoxGeometry(0.7, 0.45, 0.03);
    const screen = new THREE.Mesh(screenGeo, getToonMaterial(Colors.monitor));
    screen.position.set(0, 1.17, -0.15);
    screen.castShadow = true;
    group.add(screen);

    // Screen face (front)
    const faceGeo = new THREE.PlaneGeometry(0.62, 0.38);
    const face = new THREE.Mesh(faceGeo, getEmissiveMaterial(Colors.monitorScreen, Colors.monitorScreen, 0.8));
    face.position.set(0, 1.17, -0.133);
    group.add(face);
    group.userData.screenFace = face;

    // Keyboard
    const kbGeo = new THREE.BoxGeometry(0.4, 0.02, 0.12);
    const kb = new THREE.Mesh(kbGeo, getToonMaterial(Colors.monitor));
    kb.position.set(0, 0.8, 0.15);
    kb.castShadow = true;
    group.add(kb);
  }

  // Chair. Named (not just grouped), so the office's own desk-view camera — which sits
  // essentially where this chair is (`deskGeometry.ts`'s `DESK_SEAT_OFFSET`, "inside the
  // chair, not on top of the desk") — can find and hide this one specific chair instead of
  // rendering Gabriel's own seat back at him as a looming dark shape at the bottom of his own
  // view (issue #243). Every other desk (war rooms included) keeps its chair visible; nothing
  // here changes for them.
  const chairGroup = createChair();
  chairGroup.name = 'desk-chair';
  chairGroup.position.set(0, 0, 0.7);
  group.add(chairGroup);

  return group;
}

function createChair() {
  const group = new THREE.Group();
  const matDark = getToonMaterial(0x333344);
  const matSeat = getToonMaterial(0x444466);

  // Seat
  const seatGeo = new THREE.BoxGeometry(0.45, 0.05, 0.45);
  const seat = new THREE.Mesh(seatGeo, matSeat);
  seat.position.y = 0.45;
  seat.castShadow = true;
  group.add(seat);

  // Back
  const backGeo = new THREE.BoxGeometry(0.45, 0.4, 0.04);
  const back = new THREE.Mesh(backGeo, matSeat);
  back.position.set(0, 0.7, 0.2);
  back.castShadow = true;
  group.add(back);

  // Pole
  const poleGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.4, 6);
  const pole = new THREE.Mesh(poleGeo, matDark);
  pole.position.y = 0.22;
  group.add(pole);

  // Base
  const baseGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.03, 8);
  const base = new THREE.Mesh(baseGeo, matDark);
  base.position.y = 0.02;
  group.add(base);

  return group;
}

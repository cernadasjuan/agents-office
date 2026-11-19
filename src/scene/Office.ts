import * as THREE from 'three';
import type { Posture } from '../layout/LayoutStrategy.js';
import { createFloor } from '../furniture/Floor.js';
import { createDesk } from '../furniture/Desk.js';
import { createWhiteboard } from '../furniture/Whiteboard.js';
import { createBookshelf } from '../furniture/Bookshelf.js';
import { createCoffeeMachine } from '../furniture/CoffeeMachine.js';
import { createTestStation } from '../furniture/TestStation.js';
import { createWalls } from '../furniture/Walls.js';
import { createDecorations } from '../furniture/Decorations.js';
import { createMeetingTable } from '../furniture/MeetingTable.js';
import { createSofa } from '../furniture/Sofa.js';
import { createWaterCooler } from '../furniture/WaterCooler.js';
import { createPrinter } from '../furniture/Printer.js';

/** Scene name of the hall walls group. */
export const OFFICE_WALLS = 'office-walls';

export interface Station {
  type: string;
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
  occupied: boolean;
  /** Force a posture at this station (a sofa seats, an open spot stands). */
  posture?: Posture;
}

export function createOffice(scene: THREE.Scene): Map<string, Station> {
  const stations = new Map<string, Station>();

  // Floor
  scene.add(createFloor());

  // Walls + Ceiling (named, so a layout add-on can replace them with walls that have doorways)
  const walls = createWalls();
  walls.name = OFFICE_WALLS;
  scene.add(walls);

  // Decorations (plants, art, clock, rugs)
  scene.add(createDecorations());

  // --- Whiteboards (Planning) — against back wall ---
  const wb1 = createWhiteboard();
  wb1.position.set(-5, 0, -12);
  scene.add(wb1);
  stations.set('whiteboard_0', {
    type: 'planning',
    position: new THREE.Vector3(-5, 0, -11.2),
    lookAt: new THREE.Vector3(-5, 1.5, -12),
    occupied: false,
  });

  const wb2 = createWhiteboard();
  wb2.position.set(5, 0, -12);
  scene.add(wb2);
  stations.set('whiteboard_1', {
    type: 'planning',
    position: new THREE.Vector3(5, 0, -11.2),
    lookAt: new THREE.Vector3(5, 1.5, -12),
    occupied: false,
  });

  // --- Coding Desks (2 rows of 3) ---
  const deskPositions: [number, number][] = [
    [-8, -5],
    [-3, -5],
    [3, -5],
    [8, -5],
    [-8, -2],
    [-3, -2],
    [3, -2],
    [8, -2],
  ];
  deskPositions.forEach(([x, z], i) => {
    const desk = createDesk(true);
    desk.position.set(x, 0, z);
    scene.add(desk);
    stations.set(`desk_${i}`, {
      type: 'implementing',
      position: new THREE.Vector3(x, 0, z + 0.7),
      lookAt: new THREE.Vector3(x, 1.2, z - 0.15),
      occupied: false,
    });
  });

  // --- Bookshelves (Researching) — along left wall ---
  const bookshelf1 = createBookshelf();
  bookshelf1.position.set(-13.5, 0, -2);
  bookshelf1.rotation.y = Math.PI / 2;
  scene.add(bookshelf1);

  const bookshelf2 = createBookshelf();
  bookshelf2.position.set(-13.5, 0, 0.5);
  bookshelf2.rotation.y = Math.PI / 2;
  scene.add(bookshelf2);

  stations.set('bookshelf_0', {
    type: 'researching',
    position: new THREE.Vector3(-12.5, 0, -2),
    lookAt: new THREE.Vector3(-13.5, 1.0, -2),
    occupied: false,
  });
  stations.set('bookshelf_1', {
    type: 'researching',
    position: new THREE.Vector3(-12.5, 0, 0.5),
    lookAt: new THREE.Vector3(-13.5, 1.0, 0.5),
    occupied: false,
  });

  // --- Test Station (Running tests) — right side ---
  const testStation1 = createTestStation();
  testStation1.position.set(12, 0, -2);
  scene.add(testStation1);
  stations.set('test_0', {
    type: 'testing',
    position: new THREE.Vector3(12, 0, -1.2),
    lookAt: new THREE.Vector3(12, 1.4, -2),
    occupied: false,
  });

  const testStation2 = createTestStation();
  testStation2.position.set(12, 0, 1.5);
  scene.add(testStation2);
  stations.set('test_1', {
    type: 'testing',
    position: new THREE.Vector3(12, 0, 2.2),
    lookAt: new THREE.Vector3(12, 1.4, 1.5),
    occupied: false,
  });

  // --- Review Desks (Reviewing / Writing docs) ---
  const reviewPositions: [number, number][] = [
    [-5, 4],
    [3, 4],
    [9, 4],
  ];
  reviewPositions.forEach(([x, z], i) => {
    const desk = createDesk(true);
    desk.position.set(x, 0, z);
    scene.add(desk);
    stations.set(`review_${i}`, {
      type: 'reviewing',
      position: new THREE.Vector3(x, 0, z + 0.7),
      lookAt: new THREE.Vector3(x, 1.2, z - 0.15),
      occupied: false,
    });
  });

  // --- Coffee Machine (Idle) — front-left ---
  const coffee = createCoffeeMachine();
  coffee.position.set(-12, 0, 9);
  scene.add(coffee);
  stations.set('coffee_0', {
    type: 'idle',
    position: new THREE.Vector3(-11.2, 0, 9),
    lookAt: new THREE.Vector3(-12, 1.0, 9),
    occupied: false,
  });
  stations.set('coffee_1', {
    type: 'idle',
    position: new THREE.Vector3(-10.8, 0, 9.5),
    lookAt: new THREE.Vector3(-12, 1.0, 9),
    occupied: false,
  });

  // --- Water Cooler — near coffee ---
  const waterCooler = createWaterCooler();
  waterCooler.position.set(-12, 0, 7);
  scene.add(waterCooler);

  // --- Printer — against right wall ---
  const printer = createPrinter();
  printer.position.set(13, 0, 5);
  printer.rotation.y = -Math.PI / 2;
  scene.add(printer);

  // --- Meeting area (front-right) — round table + sofa ---
  const meetingTable = createMeetingTable();
  meetingTable.position.set(9, 0, 9);
  scene.add(meetingTable);

  stations.set('meeting_0', {
    type: 'meeting',
    position: new THREE.Vector3(9, 0, 7.3),
    lookAt: new THREE.Vector3(9, 1.2, 9),
    occupied: false,
  });
  stations.set('meeting_1', {
    type: 'meeting',
    position: new THREE.Vector3(10.7, 0, 9),
    lookAt: new THREE.Vector3(9, 1.2, 9),
    occupied: false,
  });
  stations.set('meeting_2', {
    type: 'meeting',
    position: new THREE.Vector3(7.3, 0, 9),
    lookAt: new THREE.Vector3(9, 1.2, 9),
    occupied: false,
  });

  // --- Sofa — lounge area front-left ---
  const sofa1 = createSofa(0x6a5acd);
  sofa1.position.set(-6, 0, 10);
  sofa1.rotation.y = Math.PI;
  scene.add(sofa1);

  const sofa2 = createSofa(0x5a7aad);
  sofa2.position.set(-3, 0, 10);
  sofa2.rotation.y = Math.PI;
  scene.add(sofa2);

  // Three seats per sofa for agents taking a break. They sit, facing the room.
  const SOFA_SEAT_OFFSETS = [-0.6, 0, 0.6];
  [-6, -3].forEach((sofaX, sofa) => {
    SOFA_SEAT_OFFSETS.forEach((offset, seat) => {
      const x = sofaX + offset;
      stations.set(`sofa_${sofa * SOFA_SEAT_OFFSETS.length + seat}`, {
        type: 'idle',
        position: new THREE.Vector3(x, 0, 10.05),
        lookAt: new THREE.Vector3(x, 0.8, 9),
        occupied: false,
        posture: 'seated',
      });
    });
  });

  // --- Second bookshelf against back wall (right side) ---
  const bookshelf3 = createBookshelf();
  bookshelf3.position.set(11, 0, -12);
  scene.add(bookshelf3);

  return stations;
}

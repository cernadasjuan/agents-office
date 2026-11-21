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
import { createBarStool, createFridge, createKitchenCounter } from '../furniture/Kitchen.js';
import { createFoosballTable } from '../furniture/FoosballTable.js';
import { createAirHockeyTable } from '../furniture/AirHockeyTable.js';
import { createArcadeCabinet } from '../furniture/ArcadeCabinet.js';
import { createToolCrib } from '../furniture/ToolCrib.js';
import { markStatic } from './StaticMerge.js';

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
  // The hall's furniture does not move: it draws merged, one mesh per material
  const hall = new THREE.Group();
  hall.name = 'hall';
  markStatic(hall, { zone: 'hall' });
  scene.add(hall);

  // Floor
  hall.add(createFloor());

  // Walls + Ceiling (named, so a layout add-on can replace them with walls that have doorways)
  const walls = createWalls();
  walls.name = OFFICE_WALLS;
  hall.add(walls);

  // Decorations (plants, art, clock, rugs)
  hall.add(createDecorations());

  // --- Whiteboards (Planning) — against back wall ---
  const wb1 = createWhiteboard();
  wb1.position.set(-5, 0, -12);
  hall.add(wb1);
  stations.set('whiteboard_0', {
    type: 'planning',
    position: new THREE.Vector3(-5, 0, -11.2),
    lookAt: new THREE.Vector3(-5, 1.5, -12),
    occupied: false,
  });

  const wb2 = createWhiteboard();
  wb2.position.set(5, 0, -12);
  hall.add(wb2);
  stations.set('whiteboard_1', {
    type: 'planning',
    position: new THREE.Vector3(5, 0, -11.2),
    lookAt: new THREE.Vector3(5, 1.5, -12),
    occupied: false,
  });

  // --- Coding Desks, in the back corners (issue #121): the center stays open for the kitchen and play zones below ---
  // Two rows of four, one pair of desks per corner, indexed row-major (desk_0..3 the back row,
  // desk_4..7 the row in front of it) so a same-column desk (desk_3 and desk_7, 3 m apart)
  // stays a near neighbor and a same-row desk across the room (desk_3 and desk_4) stays far.
  const deskPositions: [number, number][] = [
    [-12, -10],
    [-9, -10],
    [9, -10],
    [12, -10],
    [-12, -7],
    [-9, -7],
    [9, -7],
    [12, -7],
  ];
  deskPositions.forEach(([x, z], i) => {
    const desk = createDesk(true);
    desk.position.set(x, 0, z);
    hall.add(desk);
    stations.set(`desk_${i}`, {
      type: 'implementing',
      position: new THREE.Vector3(x, 0, z + 0.7),
      lookAt: new THREE.Vector3(x, 1.2, z - 0.15),
      occupied: false,
    });
  });

  // --- Kitchen zone (issue #122), in the center the desks left: a counter, a fridge, two stools ---
  const kitchenCounter = createKitchenCounter();
  kitchenCounter.position.set(0, 0, -9.3);
  hall.add(kitchenCounter);

  const fridge = createFridge();
  fridge.position.set(-2.6, 0, -9.3);
  hall.add(fridge);

  const stoolPositions: [number, number][] = [[-0.5, -8], [0.5, -8]];
  stoolPositions.forEach(([x, z]) => {
    const stool = createBarStool();
    stool.position.set(x, 0, z);
    hall.add(stool);
  });

  // --- Play zone (issue #122): a foosball table, an air hockey table and a video game cabinet ---
  const foosball = createFoosballTable();
  foosball.position.set(-2.5, 0, -1);
  hall.add(foosball);

  const airHockey = createAirHockeyTable();
  airHockey.position.set(2.5, 0, -1);
  hall.add(airHockey);

  // --- Tool crib (issue #167 addendum) — center-right, a small counter between the play zone and the review desks ---
  const toolCrib = createToolCrib();
  toolCrib.position.set(6, 0, 1);
  hall.add(toolCrib);

  const arcadeCabinet = createArcadeCabinet();
  arcadeCabinet.position.set(0, 0, -3.2);
  arcadeCabinet.rotation.y = Math.PI;
  hall.add(arcadeCabinet);

  // --- Bookshelves (Researching) — along left wall ---
  const bookshelf1 = createBookshelf();
  bookshelf1.position.set(-13.5, 0, -2);
  bookshelf1.rotation.y = Math.PI / 2;
  hall.add(bookshelf1);

  const bookshelf2 = createBookshelf();
  bookshelf2.position.set(-13.5, 0, 0.5);
  bookshelf2.rotation.y = Math.PI / 2;
  hall.add(bookshelf2);

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
  hall.add(testStation1);
  stations.set('test_0', {
    type: 'testing',
    position: new THREE.Vector3(12, 0, -1.2),
    lookAt: new THREE.Vector3(12, 1.4, -2),
    occupied: false,
  });

  const testStation2 = createTestStation();
  testStation2.position.set(12, 0, 1.5);
  hall.add(testStation2);
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
    hall.add(desk);
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
  hall.add(coffee);
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
  hall.add(waterCooler);

  // --- Printer — against right wall ---
  const printer = createPrinter();
  printer.position.set(13, 0, 5);
  printer.rotation.y = -Math.PI / 2;
  hall.add(printer);

  // --- Meeting area (front-right) — round table + sofa ---
  const meetingTable = createMeetingTable();
  meetingTable.position.set(9, 0, 9);
  hall.add(meetingTable);

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
  hall.add(sofa1);

  const sofa2 = createSofa(0x5a7aad);
  sofa2.position.set(-3, 0, 10);
  sofa2.rotation.y = Math.PI;
  hall.add(sofa2);

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
  hall.add(bookshelf3);

  return stations;
}

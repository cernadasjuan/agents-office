import * as THREE from 'three';
import { createArmchair } from './Armchair.js';
import { createBookshelf } from './Bookshelf.js';
import { createCoffeeMachine } from './CoffeeMachine.js';
import { createClock, createPlant, createRug, createTallPlant, createWallArt } from './Decorations.js';
import { createDesk } from './Desk.js';
import { createDisplayShelf } from './DisplayShelf.js';
import { createFloorLamp } from './FloorLamp.js';
import { createMeetingTable } from './MeetingTable.js';
import { createPortrait } from './Portrait.js';
import { createPrinter } from './Printer.js';
import { createSofa } from './Sofa.js';
import { createCredenza, createLowTable } from './Tables.js';
import { createTestStation } from './TestStation.js';
import { createTombstone } from './Tombstone.js';
import { createWaterCooler } from './WaterCooler.js';
import { createWhiteboard } from './Whiteboard.js';

/**
 * The furniture library: every piece a room can hold, in one place. Code builds
 * each piece (nothing is imported from a file); a room plan names pieces from here
 * and gives their positions (`src/addons/building/furnishing.ts`).
 *
 * `station`: a piece agents work at (desk, sofa, whiteboard). `furniture`: decor
 * that stands or hangs in a room. `plant`: a potted plant.
 */
export type PieceCategory = 'station' | 'furniture' | 'plant';

export interface PieceSpec {
  readonly name: PieceName;
  readonly category: PieceCategory;
  /** Builds a new copy. Its front looks along +z and it stands on y = 0, centered on the origin. */
  readonly create: () => THREE.Object3D;
}

const piece = <N extends string>(name: N, category: PieceCategory, create: () => THREE.Object3D) => ({ name, category, create });

export const PIECES = {
  desk: () => piece('desk', 'station', () => createDesk(true)),
  whiteboard: () => piece('whiteboard', 'station', createWhiteboard),
  bookshelf: () => piece('bookshelf', 'station', createBookshelf),
  testStation: () => piece('testStation', 'station', createTestStation),
  sofa: (color = 0x6a5acd) => piece('sofa', 'station', () => createSofa(color)),
  coffeeMachine: () => piece('coffeeMachine', 'station', createCoffeeMachine),
  meetingTable: () => piece('meetingTable', 'station', createMeetingTable),
  printer: () => piece('printer', 'furniture', createPrinter),
  waterCooler: () => piece('waterCooler', 'furniture', createWaterCooler),
  armchair: (color?: number) => piece('armchair', 'furniture', () => createArmchair(color)),
  lowTable: () => piece('lowTable', 'furniture', createLowTable),
  credenza: () => piece('credenza', 'furniture', createCredenza),
  displayShelf: () => piece('displayShelf', 'furniture', createDisplayShelf),
  floorLamp: () => piece('floorLamp', 'furniture', createFloorLamp),
  // In a group, so a room can turn the rug about y and it stays flat
  rug: (width = 3, depth = 2, color = 0x2c3e50) => piece('rug', 'furniture', () => new THREE.Group().add(createRug(width, depth, color))),
  wallArt: (width = 0.9, height = 0.6, color = 0x2980b9, frameColor = 0x222222) =>
    piece('wallArt', 'furniture', () => createWallArt(width, height, color, frameColor)),
  clock: () => piece('clock', 'furniture', createClock),
  portrait: () => piece('portrait', 'furniture', createPortrait),
  tombstone: () => piece('tombstone', 'furniture', createTombstone),
  plant: (scale = 1.2) => piece('plant', 'plant', () => createPlant(scale)),
  tallPlant: () => piece('tallPlant', 'plant', createTallPlant),
} as const;

export type PieceName = keyof typeof PIECES;

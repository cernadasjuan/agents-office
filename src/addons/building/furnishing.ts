import { Colors } from '../../utils/Colors.js';
import { PIECES, type PieceSpec } from '../../furniture/index.js';
import type { Posture } from '../../layout/LayoutStrategy.js';
import { ROOM_SIZE } from './RoomPlanner.js';
import type { RoomKind } from './rooms.js';

/**
 * One furnishing plan per room kind: which pieces from the furniture library
 * (`src/furniture/index.ts`) stand where, and where agents stand or sit. Plans
 * hold positions only, in the room frame (`RoomFrame`): `a` runs along the door
 * wall (-6 to 6), `d` is the depth from the door wall (0 to 12). `rooms.ts` turns
 * a plan into objects. No geometry is built here.
 */

/** A piece in a room. `turn` is added to the rotation that faces the door: 0 faces the door, PI faces away. */
export interface Placement {
  piece: PieceSpec;
  a: number;
  d: number;
  /** Height for a piece that hangs on a wall. */
  y?: number;
  turn?: number;
}

export interface SpotPlan {
  type: string;
  a: number;
  d: number;
  /** The point the agent looks at: a, d and height. */
  look: [number, number, number];
  posture?: Posture;
}

export interface SignPlan {
  role: 'you' | 'queue-count';
  a: number;
  d: number;
  y: number;
}

export interface RoomPlan {
  pieces: Placement[];
  spots: SpotPlan[];
  signs: SignPlan[];
}

/** What a plan needs to know about its room. */
export interface RoomShape {
  /** Where the hall door is along the door wall. */
  doorAlong: number;
  /** False for a second waiting room: no portrait and no count sign. Default true. */
  usersOffice?: boolean;
}

/** No standing piece comes closer than this to a queue spot or a seat. */
export const QUEUE_SPOT_RADIUS = 0.35;

/** Turns that make a piece face the room center from the left (-a) or right (+a) wall. */
const FACE_PLUS_A = Math.PI / 2;
const FACE_MINUS_A = -Math.PI / 2;
const FACE_AWAY = Math.PI;

const rows = (count: number, spacing: number) => Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * spacing);

export const OFFICE_DESK = { a: 0, d: ROOM_SIZE - 2.2 } as const;

/**
 * Queue spots in front of the user's desk: rows 1.3 m apart, 2.3 m between the
 * spots of a row, and every other row shifted by half a step, so each queued agent
 * has a clear line to the desk and the labels of neighbours stand apart.
 * The front center fills first, then outward, then the next row.
 */
function queueSpots(): SpotPlan[] {
  const look: [number, number, number] = [OFFICE_DESK.a, OFFICE_DESK.d + 0.7, 1.2];
  const spots: SpotPlan[] = [];
  const full = [0, -2.3, 2.3, -4.6, 4.6];
  const shifted = [-1.15, 1.15, -3.45, 3.45];
  for (let row = 0; row < 5; row++) {
    const d = OFFICE_DESK.d - 1.6 - row * 1.3;
    for (const a of row % 2 === 0 ? full : shifted) spots.push({ type: 'queue', a, d, look, posture: 'standing' });
  }
  return spots;
}

/**
 * Your office: the desk at the far wall facing the door, the queue in front of it,
 * a lounge corner by the door, a credenza and a display shelf behind the desk on
 * each side of the far wall door, plants along the walls, and your portrait over
 * the door on the hall side.
 */
function furnishOffice({ doorAlong, usersOffice = true }: RoomShape): RoomPlan {
  const { a: deskA, d: deskD } = OFFICE_DESK;
  // The lounge corner goes to the front corner away from the door; `side` mirrors it
  const side = doorAlong < 0 ? -1 : 1;
  const pieces: Placement[] = [
      { piece: PIECES.desk(), a: deskA, d: deskD, turn: FACE_AWAY },
      { piece: PIECES.rug(4.2, 2.8, Colors.books[7].getHex()), a: deskA, d: deskD + 0.4 },
      // Behind the desk, left and right of the gap an outer room's door may need
      { piece: PIECES.credenza(), a: -3.2, d: 11.7 },
      { piece: PIECES.wallArt(1.0, 0.6, Colors.books[0].getHex()), a: -3.2, d: 11.9, y: 1.75 },
      { piece: PIECES.displayShelf(), a: 3.2, d: 11.75 },
      { piece: PIECES.floorLamp(), a: -5.4, d: 11.4 },
      { piece: PIECES.tallPlant(), a: 5.4, d: 11.4 },
      { piece: PIECES.plant(), a: -1.75, d: 11.6 },
      { piece: PIECES.plant(), a: 1.75, d: 11.6 },
      // Side walls: art above, a plant beside the first queue row
      { piece: PIECES.wallArt(0.9, 0.6, Colors.books[5].getHex()), a: -5.9, d: 6, y: 1.6, turn: FACE_PLUS_A },
      { piece: PIECES.wallArt(0.7, 0.9, Colors.books[6].getHex()), a: 5.9, d: 6, y: 1.6, turn: FACE_MINUS_A },
      { piece: PIECES.plant(), a: -5.5, d: 8.8 },
      { piece: PIECES.plant(), a: 5.5, d: 8.8 },
      // The lounge corner, away from the door: a sofa against the door wall, two armchairs and a low table
      { piece: PIECES.sofa(Colors.books[1].getHex()), a: -4.2 * side, d: 0.5, turn: FACE_AWAY },
      { piece: PIECES.lowTable(), a: -4.2 * side, d: 1.5 },
      { piece: PIECES.armchair(), a: -5.45 * side, d: 2.0, turn: FACE_PLUS_A * side },
      { piece: PIECES.armchair(), a: -3.0 * side, d: 1.5, turn: FACE_MINUS_A * side },
      { piece: PIECES.plant(), a: -5.6 * side, d: 0.5 },
      // The other front corner
      { piece: PIECES.tallPlant(), a: 5.4 * side, d: 0.6 },
      { piece: PIECES.plant(), a: 4.6 * side, d: 0.5 },
  ];
  const signs: SignPlan[] = [{ role: 'you', a: deskA, d: deskD + 0.7, y: 2.2 }];
  if (usersOffice) {
    // Over the door, on the hall side, above the lintel, with the wait count under it
    pieces.push({ piece: PIECES.portrait(), a: doorAlong, d: -0.25, y: 3.1 });
    signs.push({ role: 'queue-count', a: doorAlong, d: -0.3, y: 2.4 });
  }
  return { pieces, spots: queueSpots(), signs };
}

/** A lounge: three sofas facing the door, a coffee machine and many plants, tall and small. */
function furnishLounge(): RoomPlan {
  const pieces: Placement[] = [{ piece: PIECES.coffeeMachine(), a: -5.2, d: ROOM_SIZE - 0.8 }];
  const spots: SpotPlan[] = [];
  for (const a of rows(3, 3.6)) {
    // A sofa faces the door; its back is toward the far wall
    pieces.push({ piece: PIECES.sofa(0x6a5acd), a, d: 7.5 });
    for (const offset of [-0.6, 0, 0.6]) {
      spots.push({ type: 'idle', a: a + offset, d: 7.45, look: [a + offset, 6.4, 0.8], posture: 'seated' });
    }
  }
  pieces.push(
    // Between the sofas and at both ends
    { piece: PIECES.plant(), a: -1.8, d: 7.6 },
    { piece: PIECES.plant(), a: 1.8, d: 7.6 },
    { piece: PIECES.tallPlant(), a: -5.4, d: 7.5 },
    { piece: PIECES.tallPlant(), a: 5.4, d: 7.5 },
    // Along the far wall, clear of the gap an outer room's door may need
    { piece: PIECES.plant(), a: -3.9, d: 11.5 },
    { piece: PIECES.plant(), a: -2.2, d: 11.6 },
    { piece: PIECES.plant(), a: 2.2, d: 11.6 },
    { piece: PIECES.tallPlant(), a: 5.4, d: 11.4 },
    // The front corners, away from the door
    { piece: PIECES.tallPlant(), a: -5.4, d: 0.6 },
    { piece: PIECES.tallPlant(), a: 5.4, d: 0.6 },
  );
  return { pieces, spots, signs: [] };
}

function furnishDesks(): RoomPlan {
  const pieces: Placement[] = [];
  const spots: SpotPlan[] = [];
  for (const d of [4, 8]) {
    for (const a of rows(4, 2.8)) {
      pieces.push({ piece: PIECES.desk(), a, d });
      spots.push({ type: 'implementing', a, d: d - 0.7, look: [a, d + 0.15, 1.2] });
    }
  }
  return { pieces, spots, signs: [] };
}

/** Shelves on the far wall and on both side walls: the knowledge base of the office. */
function furnishLibrary(): RoomPlan {
  const pieces: Placement[] = [];
  const spots: SpotPlan[] = [];
  // Pulled off center so the pair nearest the middle stays clear of the far-wall door gap
  for (const a of [-3.9, -2.2, 2.2, 3.9]) {
    pieces.push({ piece: PIECES.bookshelf(), a, d: ROOM_SIZE - 0.5 });
    spots.push({ type: 'researching', a, d: ROOM_SIZE - 1.5, look: [a, ROOM_SIZE - 0.5, 1.0] });
  }
  for (const side of [-1, 1]) {
    for (const d of [3.5, 6, 8.5]) {
      const wallA = side * (ROOM_SIZE / 2 - 0.5);
      pieces.push({ piece: PIECES.bookshelf(), a: wallA, d, turn: side * Math.PI / 2 });
      spots.push({ type: 'researching', a: wallA - side, d, look: [wallA, d, 1.0] });
    }
  }
  return { pieces, spots, signs: [] };
}

function furnishLab(): RoomPlan {
  const pieces: Placement[] = [];
  const spots: SpotPlan[] = [];
  for (const a of rows(4, 2.8)) {
    pieces.push({ piece: PIECES.testStation(), a, d: 7 });
    spots.push({ type: 'testing', a, d: 6.2, look: [a, 7, 1.4] });
  }
  return { pieces, spots, signs: [] };
}

const FURNISH: Record<RoomKind, (shape: RoomShape) => RoomPlan> = {
  office: furnishOffice,
  desks: furnishDesks,
  library: furnishLibrary,
  lab: furnishLab,
  lounge: furnishLounge,
};

/** The furnishing plan of a room kind. */
export function roomFurnishing(kind: RoomKind, shape: RoomShape): RoomPlan {
  return FURNISH[kind](shape);
}

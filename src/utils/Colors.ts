import * as THREE from 'three';

export const Colors = {
  // Environment
  sky: new THREE.Color(0x2b2d3a),
  floor: new THREE.Color(0xd4c9a8),
  carpet: new THREE.Color(0x6b5b73),

  // Furniture
  desk: new THREE.Color(0xc4a882),
  deskLegs: new THREE.Color(0x8b7355),
  monitor: new THREE.Color(0x2a2a3e),
  monitorScreen: new THREE.Color(0x1a3a5c),
  monitorScreenActive: new THREE.Color(0x2a5a2a),
  monitorScreenError: new THREE.Color(0x5a2a2a),
  whiteboard: new THREE.Color(0xf0f0f0),
  whiteboardFrame: new THREE.Color(0x888888),
  bookshelf: new THREE.Color(0x8b6914),
  coffeeMachine: new THREE.Color(0x444444),
  coffeeCounter: new THREE.Color(0xb8a88a),
  cup: new THREE.Color(0xf5f5f0),
  wall: new THREE.Color(0xf5f0e8),

  // Stickman
  skin: new THREE.Color(0xf5deb3),
  limb: new THREE.Color(0x333344),
  shoe: new THREE.Color(0x222233),

  // Accent colors for agents
  accents: [
    new THREE.Color(0x4a90d9), // blue
    new THREE.Color(0xd94a4a), // red
    new THREE.Color(0x4ad94a), // green
    new THREE.Color(0xd9d94a), // yellow
    new THREE.Color(0xd94ad9), // magenta
    new THREE.Color(0x4ad9d9), // cyan
    new THREE.Color(0xd9904a), // orange
    new THREE.Color(0x904ad9), // purple
  ],

  // Books
  books: [
    new THREE.Color(0xc0392b),
    new THREE.Color(0x2980b9),
    new THREE.Color(0x27ae60),
    new THREE.Color(0xf39c12),
    new THREE.Color(0x8e44ad),
    new THREE.Color(0x16a085),
    new THREE.Color(0xd35400),
    new THREE.Color(0x2c3e50),
  ],

  // Plants
  pot: new THREE.Color(0xb5651d),
  plant: new THREE.Color(0x2d7a3a),
  plantLight: new THREE.Color(0x4caf50),

  /**
   * Mission color pairs (issue #125 part 3): each entry names two indices into
   * `accents` above, never index 6 (orange) — that color already means "waits
   * for you". Pairs, not raw hex: a mission's figures reuse the same cached
   * accent materials every other agent already costs, so the draw-call budget
   * never pays for a mission's own color twice.
   */
  missionPalettes: [
    [1, 2], [0, 7], [4, 5], [2, 4], [0, 1], [5, 7], [3, 7],
  ] as const,
};

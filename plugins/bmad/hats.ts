import * as THREE from 'three';
import { getEmissiveMaterial, getToonMaterial } from '../../src/utils/Materials.js';

/** A toon hat built with its base at y = 0. `height` is where the next hat sits. */
export interface Hat {
  kind: string;
  group: THREE.Group;
  height: number;
}

type Vec = [number, number, number];
type Part = [THREE.BufferGeometry, number, Vec?, Vec?];
const ORIGIN: Vec = [0, 0, 0];
const UNIT: Vec = [1, 1, 1];

function assemble(kind: string, height: number, parts: Part[], emissive?: Part): Hat {
  const group = new THREE.Group();
  for (const [geometry, color, position = ORIGIN, scale = UNIT] of parts) {
    const mesh = new THREE.Mesh(geometry, getToonMaterial(color));
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.castShadow = true;
    mesh.userData.figurePart = true;
    group.add(mesh);
  }
  if (emissive) {
    const [geometry, color, position = ORIGIN] = emissive;
    const mesh = new THREE.Mesh(geometry, getEmissiveMaterial(color, color, 0.8));
    mesh.position.set(...position);
    mesh.userData.figurePart = true;
    group.add(mesh);
  }
  return { kind, group, height };
}

const dome = (radius: number) => new THREE.SphereGeometry(radius, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
const disc = (radius: number, height: number) => new THREE.CylinderGeometry(radius, radius, height, 16);

const BUILDERS: Record<string, () => Hat> = {
  // Sally: a red beret, tilted
  'ux-designer': () => {
    const hat = assemble('beret', 0.07, [
      [new THREE.SphereGeometry(0.17, 14, 8), 0xc0392b, [0.02, 0.03, 0], [1, 0.28, 1]],
      [disc(0.015, 0.04), 0xc0392b, [0.02, 0.08, 0]],
    ]);
    hat.group.rotation.z = -0.15;
    return hat;
  },
  // Winston: a yellow hard hat with a brim
  architect: () => assemble('hard-hat', 0.14, [
    [dome(0.16), 0xf1c40f],
    [disc(0.2, 0.015), 0xf1c40f],
    [new THREE.BoxGeometry(0.04, 0.03, 0.26), 0xd4ac0d, [0, 0.13, 0]],
  ]),
  // Amelia: a teal beanie with a pompom
  dev: () => assemble('beanie', 0.17, [
    [dome(0.155), 0x16a085, [0, 0, 0], [1, 0.9, 1]],
    [disc(0.16, 0.04), 0x0e6655, [0, 0.01, 0]],
    [new THREE.SphereGeometry(0.04, 8, 6), 0xecf0f1, [0, 0.15, 0]],
  ]),
  // Quinn: a brown detective cap (fedora)
  qa: () => assemble('detective-cap', 0.13, [
    [disc(0.22, 0.015), 0x6e4b2a],
    [new THREE.CylinderGeometry(0.1, 0.13, 0.11, 16), 0x6e4b2a, [0, 0.06, 0]],
    [new THREE.CylinderGeometry(0.132, 0.132, 0.025, 16), 0x2c2c2c, [0, 0.022, 0]],
  ]),
  // John: a black top hat with a red band
  pm: () => assemble('top-hat', 0.25, [
    [disc(0.22, 0.015), 0x1b1b1b],
    [disc(0.12, 0.24), 0x1b1b1b, [0, 0.12, 0]],
    [disc(0.122, 0.03), 0xc0392b, [0, 0.03, 0]],
  ]),
  // Mary: a navy graduation cap with a gold tassel
  analyst: () => assemble('graduation-cap', 0.09, [
    [disc(0.13, 0.06), 0x1f2a44, [0, 0.03, 0]],
    [new THREE.BoxGeometry(0.34, 0.02, 0.34), 0x1f2a44, [0, 0.07, 0]],
    [new THREE.SphereGeometry(0.025, 6, 4), 0xf1c40f, [0.15, 0.04, 0.15]],
  ]),
  // Bob: a blue baseball cap with a visor
  sm: () => assemble('baseball-cap', 0.12, [
    [dome(0.155), 0x2e86de],
    [new THREE.BoxGeometry(0.2, 0.012, 0.14), 0x1b4f72, [0, 0.005, 0.17]],
    [new THREE.SphereGeometry(0.02, 6, 4), 0x1b4f72, [0, 0.155, 0]],
  ]),
  // Dexter: a tan deerstalker with brims front and back
  debugger: () => assemble('deerstalker', 0.13, [
    [dome(0.16), 0xb08d57],
    [new THREE.BoxGeometry(0.14, 0.012, 0.12), 0x8a6d3b, [0, 0.01, 0.17]],
    [new THREE.BoxGeometry(0.14, 0.012, 0.12), 0x8a6d3b, [0, 0.01, -0.17]],
    [new THREE.SphereGeometry(0.02, 6, 4), 0x8a6d3b, [0, 0.16, 0]],
  ]),
  // Leo: a gold crown
  'spec-coach': () => assemble('crown', 0.14, [
    [new THREE.CylinderGeometry(0.15, 0.14, 0.06, 16, 1, true), 0xf1c40f, [0, 0.03, 0]],
    ...[0, 1, 2, 3, 4].map((i): Part => [new THREE.ConeGeometry(0.03, 0.08, 6), 0xf1c40f,
      [Math.sin((i / 5) * Math.PI * 2) * 0.145, 0.1, Math.cos((i / 5) * Math.PI * 2) * 0.145]]),
  ]),
  // Atlas: an orange miner helmet with a lamp
  'data-engineer': () => assemble('miner-helmet', 0.14, [
    [dome(0.16), 0xe67e22],
    [disc(0.18, 0.015), 0xe67e22],
  ], [new THREE.CylinderGeometry(0.035, 0.035, 0.03, 10).rotateX(Math.PI / 2), 0xfff3b0, [0, 0.08, 0.16]]),
};

const PARTY_COLORS = [0xe84393, 0x00b894, 0x6c5ce7, 0xfd9644, 0x0984e3, 0xd63031];

function partyColor(badge: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < badge.length; i++) hash = Math.imul(hash ^ badge.charCodeAt(i), 0x01000193);
  return PARTY_COLORS[(hash >>> 0) % PARTY_COLORS.length];
}

const PARTY = 'party';
const templates = new Map<string, Hat>();

function template(kind: string): Hat {
  let hat = templates.get(kind);
  if (!hat) {
    hat = kind === PARTY
      ? assemble('party-hat', 0.24, [
        [new THREE.ConeGeometry(0.1, 0.22, 12), PARTY_COLORS[0], [0, 0.11, 0]],
        [new THREE.SphereGeometry(0.03, 6, 4), 0xecf0f1, [0, 0.23, 0]],
      ])
      : BUILDERS[kind]();
    templates.set(kind, hat);
  }
  return hat;
}

/**
 * The hat for a persona badge. Personas without their own hat get a colored party hat.
 * Hats of a kind share their shapes and colors (never dispose them), and their
 * meshes are figure parts: the figure batch draws all hats of a kind in one call.
 */
export function buildHat(badge: string): Hat {
  const own = Object.prototype.hasOwnProperty.call(BUILDERS, badge);
  const source = template(own ? badge : PARTY);
  const group = source.group.clone();
  if (!own) (group.children[0] as THREE.Mesh).material = getToonMaterial(partyColor(badge));
  return { kind: source.kind, group, height: source.height };
}

import * as THREE from 'three';
import { getToonMaterial } from '../utils/Materials.js';
import { Colors } from '../utils/Colors.js';

const RADIAL_SEGMENTS = 6;
const CAP_SEGMENTS = 4;

/**
 * Hero body (issue #165, round 2 spike, "chunky toy body" confirmed 2026-11-21): a
 * bigger head, mitten-round hands, a wider rounded torso, and shorter legs. The rig
 * itself (joint hierarchy, the rotation-only poses in `ActivityAnimations.ts`) is
 * unchanged; only where each joint sits and what shape sits on it changes, so every
 * existing activity pose still applies the same angles to the same joints.
 */
const HEAD_RADIUS = 0.205; // was a plain 0.15 sphere
const TORSO_RADIUS = 0.17; // was 0.12-0.15 (tapered cylinder); now one wider capsule radius
const TORSO_LENGTH = 0.26; // the capsule's straight middle; its rounded caps add 2 * TORSO_RADIUS on top
const TORSO_HEIGHT = TORSO_LENGTH + TORSO_RADIUS * 2;
const HAND_RADIUS = 0.052; // was a 0.06 box; a mitten reads rounder at a slightly smaller radius
/**
 * Issue #165 round 3 (review follow-up): arms and legs stayed at the old plain-stick
 * 0.035 radius through every earlier Hero round, reading as thin dark wires under the
 * new chunky torso/head/hands at the default isometric zoom. Roughly 2x the old radius,
 * the ratio the review asked for, enough to read as a toy limb next to the mitten hand
 * (`HAND_RADIUS`) without the limb overtaking it.
 */
export const LIMB_RADIUS = 0.06;
/** ~20% shorter than the old 0.4 upper/lower leg segments (round 1 "chibi" direction, folded into Hero). */
const LEG_SEGMENT = 0.32;
/** Keeps the old ~0.1 ground margin above the now-shorter legs (2 * LEG_SEGMENT), same ratio as 0.9 above 2 * 0.4. */
export const HIP_HEIGHT = 0.74;
/** Body-space y of the shoulders: hips plus the torso's own height, the same relationship the old 1.5 = 0.9 + 0.6 kept. */
export const SHOULDERS_Y = HIP_HEIGHT + TORSO_HEIGHT;
/** The gap between the shoulders and the neck joint, same as the old 1.6 - 1.5. */
const NECK_MARGIN = 0.1;
export const NECK_HEIGHT = SHOULDERS_Y + NECK_MARGIN;
/** The head center sits one radius above the neck, same convention as the old 0.15 (== the old head radius). */
export const HEAD_OFFSET = HEAD_RADIUS;
/** Issue #174: first person's eye height matches a standing agent's own eye height (the neck joint plus the head center), not an arbitrary guess. Re-derived for the Hero body (issue #165): a bigger head and shorter legs move this from 1.75 to roughly 1.67. */
export const FIGURE_EYE_HEIGHT = NECK_HEIGHT + HEAD_OFFSET;

export type FaceState = 'neutral' | 'focused' | 'waiting';
export type HairStyle = 'cap' | 'spiky' | 'bun' | 'none';

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
  return part(shared('head', () => new THREE.SphereGeometry(HEAD_RADIUS, 10, 8)), getToonMaterial(Colors.skin));
}

export function createTorso(accentColor: THREE.Color): THREE.Mesh {
  return part(shared('torso', () => new THREE.CapsuleGeometry(TORSO_RADIUS, TORSO_LENGTH, CAP_SEGMENTS, RADIAL_SEGMENTS)), getToonMaterial(accentColor));
}

export function createLimb(length: number, radius = LIMB_RADIUS): THREE.Mesh {
  const geometry = shared(`limb:${length}:${radius}`, () => {
    const geo = new THREE.CylinderGeometry(radius, radius, length, RADIAL_SEGMENTS);
    geo.translate(0, -length / 2, 0);
    return geo;
  });
  return part(geometry, getToonMaterial(Colors.limb));
}

/** The per-instance tint (issue #125 part 3) that lands exactly on `color` when multiplied
 * onto the hand's own skin-colored material: the ratio of `color` to `Colors.skin`. */
export function handTintFor(color: THREE.Color): THREE.Color {
  return new THREE.Color(color.r / Colors.skin.r, color.g / Colors.skin.g, color.b / Colors.skin.b);
}

/**
 * `color`: a mission's second color (issue #125 part 3) instead of plain skin. Every hand
 * still shares the one skin-colored material and bucket (`FigureBatch.ts`); the color
 * shows up as a per-instance tint, never a second material, so a mission's hand color
 * costs no extra draw call.
 */
export function createHand(color?: THREE.Color): THREE.Mesh {
  const mesh = part(shared('hand', () => new THREE.SphereGeometry(HAND_RADIUS, 8, 6)), getToonMaterial(Colors.skin));
  if (color) mesh.userData.tint = handTintFor(color);
  return mesh;
}

export function createFoot(): THREE.Mesh {
  return part(shared('foot', () => new THREE.BoxGeometry(0.08, 0.05, 0.12)), getToonMaterial(Colors.shoe));
}

/** Face parts (issue #165 round 2, "faces"): skip the shadow, same rationale as a hat
 * (`plugins/bmad/hats.ts`) — a dot or a thin mouth shape casts nothing worth the cost
 * next to the figure's own shadow. */
function facePart(geometry: THREE.BufferGeometry): THREE.Mesh {
  const mesh = part(geometry, getToonMaterial(Colors.face));
  mesh.castShadow = false;
  return mesh;
}

const EYE_RADIUS = 0.022;
/** How far forward of the head center the face sits, as a fraction of HEAD_RADIUS. */
const FACE_DEPTH = 0.95;

/** Two eye dots, fixed at the front of the head; one shared geometry, one bucket for both. */
function createEyes(): THREE.Mesh[] {
  const geometry = shared('eye', () => new THREE.SphereGeometry(EYE_RADIUS, 6, 6));
  const z = HEAD_RADIUS * FACE_DEPTH;
  const y = HEAD_RADIUS * 0.15;
  const x = HEAD_RADIUS * 0.42;
  const left = facePart(geometry);
  left.position.set(-x, y, z);
  const right = facePart(geometry);
  right.position.set(x, y, z);
  return [left, right];
}

function mouthGeometry(state: FaceState): THREE.BufferGeometry {
  switch (state) {
    case 'neutral':
      return shared('mouth:neutral', () => new THREE.BoxGeometry(0.05, 0.012, 0.01));
    case 'focused':
      // A small "o": concentrating, mouth slightly open.
      return shared('mouth:focused', () => new THREE.TorusGeometry(0.014, 0.008, 6, 10));
    case 'waiting':
      // A half ring, flipped by `setMouthState`'s rotation into an upward smile arc.
      return shared('mouth:waiting', () => new THREE.TorusGeometry(0.03, 0.008, 6, 10, Math.PI));
  }
}

/** The mouth mesh starts in the `neutral` shape; `setMouthState` (StickFigure.ts) swaps
 * its geometry as the agent's activity or wait state changes. Never a new material or a
 * 4th bucket beyond the 3 fixed mouth shapes: a geometry swap, the same pattern a persona
 * hat swap already uses. */
function createMouth(): THREE.Mesh {
  const mesh = facePart(mouthGeometry('neutral'));
  mesh.position.set(0, -HEAD_RADIUS * 0.3, HEAD_RADIUS * FACE_DEPTH);
  return mesh;
}

/** Swaps a figure's mouth to the shape for its current face state. */
export function setMouthState(mouth: THREE.Mesh, state: FaceState): void {
  mouth.geometry = mouthGeometry(state);
  mouth.rotation.z = state === 'waiting' ? Math.PI : 0;
}

/**
 * A small set of hair shapes (issue #165 round 2, "hair + body-shape variety"), one
 * per agent, seeded off its name (`HeroVariety.ts`). Every style shares its geometry
 * and material across every figure wearing it — one bucket per style kind, like a
 * persona hat, never one per figure. `'none'` costs nothing.
 */
function createHair(style: HairStyle): THREE.Group | null {
  if (style === 'none') return null;
  const group = new THREE.Group();
  group.name = 'hero-hair';
  const material = getToonMaterial(Colors.hair);
  const addPiece = (geometry: THREE.BufferGeometry, position: [number, number, number], rotation?: [number, number, number]): void => {
    const mesh = part(geometry, material);
    mesh.castShadow = false;
    mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    group.add(mesh);
  };
  switch (style) {
    case 'cap': {
      // A snug dome over the top of the head, like short hair combed flat.
      const geometry = shared('hair:cap', () => new THREE.SphereGeometry(HEAD_RADIUS * 1.06, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55));
      addPiece(geometry, [0, HEAD_RADIUS * 0.1, 0]);
      break;
    }
    case 'spiky': {
      const geometry = shared('hair:spike', () => new THREE.ConeGeometry(HEAD_RADIUS * 0.16, HEAD_RADIUS * 0.55, 6));
      const count = 5;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const r = HEAD_RADIUS * 0.5;
        addPiece(geometry, [Math.cos(angle) * r, HEAD_RADIUS * 0.8, Math.sin(angle) * r * 0.6 - HEAD_RADIUS * 0.1], [-0.4, -angle, 0]);
      }
      break;
    }
    case 'bun': {
      const base = shared('hair:bun-base', () => new THREE.SphereGeometry(HEAD_RADIUS * 1.03, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.4));
      addPiece(base, [0, HEAD_RADIUS * 0.2, 0]);
      const knot = shared('hair:bun-knot', () => new THREE.SphereGeometry(HEAD_RADIUS * 0.3, 8, 8));
      addPiece(knot, [0, HEAD_RADIUS * 1.05, -HEAD_RADIUS * 0.45]);
      break;
    }
  }
  return group;
}

export interface Joints {
  root: THREE.Group;
  body: THREE.Group;
  hips: THREE.Group;
  shoulders: THREE.Group;
  neck: THREE.Group;
  head: THREE.Mesh;
  mouth: THREE.Mesh;
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

/**
 * `secondColor`: a mission's second color (issue #125 part 3), worn on the hands; plain
 * skin without one. `hairStyle` (issue #165 round 2): one of the seeded Hero hair
 * styles (`HeroVariety.ts`), `'none'` by default so a direct caller (a test, say) gets
 * a bald figure rather than an undefined one.
 */
export function buildSkeleton(accentColor: THREE.Color, secondColor?: THREE.Color, hairStyle: HairStyle = 'none'): Joints {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Hips
  const hips = new THREE.Group();
  hips.position.y = HIP_HEIGHT;
  body.add(hips);

  // Torso
  const torso = createTorso(accentColor);
  torso.position.y = TORSO_HEIGHT / 2;
  hips.add(torso);

  // --- Legs ---
  const leftUpperLeg = new THREE.Group();
  leftUpperLeg.position.set(-0.1, 0, 0);
  hips.add(leftUpperLeg);
  const leftUpperLegMesh = createLimb(LEG_SEGMENT);
  leftUpperLeg.add(leftUpperLegMesh);

  const leftLowerLeg = new THREE.Group();
  leftLowerLeg.position.set(0, -LEG_SEGMENT, 0);
  leftUpperLeg.add(leftLowerLeg);
  const leftLowerLegMesh = createLimb(LEG_SEGMENT);
  leftLowerLeg.add(leftLowerLegMesh);

  const leftFoot = createFoot();
  leftFoot.position.set(0, -LEG_SEGMENT, 0.03);
  leftLowerLeg.add(leftFoot);

  const rightUpperLeg = new THREE.Group();
  rightUpperLeg.position.set(0.1, 0, 0);
  hips.add(rightUpperLeg);
  const rightUpperLegMesh = createLimb(LEG_SEGMENT);
  rightUpperLeg.add(rightUpperLegMesh);

  const rightLowerLeg = new THREE.Group();
  rightLowerLeg.position.set(0, -LEG_SEGMENT, 0);
  rightUpperLeg.add(rightLowerLeg);
  const rightLowerLegMesh = createLimb(LEG_SEGMENT);
  rightLowerLeg.add(rightLowerLegMesh);

  const rightFoot = createFoot();
  rightFoot.position.set(0, -LEG_SEGMENT, 0.03);
  rightLowerLeg.add(rightFoot);

  // Shoulders
  const shoulders = new THREE.Group();
  shoulders.position.y = SHOULDERS_Y;
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

  const leftHand = createHand(secondColor);
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

  const rightHand = createHand(secondColor);
  rightHand.position.set(0, -0.3, 0);
  rightForearm.add(rightHand);

  // Neck + Head
  const neck = new THREE.Group();
  neck.position.y = NECK_HEIGHT;
  body.add(neck);

  const head = createHead();
  head.position.y = HEAD_OFFSET;
  neck.add(head);

  // Face (issue #165 round 2): fixed eyes, a mouth that swaps shape with the figure's
  // state (StickFigure.ts). Hair (issue #165 round 2): a persona hat still attaches to
  // `head` directly (plugins/bmad/client.ts) and sits above it, unaffected by this.
  for (const eye of createEyes()) head.add(eye);
  const mouth = createMouth();
  head.add(mouth);
  const hair = createHair(hairStyle);
  if (hair) head.add(hair);

  return {
    root, body, hips, shoulders, neck, head, mouth, torso,
    leftUpperArm, leftForearm, leftHand,
    rightUpperArm, rightForearm, rightHand,
    leftUpperLeg, leftLowerLeg, leftFoot,
    rightUpperLeg, rightLowerLeg, rightFoot,
  };
}

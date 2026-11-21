import * as THREE from 'three';
import { getToonMaterial } from '../../src/utils/Materials.js';

/**
 * Equipment catalog v1 (issue #167, spike confirmed 2026-11-21): a small held or worn
 * item for the skill an agent used. Every item follows the `plugins/bmad/hats.ts`
 * pattern exactly: one hand-built `THREE.Group` per kind, cached once and `.clone()`d
 * per figure, every mesh `userData.figurePart = true` so `FigureBatch` draws it
 * instanced, and no shadow (same rationale as a hat: a tiny prop's shadow is
 * imperceptible next to the figure's own).
 *
 * `extras.skills` (issue #166) only ever carries a `Skill` tool's own `input.skill`,
 * never a raw built-in tool name — so a catalog entry keys on a skill slug this
 * harness actually ships (`git`, `jira`, `crit:crit`, `dataviz`, `research`...), not a
 * raw tool name like "Bash" or "Grep" that this data source structurally cannot carry.
 */

export type HandKind = 'wrench' | 'clipboard' | 'gavel' | 'loupe' | 'stamp' | 'easel-chart' | 'open-book' | 'magnifier' | 'toolbox';
export type FaceKind = 'headphones' | 'glasses';

const ITEM_COLOR = 0x8a7a5c;
const ITEM_COLOR_DARK = 0x4a4038;

function itemMaterial(): THREE.Material {
  return getToonMaterial(ITEM_COLOR);
}

const templates = new Map<string, THREE.Group>();

function buildPart(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.figurePart = true;
  mesh.castShadow = false;
  return mesh;
}

function group(name: string, ...parts: THREE.Mesh[]): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  for (const part of parts) g.add(part);
  return g;
}

function buildHandTemplate(kind: HandKind): THREE.Group {
  const material = itemMaterial();
  switch (kind) {
    case 'wrench':
      return group(kind, buildPart(new THREE.BoxGeometry(0.02, 0.1, 0.015), material));
    case 'clipboard':
      // jira and klever-mr share this one shape and material; a distinct tint per
      // skill (`handTintFor`-style, StickFigureParts.ts) tells them apart with no
      // second bucket.
      return group(kind, buildPart(new THREE.BoxGeometry(0.06, 0.08, 0.01), material));
    case 'gavel':
      return group(kind, buildPart(new THREE.CylinderGeometry(0.018, 0.018, 0.09, 8), material));
    case 'loupe':
      return group(kind, buildPart(new THREE.TorusGeometry(0.025, 0.007, 6, 10), material));
    case 'stamp':
      return group(kind, buildPart(new THREE.BoxGeometry(0.03, 0.05, 0.03), material));
    case 'easel-chart':
      return group(kind, buildPart(new THREE.BoxGeometry(0.06, 0.07, 0.006), material));
    case 'open-book':
      return group(kind, buildPart(new THREE.BoxGeometry(0.07, 0.01, 0.05), material));
    case 'magnifier':
      return group(kind, buildPart(new THREE.TorusGeometry(0.035, 0.007, 6, 10), material));
    case 'toolbox':
      return group(kind, buildPart(new THREE.BoxGeometry(0.06, 0.04, 0.04), material));
  }
}

function buildFaceTemplate(kind: FaceKind): THREE.Group {
  const dark = getToonMaterial(ITEM_COLOR_DARK);
  if (kind === 'headphones') {
    const band = buildPart(new THREE.TorusGeometry(0.1, 0.012, 6, 10, Math.PI), dark);
    const cupGeometry = new THREE.CylinderGeometry(0.03, 0.03, 0.015, 10);
    const left = buildPart(cupGeometry, dark);
    left.position.set(-0.1, -0.02, 0);
    left.rotation.z = Math.PI / 2;
    const right = buildPart(cupGeometry, dark);
    right.position.set(0.1, -0.02, 0);
    right.rotation.z = Math.PI / 2;
    return group(kind, band, left, right);
  }
  const lensGeometry = new THREE.TorusGeometry(0.03, 0.006, 6, 10);
  const left = buildPart(lensGeometry, dark);
  left.position.set(-0.06, 0, 0);
  const right = buildPart(lensGeometry, dark);
  right.position.set(0.06, 0, 0);
  const bridge = buildPart(new THREE.BoxGeometry(0.03, 0.006, 0.006), dark);
  return group(kind, left, right, bridge);
}

function handTemplate(kind: HandKind): THREE.Group {
  let template = templates.get(`hand:${kind}`);
  if (!template) {
    template = buildHandTemplate(kind);
    templates.set(`hand:${kind}`, template);
  }
  return template;
}

function faceTemplate(kind: FaceKind): THREE.Group {
  let template = templates.get(`face:${kind}`);
  if (!template) {
    template = buildFaceTemplate(kind);
    templates.set(`face:${kind}`, template);
  }
  return template;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

const TOOLBOX_TINTS = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x8e44ad, 0x16a085];
const ITEM_BASE = new THREE.Color(ITEM_COLOR);

/** `FigureBatch`'s instance tint is a multiplier on the material's own color (the same
 * convention `StickFigureParts.handTintFor` uses for a mission's hand color): the ratio
 * of the target color to the item's own base color lands the multiply exactly on
 * target, never on a muddy product of the two. */
function tintToward(target: number): THREE.Color {
  const color = new THREE.Color(target);
  return new THREE.Color(color.r / ITEM_BASE.r, color.g / ITEM_BASE.g, color.b / ITEM_BASE.b);
}

/** An unmapped skill still gets an item (never no item): a hashed tint on the shared
 * toolbox shape, the same "unlisted persona gets a colored party hat" fallback
 * `plugins/bmad/hats.ts`'s `partyColor` already uses. */
function toolboxTint(skill: string): THREE.Color {
  return tintToward(TOOLBOX_TINTS[fnv1a(skill) % TOOLBOX_TINTS.length]);
}

const HAND_MAP: Array<{ match: (skill: string) => boolean; kind: HandKind; tint?: number }> = [
  { match: (s) => s === 'git', kind: 'wrench' },
  { match: (s) => s === 'jira' || s === 'create-tickets' || s === 'ticket-init', kind: 'clipboard' },
  { match: (s) => s === 'klever-mr' || s.startsWith('gitlab'), kind: 'clipboard', tint: 0x2980b9 },
  { match: (s) => s.startsWith('crit') || s === 'adversarial-cascade', kind: 'gavel' },
  { match: (s) => s === 'code-review' || s === 'pr-review' || s === 'security-review', kind: 'loupe' },
  { match: (s) => s === 'bibliotheque-librarian' || s === 'notion', kind: 'stamp' },
  { match: (s) => s === 'dataviz', kind: 'easel-chart' },
  { match: (s) => s === 'research', kind: 'open-book' },
  { match: (s) => s === 'investigate', kind: 'magnifier' },
];

const FACE_HEADPHONE_SKILLS = new Set(['klever-test', 'ui-probe', 'agent-browser']);
/** A face item reads as "characteristic", not tied to the single newest skill (spike
 * #167): an agent with a headphone-worthy skill anywhere in its list wears them; one
 * with enough skill variety but none of those wears glasses instead. Both are a v1
 * simplification pending a review against a live crowd (see the PR's open questions). */
const FACE_GLASSES_MIN_SKILLS = 2;

export interface HandItem { kind: HandKind; tint?: THREE.Color }

/** The item for the single newest-used skill (last in the array); an unmapped skill
 * still equips the hashed toolbox, never no item. */
export function handItemFor(skills: string[]): HandItem | undefined {
  if (skills.length === 0) return undefined;
  const newest = skills[skills.length - 1];
  for (const entry of HAND_MAP) {
    if (entry.match(newest)) return { kind: entry.kind, tint: entry.tint !== undefined ? tintToward(entry.tint) : undefined };
  }
  return { kind: 'toolbox', tint: toolboxTint(newest) };
}

export function faceItemFor(skills: string[]): FaceKind | undefined {
  if (skills.some((skill) => FACE_HEADPHONE_SKILLS.has(skill))) return 'headphones';
  if (skills.length >= FACE_GLASSES_MIN_SKILLS) return 'glasses';
  return undefined;
}

/** A clone of the hand item's template, tinted if the mapping calls for one. Every
 * mesh in the clone is already `figurePart`-tagged (the template's own meshes are). */
export function buildHandItem(item: HandItem): THREE.Group {
  const clone = handTemplate(item.kind).clone(true);
  if (item.tint) for (const child of clone.children) (child as THREE.Mesh).userData.tint = item.tint;
  return clone;
}

export function buildFaceItem(kind: FaceKind): THREE.Group {
  return faceTemplate(kind).clone(true);
}

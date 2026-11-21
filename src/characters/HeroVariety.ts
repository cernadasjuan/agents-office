import type { HairStyle } from './StickFigureParts.js';

/**
 * Round 2 of the character-look spike (issue #165, confirmed 2026-11-21): a crowd of
 * Hero figures should not look like 40 copies of one mold. Hair style and body width
 * are seeded off the agent's own name, the same hash-then-pick pattern as the
 * unlisted-persona party hat color (`plugins/bmad/hats.ts`'s `partyColor`) and the
 * per-figure animation-clip gap (`src/agents/ActivityAnimations.ts`'s `seededFraction`):
 * deterministic, so a figure always looks the same figure, and no shared RNG state to
 * desync between figures or across a test run.
 *
 * Body width is a `root` scale transform (StickFigure.ts), never a new geometry: the
 * one gotcha this spike flagged is `StickFigureParts.ts`'s shared-geometry cache keys a
 * limb by its exact length, so per-agent variety has to ride a transform, not a new
 * length, or every agent would mint its own bucket.
 */

const HAIR_STYLES: HairStyle[] = ['tufts', 'spiky', 'bun', 'none'];

/** The narrow range a scaled figure still fits its desk, chair and doorway. */
const MIN_BODY_SCALE = 0.92;
const MAX_BODY_SCALE = 1.08;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A deterministic 0..1 value for one name and one draw: a second draw never repeats the first's bits. */
function seededFraction(name: string, draw: number): number {
  return fnv1a(`${name}:${draw}`) / 0xffffffff;
}

/** One of 4 hair styles ('none' included), stable for one agent name for its whole lifetime. */
export function hairStyleFor(name: string): HairStyle {
  return HAIR_STYLES[Math.floor(seededFraction(name, 0) * HAIR_STYLES.length) % HAIR_STYLES.length];
}

/** A small per-agent width multiplier (root scale.x/z, issue #165 round 2: "hair + body-shape variety"). */
export function bodyScaleFor(name: string): number {
  return MIN_BODY_SCALE + seededFraction(name, 1) * (MAX_BODY_SCALE - MIN_BODY_SCALE);
}

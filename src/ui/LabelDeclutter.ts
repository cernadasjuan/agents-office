import { attentionBand, type Wait } from './attention.js';

/** A screen rect in CSS pixels, any consistent origin (overlap is relative). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DeclutterFacts {
  selected: boolean;
  hovered: boolean;
  stuck: boolean;
  attention: string | undefined;
  waitMinutes: number | undefined;
  /** The agent's own activity is idle (at rest, not a subagent's "Done" case). */
  idle: boolean;
}

/**
 * Lower is more important. Selected and hovered always win (you asked for
 * them). After that: a fresh wait (it calls for the user, same rule as
 * `labelDetail`'s `blockedRecently`), a stuck mark, an aging wait, a cold
 * wait, any other busy agent, then an idle one. Ties break by the longer
 * wait (`declutterLabels` sorts on `waitMinutes` after this).
 */
export function labelPriority(facts: DeclutterFacts): number {
  if (facts.selected) return 0;
  if (facts.hovered) return 1;
  const calling = facts.attention === 'waiting' || facts.attention === 'your-turn';
  const band = attentionBand({ attention: facts.attention, waitMinutes: facts.waitMinutes } as Wait);
  if (calling && (band === undefined || band === 'fresh')) return 2;
  if (facts.stuck) return 3;
  if (band === 'aging') return 4;
  if (band === 'cold') return 5;
  return facts.idle ? 7 : 6;
}

/** Approximate on-screen box of a label, in CSS pixels, anchored at its center.
 * Agent labels are a fixed-size CSS2D overlay: they never scale with camera
 * distance (unlike room labels, which are a distance-scaled sprite). A real
 * label's width varies with the name; these are a safe upper estimate from
 * the rendered CSS (`.agent-label`, `index.html`), padded for a long name. */
export const FULL_LABEL_SIZE = { width: 150, height: 42 } as const;
export const COMPACT_LABEL_SIZE = { width: 110, height: 24 } as const;

export function labelRect(centerX: number, centerY: number, level: 'full' | 'compact'): Rect {
  const size = level === 'full' ? FULL_LABEL_SIZE : COMPACT_LABEL_SIZE;
  return {
    left: centerX - size.width / 2,
    right: centerX + size.width / 2,
    top: centerY - size.height / 2,
    bottom: centerY + size.height / 2,
  };
}

export interface DeclutterCandidate {
  id: string;
  rect: Rect;
  priority: number;
  /** Minutes waited, for the tie-break; -1 for an agent with no wait. */
  waitMinutes: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Which labels stay visible: in any cluster of overlapping labels, only the
 * highest-priority one stays, the rest hide. Pure: no DOM, no scene, no
 * stored state. Call again after anything moves (the camera or an agent) —
 * a candidate whose rect no longer overlaps a higher one returns on its own,
 * since nothing here remembers the last call.
 */
export function declutterLabels(candidates: DeclutterCandidate[]): Set<string> {
  const ordered = [...candidates].sort((a, b) => a.priority - b.priority || b.waitMinutes - a.waitMinutes);
  const kept: Rect[] = [];
  const visible = new Set<string>();
  for (const candidate of ordered) {
    if (kept.some((rect) => overlaps(rect, candidate.rect))) continue;
    kept.push(candidate.rect);
    visible.add(candidate.id);
  }
  return visible;
}

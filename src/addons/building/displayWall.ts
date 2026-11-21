import type { AgentExtras } from '../../agents/AgentData.js';
import { callsForYou } from '../../ui/attention.js';

/**
 * The war room display wall (issue #223): "the screens on the wall... show the main tickets
 * they're working, so what are current sessions are going" (round 7), and the wall must stay
 * legible ("documents, mission and issues should be on the wall", round 6). The mission's own
 * statement/docs/issues/kanban boards already exist (`missionRooms.ts`, issues #47, #124,
 * #146); this module is the one new piece, "live sessions", plus the pure rules a board
 * drawer and a pick-target builder both need, kept here so they are testable without a scene,
 * a canvas, or a room shape (rect today, hex later — this file imports neither).
 */

export type SessionState = 'working' | 'waiting' | 'blocked';

export interface SessionEntry {
  id: string;
  name: string;
  extras?: AgentExtras;
}

export interface SessionRow {
  id: string;
  name: string;
  state: SessionState;
}

/** AC3's three words. `stuck` (busy with no transcript write for a long while) reads as
 * "blocked" — the same signal the label and the triage panel already call out. A fresh wait
 * for Gabriel (the beacon's own predicate, `callsForYou`) reads as "waiting". Anything else
 * reads as "working": the default, and the only state with no special signal to show. */
export function sessionState(extras: AgentExtras | undefined): SessionState {
  if (extras?.stuck) return 'blocked';
  if (callsForYou(extras)) return 'waiting';
  return 'working';
}

/** At most this many rows on the screen (AC3), the same convention `PEEK_MAX_ASSETS` and
 * `CARD_MAX_ISSUES` already use elsewhere: a short list, not a scrollable one. */
export const MAX_SESSION_ROWS = 4;

const STATE_PRIORITY: Record<SessionState, number> = { blocked: 0, waiting: 1, working: 2 };

/**
 * The rows to draw, ranked and capped. Pure: the caller already filtered `entries` to one
 * mission's own sessions (`BuildingLayout.ts` already does this same filter for the war room's
 * desk/debug counts); this only decides the state label, the order (the agent most likely to
 * need a look first: blocked, then waiting, then working; ties keep arrival order, the only
 * order a caller not sorted by anything else can offer) and the cap.
 */
export function sessionRows(entries: SessionEntry[], max = MAX_SESSION_ROWS): SessionRow[] {
  return entries
    .map((entry) => ({ id: entry.id, name: entry.name, state: sessionState(entry.extras) }))
    .sort((a, b) => STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state])
    .slice(0, max);
}

const STATE_MARK: Record<SessionState, string> = { blocked: '■', waiting: '●', working: '○' };

// A name long enough to leave the mark, spacing and the longest state word ("blocked") within
// the board drawer's own 44-character line cap (`canvasBoardSections`'s `draw()`,
// `missionRooms.ts`): review fix — truncating the whole formatted line there, as before, could
// cut off the state word entirely for a long name, so a blocked session could read as nothing
// more than its name.
const MAX_SESSION_NAME_LEN = 28;

/** One line per row, for the board's canvas `draw(title, lines)` (`missionRooms.ts`'s
 * `canvasBoard`). A mark first, so the state reads even at a glance, the same idea as the
 * issues board's own "✓"/"○" marks. */
export function sessionLines(rows: SessionRow[]): string[] {
  if (rows.length === 0) return ['No live sessions'];
  return rows.map((row) => {
    const name = row.name.length > MAX_SESSION_NAME_LEN ? `${row.name.slice(0, MAX_SESSION_NAME_LEN - 1)}…` : row.name;
    return `${STATE_MARK[row.state]} ${name} — ${row.state}`;
  });
}

/**
 * Floor data model (issue #118). A floor is a whitelisted short repo name (one segment, or
 * two joined by a slash when an org-qualifying parent directory applies, `server/floor.ts`'s
 * own rule), or the shared `'general'` floor for a session with no resolvable repo
 * (`server/seam.ts`'s `projectAgents` is the only place that field crosses to the browser).
 * This module is pure: no scene, no DOM, so it is cheap to unit test and safe for both
 * `main.ts` (choosing the floor to focus) and `AgentPoller`/`BuildingLayout` (filtering and
 * per-floor storage) to import.
 */

/** The shared floor every session with no resolvable repo lands on (scope item 2). */
export const GENERAL_FLOOR = 'general';

/**
 * No filter: every agent shows, from every floor, the office's original single-building
 * behavior (review: a cold start, or an explicit choice, must never silently hide every
 * waiting agent on another floor from the one place meant to catch them). This is the
 * default until the user picks a specific floor. `BuildingLayout`'s own storage key for this
 * state is the legacy bare key (`floorStorageKey`'s `floor` argument stays unset for it) —
 * the same room list the single building already used before floors existed, so choosing
 * "All floors" costs no migration and loses no data: it already is today's behavior.
 */
export const ALL_FLOORS = 'all';

/**
 * The legacy, pre-floors room-kind-list storage key. Duplicated from
 * `BuildingLayout.BUILDING_STORAGE_KEY` as a literal: a plain data module should not import
 * a scene-graph file for one string, and the two are kept in sync by
 * `tests/floor-registry.test.ts`'s own cross-check against the real export.
 */
export const LEGACY_ROOMS_KEY = 'agents-office.building.rooms';

/** Where the last-focused floor is remembered, the same pattern `src/layout/registry.ts` uses for the layout choice. */
export const FOCUSED_FLOOR_KEY = 'agents-office.floor';

/**
 * One floor-name segment, the same shape `server/seam.ts`'s `FLOOR_SEGMENT` whitelists: a
 * short name, no slash, 1-40 characters, never `.` or `..`. A floor name is one segment, or
 * two joined by a single slash (the org-qualifying case); never more than one slash.
 */
const SEGMENT = '[A-Za-z0-9_.-]{1,40}';
const FLOOR_NAME_RE = new RegExp(`^${SEGMENT}(?:/${SEGMENT})?$`);

/** Whether a string is a well-shaped floor name: one segment, or two joined by one slash, never `.` or `..` in either. */
export function isFloorName(value: string): boolean {
  if (!FLOOR_NAME_RE.test(value)) return false;
  return !value.split('/').some((segment) => segment === '.' || segment === '..');
}

/** A floor's own room-kind-list storage key (`BuildingLayout.floorStorageKey` builds the same string). */
export function floorRoomsStorageKey(floor: string): string {
  return `${LEGACY_ROOMS_KEY}:${floor}`;
}

/** An agent's floor, defaulting to the general floor for a missing or malformed value (never a crash). */
function floorOf(agent: { floor?: string }): string {
  return agent.floor && isFloorName(agent.floor) ? agent.floor : GENERAL_FLOOR;
}

/** `#floor=<name>` from the URL hash, or null without one or with a malformed name. `#floor=all` resolves to `ALL_FLOORS`, a well-shaped name like any other. */
export function floorFromHash(hash: string): string | null {
  const match = /(?:^|[?&#])floor=([^&]+)/.exec(hash);
  if (!match) return null;
  let name: string;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return isFloorName(name) ? name : null;
}

export interface FloorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Every floor with at least one tracked session right now, sorted, `'general'` always last. Never includes `ALL_FLOORS`: that is a view choice, not a floor a session can be on. */
export function knownFloors(agents: ReadonlyArray<{ floor?: string }>): string[] {
  const floors = new Set<string>([GENERAL_FLOOR]);
  for (const agent of agents) floors.add(floorOf(agent));
  return [...floors].sort((a, b) => {
    if (a === GENERAL_FLOOR) return b === GENERAL_FLOOR ? 0 : 1;
    if (b === GENERAL_FLOOR) return -1;
    return a.localeCompare(b);
  });
}

/**
 * The floor to focus: `#floor=` in the URL first (an explicit link always wins, the same
 * URL-first order `chooseViewMode`/`chooseLayoutId` already use), then the last floor the
 * user visited, else `ALL_FLOORS` (review: a fresh page load has not polled any agent yet,
 * so there is no "busiest floor" to compute a default from before the first poll answers —
 * showing everything, same as today, is the only safe default at that point; the
 * floor-switch menu surfaces a specific floor for the user to choose once agents are known).
 */
export function defaultFloor(
  storage: Pick<FloorStorage, 'getItem'> | undefined,
  hash: string,
): string {
  const fromHash = floorFromHash(hash);
  if (fromHash) return fromHash;
  const stored = storage?.getItem(FOCUSED_FLOOR_KEY);
  if (stored && isFloorName(stored)) return stored;
  return ALL_FLOORS;
}

export function rememberFloor(floor: string, storage: Pick<FloorStorage, 'setItem'> | undefined): void {
  storage?.setItem(FOCUSED_FLOOR_KEY, floor);
}

/** The parts of `window.location` a floor switch needs; injectable for tests. */
export interface FloorSwitchLocation {
  href: string;
  hash: string;
  assign(url: string): void;
  reload(): void;
}

/**
 * Load the page again focused on a new floor (the same "the page reloads" pattern
 * `reloadForLayoutSwitch`, `src/layout/registry.ts`, uses for a layout switch: a live
 * teardown-and-rebuild of the whole building, mid-session, risks the render budget and the
 * static-merge zones far more than a reload the user already expects from the one other
 * full-scene switch this office has). Always reloads (review fix: the previous version only
 * called `location.reload()` when the hash already named the target floor — the branch the
 * select's own change handler never reaches, since it skips calling this at all when the
 * floor does not change — so picking a different floor updated the address bar and
 * `localStorage` but left the page's in-memory state on the old floor until a manual
 * refresh). Setting the hash through `assign()` updates the URL and the browser's history
 * before the reload, same as a normal navigation would; `location.hash = ...` is not used
 * here since the injectable `FloorSwitchLocation` keeps the same two methods
 * `reloadForLayoutSwitch` already relies on, not a settable property.
 */
export function reloadForFloorSwitch(location: FloorSwitchLocation, floor: string): void {
  const nextHash = `#floor=${floor}`;
  if (location.hash !== nextHash) {
    const url = new URL(location.href);
    url.hash = nextHash;
    location.assign(url.toString());
  }
  location.reload();
}

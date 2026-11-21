/**
 * Floor data model (issue #118). A floor is a whitelisted short repo name, or the shared
 * `'general'` floor for a session with no resolvable repo (`server/floor.ts` resolves it;
 * `server/seam.ts`'s `projectAgents` is the only place that field crosses to the browser).
 * This module is pure: no scene, no DOM, so it is cheap to unit test and safe for both
 * `main.ts` (choosing the floor to focus) and `AgentPoller`/`BuildingLayout` (filtering and
 * per-floor storage) to import.
 */

/** The shared floor every session with no resolvable repo lands on (scope item 2). */
export const GENERAL_FLOOR = 'general';

/**
 * The one floor today's single building's room list migrates to at cutover (the floors
 * design document: "the repo this session's data already belongs to, confirmed by the 10
 * `mission` rooms currently live").
 */
export const MIGRATION_FLOOR = 'agents-office';

/**
 * The legacy, pre-floors room-kind-list storage key. Duplicated from
 * `BuildingLayout.BUILDING_STORAGE_KEY` as a literal: a plain data module should not import
 * a scene-graph file for one string, and the two are kept in sync by
 * `tests/floor-registry.test.ts`'s own cross-check against the real export.
 */
export const LEGACY_ROOMS_KEY = 'agents-office.building.rooms';

/** Where the last-focused floor is remembered, the same pattern `src/layout/registry.ts` uses for the layout choice. */
export const FOCUSED_FLOOR_KEY = 'agents-office.floor';

/** Same token shape `server/seam.ts`'s `REPO_SHORT` whitelists: a short name, no slash, 1-40 characters. */
const FLOOR_NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;

/** Whether a string is a well-shaped floor name (never `.` or `..`, never empty, never over 40 characters). */
export function isFloorName(value: string): boolean {
  return FLOOR_NAME_RE.test(value) && value !== '.' && value !== '..';
}

/** A floor's own room-kind-list storage key (`BuildingLayout.floorStorageKey` builds the same string). */
export function floorRoomsStorageKey(floor: string): string {
  return `${LEGACY_ROOMS_KEY}:${floor}`;
}

/** An agent's floor, defaulting to the general floor for a missing or malformed value (never a crash). */
function floorOf(agent: { floor?: string }): string {
  return agent.floor && isFloorName(agent.floor) ? agent.floor : GENERAL_FLOOR;
}

/** `#floor=<name>` from the URL hash, or null without one or with a malformed name. */
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

/**
 * One-time migration (floors design document): today's single building's room list moves to
 * the `agents-office` floor's own key; the legacy key is removed, never kept as a dual-read
 * path. A storage with nothing at the legacy key, or a target key that already has data (a
 * migration that already ran), is a no-op — the second call never overwrites real data with
 * a stale copy.
 */
export function migrateLegacyRooms(storage: FloorStorage): void {
  const legacy = storage.getItem(LEGACY_ROOMS_KEY);
  if (legacy === null) return;
  const targetKey = floorRoomsStorageKey(MIGRATION_FLOOR);
  if (storage.getItem(targetKey) === null) storage.setItem(targetKey, legacy);
  storage.removeItem(LEGACY_ROOMS_KEY);
}

/** Every floor with at least one tracked session right now, sorted, `'general'` always last. */
export function knownFloors(agents: ReadonlyArray<{ floor?: string }>): string[] {
  const floors = new Set<string>([GENERAL_FLOOR]);
  for (const agent of agents) floors.add(floorOf(agent));
  return [...floors].sort((a, b) => {
    if (a === GENERAL_FLOOR) return b === GENERAL_FLOOR ? 0 : 1;
    if (b === GENERAL_FLOOR) return -1;
    return a.localeCompare(b);
  });
}

/** The floor with the most tracked sessions right now. Ties keep the alphabetically-first floor. Null with no agents at all. */
function busiestFloor(agents: ReadonlyArray<{ floor?: string }>): string | null {
  if (agents.length === 0) return null;
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const floor = floorOf(agent);
    counts.set(floor, (counts.get(floor) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const floor of [...counts.keys()].sort()) {
    const count = counts.get(floor)!;
    if (count > bestCount) {
      best = floor;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The floor to focus: `#floor=` in the URL first (an explicit link always wins, the same
 * URL-first order `chooseViewMode`/`chooseLayoutId` already use), then the last floor the
 * user visited, then the floor with the most tracked sessions right now, else the shared
 * general floor (the brief's default order).
 */
export function defaultFloor(
  agents: ReadonlyArray<{ floor?: string }>,
  storage: Pick<FloorStorage, 'getItem'> | undefined,
  hash: string,
): string {
  const fromHash = floorFromHash(hash);
  if (fromHash) return fromHash;
  const stored = storage?.getItem(FOCUSED_FLOOR_KEY);
  if (stored && isFloorName(stored)) return stored;
  return busiestFloor(agents) ?? GENERAL_FLOOR;
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
 * full-scene switch this office has). A hash that already names this floor reloads in
 * place; otherwise it navigates to the new hash.
 */
export function reloadForFloorSwitch(location: FloorSwitchLocation, floor: string): void {
  const nextHash = `#floor=${floor}`;
  if (location.hash === nextHash) {
    location.reload();
    return;
  }
  const url = new URL(location.href);
  url.hash = nextHash;
  location.assign(url.toString());
}

import { ALL_FLOORS } from './FloorRegistry.js';

/**
 * The floor this page load is focused on (issue #118). A module-level singleton, not a
 * class: `main.ts` sets it once, early, before any layout factory runs (the glob-imported
 * `src/addons/*.ts` register factories at import time, but `building.ts`'s factory only
 * reads this value when `createLayout` actually invokes it, later in `main.ts`'s own body —
 * after the choice below has been made). Switching floors reloads the whole page
 * (`reloadForFloorSwitch`), so this value never changes in place during one page's life.
 *
 * Defaults to `ALL_FLOORS` (issue #191 review, blocking): `main.ts` only ever calls
 * `setFocusedFloor` on the building-layout branch — the flat "activity" layout, and any other
 * layout that is not floor-aware, never calls it at all. A default of `GENERAL_FLOOR` (a real,
 * selectable floor) would make `plugins/github/client.ts`'s `worldChanged` — which reads this
 * value unconditionally, with no layout check of its own — filter every kanban board against
 * "general" and keep none. `ALL_FLOORS` reads as "no floor chosen," the one default every
 * floor-unaware consumer already needs: show everything, same as before floors existed.
 */
let floor: string = ALL_FLOORS;

export function setFocusedFloor(name: string): void {
  floor = name;
}

export function focusedFloor(): string {
  return floor;
}

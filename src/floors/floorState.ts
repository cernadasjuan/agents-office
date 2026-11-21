import { GENERAL_FLOOR } from './FloorRegistry.js';

/**
 * The floor this page load is focused on (issue #118). A module-level singleton, not a
 * class: `main.ts` sets it once, early, before any layout factory runs (the glob-imported
 * `src/addons/*.ts` register factories at import time, but `building.ts`'s factory only
 * reads this value when `createLayout` actually invokes it, later in `main.ts`'s own body —
 * after the choice below has been made). Switching floors reloads the whole page
 * (`reloadForFloorSwitch`), so this value never changes in place during one page's life.
 */
let floor = GENERAL_FLOOR;

export function setFocusedFloor(name: string): void {
  floor = name;
}

export function focusedFloor(): string {
  return floor;
}

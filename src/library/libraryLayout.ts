/**
 * Pure geometry for the library's own scene (issue #239): which rect each section room rents,
 * and where each of its shelves sits inside that room. No Three.js here, so this is easy to
 * test the same way `addons/building/RoomPlanner.ts` keeps its own room-slot math pure.
 */
import { slotFor, type RoomSlot } from '../addons/building/RoomPlanner.js';

/** A room's own shelf grid: 10x10, matching `MAX_ENTRIES` (issue #221's own 100-entry cap)
 * exactly, so a section at the server's own cap still gets one shelf per file, not a cap
 * within the cap. */
export const SHELF_COLUMNS = 10;
export const SHELF_ROWS = 10;
export const SHELF_CAP = SHELF_COLUMNS * SHELF_ROWS;

/** One section's own room: the slot it rents (the same ring-growth math the office's own
 * rooms use, `slotFor`), and up to `SHELF_CAP` of its own entries placed in a grid. */
export interface SectionRoomLayout {
  sectionIndex: number;
  name: string;
  slot: RoomSlot;
  shownEntryCount: number;
  hiddenEntryCount: number;
}

/** One room per top-level section, in the server's own order, each renting the next slot —
 * the same growth rule the office building already uses for its own rooms (issue #220's own
 * "the Library sector grows the same way a component wing keeps claiming rings"). */
export function sectionRoomLayouts(sections: Array<{ name: string; entries: unknown[] }>): SectionRoomLayout[] {
  return sections.map((section, sectionIndex) => ({
    sectionIndex,
    name: section.name,
    slot: slotFor(sectionIndex),
    shownEntryCount: Math.min(section.entries.length, SHELF_CAP),
    hiddenEntryCount: Math.max(0, section.entries.length - SHELF_CAP),
  }));
}

/** Where the `entryIndex`-th shelf sits in its own room's local frame (`a` along the door
 * wall, `d` the depth from it) — a 10-column grid, centered on the room's own middle, starting
 * two units in from the door so no shelf ever shares floor space with the doorway. */
export function shelfPlacement(entryIndex: number): { a: number; d: number } {
  const column = entryIndex % SHELF_COLUMNS;
  const row = Math.floor(entryIndex / SHELF_COLUMNS);
  return { a: (column - (SHELF_COLUMNS - 1) / 2) * 1.0, d: 2 + row * 1.0 };
}

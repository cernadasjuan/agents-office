import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slotFor } from '../src/addons/building/RoomPlanner.js';
import { SHELF_CAP, SHELF_COLUMNS, SHELF_ROWS, sectionRoomLayouts, shelfPlacement } from '../src/library/libraryLayout.js';

test('SHELF_CAP matches the server\'s own 100-entry cap (issue #221\'s MAX_ENTRIES), so a section at the cap still gets one shelf per file', () => {
  assert.equal(SHELF_COLUMNS * SHELF_ROWS, 100);
  assert.equal(SHELF_CAP, 100);
});

test('one room per section, in order, renting the next slot outward — the same growth rule the office building already uses', () => {
  const sections = [
    { name: 'vendors', entries: [{ title: 'a' }, { title: 'b' }] },
    { name: 'domain', entries: [{ title: 'c' }] },
  ];
  const layouts = sectionRoomLayouts(sections);
  assert.deepEqual(layouts.map((l) => l.name), ['vendors', 'domain']);
  assert.deepEqual(layouts.map((l) => l.slot), [slotFor(0), slotFor(1)]);
  assert.deepEqual(layouts.map((l) => l.shownEntryCount), [2, 1]);
  assert.deepEqual(layouts.map((l) => l.hiddenEntryCount), [0, 0]);
});

test('a section past the shelf cap shows SHELF_CAP shelves and reports the rest as hidden, never silently dropped', () => {
  const entries = Array.from({ length: 140 }, (_, i) => ({ title: `entry ${i}` }));
  const [layout] = sectionRoomLayouts([{ name: 'big', entries }]);
  assert.equal(layout!.shownEntryCount, 100);
  assert.equal(layout!.hiddenEntryCount, 40);
});

test('shelfPlacement fills a 10-column grid, row-major, starting 2 units in from the door', () => {
  assert.deepEqual(shelfPlacement(0), { a: -4.5, d: 2 });
  assert.deepEqual(shelfPlacement(9), { a: 4.5, d: 2 });
  assert.deepEqual(shelfPlacement(10), { a: -4.5, d: 3 });
  assert.deepEqual(shelfPlacement(99), { a: 4.5, d: 11 });
});

test('every shelf position in a 100-shelf room is unique (no two files ever share a spot)', () => {
  const points = Array.from({ length: 100 }, (_, i) => shelfPlacement(i));
  const keys = new Set(points.map((p) => `${p.a}:${p.d}`));
  assert.equal(keys.size, 100);
});

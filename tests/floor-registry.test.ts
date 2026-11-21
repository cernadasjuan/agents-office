import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultFloor, floorFromHash, floorRoomsStorageKey, GENERAL_FLOOR, isFloorName,
  knownFloors, LEGACY_ROOMS_KEY, migrateLegacyRooms, MIGRATION_FLOOR,
  reloadForFloorSwitch, rememberFloor,
} from '../src/floors/FloorRegistry.js';

function memoryStorage(initial: Record<string, string> = {}): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

// --- isFloorName ---

test('isFloorName accepts a short repo-shaped token and rejects a path, an empty string or a relative segment', () => {
  assert.equal(isFloorName('agents-office'), true);
  assert.equal(isFloorName('general'), true);
  assert.equal(isFloorName(''), false);
  assert.equal(isFloorName('..'), false);
  assert.equal(isFloorName('.'), false);
  assert.equal(isFloorName('owner/repo'), false);
  assert.equal(isFloorName('x'.repeat(41)), false);
});

// --- floorRoomsStorageKey ---

test('floorRoomsStorageKey namespaces the legacy room-list key by floor', () => {
  assert.equal(floorRoomsStorageKey('agents-office'), `${LEGACY_ROOMS_KEY}:agents-office`);
  assert.equal(floorRoomsStorageKey(GENERAL_FLOOR), `${LEGACY_ROOMS_KEY}:general`);
});

// --- floorFromHash ---

test('floorFromHash reads #floor=<name>, alongside another hash parameter', () => {
  assert.equal(floorFromHash('#floor=agents-office'), 'agents-office');
  assert.equal(floorFromHash('#view=iso&floor=widget-service'), 'widget-service');
  assert.equal(floorFromHash('#floor=widget-service&view=iso'), 'widget-service');
});

test('floorFromHash is null without one, or with a malformed name', () => {
  assert.equal(floorFromHash(''), null);
  assert.equal(floorFromHash('#view=iso'), null);
  assert.equal(floorFromHash('#floor=..'), null);
  assert.equal(floorFromHash('#floor=owner%2Frepo'), null);
});

// --- migrateLegacyRooms ---

test('migrateLegacyRooms copies today\'s single building forward to the agents-office floor, and removes the legacy key', () => {
  const storage = memoryStorage({ [LEGACY_ROOMS_KEY]: '["office","library","desks"]' });

  migrateLegacyRooms(storage);

  assert.equal(storage.getItem(floorRoomsStorageKey(MIGRATION_FLOOR)), '["office","library","desks"]');
  assert.equal(storage.getItem(LEGACY_ROOMS_KEY), null);
});

test('migrateLegacyRooms is a no-op without a legacy key', () => {
  const storage = memoryStorage();

  migrateLegacyRooms(storage);

  assert.equal(storage.getItem(floorRoomsStorageKey(MIGRATION_FLOOR)), null);
});

test('migrateLegacyRooms never overwrites a floor that already has its own room list (a second run)', () => {
  const storage = memoryStorage({
    [LEGACY_ROOMS_KEY]: '["office","stale"]',
    [floorRoomsStorageKey(MIGRATION_FLOOR)]: '["office","library","desks","lab"]',
  });

  migrateLegacyRooms(storage);

  assert.equal(storage.getItem(floorRoomsStorageKey(MIGRATION_FLOOR)), '["office","library","desks","lab"]');
  assert.equal(storage.getItem(LEGACY_ROOMS_KEY), null);
});

// --- knownFloors ---

test('knownFloors lists every floor with a tracked session plus general, sorted, general last', () => {
  assert.deepEqual(
    knownFloors([{ floor: 'widget-service' }, { floor: 'agents-office' }, { floor: GENERAL_FLOOR }, {}]),
    ['agents-office', 'widget-service', GENERAL_FLOOR],
  );
});

test('knownFloors always includes general even with zero agents', () => {
  assert.deepEqual(knownFloors([]), [GENERAL_FLOOR]);
});

// --- defaultFloor ---

test('defaultFloor prefers #floor= in the URL over everything else', () => {
  const storage = memoryStorage({ 'agents-office.floor': 'other-repo' });
  assert.equal(defaultFloor([{ floor: 'agents-office' }, { floor: 'agents-office' }], storage, '#floor=widget-service'), 'widget-service');
});

test('defaultFloor falls back to the last visited floor when the URL names none', () => {
  const storage = memoryStorage({ 'agents-office.floor': 'widget-service' });
  assert.equal(defaultFloor([{ floor: 'agents-office' }], storage, ''), 'widget-service');
});

test('defaultFloor falls back to the busiest floor when nothing is stored', () => {
  const agents = [{ floor: 'agents-office' }, { floor: 'agents-office' }, { floor: 'widget-service' }];
  assert.equal(defaultFloor(agents, memoryStorage(), ''), 'agents-office');
});

test('a session with no resolvable repo (no floor field) counts toward general for the busiest-floor tie-break', () => {
  const agents = [{}, {}, { floor: 'agents-office' }];
  assert.equal(defaultFloor(agents, memoryStorage(), ''), GENERAL_FLOOR);
});

test('defaultFloor is the general floor with no stored choice and no agents at all', () => {
  assert.equal(defaultFloor([], memoryStorage(), ''), GENERAL_FLOOR);
});

test('rememberFloor stores the chosen floor under its own key', () => {
  const storage = memoryStorage();
  rememberFloor('widget-service', storage);
  assert.equal(storage.getItem('agents-office.floor'), 'widget-service');
});

// --- reloadForFloorSwitch ---

function fakeLocation(href: string): { assigned: string[]; reloaded: number; href: string; hash: string; assign(url: string): void; reload(): void } {
  const url = new URL(href);
  const self = {
    assigned: [] as string[],
    reloaded: 0,
    get href() { return url.toString(); },
    get hash() { return url.hash; },
    assign(next: string) { self.assigned.push(next); },
    reload() { self.reloaded++; },
  };
  return self;
}

test('reloadForFloorSwitch navigates to the new #floor= hash when it differs', () => {
  const location = fakeLocation('http://localhost:5173/#floor=general');

  reloadForFloorSwitch(location, 'agents-office');

  assert.equal(location.assigned.length, 1);
  assert.ok(location.assigned[0].endsWith('#floor=agents-office'));
  assert.equal(location.reloaded, 0);
});

test('reloadForFloorSwitch reloads in place when the hash already names that floor', () => {
  const location = fakeLocation('http://localhost:5173/#floor=agents-office');

  reloadForFloorSwitch(location, 'agents-office');

  assert.equal(location.reloaded, 1);
  assert.equal(location.assigned.length, 0);
});

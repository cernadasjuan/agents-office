import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALL_FLOORS, defaultFloor, floorFromHash, floorRoomsStorageKey, GENERAL_FLOOR, isFloorName,
  knownFloors, LEGACY_ROOMS_KEY, reloadForFloorSwitch, rememberFloor,
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

test('isFloorName accepts a short repo-shaped token and the org-qualified two-segment form', () => {
  assert.equal(isFloorName('agents-office'), true);
  assert.equal(isFloorName('general'), true);
  assert.equal(isFloorName('all'), true);
  assert.equal(isFloorName('gabriel-amyot/agents-office'), true);
  assert.equal(isFloorName('grp-beklever-com/project-management'), true);
});

test('isFloorName rejects an empty string, a relative segment, more than one slash, and an over-length segment', () => {
  assert.equal(isFloorName(''), false);
  assert.equal(isFloorName('..'), false);
  assert.equal(isFloorName('.'), false);
  assert.equal(isFloorName('a/..'), false);
  assert.equal(isFloorName('../a'), false);
  assert.equal(isFloorName('a/b/c'), false);
  assert.equal(isFloorName('x'.repeat(41)), false);
});

// --- floorRoomsStorageKey ---

test('floorRoomsStorageKey namespaces the legacy room-list key by floor, org-qualified names included', () => {
  assert.equal(floorRoomsStorageKey('agents-office'), `${LEGACY_ROOMS_KEY}:agents-office`);
  assert.equal(floorRoomsStorageKey(GENERAL_FLOOR), `${LEGACY_ROOMS_KEY}:general`);
  assert.equal(floorRoomsStorageKey('gabriel-amyot/agents-office'), `${LEGACY_ROOMS_KEY}:gabriel-amyot/agents-office`);
});

// --- floorFromHash ---

test('floorFromHash reads #floor=<name>, alongside another hash parameter', () => {
  assert.equal(floorFromHash('#floor=agents-office'), 'agents-office');
  assert.equal(floorFromHash('#view=iso&floor=widget-service'), 'widget-service');
  assert.equal(floorFromHash('#floor=widget-service&view=iso'), 'widget-service');
  assert.equal(floorFromHash('#floor=all'), ALL_FLOORS);
});

test('floorFromHash is null without one, or with a malformed name', () => {
  assert.equal(floorFromHash(''), null);
  assert.equal(floorFromHash('#view=iso'), null);
  assert.equal(floorFromHash('#floor=..'), null);
  assert.equal(floorFromHash('#floor=owner%2Fa%2Fb'), null);
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

test('defaultFloor prefers #floor= in the URL over everything else, "all" included', () => {
  const storage = memoryStorage({ 'agents-office.floor': 'other-repo' });
  assert.equal(defaultFloor(storage, '#floor=widget-service'), 'widget-service');
  assert.equal(defaultFloor(storage, '#floor=all'), ALL_FLOORS);
});

test('defaultFloor falls back to the last visited floor when the URL names none', () => {
  const storage = memoryStorage({ 'agents-office.floor': 'widget-service' });
  assert.equal(defaultFloor(storage, ''), 'widget-service');
});

test('defaultFloor is "all floors" with no stored choice and no #floor= (review: a fresh page load has no agent data yet to pick a busiest floor from)', () => {
  assert.equal(defaultFloor(memoryStorage(), ''), ALL_FLOORS);
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

test('reloadForFloorSwitch updates the #floor= hash and always reloads when the floor differs (review: the old version never reloaded this branch)', () => {
  const location = fakeLocation('http://localhost:5173/#floor=general');

  reloadForFloorSwitch(location, 'agents-office');

  assert.equal(location.assigned.length, 1);
  assert.ok(location.assigned[0].endsWith('#floor=agents-office'));
  assert.equal(location.reloaded, 1, 'a floor switch must actually switch, not just update the address bar');
});

test('reloadForFloorSwitch reloads without assigning again when the hash already names that floor', () => {
  const location = fakeLocation('http://localhost:5173/#floor=agents-office');

  reloadForFloorSwitch(location, 'agents-office');

  assert.equal(location.reloaded, 1);
  assert.equal(location.assigned.length, 0);
});

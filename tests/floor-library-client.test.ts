import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { World, WorldLibrary } from '../src/extensions.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
const { FloorLibraryOfficeExtension } = await import('../plugins/floor-library/client.js');
const { ALL_FLOORS } = await import('../src/floors/FloorRegistry.js');
const { setFocusedFloor } = await import('../src/floors/floorState.js');
const { countDrawCalls } = await import('../src/scene/RenderBudget.js');
const { libraryEntryId, libraryIndexId, librarySectionId } = await import('../src/ui/LibraryCard.js');

setFocusedFloor(ALL_FLOORS);
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const LIBRARY_ROOM_NAME = 'room-1-library';

function sceneWithLibraryRoom(): THREE.Scene {
  const scene = new THREE.Scene();
  const room = new THREE.Group();
  room.name = LIBRARY_ROOM_NAME;
  scene.add(room);
  return scene;
}

function library(repo: string | undefined, sections: WorldLibrary['sections'], id = 'lib'): WorldLibrary {
  return { id, sections, ...(repo ? { repo } : {}) };
}

function world(libraries: WorldLibrary[]): World {
  return { plugins: ['floor-library'], rooms: [], boards: [], jiraTickets: [], libraries };
}

/** CSS2D labels only (issue #221: a plaque, a shown entry line, or a "more" sign) — never the
 * invisible pick-target meshes `mount()` adds alongside them (those carry no `detailSign`). */
function shelfSigns(scene: THREE.Scene): THREE.Object3D[] {
  return scene.children.filter((child) => child.userData.detailSign !== undefined);
}

test('without the library room in the scene, no shelf mounts (another layout, or not grown yet)', () => {
  setFocusedFloor('pm-floor');
  const scene = new THREE.Scene(); // no room-1-library
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  extension.worldChanged(world([library('pm-floor', [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }])]));
  assert.equal(shelfSigns(scene).length, 0);
  assert.deepEqual(extension.pickTargets(), []);
});

test('without a library for the focused floor, no shelf mounts (graceful degradation, no data)', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  extension.worldChanged(world([library('widget-service', [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }])]));
  assert.equal(shelfSigns(scene).length, 0);
});

test('on "all floors" with exactly one library configured, it shows anyway: the default view every cold start lands on must not hide the only library there is', () => {
  setFocusedFloor(ALL_FLOORS);
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  extension.worldChanged(world([library('pm-floor', [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }])]));
  assert.equal(shelfSigns(scene).length, 2, 'one plaque + one entry line for the single section/entry');
});

test('on "all floors" with no library at all, nothing shows (graceful degradation, no data)', () => {
  setFocusedFloor(ALL_FLOORS);
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  extension.worldChanged(world([]));
  assert.equal(shelfSigns(scene).length, 0);
});

test('on "all floors" with more than one library configured, every one\'s sections list together rather than picking one floor to guess at', () => {
  setFocusedFloor(ALL_FLOORS);
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  extension.worldChanged(world([
    library('pm-floor', [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }], 'lib-a'),
    library('harness', [{ name: 'skills', entries: [{ title: 'write-a-skill' }] }], 'lib-b'),
  ]));
  const signs = shelfSigns(scene);
  const plaqueTexts = signs.filter((sign) => sign.userData.detailSign.hoverOnly === false)
    .map((sign) => (sign as THREE.Object3D & { element: HTMLElement }).element.textContent);
  assert.deepEqual(plaqueTexts, ['vendors', 'skills']);
});

test('a focused floor with a matching library mounts one plaque and one line per shown entry, capped at 3 sections and 4 entries, with "more" signs that never hide the rest (issue #221 AC1)', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  const sections: WorldLibrary['sections'] = [
    { name: 'vendors', entries: [{ title: 'Placer.ai' }, { title: 'Old vendor', archived: true }] },
    { name: 'domain', entries: [{ title: 'Proximity' }], truncated: true },
    { name: 'surfaces', entries: [{ title: 'Registry' }] },
    { name: 'clients', entries: [{ title: 'Clover' }] }, // past the render cap (3 slots): never mounts
  ];
  extension.worldChanged(world([library('pm-floor', sections)]));
  const signs = shelfSigns(scene);

  const plaques = signs.filter((sign) => sign.userData.detailSign.hoverOnly === false);
  assert.deepEqual(plaques.map((sign) => (sign as THREE.Object3D & { element: HTMLElement }).element.textContent), ['vendors', 'domain', 'surfaces']);

  const lines = signs.filter((sign) => sign.userData.detailSign.hoverOnly === true)
    .map((sign) => (sign as THREE.Object3D & { element: HTMLElement }).element.textContent);
  // vendors: both its entries fit under the 4-line cap, nothing truncated, not the last slot —
  // no "more" sign for it at all.
  assert.deepEqual(lines.slice(0, 2), ['Placer.ai', 'Old vendor (archived)']);
  // domain: the server's own `truncated` flag (more rows in its own INDEX.md than the entries
  // array carries) still shows a "more" sign even though only one entry reached the client.
  assert.deepEqual(lines.slice(2, 4), ['Proximity', '…more on this shelf']);
  // surfaces: the last of the 3 shown slots, standing in for the whole library — "clients"
  // never got a slot, so this section's own "more" sign carries that count instead, never
  // silently dropping the 4th section (issue #221 AC1).
  assert.deepEqual(lines.slice(4, 6), ['Registry', '+1 more section in the library']);
});

test('pick targets (issue #221 AC2): one per plaque, one per shown entry line, one per "more" sign, ids matching src/ui/LibraryCard\'s own scheme', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  const sections: WorldLibrary['sections'] = [
    { name: 'vendors', entries: [{ title: 'Placer.ai' }] },
    { name: 'domain', entries: [{ title: 'Proximity' }] },
    { name: 'surfaces', entries: [{ title: 'Registry' }] },
    { name: 'clients', entries: [{ title: 'Clover' }] }, // pushes surfaces into the overflow slot
  ];
  extension.worldChanged(world([library('pm-floor', sections, 'pm-lib')]));
  const ids = extension.pickTargets().map((target) => target.id);
  assert.deepEqual(ids, [
    librarySectionId('pm-lib', 0), libraryEntryId('pm-lib', 0, 0),
    librarySectionId('pm-lib', 1), libraryEntryId('pm-lib', 1, 0),
    librarySectionId('pm-lib', 2), libraryEntryId('pm-lib', 2, 0), libraryIndexId('pm-lib'),
  ], 'the 4th section is never reachable as a shelf, but its own id still surfaces through the index, never dropped');
  for (const target of extension.pickTargets()) assert.ok(target.object instanceof THREE.Object3D);
});

test('a world update with the same shelves changes nothing (no churn on every 10 s poll)', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  const sections: WorldLibrary['sections'] = [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }];
  extension.worldChanged(world([library('pm-floor', sections)]));
  const before = shelfSigns(scene);
  extension.worldChanged(world([library('pm-floor', sections)]));
  assert.deepEqual(shelfSigns(scene), before);
});

test('a library shelf and its pick targets add zero draw calls: CSS2D labels carry no WebGL geometry, and every hit-test mesh has material.visible = false (RenderBudget.ts\'s own callsOf skips it, issue #221 AC4)', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom();
  // The camera looks straight at the library's own far wall (the shelf's own world position,
  // review: a default, unaimed camera's frustum does not reach there at all, so it would read
  // "zero" the same way even if a future change swapped a CSS2DObject for a real Mesh board).
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(20, 1.9, 12);
  camera.lookAt(26.5, 1.9, 12);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const before = countDrawCalls(scene, camera);
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  const sections: WorldLibrary['sections'] = [
    { name: 'vendors', entries: [{ title: 'Placer.ai' }, { title: 'Old vendor', archived: true }], truncated: true },
    { name: 'domain', entries: [{ title: 'Proximity' }] },
    { name: 'surfaces', entries: [{ title: 'Registry' }] },
  ];
  extension.worldChanged(world([library('pm-floor', sections)]));
  assert.ok(extension.pickTargets().length > 0, 'the budget claim means nothing without real pick targets mounted');
  const after = countDrawCalls(scene, camera);
  assert.equal(after.total, before.total);
});

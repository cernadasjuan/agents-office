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

function library(repo: string | undefined, sections: WorldLibrary['sections']): WorldLibrary {
  return { id: 'lib', sections, ...(repo ? { repo } : {}) };
}

function world(libraries: WorldLibrary[]): World {
  return { plugins: ['floor-library'], rooms: [], boards: [], jiraTickets: [], libraries };
}

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
  assert.equal(shelfSigns(scene).length, 2, 'one plaque + one board for the single section');
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
    library('pm-floor', [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }]),
    library('harness', [{ name: 'skills', entries: [{ title: 'write-a-skill' }] }]),
  ]));
  const signs = shelfSigns(scene);
  const plaqueTexts = signs.filter((sign) => sign.userData.shelfRole === 'plaque')
    .map((sign) => (sign as THREE.Object3D & { element: HTMLElement }).element.textContent);
  assert.deepEqual(plaqueTexts, ['vendors', 'skills']);
});

test('a focused floor with a matching library mounts one plaque and one board per section, capped, each section name and titles visible', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  const sections: WorldLibrary['sections'] = [
    { name: 'vendors', entries: [{ title: 'Placer.ai' }, { title: 'Old vendor', archived: true }] },
    { name: 'domain', entries: [{ title: 'Proximity' }], truncated: true },
    { name: 'surfaces', entries: [{ title: 'Registry' }] },
    { name: 'clients', entries: [{ title: 'Clover' }] }, // past the render cap (3 slots)
  ];
  extension.worldChanged(world([library('pm-floor', sections)]));
  const signs = shelfSigns(scene);
  assert.equal(signs.length, 6, '3 sections shown x (one plaque + one board) each, the 4th section never mounts');

  const plaqueTexts = signs.filter((sign) => sign.userData.shelfRole === 'plaque')
    .map((sign) => (sign as THREE.Object3D & { element: HTMLElement }).element.textContent);
  assert.deepEqual(plaqueTexts, ['vendors', 'domain', 'surfaces']);

  const boards = signs.filter((sign) => sign.userData.shelfRole === 'board');
  const vendorsBoard = boards[0] as THREE.Object3D & { element: HTMLElement };
  assert.ok(vendorsBoard.element.textContent!.includes('Placer.ai'));
  assert.ok(vendorsBoard.element.textContent!.includes('Old vendor (archived)'), 'an archived entry keeps its visible mark');
  const domainBoard = boards[1] as THREE.Object3D & { element: HTMLElement };
  assert.ok(domainBoard.element.textContent!.includes('more on this shelf'), 'truncated carries its own notice');
});

test('#214: neither the section plaque nor the file board is hover-only, and both read from across the room', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  extension.worldChanged(world([library('pm-floor', [{ name: 'clients', entries: [{ title: 'blinds to go' }] }])]));
  const signs = shelfSigns(scene);
  assert.equal(signs.length, 2);
  for (const sign of signs) {
    const detail = sign.userData.detailSign as { hoverOnly: boolean; maxDistance: number };
    assert.equal(detail.hoverOnly, false, `${sign.userData.shelfRole} must not require hovering to read`);
    assert.ok(detail.maxDistance > 12, `${sign.userData.shelfRole} must read from further than a war room sign's default distance`);
  }
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

test('a library shelf sign adds zero draw calls: CSS2DObjects carry no geometry for the WebGL renderer to count', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom();
  // The camera looks straight at the library's own far wall (the shelf's own world position,
  // review: a default, unaimed camera's frustum does not reach there at all, so it would read
  // "zero" the same way even if a future change swapped the CSS2DObject for a real Mesh board).
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(20, 1.9, 12);
  camera.lookAt(26.5, 1.9, 12);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const before = countDrawCalls(scene, camera);
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  extension.worldChanged(world([library('pm-floor', [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }])]));
  const after = countDrawCalls(scene, camera);
  assert.equal(after.total, before.total);
});

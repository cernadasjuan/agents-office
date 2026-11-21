import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { World, WorldLibrary } from '../src/extensions.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
// Issue #248: client.ts now builds a StickFigure (the librarian NPC), which paints a toon
// gradient onto a real 2D canvas context (`src/utils/Materials.ts`) at import time — jsdom
// itself implements no canvas backend, the same stub every other figure-touching test file
// already installs (`tests/library-plugin.test.ts`, for one).
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => undefined, set: () => true })) as never;
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
  const plaqueTexts = signs.filter((sign) => sign.userData.shelfRole === 'plaque')
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

  const plaques = signs.filter((sign) => sign.userData.shelfRole === 'plaque');
  assert.deepEqual(plaques.map((sign) => (sign as THREE.Object3D & { element: HTMLElement }).element.textContent), ['vendors', 'domain', 'surfaces']);

  const lines = signs.filter((sign) => sign.userData.shelfRole === 'entry' || sign.userData.shelfRole === 'more')
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
    // The librarian NPC (issue #248): its own click target, always last, opening the same
    // index card the "+N more" sign above already does — a second door to the same room,
    // never a second source of truth.
    libraryIndexId('pm-lib'),
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
  // Review: `countDrawCalls` reads each mesh's own `matrixWorld`, which only `updateMatrixWorld`
  // refreshes — without it every newly added hit-test mesh is still at the identity matrix (the
  // scene's own origin), nowhere near the camera's frustum, so this assertion would pass even if
  // `callsOf` and `material.visible` were both wrong: the meshes would be "zero calls" simply
  // because they look culled at the wrong place, not because they are genuinely invisible.
  scene.updateMatrixWorld(true);
  const after = countDrawCalls(scene, camera);
  assert.equal(after.total, before.total);
  // Positive control: the exact same geometry and positions, but with a visible material,
  // must show up in the count. Without this, a regression that flips `HIT_MATERIAL.visible`
  // back to `true` would still pass the assertion above for the wrong reason (frustum culling
  // at the origin, not `material.visible`), rather than failing as it should.
  const visibleProbe = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.22, 0.2), new THREE.MeshBasicMaterial({ visible: true }));
  const firstHit = extension.pickTargets()[0]!.object as THREE.Mesh;
  visibleProbe.position.copy(firstHit.position);
  scene.add(visibleProbe);
  scene.updateMatrixWorld(true);
  const withVisibleProbe = countDrawCalls(scene, camera);
  assert.ok(withVisibleProbe.total > after.total, 'a visible mesh at a real shelf position must move the count, or this test cannot catch a flipped material.visible');
  visibleProbe.removeFromParent();
});

test('issue #221 FAIL round: a hit box is rotated to match its label\'s own orientation, so a click along the shelf row (not just dead center) still hits it, on the library room\'s real (west) door', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom(); // room-1-library -> slotFor(1) -> a west-door room
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  extension.worldChanged(world([library('pm-floor', [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }])]));

  const entryHit = extension.pickTargets().find((target) => target.id.startsWith('lib-entry:'))!;
  assert.ok(entryHit, 'the one entry mounted has its own pick target');
  const mesh = entryHit.object as THREE.Mesh;
  scene.updateMatrixWorld(true);

  // A west door room's own "along the shelf row" axis is world Z (`shelfPoint`'s own `-nz*a`
  // term with `nz = 0` for west): offset the ray along Z, not X, by less than the hit box's
  // own half-length (1.0 / 2 = 0.5) but well past its own half-depth (0.2 / 2 = 0.1) — a click
  // that visibly lands on the label's own row, not its exact center point. Before the fix,
  // this box's long axis ran along world X regardless of door side, so the same offset along Z
  // would miss it entirely (the box's Z footprint was only +/-0.1).
  const origin = mesh.position.clone().setY(mesh.position.y + 5);
  const alongZOffset = new THREE.Vector3(mesh.position.x, mesh.position.y, mesh.position.z + 0.4);
  const raycaster = new THREE.Raycaster(origin, alongZOffset.clone().sub(origin).normalize());
  const hits = raycaster.intersectObject(mesh, false);
  assert.ok(hits.length > 0, 'a point offset along the shelf row\'s own axis still hits the (rotated) box');
});

test('issue #221 FAIL round: in "all floors" with two libraries, the "+N more" sign on an overflowing library opens THAT library\'s own index, never a different library\'s', () => {
  setFocusedFloor(ALL_FLOORS);
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  // Library A alone already has more sections (4) than the room's own 3 wall slots; library B
  // (a single section) is listed after it and never gets a slot at all under the combined cap.
  const libraryA = library('floor-a', [
    { name: 'vendors', entries: [{ title: 'Placer.ai' }] },
    { name: 'domain', entries: [{ title: 'Proximity' }] },
    { name: 'surfaces', entries: [{ title: 'Registry' }] },
    { name: 'clients', entries: [{ title: 'Clover' }] }, // A's own 4th section: no slot
  ], 'lib-a');
  const libraryB = library('floor-b', [{ name: 'skills', entries: [{ title: 'write-a-skill' }] }], 'lib-b');
  extension.worldChanged(world([libraryA, libraryB]));

  const moreSignId = extension.pickTargets().find((target) => target.id.startsWith('lib-index:'))?.id;
  assert.equal(moreSignId, libraryIndexId('lib-a'), 'the overflow is library A\'s own 4th section, so the sign must open A\'s index, never B\'s — B never even got a slot to overflow from');
});

// --- Issue #248: the librarian NPC ---

test('the librarian NPC mounts once a library room and a library both exist, clickable into that library\'s own index card', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  extension.worldChanged(world([library('pm-floor', [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }], 'pm-lib')]));

  assert.deepEqual(extension.npcFigures().length, 1, 'one NPC figure, drawn through the shared figure batch');
  const npcGroup = extension.npcFigures()[0]!;
  assert.ok(npcGroup.parent === scene, 'the NPC\'s own figure root is actually in the scene (figure-batch sync requires this)');

  const targets = extension.pickTargets();
  const npcTarget = targets[targets.length - 1]!;
  assert.equal(npcTarget.id, libraryIndexId('pm-lib'));
  assert.notEqual(npcTarget.object, npcGroup, 'the NPC\'s own pick target is its own hit box, not the figure root the figure batch already manages');
});

test('the librarian NPC never mounts without the library room (graceful degradation), and unmounts if the library disappears', () => {
  setFocusedFloor('pm-floor');
  const scene = new THREE.Scene(); // no room-1-library
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  extension.worldChanged(world([library('pm-floor', [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }], 'pm-lib')]));
  assert.deepEqual(extension.npcFigures(), []);

  const withRoom = sceneWithLibraryRoom();
  const extensionWithRoom = new FloorLibraryOfficeExtension();
  extensionWithRoom.start(withRoom);
  extensionWithRoom.worldChanged(world([library('pm-floor', [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }], 'pm-lib')]));
  assert.equal(extensionWithRoom.npcFigures().length, 1);
  extensionWithRoom.worldChanged(world([])); // the library disappears
  assert.deepEqual(extensionWithRoom.npcFigures(), [], 'the NPC leaves when there is no catalog left for him to show');
});

test('the librarian NPC is the same figure instance across an ordinary poll with no real changes (no churn)', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  const sections: WorldLibrary['sections'] = [{ name: 'vendors', entries: [{ title: 'Placer.ai' }] }];
  extension.worldChanged(world([library('pm-floor', sections, 'pm-lib')]));
  const first = extension.npcFigures()[0];
  extension.worldChanged(world([library('pm-floor', sections, 'pm-lib')]));
  assert.equal(extension.npcFigures()[0], first);
});

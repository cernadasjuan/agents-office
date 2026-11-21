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
const { IsometricController } = await import('../src/scene/IsometricCamera.js');

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

test('a focused floor with a matching library mounts one plaque and one line per shown entry, capped at 3 sections and 2 entries (FAIL round 2: fewer, wider-spaced lines so the shelf clears the room\'s own floor budget), with "more" signs that never hide the rest (issue #221 AC1)', () => {
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
  // vendors: both its entries fit under the 2-line cap, nothing truncated, not the last slot —
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

test('issue #221 FAIL round 2: a library that gets zero shown sections at all (every slot already belongs to an earlier library) still gets its own reachable "+N more" sign', () => {
  setFocusedFloor(ALL_FLOORS);
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  // Library A exactly fills all 3 wall slots on its own, with nothing of its own left over —
  // review (round 2): scoping the "+N more" count to the last shown slot's own library (the
  // round 1 fix) made this exact case mount no "more" sign at all, because A's own hidden-count
  // is zero. Library B is configured too, but never gets a slot — before this fix, B would be
  // completely unreachable with no sign of any kind.
  const libraryA = library('floor-a', [
    { name: 'vendors', entries: [{ title: 'Placer.ai' }] },
    { name: 'domain', entries: [{ title: 'Proximity' }] },
    { name: 'surfaces', entries: [{ title: 'Registry' }] },
  ], 'lib-a');
  const libraryB = library('floor-b', [{ name: 'skills', entries: [{ title: 'write-a-skill' }] }], 'lib-b');
  extension.worldChanged(world([libraryA, libraryB]));

  const indexTargets = extension.pickTargets().filter((target) => target.id.startsWith('lib-index:'));
  assert.ok(indexTargets.some((target) => target.id === libraryIndexId('lib-b')),
    'library B never got a shelf slot, but its own index must still be one click away, never silently dropped');
});

test('issue #221 FAIL round 2: the section label and its shown entry lines never overlap at the default isometric zoom', () => {
  setFocusedFloor('pm-floor');
  const scene = sceneWithLibraryRoom();
  const extension = new FloorLibraryOfficeExtension();
  extension.start(scene);
  const sections: WorldLibrary['sections'] = [
    { name: 'vendors', entries: [{ title: 'Placer.ai' }, { title: 'Old vendor', archived: true }], truncated: true },
  ];
  extension.worldChanged(world([library('pm-floor', sections)]));
  const signs = shelfSigns(scene);
  assert.equal(signs.length, 4, 'one plaque, two entry lines (the cap), one "more" sign for the truncated row');

  // The room's own real door side (west, per `findLibraryRoomIndex`/`slotFor`'s own first-ring
  // assignment for a freshly built office) looking along +X: build the same orthographic
  // camera this office's own isometric view starts at (`IsometricCamera.ts`'s own starting
  // `halfHeight = 20`), on the same 800px-tall viewport the spacing constants were measured
  // against (`plugins/floor-library/client.ts`'s own `MEASURED_VIEWPORT_HEIGHT`).
  const viewportWidth = 1280;
  const viewportHeight = 800;
  const isometric = new IsometricController();
  isometric.halfHeight = 20;
  isometric.target.set(26.5, 1.9, 12);
  const camera = new THREE.OrthographicCamera();
  isometric.applyTo(camera, viewportWidth / viewportHeight, 60);
  camera.updateMatrixWorld();

  const projectY = (position: THREE.Vector3): number => {
    const ndc = position.clone().project(camera);
    return ((1 - ndc.y) / 2) * viewportHeight;
  };
  // The same rendered chip height this office's own spacing constants were derived from
  // (`LABEL_HEIGHT_PX` in `plugins/floor-library/client.ts`, measured with a real headless
  // browser screenshot — `qa-237-r3-*.png` in the ticket's screenshots folder).
  const LABEL_HEIGHT_PX = 13;
  const byRole = (role: string) => signs.filter((sign) => sign.userData.shelfRole === role);
  const plaqueY = projectY(byRole('plaque')[0]!.position);
  const entryYs = byRole('entry').map((sign) => projectY(sign.position));
  const moreY = projectY(byRole('more')[0]!.position);
  const order = [plaqueY, ...entryYs, moreY];
  for (let i = 0; i < order.length - 1; i++) {
    const gap = order[i + 1] - order[i];
    assert.ok(gap >= LABEL_HEIGHT_PX, `row ${i} to ${i + 1}: only ${gap.toFixed(1)}px apart, less than the chip's own ${LABEL_HEIGHT_PX}px height`);
  }
});

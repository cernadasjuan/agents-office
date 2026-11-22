import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// getToonMaterial paints a canvas gradient map; needs a document (same setup as building.test.ts).
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;

const { buildHexOffice } = await import('../src/addons/building/HexRooms.js');

/** The normal of a `BufferGeometry` triangle's first face, from its raw (unindexed)
 * position attribute — independent of `computeVertexNormals()`, which both the bug and its
 * fix feed through, so this catches a reversed winding the same way a downward raycast or a
 * `FrontSide` material would. */
function firstFaceNormal(geometry: THREE.BufferGeometry): THREE.Vector3 {
  const position = geometry.getAttribute('position');
  const a = new THREE.Vector3().fromBufferAttribute(position, 0);
  const b = new THREE.Vector3().fromBufferAttribute(position, 1);
  const c = new THREE.Vector3().fromBufferAttribute(position, 2);
  return new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
}

test('all three hex floors face up, visible from above (review #242: reversed winding made them invisible)', () => {
  const office = buildHexOffice();
  const floors = office.group.getObjectByName('hex-floors') as THREE.Group;
  const hexFloors = floors.children.filter((child) => child.name === 'hex-floor') as THREE.Mesh[];
  // Issue #258: the Library joined the Hub and Office as a third hex floor.
  assert.equal(hexFloors.length, 3, 'expected one floor mesh each for the hub, the office and the library');
  for (const floor of hexFloors) {
    const normal = firstFaceNormal(floor.geometry as THREE.BufferGeometry);
    assert.ok(normal.y > 0, `hex floor normal should point up, got ${JSON.stringify(normal)}`);
  }
});

test('hex walls carry an overview cutaway height (review #242: missing overviewLower left them full height, occluding the Hub furniture)', () => {
  const office = buildHexOffice();
  const walls = office.group.getObjectByName('hex-walls') as THREE.Group;
  assert.ok(walls, 'expected a hex-walls zone group');
  const mark = walls.userData.staticBatch as { zone?: string; overviewLower?: number | null } | undefined;
  assert.ok(mark, 'hex-walls should be marked static');
  assert.ok(typeof mark!.overviewLower === 'number' && mark!.overviewLower! > 0, 'hex-walls zone should carry a positive overviewLower, like every rect room\'s walls');
});

test('issue #258 steps 5/6: passing wing counts grows every zone\'s own child count, never a new zone (a wing costs nothing extra to render)', () => {
  const noWings = buildHexOffice();
  const wings = buildHexOffice({ library: 1, portal: 3, agents: 2, tooling: 1, infra: 4 });
  assert.equal(wings.layout.rooms.length, 13, 'hub + office + library + 3 + 2 + 1 + 4');
  for (const zone of ['hex-walls', 'hex-floors', 'hex-walkway']) {
    const before = (noWings.group.getObjectByName(zone) as THREE.Group).children.length;
    const after = (wings.group.getObjectByName(zone) as THREE.Group).children.length;
    assert.ok(after > before, `${zone} should have grown (before ${before}, after ${after})`);
    assert.equal(noWings.group.getObjectByName(zone)!.parent, noWings.group, `${zone} stays its own single group either way, not a new one per room`);
    assert.equal(wings.group.getObjectByName(zone)!.parent, wings.group);
  }
  // The accent and marker groups are per-building, not per-room: still exactly one each, wings or not.
  assert.equal(wings.group.children.filter((child) => child.name === 'hex-hub-accents').length, 1);
});

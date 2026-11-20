import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import {
  OverviewController,
  PoseTween,
  easeInOutCubic,
  floorBounds,
  floorPointUnderCursor,
  frameForBounds,
  interpolatePose,
  overviewBounds,
  overviewDirection,
  setOverviewBounds,
  zoomTowardCursor,
} from '../src/scene/OverviewCamera.js';
import { OFFICE } from '../src/utils/Constants.js';

const ROOM = new THREE.Box3(new THREE.Vector3(-OFFICE.halfX, 0, -OFFICE.halfZ), new THREE.Vector3(OFFICE.halfX, 0, OFFICE.halfZ));

function cornersInView(box: THREE.Box3, frame: { target: THREE.Vector3; distance: number }, fov: number, aspect: number): boolean {
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 1000);
  camera.position.copy(frame.target).addScaledVector(overviewDirection(), frame.distance);
  camera.lookAt(frame.target);
  camera.updateMatrixWorld();
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const ndc = new THREE.Vector3(x, y, z).project(camera);
        if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z > 1) return false;
      }
    }
  }
  return true;
}

test('the overview frame shows the whole room on wide and tall screens', () => {
  for (const aspect of [16 / 9, 1, 9 / 16]) {
    const frame = frameForBounds(ROOM, 60, aspect);
    assert.ok(cornersInView(ROOM, frame, 60, aspect), `aspect ${aspect}`);
  }
});

test('a larger floor gives a frame that still holds all of it', () => {
  const grown = new THREE.Box3(new THREE.Vector3(-15, 0, -13), new THREE.Vector3(45, 0, 30));
  const room = frameForBounds(ROOM, 60, 16 / 9);
  const frame = frameForBounds(grown, 60, 16 / 9);
  assert.ok(frame.distance > room.distance);
  assert.ok(cornersInView(grown, frame, 60, 16 / 9));
});

test('the overview bounds come from floor objects, also outside the room', () => {
  setOverviewBounds(null);
  const scene = new THREE.Scene();
  assert.equal(floorBounds(scene), null);
  assert.deepEqual(overviewBounds(scene).min.toArray().slice(0, 1), [-OFFICE.halfX]);

  const annex = new THREE.Mesh(new THREE.PlaneGeometry(10, 10));
  annex.rotation.x = -Math.PI / 2;
  annex.position.set(25, 0, 0);
  annex.userData.floor = true;
  scene.add(annex);
  const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  plain.position.set(-80, 0, 0);
  scene.add(plain);

  const box = overviewBounds(scene);
  assert.equal(Math.round(box.max.x), 30);
  assert.equal(Math.round(box.min.x), 20);
});

test('setOverviewBounds wins over floor objects until it is cleared', () => {
  const scene = new THREE.Scene();
  const custom = new THREE.Box3(new THREE.Vector3(-50, 0, -5), new THREE.Vector3(50, 0, 5));
  setOverviewBounds(custom);
  assert.equal(overviewBounds(scene).min.x, -50);
  setOverviewBounds(null);
  assert.equal(overviewBounds(scene).min.x, -OFFICE.halfX);
});

test('the wheel zooms between limits and a drag pans on the floor', () => {
  const view = new OverviewController();
  view.frame(ROOM, 60, 16 / 9);
  const fit = view.distance;

  view.zoom(-100000);
  assert.equal(view.distance, view.minDistance);
  view.zoom(100000);
  assert.ok(view.distance <= fit * 1.5 + 1e-9);

  view.frame(ROOM, 60, 16 / 9);
  const before = view.target.clone();
  view.drag(100, 0, 800, 60);
  assert.notDeepEqual(view.target.toArray(), before.toArray());
  assert.equal(view.target.y, before.y);

  view.drag(1e7, 1e7, 800, 60);
  assert.ok(view.target.x >= ROOM.min.x - 1e-9 && view.target.x <= ROOM.max.x + 1e-9);
  assert.ok(view.target.z >= ROOM.min.z - 1e-9 && view.target.z <= ROOM.max.z + 1e-9);
});

test('issue #87 AC1: the wheel zooms toward the cursor — the same floor point stays under it after 5 zoom steps', () => {
  const fov = 60;
  const aspect = 16 / 9;
  const view = new OverviewController();
  view.frame(ROOM, fov, aspect);

  const ndcX = 0.4;
  const ndcY = 0.3;
  const underCursor = floorPointUnderCursor(view.target, view.distance, fov, aspect, ndcX, ndcY);
  const distanceBefore = view.distance;

  // -100 per step: one mouse wheel notch in most browsers.
  for (let step = 0; step < 5; step++) zoomTowardCursor(view, ndcX, ndcY, -100, fov, aspect);
  assert.ok(view.distance < distanceBefore, 'zoomed in');

  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 1000);
  camera.position.copy(view.target).addScaledVector(overviewDirection(), view.distance);
  camera.lookAt(view.target);
  camera.updateMatrixWorld();
  const projected = underCursor.clone().project(camera);

  const viewportHeight = 900;
  const pxDx = ((projected.x - ndcX) / 2) * (viewportHeight * aspect);
  const pxDy = ((projected.y - ndcY) / 2) * viewportHeight;
  assert.ok(Math.hypot(pxDx, pxDy) < 50, `lounge stayed under the cursor within 50 px (off by ${Math.hypot(pxDx, pxDy)})`);
});

test('issue #87: the zoom still respects the pan/zoom limits (min/max distance, floor bounds)', () => {
  const fov = 60;
  const aspect = 16 / 9;
  const view = new OverviewController();
  view.frame(ROOM, fov, aspect);
  const fit = view.distance;

  for (let step = 0; step < 50; step++) zoomTowardCursor(view, 0.9, 0.9, -100000, fov, aspect);
  assert.equal(view.distance, view.minDistance);
  assert.ok(view.target.x >= ROOM.min.x - 1e-9 && view.target.x <= ROOM.max.x + 1e-9);
  assert.ok(view.target.z >= ROOM.min.z - 1e-9 && view.target.z <= ROOM.max.z + 1e-9);

  view.frame(ROOM, fov, aspect);
  for (let step = 0; step < 50; step++) zoomTowardCursor(view, -0.9, -0.9, 100000, fov, aspect);
  assert.ok(view.distance <= fit * 1.5 + 1e-9);
  assert.ok(view.target.x >= ROOM.min.x - 1e-9 && view.target.x <= ROOM.max.x + 1e-9);
  assert.ok(view.target.z >= ROOM.min.z - 1e-9 && view.target.z <= ROOM.max.z + 1e-9);
});

test('focusing on a point moves the target there and comes closer', () => {
  const view = new OverviewController();
  view.frame(ROOM, 60, 16 / 9);
  view.focusOn(new THREE.Vector3(5, 0, -4));
  assert.deepEqual(view.target.toArray(), [5, 0, -4]);
  assert.ok(view.distance < 20);
  const pose = view.pose();
  assert.ok(pose.position.y > 0);
  assert.deepEqual(pose.lookAt.toArray(), [5, 0, -4]);
});

test('the camera tween eases from start to end over its duration', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.ok(easeInOutCubic(0.1) < 0.1);

  const from = { position: new THREE.Vector3(0, 0, 0), lookAt: new THREE.Vector3(0, 0, -1) };
  const to = { position: new THREE.Vector3(10, 4, 0), lookAt: new THREE.Vector3(10, 0, -1) };
  assert.deepEqual(interpolatePose(from, to, 0.5).position.toArray(), [5, 2, 0]);

  const tween = new PoseTween(from, to, 0.6);
  const early = tween.advance(0.1);
  assert.ok(early.position.x > 0 && early.position.x < 5);
  assert.equal(tween.done, false);
  const end = tween.advance(1);
  assert.equal(tween.done, true);
  assert.deepEqual(end.position.toArray(), [10, 4, 0]);
});

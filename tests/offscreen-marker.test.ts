import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { offscreenMarker, projectToClip, type Projection } from '../src/scene/OffscreenMarker.js';

const WIDTH = 1600;
const HEIGHT = 900;

function perspectiveCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 1000);
  cam.position.set(0, 2, 10);
  cam.lookAt(0, 2, 0);
  cam.updateMatrixWorld();
  return cam;
}

function orthographicCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-20, 20, 11.25, -11.25, 0.1, 1000);
  cam.position.set(0, 2, 10);
  cam.lookAt(0, 2, 0);
  cam.updateMatrixWorld();
  return cam;
}

function projection(ndcX: number, ndcY: number, behind = false, pastFar = false): Projection {
  return { ndc: new THREE.Vector3(ndcX, ndcY, 0), behind, pastFar };
}

test('a point dead ahead, inside the frame, draws no marker', () => {
  const clip = projectToClip(new THREE.Vector3(0, 2, 0), perspectiveCamera());
  assert.equal(offscreenMarker(clip, WIDTH, HEIGHT), null);
});

test('on a wide canvas, the edge clamp is aspect-correct: the right edge, not the top', () => {
  // A regression case from code review: clip (2, 1.2) on a 1600x900 canvas must land
  // near the right edge (~1572, 189), not near the top (the un-corrected math gave ~1503, 28).
  const marker = offscreenMarker(projection(2, 1.2), WIDTH, HEIGHT);
  assert.ok(marker);
  assert.ok(Math.abs(marker!.x - 1572) < 1, `expected x near 1572, got ${marker!.x}`);
  assert.ok(Math.abs(marker!.y - 189) < 1, `expected y near 189, got ${marker!.y}`);
});

test('a point far to the right of the frame gets a marker on the right edge', () => {
  const clip = projectToClip(new THREE.Vector3(80, 2, 0), perspectiveCamera());
  const marker = offscreenMarker(clip, WIDTH, HEIGHT);
  assert.ok(marker);
  assert.ok(marker!.x > WIDTH / 2, `expected the marker right of center, got x=${marker!.x}`);
  assert.ok(marker!.x <= WIDTH - 1, `expected the marker inside the margin, got x=${marker!.x}`);
  // atan2(dy, dx) with dx > 0 and dy ~ 0 is near 0 (pointing right)
  assert.ok(Math.abs(marker!.angle) < 0.2, `expected an angle near 0, got ${marker!.angle}`);
});

test('a point above the frame gets a marker on the top edge, pointing up', () => {
  const clip = projectToClip(new THREE.Vector3(0, 80, 0), perspectiveCamera());
  const marker = offscreenMarker(clip, WIDTH, HEIGHT);
  assert.ok(marker);
  assert.ok(marker!.y < HEIGHT / 2, `expected the marker above center, got y=${marker!.y}`);
  // Pointing up in screen pixels (y grows down) is an angle near -90deg.
  assert.ok(marker!.angle < -1, `expected a steep upward angle, got ${marker!.angle}`);
});

test('a point truly behind the camera gets the correct-side marker (no left/right mirror)', () => {
  // The camera looks toward -z from z=10; a point at z=20 is behind it, to the camera's right (+x).
  const clip = projectToClip(new THREE.Vector3(5, 2, 20), perspectiveCamera());
  assert.equal(clip.behind, true);
  const marker = offscreenMarker(clip, WIDTH, HEIGHT);
  assert.ok(marker);
  assert.ok(marker!.x > WIDTH / 2, `expected the marker on the right (same side as the target), got x=${marker!.x}`);
});

test('a point ahead of the camera, past the far plane, is not "behind" and does not flip', () => {
  // The camera stands at z=10 looking toward -z, with camera.far = 1000. z = -1500
  // is 1510 units away: past the far plane, but still ahead of the camera, not behind it.
  const clip = projectToClip(new THREE.Vector3(80, 2, -1500), perspectiveCamera());
  assert.equal(clip.behind, false, 'a point past the far plane, but ahead, is not behind the camera');
  assert.equal(clip.pastFar, true);
});

test('a point past the far plane, dead centered, still gets a marker (the renderer clips it; the arrow must not)', () => {
  // Review's exact case: far: 100, a point 1500 units straight ahead.
  const camera = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(0, 2, 10);
  camera.lookAt(0, 2, 0);
  camera.updateMatrixWorld();
  const clip = projectToClip(new THREE.Vector3(0, 2, -1500), camera);
  assert.equal(clip.behind, false);
  assert.equal(clip.pastFar, true);
  const marker = offscreenMarker(clip, WIDTH, HEIGHT);
  assert.ok(marker, 'expected a marker: the figure is clipped from the render, so it still needs an arrow');
});

test('a point within the far plane, dead centered, still draws no marker (the ordinary on-screen case)', () => {
  const clip = projectToClip(new THREE.Vector3(0, 2, 0), perspectiveCamera());
  assert.equal(clip.pastFar, false);
  assert.equal(offscreenMarker(clip, WIDTH, HEIGHT), null);
});

test('the orthographic camera (the isometric view) never flips, at any depth', () => {
  const camera = orthographicCamera();
  const near = projectToClip(new THREE.Vector3(80, 2, 5), camera);
  const far = projectToClip(new THREE.Vector3(80, 2, -5000), camera);
  assert.equal(near.behind, false);
  assert.equal(far.behind, false);
});

test('the marker never sits closer than the margin to the true edge', () => {
  const clip = projectToClip(new THREE.Vector3(500, 2, 0), perspectiveCamera());
  const marker = offscreenMarker(clip, WIDTH, HEIGHT, 28);
  assert.ok(marker);
  assert.ok(marker!.x <= WIDTH - 28 + 0.01, `expected x within the margin, got ${marker!.x}`);
  assert.ok(marker!.y >= 0 - 0.01 && marker!.y <= HEIGHT + 0.01, `expected y clamped inside the canvas, got ${marker!.y}`);
});

test("a target on the camera's own axis, behind it, picks a default edge instead of NaN", () => {
  const marker = offscreenMarker(projection(0, 0, true), WIDTH, HEIGHT);
  assert.ok(marker);
  assert.ok(Number.isFinite(marker!.x), `expected a finite x, got ${marker!.x}`);
  assert.ok(Number.isFinite(marker!.y), `expected a finite y, got ${marker!.y}`);
});

test('an avoided rect (the side panel) stops the marker short of it', () => {
  const panel = { left: 1280, top: 16, right: 1584, bottom: 500 };
  // Up and to the right: without the avoided rect this lands inside the panel.
  const unavoided = offscreenMarker(projection(2, 1.2), WIDTH, HEIGHT);
  assert.ok(unavoided);
  const insidePanel = unavoided!.x >= panel.left && unavoided!.x <= panel.right && unavoided!.y >= panel.top && unavoided!.y <= panel.bottom;
  assert.ok(insidePanel, 'the unavoided point should land inside the panel rect, to make this a real regression case');

  const marker = offscreenMarker(projection(2, 1.2), WIDTH, HEIGHT, 28, panel);
  assert.ok(marker);
  const outside = marker!.x < panel.left - 28 + 0.5 || marker!.x > panel.right + 28 - 0.5 || marker!.y < panel.top - 28 + 0.5 || marker!.y > panel.bottom + 28 - 0.5;
  assert.ok(outside, `expected the marker outside the avoided rect, got (${marker!.x}, ${marker!.y})`);
});

test('without the avoided rect in the way, the marker lands on the usual edge', () => {
  const panel = { left: 1280, top: 16, right: 1584, bottom: 500 };
  // Down and to the left: nowhere near the top-right panel.
  const marker = offscreenMarker(projection(-2, -1.2), WIDTH, HEIGHT, 28, panel);
  assert.ok(marker);
  assert.ok(marker!.x < WIDTH / 2 && marker!.y > HEIGHT / 2);
});

test('on a narrow window, a panel spanning the canvas center still never traps the marker inside it', () => {
  // Review's exact case: a 640-wide canvas, a panel covering the center (the canvas's own
  // center, 320, sits inside this rect — the bug the old ray-from-center math assumed away).
  const width = 640;
  const height = 900;
  const panel = { left: 160, top: 0, right: 480, bottom: 900 };
  assert.ok(width / 2 >= panel.left && width / 2 <= panel.right, 'the canvas center must sit inside the panel, to make this a real regression case');

  const marker = offscreenMarker(projection(2, 0), width, height, 28, panel);
  assert.ok(marker);
  const insidePanel = marker!.x >= panel.left && marker!.x <= panel.right;
  assert.equal(insidePanel, false, `expected the marker outside the panel's left/right span, got x=${marker!.x}`);
});

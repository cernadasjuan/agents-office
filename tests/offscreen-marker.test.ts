import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { offscreenMarker, projectToClip } from '../src/scene/OffscreenMarker.js';

const WIDTH = 1600;
const HEIGHT = 900;

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 1000);
  cam.position.set(0, 2, 10);
  cam.lookAt(0, 2, 0);
  cam.updateMatrixWorld();
  return cam;
}

test('a point dead ahead, inside the frame, draws no marker', () => {
  const clip = projectToClip(new THREE.Vector3(0, 2, 0), camera());
  assert.equal(offscreenMarker(clip, WIDTH, HEIGHT), null);
});

test('a point far to the right of the frame gets a marker on the right edge', () => {
  const clip = projectToClip(new THREE.Vector3(80, 2, 0), camera());
  const marker = offscreenMarker(clip, WIDTH, HEIGHT);
  assert.ok(marker);
  assert.ok(marker!.x > WIDTH / 2, `expected the marker right of center, got x=${marker!.x}`);
  assert.ok(marker!.x <= WIDTH - 1, `expected the marker inside the margin, got x=${marker!.x}`);
  // atan2(dy, dx) with dx > 0 and dy ~ 0 is near 0 (pointing right)
  assert.ok(Math.abs(marker!.angle) < 0.2, `expected an angle near 0, got ${marker!.angle}`);
});

test('a point above the frame gets a marker on the top edge, pointing up', () => {
  const clip = projectToClip(new THREE.Vector3(0, 80, 0), camera());
  const marker = offscreenMarker(clip, WIDTH, HEIGHT);
  assert.ok(marker);
  assert.ok(marker!.y < HEIGHT / 2, `expected the marker above center, got y=${marker!.y}`);
  // Pointing up in screen pixels (y grows down) is an angle near -90deg.
  assert.ok(marker!.angle < -1, `expected a steep upward angle, got ${marker!.angle}`);
});

test('a point behind the camera still gets the correct-side marker (no left/right flip)', () => {
  // The camera looks toward -z from z=10; a point at z=20 is behind it, to the camera's right (+x).
  const clip = projectToClip(new THREE.Vector3(5, 2, 20), camera());
  const marker = offscreenMarker(clip, WIDTH, HEIGHT);
  assert.ok(marker);
  assert.ok(marker!.x > WIDTH / 2, `expected the marker on the right (same side as the target), got x=${marker!.x}`);
});

test('the marker never sits closer than the margin to the true edge', () => {
  const clip = projectToClip(new THREE.Vector3(500, 2, 0), camera());
  const marker = offscreenMarker(clip, WIDTH, HEIGHT, 28);
  assert.ok(marker);
  assert.ok(marker!.x <= WIDTH - 28 + 0.01, `expected x within the margin, got ${marker!.x}`);
  assert.ok(marker!.y >= 0 - 0.01 && marker!.y <= HEIGHT + 0.01, `expected y clamped inside the canvas, got ${marker!.y}`);
});

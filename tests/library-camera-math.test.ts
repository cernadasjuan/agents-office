import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { clampPitch, forwardFromYawPitch, groundAxes, moveWithCollision, yawPitchFromLookAt } from '../src/library/cameraMath.js';

function close(a: number, b: number, eps = 1e-9): void {
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
}

test('clampPitch never lets the look direction reach straight up or down', () => {
  assert.equal(clampPitch(10), Math.PI / 2 - 0.05);
  assert.equal(clampPitch(-10), -(Math.PI / 2 - 0.05));
  assert.equal(clampPitch(0), 0);
});

test('yawPitchFromLookAt then forwardFromYawPitch points back at the same target (round-trip)', () => {
  const position = { x: 0, y: 1.7, z: 0 };
  const lookAt = { x: 4, y: 1.7, z: 3 };
  const { yaw, pitch } = yawPitchFromLookAt(position, lookAt);
  const forward = forwardFromYawPitch(yaw, pitch);
  const rebuilt = { x: position.x + forward.x * 5, y: position.y + forward.y * 5, z: position.z + forward.z * 5 };
  const targetDir = { x: lookAt.x - position.x, y: lookAt.y - position.y, z: lookAt.z - position.z };
  const length = Math.hypot(targetDir.x, targetDir.y, targetDir.z);
  const normalized = { x: targetDir.x / length, y: targetDir.y / length, z: targetDir.z / length };
  close(forward.x, normalized.x, 1e-6);
  close(forward.y, normalized.y, 1e-6);
  close(forward.z, normalized.z, 1e-6);
  assert.ok(rebuilt.x !== undefined); // keeps the rebuilt point from being an unused computation
});

test('yaw 0 pitch 0 looks down +Z (Three.js convention), yaw PI/2 looks down +X', () => {
  const origin = { x: 0, y: 0, z: 0 };
  close(yawPitchFromLookAt(origin, { x: 0, y: 0, z: 1 }).yaw, 0);
  close(yawPitchFromLookAt(origin, { x: 1, y: 0, z: 0 }).yaw, Math.PI / 2);
});

test('groundAxes ignores pitch: forward and right always lie flat on the XZ plane', () => {
  const { forward, right } = groundAxes(Math.PI / 4);
  assert.equal(forward.y, 0);
  assert.equal(right.y, 0);
  // forward and right are perpendicular (dot product zero) at any yaw
  close(forward.x * right.x + forward.z * right.z, 0, 1e-9);
});

test('issue #245 review: groundAxes\' own "right" actually projects to screen-right once camera.lookAt builds the camera from the same forward vector (D must strafe right, not left)', () => {
  const position = new THREE.Vector3(0, 1.7, 0);
  for (const yaw of [0, 0.4, Math.PI / 2, 2, -1.3]) {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.copy(position);
    const forward = forwardFromYawPitch(yaw, 0);
    camera.lookAt(position.x + forward.x, position.y + forward.y, position.z + forward.z);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const { right } = groundAxes(yaw);
    // A point ahead of and to this "right" side, well inside the frustum (not on the near
    // plane boundary, where the perspective divide is singular).
    const worldPoint = new THREE.Vector3(
      position.x + forward.x * 5 + right.x,
      position.y,
      position.z + forward.z * 5 + right.z,
    );
    const projected = worldPoint.clone().project(camera);
    assert.ok(projected.x > 0, `yaw ${yaw}: "right" projected to screen X ${projected.x}, expected positive (screen-right)`);
  }
});

// --- Issue #245 review: wall collision (ported from FreeCamera.ts's own algorithm) ---

test('moveWithCollision moves freely with no walls in the way', () => {
  const { x, z } = moveWithCollision(0, 0, 2, 3, []);
  close(x, 2);
  close(z, 3);
});

test('moveWithCollision stops at a wall instead of tunneling through it in one big step', () => {
  const wall = { minX: 5, maxX: 6, minZ: -10, maxZ: 10 };
  const { x } = moveWithCollision(0, 0, 20, 0, [wall]); // a huge delta, like a slow frame
  assert.ok(x < 5, `stopped before the wall, got x=${x}`);
  assert.ok(x > 4, `stopped right at the wall's own margin, not far short of it, got x=${x}`);
});

test('moveWithCollision slides along a wall hit at an angle: one axis blocked never blocks the other', () => {
  const wall = { minX: 5, maxX: 6, minZ: -10, maxZ: 10 }; // blocks +X, never blocks Z
  const { x, z } = moveWithCollision(0, 0, 20, 4, [wall]);
  assert.ok(x < 5, 'the X move is still blocked');
  close(z, 4, 1e-6); // the Z move (sideways along the wall) goes through unblocked
});

test('moveWithCollision never moves an axis when its own delta is already zero (no spurious collision check)', () => {
  const wall = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 }; // would block any real move
  const { x, z } = moveWithCollision(0, 0, 0, 0, [wall]);
  close(x, 0);
  close(z, 0);
});

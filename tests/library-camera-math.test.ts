import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampPitch, forwardFromYawPitch, groundAxes, yawPitchFromLookAt } from '../src/library/cameraMath.js';

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

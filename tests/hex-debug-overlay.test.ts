import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { buildHexDebugMesh } from '../src/addons/building/HexDebugOverlay.js';
import { overviewBounds } from '../src/scene/OverviewCamera.js';
import { claimHexRegion } from '../src/addons/building/HexPlanner.js';

test('the debug overlay mesh is marked userData.floor so the isometric camera can reach it', () => {
  const mesh = buildHexDebugMesh(claimHexRegion([{ role: 'library' }, { role: 'portal' }]));
  assert.equal(mesh.userData.floor, true);
});

test('overviewBounds expands to include the mounted debug overlay, not just the default room', () => {
  const scene = new THREE.Scene();
  const defaultBounds = overviewBounds(scene);
  const mesh = buildHexDebugMesh(claimHexRegion([{ role: 'library' }, { role: 'portal' }]));
  scene.add(mesh);
  const bounds = overviewBounds(scene);
  assert.ok(
    bounds.max.x > defaultBounds.max.x,
    `expected bounds to extend past the default room (x=${defaultBounds.max.x}) to cover the overlay at x~200, got x=${bounds.max.x}`,
  );
});

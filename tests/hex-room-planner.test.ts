import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildHexOfficeLayout,
  hexSurfaceHeightAt,
  hexWallColliders,
  pointInPolygon,
  WALKWAY_HEIGHT,
} from '../src/addons/building/HexRoomPlanner.js';

test('buildHexOfficeLayout is deterministic', () => {
  const a = buildHexOfficeLayout();
  const b = buildHexOfficeLayout();
  assert.deepEqual(a, b);
});

test('the hub and the office do not overlap', () => {
  const layout = buildHexOfficeLayout();
  for (const corner of layout.office.corners) {
    assert.ok(!pointInPolygon(corner, layout.hub.corners), `office corner ${JSON.stringify(corner)} sits inside the hub`);
  }
  for (const corner of layout.hub.corners) {
    assert.ok(!pointInPolygon(corner, layout.office.corners), `hub corner ${JSON.stringify(corner)} sits inside the office`);
  }
});

test('surfaceHeightAt: the hub and office floors are flat at 0', () => {
  const layout = buildHexOfficeLayout();
  assert.equal(hexSurfaceHeightAt(layout, layout.hub.center.x, layout.hub.center.z), 0);
  assert.equal(hexSurfaceHeightAt(layout, layout.office.center.x, layout.office.center.z), 0);
});

test('surfaceHeightAt: climbing the office ramp rises monotonically from 0 to WALKWAY_HEIGHT', () => {
  const layout = buildHexOfficeLayout();
  const { from, to } = layout.officeRamp;
  let previous = -Infinity;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    const height = hexSurfaceHeightAt(layout, x, z);
    assert.notEqual(height, null, `expected a surface at t=${t}`);
    assert.ok(height! >= previous - 1e-9, `height went backwards at t=${t}`);
    previous = height!;
  }
  assert.ok(Math.abs(previous - WALKWAY_HEIGHT) < 1e-6, 'the ramp top reaches walkway height');
});

test('surfaceHeightAt: the deck between the two ramp tops is flat at WALKWAY_HEIGHT', () => {
  const layout = buildHexOfficeLayout();
  const mid = {
    x: (layout.hubRamp.to.x + layout.officeRamp.to.x) / 2,
    z: (layout.hubRamp.to.z + layout.officeRamp.to.z) / 2,
  };
  const height = hexSurfaceHeightAt(layout, mid.x, mid.z);
  assert.ok(height !== null && Math.abs(height - WALKWAY_HEIGHT) < 1e-6);
});

test('surfaceHeightAt: a point far from every surface is null', () => {
  const layout = buildHexOfficeLayout();
  assert.equal(hexSurfaceHeightAt(layout, layout.hub.center.x + 1000, layout.hub.center.z + 1000), null);
});

test('a full walk from the hub floor, up its ramp, across the deck, down the office ramp, onto the office floor never has a null gap', () => {
  const layout = buildHexOfficeLayout();
  const waypoints: Array<[number, number]> = [
    [layout.hub.center.x, layout.hub.center.z],
    [layout.hubRamp.from.x, layout.hubRamp.from.z],
    [layout.hubRamp.to.x, layout.hubRamp.to.z],
    [layout.officeRamp.to.x, layout.officeRamp.to.z],
    [layout.officeRamp.from.x, layout.officeRamp.from.z],
    [layout.office.center.x, layout.office.center.z],
  ];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [ax, az] = waypoints[i];
    const [bx, bz] = waypoints[i + 1];
    for (let t = 0; t <= 1; t += 0.05) {
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const height = hexSurfaceHeightAt(layout, x, z);
      assert.notEqual(height, null, `gap in the walk at segment ${i}, t=${t} (${x}, ${z})`);
    }
  }
});

test('wallColliders: the hub and office each contribute 5 wall segments (one edge stays open for the stair)', () => {
  const layout = buildHexOfficeLayout();
  const colliders = hexWallColliders(layout);
  assert.equal(colliders.length, 10);
});

test('wallColliders: no wall blocks either ramp\'s own doorway point', () => {
  const layout = buildHexOfficeLayout();
  const colliders = hexWallColliders(layout);
  for (const point of [layout.hubRamp.from, layout.officeRamp.from]) {
    for (const wall of colliders) {
      const inside = point.x > wall.minX && point.x < wall.maxX && point.z > wall.minZ && point.z < wall.maxZ;
      assert.ok(!inside, `a wall blocks the doorway at ${JSON.stringify(point)}`);
    }
  }
});

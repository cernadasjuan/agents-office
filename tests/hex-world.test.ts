import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildHexWorld,
  hexSurfaceHeightAt,
  hexWallColliders,
  pointInPolygon,
  WALKWAY_HEIGHT,
} from '../src/addons/building/HexRoomPlanner.js';

/** Issue #258 steps 5/6: `buildHexWorld` generalizes `buildHexOfficeLayout` to any number of
 * component wing rooms. These tests exercise that general path directly (wings on, not just
 * the hub/office/library default every step-4 test already covers). */

test('buildHexWorld with wing counts is deterministic', () => {
  const counts = { library: 1, portal: 2, agents: 1, tooling: 0, infra: 3 };
  const a = buildHexWorld(counts);
  const b = buildHexWorld(counts);
  assert.deepEqual(a.rooms, b.rooms);
  assert.deepEqual(a.connections.map((c) => [c.parent.slot.cell, c.child.slot.cell]), b.connections.map((c) => [c.parent.slot.cell, c.child.slot.cell]));
});

test('every requested wing room is actually claimed, by role', () => {
  const layout = buildHexWorld({ library: 1, portal: 2, agents: 1, tooling: 0, infra: 3 });
  const countOf = (role: string) => layout.rooms.filter((room) => room.role === role).length;
  assert.equal(countOf('hub'), 1);
  assert.equal(countOf('office'), 1);
  assert.equal(countOf('library'), 1);
  assert.equal(countOf('portal'), 2);
  assert.equal(countOf('agents'), 1);
  assert.equal(countOf('tooling'), 0);
  assert.equal(countOf('infra'), 3);
});

test('no two rooms overlap, wings included', () => {
  const layout = buildHexWorld({ library: 1, portal: 2, agents: 2, tooling: 2, infra: 2 });
  for (let i = 0; i < layout.rooms.length; i++) {
    for (let j = i + 1; j < layout.rooms.length; j++) {
      for (const corner of layout.rooms[i].corners) {
        assert.ok(!pointInPolygon(corner, layout.rooms[j].corners), `room ${i} (${layout.rooms[i].role}) overlaps room ${j} (${layout.rooms[j].role})`);
      }
    }
  }
});

test('every non-hub room has exactly one connection to a parent, except the office (two: hub and library)', () => {
  const layout = buildHexWorld({ library: 1, portal: 2, agents: 1, tooling: 0, infra: 1 });
  for (const room of layout.rooms) {
    if (room.role === 'hub') continue;
    const asChild = layout.connections.filter((c) => c.child === room);
    assert.equal(asChild.length, 1, `${room.role} at ${JSON.stringify(room.slot.cell)} should have exactly one parent connection`);
  }
  assert.equal(layout.office.openEdges.length, 2, 'the office opens onto both the hub and the library');
});

test('growing a wing by one only ever appends a room: the earlier ones keep the same cell', () => {
  const before = buildHexWorld({ library: 1, portal: 1, agents: 0, tooling: 0, infra: 0 });
  const after = buildHexWorld({ library: 1, portal: 2, agents: 0, tooling: 0, infra: 0 });
  const beforePortals = before.rooms.filter((room) => room.role === 'portal');
  const afterPortals = after.rooms.filter((room) => room.role === 'portal');
  assert.equal(beforePortals.length, 1);
  assert.equal(afterPortals.length, 2);
  assert.deepEqual(afterPortals[0].slot.cell, beforePortals[0].slot.cell, 'the first portal room never moves when a second one is added');
});

test('a point on every wing room\'s own floor reports height 0, and its own walkway chain has no gap back to the hub', () => {
  const layout = buildHexWorld({ library: 1, portal: 1, agents: 0, tooling: 0, infra: 0 });
  const portal = layout.rooms.find((room) => room.role === 'portal')!;
  assert.equal(hexSurfaceHeightAt(layout, portal.center.x, portal.center.z), 0);

  // Walk the chain of connections from the portal room back to the hub; every ramp/deck along
  // the way must report a real height, never null.
  let current = portal;
  const seen = new Set<string>();
  while (current.role !== 'hub') {
    const connection = layout.connections.find((c) => c.child === current)!;
    assert.ok(connection, `no connection found back toward the hub from ${current.role}`);
    assert.ok(!seen.has(connection.child.role + JSON.stringify(connection.child.slot.cell)), 'no cycle');
    seen.add(connection.child.role + JSON.stringify(connection.child.slot.cell));
    for (let t = 0; t <= 1; t += 0.1) {
      const x = connection.childRamp.from.x + (connection.childRamp.to.x - connection.childRamp.from.x) * t;
      const z = connection.childRamp.from.z + (connection.childRamp.to.z - connection.childRamp.from.z) * t;
      const height = hexSurfaceHeightAt(layout, x, z);
      assert.notEqual(height, null, `gap on the child ramp at t=${t}`);
    }
    const deckMid = { x: (connection.parentRamp.to.x + connection.childRamp.to.x) / 2, z: (connection.parentRamp.to.z + connection.childRamp.to.z) / 2 };
    const deckHeight = hexSurfaceHeightAt(layout, deckMid.x, deckMid.z);
    assert.ok(deckHeight !== null && Math.abs(deckHeight - WALKWAY_HEIGHT) < 1e-6, 'the deck between the two ramp tops is flat at walkway height');
    current = connection.parent;
  }
});

test('wallColliders grows by exactly 4 segments per extra wing room: the new room brings 5, but its own parent loses 1 (a second open edge for the new stair)', () => {
  const noWings = buildHexWorld({ library: 1, portal: 0, agents: 0, tooling: 0, infra: 0 });
  const oneWing = buildHexWorld({ library: 1, portal: 1, agents: 0, tooling: 0, infra: 0 });
  const twoWings = buildHexWorld({ library: 1, portal: 2, agents: 0, tooling: 0, infra: 0 });
  assert.equal(hexWallColliders(oneWing).length - hexWallColliders(noWings).length, 4);
  assert.equal(hexWallColliders(twoWings).length - hexWallColliders(oneWing).length, 4);
});

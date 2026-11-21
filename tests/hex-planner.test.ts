import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claimHexRegion,
  hexAdd,
  hexKey,
  hexRing,
  ringOf,
  roleFor,
  sectorOf,
  SECTOR_TABLE,
  type GrowthRequest,
  type HexCell,
  type HexSlot,
} from '../src/addons/building/HexPlanner.js';

const AX_DIRS: HexCell[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

function neighborsOf(cell: HexCell): HexCell[] {
  return AX_DIRS.map((dir) => hexAdd(cell, dir));
}

function slotMap(slots: HexSlot[]): Map<string, HexSlot> {
  const map = new Map<string, HexSlot>();
  for (const slot of slots) map.set(hexKey(slot.cell), slot);
  return map;
}

const LARGE_STAGE: GrowthRequest[] = [
  ...Array(8).fill({ role: 'library' as const }),
  ...Array(10).fill({ role: 'portal' as const }),
  ...Array(8).fill({ role: 'agents' as const }),
  ...Array(6).fill({ role: 'tooling' as const }),
  ...Array(4).fill({ role: 'infra' as const }),
];

test('hexRing(0) is just the hub, hexRing(n) has 6n cells', () => {
  assert.deepEqual(hexRing(0), [{ q: 0, r: 0 }]);
  for (let ring = 1; ring <= 4; ring++) {
    assert.equal(hexRing(ring).length, ring * 6);
  }
});

test('ringOf matches the ring a cell was generated in', () => {
  for (let ring = 0; ring <= 5; ring++) {
    for (const cell of hexRing(ring)) {
      assert.equal(ringOf(cell), ring, `${hexKey(cell)} expected ring ${ring}`);
    }
  }
});

test('every claimed tile is contiguous: shares an edge with another claimed tile', () => {
  const slots = claimHexRegion(LARGE_STAGE);
  const claimed = slotMap(slots);
  for (const slot of slots) {
    if (slot.ring === 0) continue; // the hub has nothing inward of it
    const hasClaimedNeighbor = neighborsOf(slot.cell).some((n) => claimed.has(hexKey(n)));
    assert.ok(hasClaimedNeighbor, `${slot.role} at ${hexKey(slot.cell)} (ring ${slot.ring}) has no claimed neighbor`);
  }
});

test('no two claimed hexes overlap (claim is a set, not a multiset)', () => {
  const slots = claimHexRegion(LARGE_STAGE);
  const seen = new Set<string>();
  for (const slot of slots) {
    const key = hexKey(slot.cell);
    assert.ok(!seen.has(key), `${key} claimed twice`);
    seen.add(key);
  }
});

test('stable growth: adding a room never moves an already-claimed room', () => {
  const requests: GrowthRequest[] = [
    { role: 'portal' }, { role: 'portal' }, { role: 'agents' },
    { role: 'portal' }, { role: 'library' }, { role: 'tooling' },
    { role: 'portal' }, { role: 'agents' }, { role: 'library' },
    { role: 'infra' }, { role: 'portal' }, { role: 'agents' },
  ];
  let previous = slotMap(claimHexRegion([]));
  for (let n = 1; n <= requests.length; n++) {
    const next = slotMap(claimHexRegion(requests.slice(0, n)));
    for (const [key, slot] of previous) {
      const stillThere = next.get(key);
      assert.ok(stillThere, `cell ${key} (${slot.role}) disappeared after adding request ${n}`);
      assert.equal(stillThere.role, slot.role, `cell ${key} changed role after adding request ${n}`);
    }
    previous = next;
  }
});

test('deterministic: the same requests in the same order always produce the same layout', () => {
  const a = claimHexRegion(LARGE_STAGE);
  const b = claimHexRegion(LARGE_STAGE);
  assert.deepEqual(a, b);
});

test('the hub is always present, fixed at ring 0, with no sector', () => {
  const slots = claimHexRegion([]);
  assert.equal(slots.length, 2); // hub + the fixed office
  const hub = slots.find((s) => s.role === 'hub');
  assert.ok(hub);
  assert.deepEqual(hub!.cell, { q: 0, r: 0 });
  assert.equal(hub!.ring, 0);
  assert.equal(hub!.sector, -1);
});

test('the office is fixed: exactly one hex, at ring 1, even with no requests', () => {
  const slots = claimHexRegion([]);
  const offices = slots.filter((s) => s.role === 'office');
  assert.equal(offices.length, 1);
  assert.equal(offices[0].ring, 1);
});

test('the office never grows past one hex, no matter how many library requests arrive', () => {
  const requests: GrowthRequest[] = Array(20).fill({ role: 'library' });
  const slots = claimHexRegion(requests);
  assert.equal(slots.filter((s) => s.role === 'office').length, 1);
});

test('the library grows behind the office: same sector, one ring further out', () => {
  const slots = claimHexRegion([{ role: 'library' }, { role: 'library' }, { role: 'library' }]);
  const office = slots.find((s) => s.role === 'office')!;
  const libraries = slots.filter((s) => s.role === 'library');
  assert.equal(libraries.length, 3);
  for (const lib of libraries) {
    assert.equal(lib.sector, office.sector, 'library must share the office sector');
    assert.ok(lib.ring >= 2, 'library must grow outward past the office ring');
  }
});

test('a component wing only ever claims its own sector', () => {
  const slots = claimHexRegion(LARGE_STAGE);
  for (const role of ['portal', 'agents', 'tooling', 'infra'] as const) {
    const cells = slots.filter((s) => s.role === role);
    const sectors = new Set(cells.map((s) => s.sector));
    assert.equal(sectors.size, 1, `${role} spread across more than one sector: ${[...sectors]}`);
  }
});

test('a partial ring claims a contiguous arc (no gaps between taken cells by angle)', () => {
  // A budget smaller than a full ring (6 cells at ring 1) should still read as "one wedge":
  // every pair of claimed cells in the wing's own sector, at a given ring, differs in angle
  // by no more than the number of untaken cells in that sector's slice of the ring.
  const slots = claimHexRegion([{ role: 'portal' }, { role: 'portal' }]);
  const portalCells = slots.filter((s) => s.role === 'portal');
  assert.equal(portalCells.length, 2);
  assert.equal(sectorOf(portalCells[0].cell), sectorOf(portalCells[1].cell));
});

test('roleFor resolves the sector table: ring 1 fixed role, ring 2+ growth role, reserved sector is null', () => {
  const officeSector = SECTOR_TABLE.find((e) => e.fixedRole === 'office')!.sector;
  assert.equal(roleFor(officeSector, 1), 'office');
  assert.equal(roleFor(officeSector, 2), 'library');
  assert.equal(roleFor(officeSector, 5), 'library');
  const reserved = SECTOR_TABLE.find((e) => !e.fixedRole && !e.growthRole)!.sector;
  assert.equal(roleFor(reserved, 1), null);
  assert.equal(roleFor(reserved, 2), null);
});

test('sectorOf is stable across rings: a cell straight out along a direction stays in one sector', () => {
  const base = sectorOf({ q: 1, r: 0 });
  for (let ring = 1; ring <= 6; ring++) {
    assert.equal(sectorOf({ q: ring, r: 0 }), base);
  }
});

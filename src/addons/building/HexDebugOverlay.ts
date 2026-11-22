/**
 * Dev-only debug overlay for the hex office planner (issue #218, step 1): draws the claimed
 * region as flat colored planes, one draw call total, so the shape from `claimHexRegion` can
 * be checked against the round 3 spike's SVG before any real room is built on top of it.
 *
 * Off by default (rule 5 of `docs/design-principles.md`, opt-in): mounted only behind
 * `?hexDebug=1`, the same URL-param pattern `RenderScheduler.ts`'s `?debug=1` and
 * `AgentPanel.ts`'s `?demo=1` already use. No production file wires this in yet — Hub and
 * Office become real hex rooms in step 2.
 */
import * as THREE from 'three';
import { claimHexRegion, hexCorners, hexPixel, type GrowthRequest, type HexSlot, type RoomRole } from './HexPlanner.js';

const ROLE_COLOR: Record<RoomRole, number> = {
  hub: 0xf5f0e8,
  office: 0xd4af37,
  library: 0xa98fd1,
  portal: 0x6f8aa8,
  agents: 0x79a884,
  tooling: 0xb89a66,
  infra: 0xa8708a,
};

/** The large-stage mix from the round 3 spike (`scripts/r3_mosaic.py`'s `STAGES`), the fixture
 * the overlay's own screenshot is checked against. */
export const DEBUG_STAGE: GrowthRequest[] = [
  ...Array(8).fill({ role: 'library' as const }),
  ...Array(10).fill({ role: 'portal' as const }),
  ...Array(8).fill({ role: 'agents' as const }),
  ...Array(6).fill({ role: 'tooling' as const }),
  ...Array(4).fill({ role: 'infra' as const }),
];

/** True only with `?hexDebug=1` in the page URL. */
export function isHexDebugMode(search: string = typeof location !== 'undefined' ? location.search : ''): boolean {
  return new URLSearchParams(search).get('hexDebug') === '1';
}

/** One merged flat-plane mesh, one triangle fan per claimed cell, vertex-colored by role. */
export function buildHexDebugMesh(slots: HexSlot[]): THREE.Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();

  for (const slot of slots) {
    const center = hexPixel(slot.cell);
    const corners = hexCorners(center);
    color.setHex(ROLE_COLOR[slot.role]);
    for (let i = 0; i < 6; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 6];
      positions.push(center.x, 0, center.z, a.x, 0, a.z, b.x, 0, b.z);
      for (let v = 0; v < 3; v++) colors.push(color.r, color.g, color.b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'hex-debug-overlay';
  // Clear of the rect-room building entirely (rule 3, degrade gracefully / no visual change):
  // far enough along x that it never overlaps the existing hall and rooms.
  mesh.position.set(200, 0.02, 0);
  // `userData.floor` is how `overviewBounds()` (OverviewCamera.ts) decides what the isometric
  // camera's pan/zoom can reach. Without it the overlay sits outside the default viewport even
  // at max zoom-out, defeating the one thing a debug overlay is for (looking at it).
  mesh.userData.floor = true;
  return mesh;
}

/** Builds and adds the overlay to `scene` when `?hexDebug=1` is set; a no-op otherwise. */
export function mountHexDebugOverlay(scene: THREE.Scene, slots: HexSlot[] = claimHexRegion(DEBUG_STAGE)): THREE.Mesh | null {
  if (!isHexDebugMode()) return null;
  const mesh = buildHexDebugMesh(slots);
  scene.add(mesh);
  return mesh;
}

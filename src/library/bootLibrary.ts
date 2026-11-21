import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createScene } from '../scene/SceneSetup.js';
import { countDrawCalls } from '../scene/RenderBudget.js';
import { StaticBatch } from '../scene/StaticMerge.js';
import { markStatic } from '../scene/StaticMerge.js';
import { isDebugMode } from '../scene/RenderScheduler.js';
import { setPointerLockFilter } from '../scene/FreeCamera.js';
import { SelectionState } from '../scene/Selection.js';
import { getToonMaterial } from '../utils/Materials.js';
import { buildCeiling, buildWalls, doorFrame, RoomFrame, WALL_HEIGHT, wallRects } from '../addons/building/rooms.js';
import { HALL, ROOM_SIZE } from '../addons/building/RoomPlanner.js';
import { ALL_FLOORS, matchesFloor } from '../floors/FloorRegistry.js';
import { sectionRoomLayouts, shelfPlacement, type SectionRoomLayout } from './libraryLayout.js';
import { clampPitch, forwardFromYawPitch, groundAxes, moveWithCollision, yawPitchFromLookAt, type Vec3, type WallRect } from './cameraMath.js';
import { libraryFloorFromSearch, officeReturnUrl, type SceneNavLocation } from './sceneNav.js';
import { consumeReturningFromLibrary, markReturningFromLibrary, navigateAfterTransition, removeTransition, showTransition } from './transition.js';
import { LibraryCard, libraryEntryId } from '../ui/LibraryCard.js';
import type { World, WorldLibrary, WorldLibraryEntry } from '../extensions.js';

/**
 * The library's own scene (issue #239, #220: Gabriel's "different dimension" idea). A
 * separate boot path `main.ts` runs instead of the office's, so only one of the two scenes
 * ever exists in memory, let alone renders, at a time — the office's own draw-call budget
 * (`src/scene/RenderBudget.ts`'s 430) is untouched by anything in here, by construction, not
 * by a shared cap this module has to mind.
 *
 * Layout: the office's own `HALL` rect is reused as the entrance/lobby (open floor, no walls
 * of its own — same shape the office's hall already is). The wall index, the room title and
 * the door back to the office are a fixed on-screen panel (issue #245 review: three CSS2D
 * objects stacked at the same world position overlapped at any real viewing distance — a
 * `position: fixed` panel, the same pattern the office's own `#ui-panel` already uses, never
 * has that problem, and gets a real scrollable height bound for free). One room per top-level
 * bibliotheque section rents the next slot outward (`slotFor`, the exact ring-growth math
 * `BuildingLayout`'s own rooms use), each with a 10x10 shelf grid (`libraryLayout.ts`'s own
 * `SHELF_CAP`, matching the server's own 100-entry cap). Every shelf is one instance of one
 * shared `InstancedMesh` — one draw call for the whole library's worth of shelves, however
 * many sections or entries it holds — and still individually clickable (issue #245 review:
 * raycast against `instanceId`, opening the same `LibraryCard` document card slice 1 built).
 */

const EYE_HEIGHT = 1.7;
const MOVE_SPEED = 5; // units/second
const LOOK_SENSITIVITY = 0.0035;
const SHELF_GEOMETRY = new THREE.BoxGeometry(0.6, 1.1, 0.26);
const SHELF_COLOR = new THREE.Color(0x3a6f5a);
const SHELF_ARCHIVED_COLOR = new THREE.Color(0x6a6558);

function plaqueElement(text: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'library-plaque';
  element.textContent = text;
  return element;
}

interface Standing {
  position: Vec3;
  lookAt: Vec3;
}

/**
 * The single entrance anchor (issue #245 review: a shared door anchor, not two independent
 * positions guessed at separately) — where the camera lands on arrival, the implicit "door"
 * this scene's own half of the trip owns. The office's own half is `#room=library`
 * (`sceneNav.ts`'s `officeReturnUrl`), the existing room-framing hash, not a second hard-coded
 * world position to keep in sync by hand.
 */
const ENTRANCE_STANDING: Standing = {
  position: { x: (HALL.minX + HALL.maxX) / 2, y: EYE_HEIGHT, z: HALL.maxZ - 2 },
  lookAt: { x: (HALL.minX + HALL.maxX) / 2, y: EYE_HEIGHT, z: 0 },
};

/**
 * The library this scene actually shows (issue #245 review): the office's own
 * `matchesFloor`/`relevantLibraries` rule (`plugins/floor-library/client.ts`), reused here
 * rather than always taking `libraries[0]` — a second configured library was otherwise
 * unreachable from this scene no matter which floor was actually focused when Gabriel walked
 * through the door. Without a floor (`ALL_FLOORS`, or none given at all) this keeps the old
 * "first configured library" default.
 */
function relevantLibrary(libraries: WorldLibrary[], floor: string | undefined): WorldLibrary | undefined {
  if (!floor || floor === ALL_FLOORS) return libraries[0];
  return libraries.find((candidate) => matchesFloor(floor, candidate.repo)) ?? libraries[0];
}

/**
 * The teleport-in pose for a section room: aligned with wherever its own shelves actually
 * are, not a fixed guess. `shelfPlacement` fills a 10-column grid left to right, so a section
 * with only a few files clusters them at one edge of the grid (review: a fixed center-of-room
 * look-at left every file off to one side for any section under ~10 entries — nearly every
 * real one). Standing at the centroid's own column and looking down that column's aisle
 * means at least the nearest shelf is always in frame, regardless of how many a section has.
 * A room with no files at all (a section whose own `INDEX.md` resolved to zero entries) still
 * gets a reasonable pose: centered, looking at the room's own middle.
 */
function roomStanding(frame: RoomFrame, placements: Array<{ a: number; d: number }>): Standing {
  if (placements.length === 0) {
    return { position: frame.point(0, 0.5, EYE_HEIGHT), lookAt: frame.point(0, ROOM_SIZE / 2, EYE_HEIGHT) };
  }
  const columnCentroid = placements.reduce((sum, placement) => sum + placement.a, 0) / placements.length;
  const depthCentroid = placements.reduce((sum, placement) => sum + placement.d, 0) / placements.length;
  return {
    position: frame.point(columnCentroid, 0.3, EYE_HEIGHT),
    lookAt: frame.point(columnCentroid, Math.max(depthCentroid, 2.5), 0.6),
  };
}

/**
 * A plain WASD-and-drag-to-look rig (issue #245 review: pointer lock, wired unconditionally by
 * `createScene()` for the office's own first-person mode, broke this scene's own DOM click
 * targets the moment the first click engaged it — `bootLibraryScene` now calls
 * `setPointerLockFilter(() => false)` before anything else, so it never engages here at all).
 * Wall collision (`moveWithCollision`) and a dirty flag for on-demand rendering (issue #245
 * review: this used to render every frame unconditionally, unlike the office's own
 * `FrameLoop`) are both tracked here too.
 */
class LibraryCameraRig {
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly keys = new Set<string>();
  private walls: WallRect[] = [];
  dirty = true;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly dom: HTMLElement) {
    this.dom.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
    });
    window.addEventListener('pointerup', () => { this.dragging = false; });
    window.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      const dx = event.clientX - this.lastX;
      const dy = event.clientY - this.lastY;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.yaw -= dx * LOOK_SENSITIVITY;
      this.pitch = clampPitch(this.pitch - dy * LOOK_SENSITIVITY);
      this.applyLook();
      this.dirty = true;
    });
    window.addEventListener('keydown', (event) => { this.keys.add(event.code); this.dirty = true; });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
  }

  setWalls(walls: WallRect[]): void {
    this.walls = walls;
  }

  teleport(standing: Standing): void {
    this.camera.position.set(standing.position.x, standing.position.y, standing.position.z);
    const { yaw, pitch } = yawPitchFromLookAt(standing.position, standing.lookAt);
    this.yaw = yaw;
    this.pitch = pitch;
    this.applyLook();
    this.dirty = true;
  }

  update(deltaSeconds: number): void {
    const { forward, right } = groundAxes(this.yaw);
    let moveX = 0;
    let moveZ = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) { moveX += forward.x; moveZ += forward.z; }
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) { moveX -= forward.x; moveZ -= forward.z; }
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) { moveX += right.x; moveZ += right.z; }
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) { moveX -= right.x; moveZ -= right.z; }
    const length = Math.hypot(moveX, moveZ);
    if (length > 0) {
      const step = (MOVE_SPEED * deltaSeconds) / length;
      const { x, z } = moveWithCollision(this.camera.position.x, this.camera.position.z, moveX * step, moveZ * step, this.walls);
      this.camera.position.x = x;
      this.camera.position.z = z;
      this.dirty = true;
    }
  }

  /** Whether anything is actively moving the camera right now (issue #245 review: on-demand
   * rendering — a held key keeps firing no further discrete event, so this is checked fresh
   * every frame, the same reasoning `ViewController.isContinuouslyActive` already applies). */
  isActive(): boolean {
    return this.dragging || this.keys.size > 0;
  }

  private applyLook(): void {
    const forward = forwardFromYawPitch(this.yaw, this.pitch);
    this.camera.lookAt(this.camera.position.x + forward.x, this.camera.position.y + forward.y, this.camera.position.z + forward.z);
  }
}

/**
 * The library's own on-screen UI chrome (issue #245 review): the room title, the wall index
 * (bounded height, scrolling past it rather than running off-screen or overlapping anything
 * else) and the door back to the office, as one fixed panel — the same `position: fixed`
 * pattern the office's own `#ui-panel` already uses, not CSS2D objects placed at a world
 * position (which is what overlapped in the first place: three labels stacked at the same
 * screen spot at any real viewing distance). Also the `LibraryCard`'s own dock anchor, the same
 * relationship `#ui-panel` already has with the office's `AgentCard`.
 */
function buildLibraryPanel(sections: SectionRoomLayout[]): { panel: HTMLElement; indexList: HTMLElement; backDoor: HTMLButtonElement } {
  const panel = document.createElement('aside');
  panel.id = 'library-panel';
  const title = document.createElement('h2');
  title.textContent = 'The Library';
  panel.appendChild(title);

  const indexList = document.createElement('div');
  indexList.className = 'library-index';
  for (const section of sections) {
    const line = document.createElement('button');
    line.type = 'button';
    line.className = 'library-index-line';
    line.dataset.section = String(section.sectionIndex);
    const hidden = section.hiddenEntryCount > 0 ? ` (+${section.hiddenEntryCount} more)` : '';
    line.textContent = `${section.name} · ${section.shownEntryCount}${hidden}`;
    indexList.appendChild(line);
  }
  panel.appendChild(indexList);

  const backDoor = document.createElement('button');
  backDoor.type = 'button';
  backDoor.className = 'library-back-door';
  backDoor.textContent = '← Back to the office';
  panel.appendChild(backDoor);
  backDoor.addEventListener('click', () => {
    navigateAfterTransition('Returning to the office…', () => {
      // Set right before leaving, consumed once by the office's own boot (`main.ts`) to show
      // its own brief arrival overlay without adding one to every ordinary office load.
      markReturningFromLibrary();
      window.location.assign(officeReturnUrl(window.location as unknown as SceneNavLocation));
    });
  });

  document.body.appendChild(panel);
  return { panel, indexList, backDoor };
}

/** One shelf's own identity (issue #245 review): which library entry a raycast hit against
 * the shared `InstancedMesh` actually resolves to, keyed by `instanceId` — the index into this
 * array IS the instance index `buildShelfMesh` wrote that entry's transform/color at. */
interface ShelfMeta {
  librarySectionIndex: number;
  entryIndex: number;
}

function buildSectionRoom(
  scene: THREE.Scene,
  section: SectionRoomLayout,
  entries: WorldLibraryEntry[],
  shelfPositions: THREE.Vector3[],
  shelfColors: THREE.Color[],
  shelfMeta: ShelfMeta[],
  colliders: WallRect[],
): Standing {
  const { slot } = section;
  const group = new THREE.Group();
  group.name = `library-section-${section.sectionIndex}`;
  markStatic(group, { zone: 'library-rooms', castShadow: false });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE), getToonMaterial(0xa58a6a));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((slot.rect.minX + slot.rect.maxX) / 2, 0.005, (slot.rect.minZ + slot.rect.maxZ) / 2);
  floor.receiveShadow = true;
  group.add(floor);
  group.add(buildWalls(slot.rect, [slot.door]));
  group.add(doorFrame(slot.rect, slot.door, 0xa58a6a));
  group.add(buildCeiling(slot.rect));
  scene.add(group);
  colliders.push(...wallRects(slot.rect, [slot.door]));

  const frame = new RoomFrame(slot.rect, slot.door);
  const plaque = new CSS2DObject(plaqueElement(section.name));
  const plaquePosition = frame.point(0, ROOM_SIZE - 0.6, WALL_HEIGHT - 0.6);
  plaque.position.copy(plaquePosition);
  scene.add(plaque);

  const placements = entries.slice(0, section.shownEntryCount).map((entry, entryIndex) => {
    const placement = shelfPlacement(entryIndex);
    shelfPositions.push(frame.point(placement.a, placement.d, 0.55));
    shelfColors.push(entry.archived ? SHELF_ARCHIVED_COLOR : SHELF_COLOR);
    shelfMeta.push({ librarySectionIndex: section.sectionIndex, entryIndex });
    return placement;
  });

  return roomStanding(frame, placements);
}

function buildShelfMesh(scene: THREE.Scene, positions: THREE.Vector3[], colors: THREE.Color[]): THREE.InstancedMesh {
  const material = getToonMaterial(0xffffff);
  const mesh = new THREE.InstancedMesh(SHELF_GEOMETRY, material, Math.max(positions.length, 1));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = positions.length;
  // The mesh's own object transform never moves (every position lives in its per-instance
  // matrices instead): its local bounding sphere is `SHELF_GEOMETRY`'s own tiny one at the
  // origin, which frustum-culled the whole mesh out of every room that is not itself near
  // world (0,0,0) (review: this is why nothing drew at all before this line existed). One
  // shared mesh for the whole library is cheap enough to never cull.
  mesh.frustumCulled = false;
  const matrix = new THREE.Matrix4();
  positions.forEach((position, index) => {
    matrix.makeTranslation(position.x, position.y, position.z);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, colors[index]!);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  return mesh;
}

export async function bootLibraryScene(): Promise<void> {
  const overlay = consumeReturningFromLibrary() ? showTransition('Returning to the office…') : showTransition('Entering the library…');

  // Issue #245 review: `createScene()` wires a canvas click to request pointer lock
  // unconditionally (the office's own first-person mode). This scene's every clickable thing
  // (the index, the back door, a shelf) is a plain, un-locked click target; locking on the
  // first click broke every one of them until Escape. Set before the canvas even exists to
  // close the gap between first paint and the first click.
  setPointerLockFilter(() => false);

  const { scene, camera, renderer, labelRenderer } = createScene();
  scene.background = new THREE.Color(0x100e18);

  let sections: SectionRoomLayout[] = [];
  let sectionEntries: WorldLibraryEntry[][] = [];
  let libraries: WorldLibrary[] = [];
  let libraryId: string | undefined;
  try {
    const response = await fetch('/api/world', { signal: AbortSignal.timeout(5000) });
    const world = response.ok ? (await response.json()) as World : null;
    libraries = world?.libraries ?? [];
    const library = relevantLibrary(libraries, libraryFloorFromSearch(window.location.search));
    libraryId = library?.id;
    const rawSections = library?.sections ?? [];
    sections = sectionRoomLayouts(rawSections);
    sectionEntries = rawSections.map((section) => section.entries);
  } catch {
    // No library configured, or the server did not answer: an empty library, not a crash
    // (the same graceful-degradation rule `readBibliotheque` already follows server-side).
  }

  const { indexList } = buildLibraryPanel(sections);

  const selection = new SelectionState();
  const libraryCard = new LibraryCard(document.body, { anchor: document.getElementById('library-panel')!, selection });
  libraryCard.render(libraries);

  const shelfPositions: THREE.Vector3[] = [];
  const shelfColors: THREE.Color[] = [];
  const shelfMeta: ShelfMeta[] = [];
  const colliders: WallRect[] = [];
  const standings: Standing[] = sections.map((section, sectionIndex) =>
    buildSectionRoom(scene, section, sectionEntries[sectionIndex] ?? [], shelfPositions, shelfColors, shelfMeta, colliders));
  const shelfMesh = buildShelfMesh(scene, shelfPositions, shelfColors);

  const rig = new LibraryCameraRig(camera, renderer.domElement);
  rig.setWalls(colliders);
  rig.teleport(ENTRANCE_STANDING);

  indexList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const sectionIndex = target.dataset.section ? Number(target.dataset.section) : undefined;
    const standing = sectionIndex !== undefined ? standings[sectionIndex] : undefined;
    if (standing) { rig.teleport(standing); selection.clear(); }
  });

  // Issue #245 review: a shelf is now individually clickable, opening the same document card
  // slice 1 built for the office's own shared room — raycast against the shared
  // `InstancedMesh`'s own `instanceId`, the same primitive `THREE.Raycaster` already offers
  // for any instanced mesh, no second pick-target system needed.
  const raycaster = new THREE.Raycaster();
  renderer.domElement.addEventListener('click', (event) => {
    if (shelfMeta.length === 0) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(shelfMesh, false)[0];
    if (!hit || hit.instanceId === undefined || libraryId === undefined) return;
    const meta = shelfMeta[hit.instanceId];
    if (!meta) return;
    selection.select(libraryEntryId(libraryId, meta.librarySectionIndex, meta.entryIndex));
    rig.dirty = true;
  });

  new StaticBatch(scene).update();

  let lastTime = performance.now();
  removeTransition(overlay);

  // Issue #245 review: this used to render every frame unconditionally, unlike the office's
  // own on-demand `FrameLoop`/`AnimationSleep`. Looking around, walking, or an open card
  // changing keep it rendering; standing still with nothing selected drops to idle (still
  // scheduled, at the same frame rate requestAnimationFrame always offers, but skipping the
  // two actual render calls — the only real cost — the moment nothing has visibly changed).
  function frame(now: number): void {
    const delta = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    rig.update(delta);
    if (rig.dirty || rig.isActive()) {
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
      rig.dirty = false;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (isDebugMode(window.location.search)) {
    Object.assign(window, {
      __libraryStats: {
        drawCalls: () => countDrawCalls(scene, camera),
        sections: sections.length,
        shelves: shelfPositions.length,
      },
    });
  }
}

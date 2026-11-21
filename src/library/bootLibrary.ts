import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createScene } from '../scene/SceneSetup.js';
import { countDrawCalls } from '../scene/RenderBudget.js';
import { StaticBatch } from '../scene/StaticMerge.js';
import { markStatic } from '../scene/StaticMerge.js';
import { isDebugMode } from '../scene/RenderScheduler.js';
import { getToonMaterial } from '../utils/Materials.js';
import { buildCeiling, buildWalls, doorFrame, RoomFrame, WALL_HEIGHT } from '../addons/building/rooms.js';
import { HALL, ROOM_SIZE, type RoomSlot } from '../addons/building/RoomPlanner.js';
import { createDesk } from '../furniture/Desk.js';
import { StickFigure } from '../characters/StickFigure.js';
import { sectionRoomLayouts, shelfPlacement, type SectionRoomLayout } from './libraryLayout.js';
import { clampPitch, forwardFromYawPitch, groundAxes, yawPitchFromLookAt, type Vec3 } from './cameraMath.js';
import { officeReturnUrl, type SceneNavLocation } from './sceneNav.js';
import { consumeReturningFromLibrary, markReturningFromLibrary, navigateAfterTransition, removeTransition, showTransition } from './transition.js';
import type { World, WorldLibraryEntry } from '../extensions.js';

/**
 * The library's own scene (issue #239, #220: Gabriel's "different dimension" idea). A
 * separate boot path `main.ts` runs instead of the office's, so only one of the two scenes
 * ever exists in memory, let alone renders, at a time — the office's own draw-call budget
 * (`src/scene/RenderBudget.ts`'s 430) is untouched by anything in here, by construction, not
 * by a shared cap this module has to mind.
 *
 * Layout: the office's own `HALL` rect is reused as the entrance/lobby (open floor, no walls
 * of its own — same shape the office's hall already is), with a wall index and the door back
 * to the office. One room per top-level bibliotheque section rents the next slot outward
 * (`slotFor`, the exact ring-growth math `BuildingLayout`'s own rooms use), each with a 10x10
 * shelf grid (`libraryLayout.ts`'s own `SHELF_CAP`, matching the server's own 100-entry cap).
 * Every shelf is one instance of one shared `InstancedMesh` — one draw call for the whole
 * library's worth of shelves, however many sections or entries it holds.
 */

const EYE_HEIGHT = 1.7;
const MOVE_SPEED = 5; // units/second
const LOOK_SENSITIVITY = 0.0035;
const SHELF_GEOMETRY = new THREE.BoxGeometry(0.6, 1.1, 0.26);
const SHELF_COLOR = new THREE.Color(0x3a6f5a);
const SHELF_ARCHIVED_COLOR = new THREE.Color(0x6a6558);

function plaqueElement(text: string, className = 'library-plaque'): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  return element;
}

interface Standing {
  position: Vec3;
  lookAt: Vec3;
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

/** A plain WASD-and-drag-to-look rig, no pointer lock (issue #239 keeps the library scene's
 * own interaction simple: every clickable thing here, the wall index and the room doors, is a
 * normal DOM element with a normal click listener — pointer lock would hide the cursor and
 * break that, for no benefit this scene actually needs). `teleport` is the "click to travel"
 * primitive the wall index and the doors both call. */
class LibraryCameraRig {
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly keys = new Set<string>();

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
    });
    window.addEventListener('keydown', (event) => this.keys.add(event.code));
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
  }

  teleport(standing: Standing): void {
    this.camera.position.set(standing.position.x, standing.position.y, standing.position.z);
    const { yaw, pitch } = yawPitchFromLookAt(standing.position, standing.lookAt);
    this.yaw = yaw;
    this.pitch = pitch;
    this.applyLook();
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
      this.camera.position.x += moveX * step;
      this.camera.position.z += moveZ * step;
    }
  }

  private applyLook(): void {
    const forward = forwardFromYawPitch(this.yaw, this.pitch);
    this.camera.lookAt(this.camera.position.x + forward.x, this.camera.position.y + forward.y, this.camera.position.z + forward.z);
  }
}

function buildEntrance(scene: THREE.Scene, sections: SectionRoomLayout[]): { indexElement: HTMLDivElement } {
  const group = new THREE.Group();
  group.name = 'library-entrance';
  markStatic(group, { zone: 'library-rooms', castShadow: false });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(HALL.maxX - HALL.minX, HALL.maxZ - HALL.minZ), getToonMaterial(0x8a7a5a));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((HALL.minX + HALL.maxX) / 2, 0.005, (HALL.minZ + HALL.maxZ) / 2);
  floor.receiveShadow = true;
  group.add(floor);
  group.add(buildCeiling(HALL));
  scene.add(group);

  const title = new CSS2DObject(plaqueElement('The Library', 'library-title'));
  title.position.set((HALL.minX + HALL.maxX) / 2, WALL_HEIGHT - 0.6, HALL.minZ + 1.5);
  scene.add(title);

  const indexElement = document.createElement('div');
  indexElement.className = 'library-index';
  const heading = document.createElement('h3');
  heading.textContent = 'Sections';
  indexElement.appendChild(heading);
  for (const section of sections) {
    const line = document.createElement('button');
    line.type = 'button';
    line.className = 'library-index-line';
    line.dataset.section = String(section.sectionIndex);
    const hidden = section.hiddenEntryCount > 0 ? ` (+${section.hiddenEntryCount} more)` : '';
    line.textContent = `${section.name} · ${section.shownEntryCount}${hidden}`;
    indexElement.appendChild(line);
  }
  const index = new CSS2DObject(indexElement);
  index.position.set((HALL.minX + HALL.maxX) / 2, WALL_HEIGHT - 1.6, HALL.minZ + 1.5);
  scene.add(index);

  const backDoor = document.createElement('button');
  backDoor.type = 'button';
  backDoor.className = 'library-back-door';
  backDoor.textContent = '← Back to the office';
  const backDoorObject = new CSS2DObject(backDoor);
  // The single seam this scene owns on its own side (`sceneNav.ts` owns the URL half): one
  // door, one place, so a later redesign of the entrance only ever moves this one object.
  // Placed in the same forward view as the wall index, not off to a side (review: the
  // entrance's own spawn pose looks straight down -Z; a side-wall position never entered that
  // cone at all, in or out of a section room).
  backDoorObject.position.set((HALL.minX + HALL.maxX) / 2, WALL_HEIGHT - 2.4, HALL.minZ + 1.5);
  scene.add(backDoorObject);
  backDoor.addEventListener('click', () => {
    navigateAfterTransition('Returning to the office…', () => {
      // Set right before leaving, consumed once by the office's own boot (`main.ts`) to show
      // its own brief arrival overlay without adding one to every ordinary office load.
      markReturningFromLibrary();
      window.location.assign(officeReturnUrl(window.location as unknown as SceneNavLocation));
    });
  });

  return { indexElement };
}

/**
 * The librarian's own corner (issue #248, Gabriel's own words: "he's gonna have his desk...
 * if a session starts a sub agent that is a librarian he's gonna pop up and go there"). A
 * desk near the entrance (not inside any section room — this is the librarian's own spot, not
 * a shelf), the NPC standing beside it ("doesn't do much... you can interact with him"), and a
 * name tag above him — a plain DOM click target, the same pattern every other clickable thing
 * in this scene already uses (no 3D raycasting added just for one NPC).
 */
// Review: a corner near the HALL's own side wall sat well outside the entrance's own forward
// view (spawn looks straight down -Z from z = HALL.maxZ - 2) — the same mistake the back door
// made before it moved onto the index's own forward column. A few units to the right of that
// column, not behind the camera and not off to the side, keeps the whole corner in view on
// arrival without a single extra click.
const CORNER_X = 3;
const CORNER_Z = 8;
const NPC_COLOR = 0x5a4a3a;
const LIBRARIAN_AGENT_COLOR = 0x4a6a8e;
/** Real librarian-persona agents (issue #248) stand in a row beside the desk, one slot each,
 * spaced wide enough that two stick figures never overlap. */
const LIBRARIAN_SLOT_GAP = 0.8;
const MAX_LIBRARIAN_FIGURES = 6;

function buildLibrarianCorner(scene: THREE.Scene, onAskLibrarian: () => void): void {
  const desk = createDesk(false);
  desk.position.set(CORNER_X, 0, CORNER_Z);
  desk.rotation.y = Math.PI; // face the hall's own center, the same way every desk faces its room
  markStatic(desk, { zone: 'library-rooms', castShadow: false });
  scene.add(desk);

  const npc = new StickFigure('Prospero', new THREE.Color(NPC_COLOR));
  const npcPosition = new THREE.Vector3(CORNER_X - 1, 0, CORNER_Z);
  npc.teleportTo(npcPosition, new THREE.Vector3(0, 0, 0));
  scene.add(npc.group);

  const askButton = document.createElement('button');
  askButton.type = 'button';
  askButton.className = 'library-ask-librarian';
  askButton.textContent = 'Prospero, the librarian — see the catalog';
  const askObject = new CSS2DObject(askButton);
  askObject.position.set(npcPosition.x, 2.1, npcPosition.z);
  scene.add(askObject);
  askButton.addEventListener('click', onAskLibrarian);
}

/** The one field this scene reads off `/api/agents` (issue #248): the same badge-based
 * signal `plugins/library/index.ts`'s own enricher now sets for any librarian-persona agent,
 * real session or subagent alike, never a name match. */
interface AgentRoleInfo {
  id: string;
  name: string;
  role?: string;
}

/** Keeps one `StickFigure` per currently-live librarian-persona agent, standing in a row
 * beside the desk (issue #248: "he's gonna pop up and go there"). Capped at
 * `MAX_LIBRARIAN_FIGURES` — a physical row this short has no more room anyway, and the office
 * scene's own library room (issue #128) already shows the rest. Never a dead loop without a
 * document: on fetch failure, the existing figures simply stay as they were until the next
 * successful poll, the same graceful-degradation rule the shelves themselves follow.
 */
class LibrarianDesk {
  private figures = new Map<string, StickFigure>();

  constructor(private readonly scene: THREE.Scene) {}

  get count(): number {
    return this.figures.size;
  }

  async poll(): Promise<void> {
    let agents: AgentRoleInfo[];
    try {
      const response = await fetch('/api/agents', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      agents = (await response.json()) as AgentRoleInfo[];
    } catch {
      return;
    }
    const librarians = agents.filter((agent) => agent.role === 'librarian').slice(0, MAX_LIBRARIAN_FIGURES);
    const seen = new Set(librarians.map((agent) => agent.id));
    for (const [id, figure] of this.figures) {
      if (!seen.has(id)) {
        figure.group.removeFromParent();
        this.figures.delete(id);
      }
    }
    librarians.forEach((agent, index) => {
      if (this.figures.has(agent.id)) return;
      // Its own name (issue #248 review: a figure named after its own public id read as an
      // opaque hash on the floating label, not as a real session) and a color distinct from
      // the NPC's own, so the real agent and Prospero himself are never visually the same
      // figure twice over.
      const figure = new StickFigure(agent.name, new THREE.Color(LIBRARIAN_AGENT_COLOR));
      const position = new THREE.Vector3(CORNER_X + 1 + index * LIBRARIAN_SLOT_GAP, 0, CORNER_Z);
      figure.teleportTo(position, new THREE.Vector3(CORNER_X, 0, CORNER_Z - 2));
      this.scene.add(figure.group);
      this.figures.set(agent.id, figure);
    });
  }
}

function buildSectionRoom(scene: THREE.Scene, section: SectionRoomLayout, entries: WorldLibraryEntry[], shelfPositions: THREE.Vector3[], shelfColors: THREE.Color[]): Standing {
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

  const frame = new RoomFrame(slot.rect, slot.door);
  const plaque = new CSS2DObject(plaqueElement(section.name));
  const plaquePosition = frame.point(0, ROOM_SIZE - 0.6, WALL_HEIGHT - 0.6);
  plaque.position.copy(plaquePosition);
  scene.add(plaque);

  const placements = entries.slice(0, section.shownEntryCount).map((entry, entryIndex) => {
    const placement = shelfPlacement(entryIndex);
    shelfPositions.push(frame.point(placement.a, placement.d, 0.55));
    shelfColors.push(entry.archived ? SHELF_ARCHIVED_COLOR : SHELF_COLOR);
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

  const { scene, camera, renderer, labelRenderer } = createScene();
  scene.background = new THREE.Color(0x100e18);

  let sections: SectionRoomLayout[] = [];
  let sectionEntries: WorldLibraryEntry[][] = [];
  try {
    const response = await fetch('/api/world', { signal: AbortSignal.timeout(5000) });
    const world = response.ok ? (await response.json()) as World : null;
    const library = world?.libraries?.[0];
    const rawSections = library?.sections ?? [];
    sections = sectionRoomLayouts(rawSections);
    sectionEntries = rawSections.map((section) => section.entries);
  } catch {
    // No library configured, or the server did not answer: an empty library, not a crash
    // (the same graceful-degradation rule `readBibliotheque` already follows server-side).
  }

  const { indexElement } = buildEntrance(scene, sections);

  const shelfPositions: THREE.Vector3[] = [];
  const shelfColors: THREE.Color[] = [];
  const standings: Standing[] = sections.map((section, sectionIndex) =>
    buildSectionRoom(scene, section, sectionEntries[sectionIndex] ?? [], shelfPositions, shelfColors));
  buildShelfMesh(scene, shelfPositions, shelfColors);

  const rig = new LibraryCameraRig(camera, renderer.domElement);
  const entranceStanding: Standing = { position: { x: (HALL.minX + HALL.maxX) / 2, y: EYE_HEIGHT, z: HALL.maxZ - 2 }, lookAt: { x: (HALL.minX + HALL.maxX) / 2, y: EYE_HEIGHT, z: 0 } };
  rig.teleport(entranceStanding);

  indexElement.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const sectionIndex = target.dataset.section ? Number(target.dataset.section) : undefined;
    const standing = sectionIndex !== undefined ? standings[sectionIndex] : undefined;
    if (standing) rig.teleport(standing);
  });

  // The librarian (issue #248): "doesn't do much... maybe he shows you the catalog" — a click
  // teleports back to the entrance (where the wall index always lives) and gives it a brief
  // highlight, rather than opening a second copy of the same list in a new kind of card.
  buildLibrarianCorner(scene, () => {
    rig.teleport(entranceStanding);
    indexElement.classList.add('library-index-highlight');
    window.setTimeout(() => indexElement.classList.remove('library-index-highlight'), 1200);
  });
  const librarianDesk = new LibrarianDesk(scene);
  void librarianDesk.poll();
  window.setInterval(() => void librarianDesk.poll(), 5000);

  new StaticBatch(scene).update();

  let lastTime = performance.now();
  removeTransition(overlay);

  function frame(now: number): void {
    const delta = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    rig.update(delta);
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (isDebugMode(window.location.search)) {
    Object.assign(window, {
      __libraryStats: {
        drawCalls: () => countDrawCalls(scene, camera),
        sections: sections.length,
        shelves: shelfPositions.length,
        librarianFigures: () => librarianDesk.count,
      },
    });
  }
}
